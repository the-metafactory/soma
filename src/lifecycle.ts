import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { listAlgorithmRunSummaries, listAlgorithmRuns, readAlgorithmRunById, writeAlgorithmRun } from "./algorithm-store";
import { appendAlgorithmProvenance } from "./algorithm-provenance";
import { appendSomaMemoryEvent } from "./memory";
import { loadSomaProfile } from "./soma-home";
import { normalizeSomaWorkRegistryArtifacts, upsertSomaCurrentWorkPointer } from "./work-registry";
import { SECTION_NAME_MAP, getCriteria, getGoal } from "./vsa-accessors";
import { getRunPhase } from "./algorithm-lifecycle";
import {
  applyVsaUpdate,
  checkCompleteness,
  getActiveVsa,
  readVsa,
  type VsaUpdateEntry,
} from "./vsa";
import type {
  AlgorithmRun,
  AlgorithmRunSummary,
  AlgorithmWorkIndex,
  VerificationStateArtifact,
  VsaUpdatePayload,
  SomaLifecycleOptions,
  SomaLifecycleResult,
  SomaStartupContext,
  SubstrateId,
} from "./types";

const execFileAsync = promisify(execFile);

export function resolveSomaHome(options: SomaLifecycleOptions = {}): string {
  const home = resolve(options.homeDir ?? homedir());
  return resolve(options.somaHome ?? join(home, ".soma"));
}

function substrate(options: SomaLifecycleOptions): SubstrateId {
  return options.substrate ?? "custom";
}

export interface DeriveSessionNameInput {
  sessionId: string;
  activeVsaSlug?: string;
  activeVsaGoal?: string;
  cwd?: string;
  gitBranch?: string;
}

export interface DerivedSessionName {
  slug: string;
  sessionName: string;
  task?: string;
}

const UNINTERESTING_BRANCHES = new Set(["", "main", "master", "head", "trunk", "develop"]);

function lastPathSegment(value: string): string {
  const segments = value.split(/[/\\]+/u).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? "";
}

/**
 * Choose a human-meaningful session name, preferring (1) the active VSA slug
 * so sessions align with the goal-derived `memory/WORK/{slug}` names, then
 * (2) the working directory basename plus a non-default git branch, and
 * finally (3) the legacy `session <uuid>` fallback. Pure: git/VSA lookups
 * happen in the caller and are passed in.
 *
 * Names are not unique keys: concurrent sessions sharing a long-lived
 * project VSA (or the same cwd) derive the same slug. `upsertSomaWorkRegistry`
 * resolves the collision — the first session keeps the clean slug and later
 * ones get a `-<sessionId>` suffix via `uniqueSessionSlug` — so the name
 * groups by project/repo while each session keeps its own entry (keyed by
 * `sessionUUID`).
 */
export function deriveSessionName(input: DeriveSessionNameInput): DerivedSessionName {
  const vsaSlug = input.activeVsaSlug?.trim();
  if (vsaSlug !== undefined && vsaSlug.length > 0) {
    const goal = input.activeVsaGoal?.trim();
    return {
      slug: vsaSlug,
      sessionName: vsaSlug,
      ...(goal !== undefined && goal.length > 0 ? { task: goal } : {}),
    };
  }

  const base = input.cwd === undefined ? "" : lastPathSegment(input.cwd.trim());
  if (base.length > 0) {
    const branch = input.gitBranch?.trim();
    const useBranch = branch !== undefined && branch.length > 0 && !UNINTERESTING_BRANCHES.has(branch.toLowerCase());
    const name = useBranch ? `${base}/${branch}` : base;
    return { slug: name, sessionName: name };
  }

  return {
    slug: `session ${input.sessionId}`,
    sessionName: `session ${input.sessionId}`,
    task: `Session ${input.sessionId}`,
  };
}

/** Best-effort git branch detection for `cwd`. Never throws. */
async function detectGitBranch(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined || cwd.trim().length === 0) return undefined;
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 1000,
      windowsHide: true,
    });
    const branch = stdout.trim();
    return branch.length > 0 && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

async function resolveSessionName(
  options: SomaLifecycleOptions,
  active: { slug: string; isa: VerificationStateArtifact } | null,
): Promise<DerivedSessionName> {
  const sessionId = options.sessionId ?? "";
  const gitBranch = active === null ? options.gitBranch ?? (await detectGitBranch(options.cwd)) : undefined;
  return deriveSessionName({
    sessionId,
    activeVsaSlug: active?.slug,
    activeVsaGoal: active === null ? undefined : getGoal(active.isa) ?? undefined,
    cwd: options.cwd,
    gitBranch,
  });
}

async function readRecentMarkdown(root: string, limit: number): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map(async (entry) => {
        const path = join(root, entry.name);
        const content = await readFile(path, "utf8");
        const title = content
          .split("\n")
          .find((line) => line.startsWith("# "))
          ?.slice(2)
          .trim();

        return {
          path,
          title: title === "" || title === undefined ? entry.name : title,
        };
      }),
  );

  return files
    .sort((a, b) => b.path.localeCompare(a.path))
    .slice(0, limit)
    .map((file) => `${file.title} (${file.path})`);
}

function renderRunSummary(summary: AlgorithmRunSummary): string {
  return `- ${summary.id}: ${summary.phase.toUpperCase()} ${summary.progress} ${summary.effort} - ${summary.goal}`;
}

function renderStartupContext(input: {
  assistantName: string;
  principalName: string;
  mission?: string;
  activeRuns: AlgorithmRunSummary[];
  recentLearnings: string[];
  relationshipNotes: string[];
}): string {
  return [
    "# Soma Startup Context",
    "",
    `Assistant: ${input.assistantName}`,
    `Principal: ${input.principalName}`,
    input.mission ? `Mission: ${input.mission}` : undefined,
    "",
    "## Active Algorithm Runs",
    input.activeRuns.length > 0 ? input.activeRuns.map(renderRunSummary).join("\n") : "No active Algorithm runs.",
    "",
    "## Recent Learning",
    input.recentLearnings.length > 0 ? input.recentLearnings.map((item) => `- ${item}`).join("\n") : "No recent learning artifacts.",
    "",
    "## Relationship Notes",
    input.relationshipNotes.length > 0 ? input.relationshipNotes.map((item) => `- ${item}`).join("\n") : "No recent relationship notes.",
    "",
    "## Operating Contract",
    "- Use active Algorithm runs as the work-state source of truth.",
    "- Create or update Algorithm runs for substantial work.",
    "- Preserve verification evidence before declaring criteria complete.",
    "- Write durable observations through Soma memory, not substrate-local scratch files.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export async function buildSomaStartupContext(options: SomaLifecycleOptions = {}): Promise<SomaStartupContext> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const profile = await loadSomaProfile(somaHome);
  const summaries = await listAlgorithmRunSummaries({ somaHome });
  const activeRuns = summaries.filter((run) => run.phase !== "complete").slice(0, 8);
  const recentLearnings = await readRecentMarkdown(join(somaHome, "memory/LEARNING"), 8);
  const relationshipNotes = await readRecentMarkdown(join(somaHome, "memory/RELATIONSHIP"), 8);
  const context = renderStartupContext({
    assistantName: profile.assistant.displayName ?? profile.assistant.name,
    principalName: profile.principal.preferredName ?? profile.principal.name,
    mission: profile.purpose.mission,
    activeRuns,
    recentLearnings,
    relationshipNotes,
  });

  return {
    somaHome,
    timestamp,
    substrate: substrate(options),
    sessionId: options.sessionId,
    context,
    activeRuns,
    recentLearnings,
    relationshipNotes,
  };
}

export async function writeAlgorithmWorkIndex(options: SomaLifecycleOptions = {}): Promise<{ path: string; activePath: string; index: AlgorithmWorkIndex }> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const runs = await listAlgorithmRunSummaries({ somaHome });
  const index: AlgorithmWorkIndex = {
    updatedAt: timestamp,
    runs,
  };
  const path = join(somaHome, "memory/STATE/algorithm-work-index.json");
  const activePath = join(somaHome, "memory/STATE/active-algorithm-run.json");

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await writeFile(activePath, `${JSON.stringify(runs.find((run) => run.phase !== "complete") ?? null, null, 2)}\n`, "utf8");

  return { path, activePath, index };
}

function completedLearningContent(run: AlgorithmRun, timestamp: string): string {
  return [
    `# Algorithm Learning: ${run.id}`,
    "",
    `Captured: ${timestamp}`,
    `Run: ${run.id}`,
    `Goal: ${getGoal(run.vsa) ?? ""}`,
    `Effort: ${run.effort}`,
    "",
    `## ${SECTION_NAME_MAP.criteria}`,
    ...getCriteria(run.vsa).map((criterion) => `- [${criterion.status === "passed" ? "x" : " "}] ${criterion.id}: ${criterion.text}`),
    "",
    "## Verification",
    ...(run.verification.length > 0 ? run.verification.map((entry) => `- ${entry.timestamp} ${entry.text}`) : ["No verification entries recorded."]),
    "",
    "## Learning",
    ...(run.learning.length > 0 ? run.learning.map((entry) => `- ${entry.timestamp} ${entry.text}`) : ["No learning entries recorded."]),
    "",
    "## Meta-Reflection",
    ...(run.metaReflection.length > 0 ? run.metaReflection.flatMap(renderMetaReflectionLines) : ["No meta-reflection recorded."]),
  ].join("\n");
}

function renderMetaReflectionLines(reflection: AlgorithmRun["metaReflection"][number]): string[] {
  const { currentStateFloor, learnGateClean, completeness } = reflection.gatesFired;
  const lines = [
    `- ${reflection.timestamp} [${reflection.phase}] gates: currentStateFloor=${currentStateFloor}, learnGateClean=${learnGateClean}, completeness=${completeness}`,
  ];
  const { missedEarlyStep, missedVerifyOrParallel, highestValueMove } = reflection.smarterRun;
  if (missedEarlyStep) lines.push(`  - missed-early-step: ${missedEarlyStep}`);
  if (missedVerifyOrParallel) lines.push(`  - missed-verify-or-parallel: ${missedVerifyOrParallel}`);
  if (highestValueMove) lines.push(`  - highest-value-move: ${highestValueMove}`);
  return lines;
}

export async function captureCompletedAlgorithmLearnings(options: SomaLifecycleOptions = {}): Promise<string[]> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const runs = await listAlgorithmRuns({ somaHome });
  const written: string[] = [];

  for (const { run } of runs) {
    if (getRunPhase(run) !== "complete") {
      continue;
    }

    const path = join(somaHome, "memory/LEARNING/ALGORITHM", `${run.id}.md`);
    const exists = await readFile(path, "utf8").then(
      () => true,
      () => false,
    );

    if (exists) {
      continue;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${completedLearningContent(run, timestamp)}\n`, "utf8");
    written.push(path);
  }

  return written;
}

async function loadActiveVsaForLifecycle(somaHome: string): Promise<{ slug: string; isa: VerificationStateArtifact } | null> {
  const state = await getActiveVsa({ somaHome });
  if (state?.activeSlug == null) return null;
  try {
    const isa = await readVsa(state.activeSlug, { somaHome });
    return { slug: state.activeSlug, isa };
  } catch {
    // Active state points at a missing/unreadable VSA — treat as no
    // active VSA. Caller's events.jsonl will pick up an isa.missing
    // warning if we choose to emit one; for now lifecycle stays silent
    // and non-blocking per #38 spec ("never halt").
    return null;
  }
}

export async function runSomaLifecycleSessionStart(options: SomaLifecycleOptions = {}): Promise<SomaLifecycleResult> {
  const startup = await buildSomaStartupContext(options);
  const active = await loadActiveVsaForLifecycle(startup.somaHome);
  const activeNote = active === null ? "" : ` | active VSA: ${active.slug} (${active.isa.frontmatter.phase})`;
  const eventsPath = join(startup.somaHome, "memory/STATE/events.jsonl");
  let registryFiles: string[] = [];
  if (startup.sessionId !== undefined) {
    const name = await resolveSessionName({ ...options, sessionId: startup.sessionId }, active);
    try {
      registryFiles = (
        await upsertSomaCurrentWorkPointer({
          somaHome: startup.somaHome,
          sessionId: startup.sessionId,
          slug: name.slug,
          sessionName: name.sessionName,
          substrate: startup.substrate,
          ...(name.task !== undefined ? { task: name.task } : {}),
          phase: "native",
          progress: "0/1",
          status: "active",
          timestamp: startup.timestamp,
          ...(options.cwd !== undefined ? { signals: { cwd: options.cwd } } : {}),
          artifacts: {
            events: eventsPath,
          },
          learningSources: {
            events: eventsPath,
          },
        })
      ).files;
    } catch (error: unknown) {
      await appendSomaMemoryEvent(startup.somaHome, {
        substrate: startup.substrate,
        kind: "lifecycle.session_start.registry-write-failed",
        summary: "Session started; shared work registry writeback failed.",
        timestamp: startup.timestamp,
        metadata: {
          sessionId: startup.sessionId,
          substrate: startup.substrate,
          error: lifecycleErrorMessage(error, startup.somaHome),
        },
      });
    }
  }
  await appendSomaMemoryEvent(startup.somaHome, {
    substrate: startup.substrate,
    kind: "lifecycle.session_start",
    summary: `Session started${startup.sessionId ? `: ${startup.sessionId}` : ""}${activeNote}`,
    timestamp: startup.timestamp,
    metadata: {
      sessionId: startup.sessionId,
      activeRuns: startup.activeRuns.map((run) => run.id),
      activeVsaSlug: active?.slug ?? null,
    },
  });

  return {
    event: "session_start",
    somaHome: startup.somaHome,
    timestamp: startup.timestamp,
    files: Array.from(new Set([...registryFiles, eventsPath])),
    context: startup.context,
    activeVsa: active === null ? null : { slug: active.slug, phase: active.isa.frontmatter.phase },
  };
}

/**
 * Append decisions / changelog / verification entries to the active
 * VSA (or the explicit slug in the payload).
 *
 * Sage round-1 architecture fix: writeback gate is satisfied first by
 * emitting the full payload as a `lifecycle.vsa_updated` event in
 * `~/.soma/memory/STATE/events.jsonl` — every VSA mutation has a
 * corresponding append-only audit record. The authoritative VSA write
 * then goes through the trusted Soma-side `applyVsaUpdate` writer,
 * which does a single read + validate-all + single write so a
 * malformed later entry cannot leave partial state on disk.
 *
 * No-op when no active VSA is set AND no slug in payload — Layer 7
 * never halts session work for a missing VSA (per #38 spec).
 */
export async function runSomaLifecycleVsaUpdated(
  payload: VsaUpdatePayload,
  options: SomaLifecycleOptions = {},
): Promise<SomaLifecycleResult> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const activeState = await getActiveVsa({ somaHome });
  const activeSlug = activeState?.activeSlug ?? null;
  const slug = payload.slug ?? activeSlug;
  if (slug === null) {
    await appendSomaMemoryEvent(somaHome, {
      substrate: substrate(options),
      kind: "lifecycle.vsa_updated.no_active",
      summary: "vsa_updated event received but no active VSA set; no writes made.",
      timestamp,
    });
    return {
      event: "vsa_updated",
      somaHome,
      timestamp,
      files: [join(somaHome, "memory/STATE/events.jsonl")],
      writes: [],
    };
  }

  // Sage round-2 Security: explicit payload.slug is only honored when
  // it matches the currently-active slug OR when there is no active
  // slug (caller is electing a target with no contention). Mismatches
  // are refused so a model-controlled lifecycle payload cannot quietly
  // mutate a non-active VSA.
  if (payload.slug !== undefined && activeSlug !== null && payload.slug !== activeSlug) {
    await appendSomaMemoryEvent(somaHome, {
      substrate: substrate(options),
      kind: "lifecycle.vsa_updated.refused_scope",
      summary: `vsa_updated payload.slug='${payload.slug}' does not match active slug '${activeSlug}'; refused.`,
      timestamp,
      metadata: { payloadSlug: payload.slug, activeSlug },
    });
    throw new Error(
      `runSomaLifecycleVsaUpdated: payload.slug '${payload.slug}' does not match active slug '${activeSlug}'. Use 'setActiveVsa' to switch active first.`,
    );
  }

  const entries = buildVsaUpdateEntries(payload);

  // Validate the full payload BEFORE emitting the writeback event or
  // touching the VSA. Sage round 1: partial mutation must not occur on
  // a malformed later entry.
  for (const entry of entries) {
    if (entry.text.trim().length === 0) {
      throw new Error(`runSomaLifecycleVsaUpdated refused empty text in ${entry.section} entry.`);
    }
  }

  // Empty payload — emit a distinct no-op event and short-circuit so
  // events.jsonl never claims a write that didn't happen (Sage round-3
  // CodeQuality).
  if (entries.length === 0) {
    await emitVsaUpdateEvent(somaHome, options, {
      kind: "lifecycle.vsa_updated.noop",
      summary: `vsa_updated invoked for VSA ${slug} with no entries; no write.`,
      timestamp,
      slug,
      payload,
    });
    return {
      event: "vsa_updated",
      somaHome,
      timestamp,
      files: [join(somaHome, "memory/STATE/events.jsonl")],
      writes: [],
    };
  }

  // Sage round-2 CodeQuality: perform the authoritative write FIRST,
  // then emit the success event. If applyVsaUpdate throws (e.g.
  // missing slug, filesystem error) we emit a failure event instead so
  // events.jsonl never contains a success record for a mutation that
  // did not happen.
  let writeResult: { path: string; changed: boolean };
  try {
    writeResult = await applyVsaUpdate(slug, entries, { somaHome, timestamp });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await emitVsaUpdateEvent(somaHome, options, {
      kind: "lifecycle.vsa_updated.failed",
      summary: `vsa_updated write failed for VSA ${slug}: ${message}`,
      timestamp,
      slug,
      payload,
      extra: { error: message },
    });
    throw error;
  }

  await emitVsaUpdateEvent(somaHome, options, {
    kind: "lifecycle.vsa_updated",
    summary: `Appended ${entries.length} entr(ies) to VSA ${slug}.`,
    timestamp,
    slug,
    payload,
    artifactPaths: writeResult.path ? [writeResult.path] : [],
  });

  const writes = writeResult.path ? [writeResult.path] : [];
  return {
    event: "vsa_updated",
    somaHome,
    timestamp,
    files: Array.from(new Set([...writes, join(somaHome, "memory/STATE/events.jsonl")])),
    writes,
  };
}

function buildVsaUpdateEntries(payload: VsaUpdatePayload): VsaUpdateEntry[] {
  return [
    ...(payload.decisions ?? []).map((e) => ({ section: "decisions" as const, ...e })),
    ...(payload.changelogEntries ?? []).map((e) => ({ section: "changelog" as const, ...e })),
    ...(payload.verificationEntries ?? []).map((e) => ({ section: "verification" as const, ...e })),
  ];
}

function vsaUpdateMetadata(slug: string, payload: VsaUpdatePayload, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    slug,
    decisions: payload.decisions ?? [],
    changelogEntries: payload.changelogEntries ?? [],
    verificationEntries: payload.verificationEntries ?? [],
    ...(extra ?? {}),
  };
}

interface EmitVsaUpdateEventOptions {
  kind: "lifecycle.vsa_updated" | "lifecycle.vsa_updated.failed" | "lifecycle.vsa_updated.noop";
  summary: string;
  timestamp: string;
  slug: string;
  payload: VsaUpdatePayload;
  artifactPaths?: string[];
  extra?: Record<string, unknown>;
}

async function emitVsaUpdateEvent(
  somaHome: string,
  options: SomaLifecycleOptions,
  ev: EmitVsaUpdateEventOptions,
): Promise<void> {
  await appendSomaMemoryEvent(somaHome, {
    substrate: substrate(options),
    kind: ev.kind,
    summary: ev.summary,
    timestamp: ev.timestamp,
    metadata: vsaUpdateMetadata(ev.slug, ev.payload, ev.extra),
    artifactPaths: ev.artifactPaths,
  });
}

export async function runSomaLifecycleAlgorithmUpdated(options: SomaLifecycleOptions = {}): Promise<SomaLifecycleResult> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const index = await writeAlgorithmWorkIndex({ ...options, somaHome, timestamp });
  await appendSomaMemoryEvent(somaHome, {
    substrate: substrate(options),
    kind: "lifecycle.algorithm_updated",
    summary: `Algorithm work index updated with ${index.index.runs.length} run(s).`,
    timestamp,
    artifactPaths: [index.path, index.activePath],
  });

  return {
    event: "algorithm_updated",
    somaHome,
    timestamp,
    files: [index.path, index.activePath, join(somaHome, "memory/STATE/events.jsonl")],
  };
}

async function recordAlgorithmObservation(options: SomaLifecycleOptions & { somaHome: string; timestamp: string; runId: string }): Promise<string | undefined> {
  const observedBy = substrate(options);
  if (observedBy === "custom") return undefined;

  const { run } = await readAlgorithmRunById(options.runId, { somaHome: options.somaHome });

  const observed = appendAlgorithmProvenance(run, {
    operation: "run.observed",
    substrate: observedBy,
    phase: getRunPhase(run),
    timestamp: options.timestamp,
    detail: "Lifecycle algorithm-observed observed the active shared run.",
  });

  return (await writeAlgorithmRun({ ...observed, updatedAt: options.timestamp }, { somaHome: options.somaHome })).path;
}

export async function runSomaLifecycleAlgorithmObserved(options: SomaLifecycleOptions = {}): Promise<SomaLifecycleResult> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const active = (await listAlgorithmRunSummaries({ somaHome })).find((run) => run.phase !== "complete");
  const observedRunPath = active
    ? await recordAlgorithmObservation({ ...options, somaHome, timestamp, runId: active.id })
    : undefined;
  const index = await writeAlgorithmWorkIndex({ ...options, somaHome, timestamp });
  const artifactPaths = [index.path, index.activePath, ...(observedRunPath ? [observedRunPath] : [])];
  await appendSomaMemoryEvent(somaHome, {
    substrate: substrate(options),
    kind: "lifecycle.algorithm_observed",
    summary: observedRunPath === undefined ? "No active Algorithm run observed." : "Active Algorithm run observed by substrate.",
    timestamp,
    artifactPaths,
  });

  return {
    event: "algorithm_observed",
    somaHome,
    timestamp,
    files: [...artifactPaths, join(somaHome, "memory/STATE/events.jsonl")],
  };
}

async function writeSessionEndWorkRegistry(input: {
  somaHome: string;
  options: SomaLifecycleOptions;
  active: { slug: string; isa: VerificationStateArtifact } | null;
  timestamp: string;
  algorithmWorkIndexPath: string;
  activeAlgorithmRunPath: string;
  learningFiles: string[];
}): Promise<string[]> {
  if (input.options.sessionId === undefined) return [];

  const artifacts = buildSessionEndRegistryArtifacts({
    somaHome: input.somaHome,
    algorithmWorkIndexPath: input.algorithmWorkIndexPath,
    activeAlgorithmRunPath: input.activeAlgorithmRunPath,
    learningFiles: input.learningFiles,
  });
  const name = await resolveSessionName({ ...input.options, sessionId: input.options.sessionId }, input.active);
  let registryWrite: Awaited<ReturnType<typeof upsertSomaCurrentWorkPointer>>;
  try {
    registryWrite = await upsertSomaCurrentWorkPointer({
      somaHome: input.somaHome,
      sessionId: input.options.sessionId,
      slug: name.slug,
      sessionName: name.sessionName,
      substrate: substrate(input.options),
      ...(name.task !== undefined ? { task: name.task } : {}),
      phase: "complete",
      progress: "1/1",
      status: "complete",
      timestamp: input.timestamp,
      ...(input.options.cwd !== undefined ? { signals: { cwd: input.options.cwd } } : {}),
      artifacts,
      learningSources: {
        events: join(input.somaHome, "memory/STATE/events.jsonl"),
        results: input.learningFiles,
      },
    });
  } catch (error: unknown) {
    await appendSomaMemoryEvent(input.somaHome, {
      substrate: substrate(input.options),
      kind: "lifecycle.session_end.registry-write-failed",
      summary: "Session ended; shared work registry writeback failed.",
      timestamp: input.timestamp,
      metadata: {
        sessionId: input.options.sessionId,
        substrate: substrate(input.options),
        error: lifecycleErrorMessage(error, input.somaHome),
      },
    });
    return [];
  }

  return registryWrite.files;
}

export function buildSessionEndRegistryArtifacts(input: {
  somaHome: string;
  algorithmWorkIndexPath: string;
  activeAlgorithmRunPath: string;
  learningFiles: string[];
}): Record<string, string> {
  const rawArtifacts: Record<string, string> = {
    algorithmWorkIndex: input.algorithmWorkIndexPath,
    activeAlgorithmRun: input.activeAlgorithmRunPath,
  };

  for (const [index, file] of input.learningFiles.entries()) {
    rawArtifacts[`learning${index + 1}`] = file;
  }

  return normalizeSomaWorkRegistryArtifacts({ somaHome: input.somaHome }, rawArtifacts);
}

function lifecycleErrorMessage(error: unknown, somaHome: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(somaHome, "<soma-home>").slice(0, 300);
}

function normalizeLifecycleArtifactPaths(somaHome: string, artifactPaths: string[]): string[] {
  const artifacts = Object.fromEntries(artifactPaths.map((artifactPath, index) => [`artifact${index + 1}`, artifactPath]));
  return Object.values(normalizeSomaWorkRegistryArtifacts({ somaHome }, artifacts));
}

/**
 * A substrate-registered SessionEnd transcript-digest handler. Dependency INVERSION:
 * core lifecycle owns this neutral hook point; a substrate adapter (e.g. claude-code)
 * registers its transcript→digest fallback, so core never imports an adapter. The
 * transcript FORMAT stays entirely inside the adapter.
 */
export type SessionEndTranscriptHandler = (input: {
  homeDir?: string;
  somaHome: string;
  now: Date;
  substrate: SubstrateId;
  sessionId: string;
  transcriptPath: string;
  subagentId?: string;
  subagentType?: string;
  forcePrimary?: boolean;
  forceSubagent?: boolean;
}) => Promise<{ outcome: string; path?: string }>;

const sessionEndTranscriptHandlers = new Map<SubstrateId, SessionEndTranscriptHandler>();

/** Register a substrate's SessionEnd transcript-digest fallback (see the type doc). */
export function registerSessionEndTranscriptHandler(substrate: SubstrateId, handler: SessionEndTranscriptHandler): void {
  sessionEndTranscriptHandlers.set(substrate, handler);
}

export async function runSomaLifecycleSessionEnd(options: SomaLifecycleOptions = {}): Promise<SomaLifecycleResult> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const index = await writeAlgorithmWorkIndex({ ...options, somaHome, timestamp });
  const learningFiles = await captureCompletedAlgorithmLearnings({ ...options, somaHome, timestamp });
  const activeForName = await loadActiveVsaForLifecycle(somaHome);
  const registryFiles = await writeSessionEndWorkRegistry({
    somaHome,
    options,
    active: activeForName,
    timestamp,
    algorithmWorkIndexPath: index.path,
    activeAlgorithmRunPath: index.activePath,
    learningFiles,
  });

  // #38 AC-4: If an active VSA is set, run checkCompleteness and emit a
  // warning event when tier gate is unmet. NEVER blocks session end.
  const active = await getActiveVsa({ somaHome });
  let tierGateNote = "";
  if (active?.activeSlug != null) {
    try {
      const report = await checkCompleteness(active.activeSlug, { somaHome });
      if (!report.passed) {
        await appendSomaMemoryEvent(somaHome, {
          substrate: substrate(options),
          kind: "lifecycle.tier-gate-unmet",
          summary: `Tier gate unmet for active VSA ${active.activeSlug} at ${report.tier}: ${report.gaps.length} gap(s).`,
          timestamp,
          metadata: {
            slug: active.activeSlug,
            tier: report.tier,
            gaps: report.gaps,
          },
        });
        tierGateNote = ` | tier-gate-unmet: ${active.activeSlug} (${report.gaps.length} gap(s))`;
      }
    } catch {
      // checkCompleteness can fail if the VSA file was removed; ignore
      // — session end stays non-blocking.
    }
  }

  // M5b deterministic digest FALLBACK — dependency-INVERTED so core stays
  // substrate-neutral. The transcript FORMAT is substrate-specific, so core does not
  // import any adapter; instead a substrate REGISTERS a handler (see
  // registerSessionEndTranscriptHandler) which core looks up by substrate here.
  // Best-effort: a thrown handler failure is swallowed so it never FAILS session end —
  // but the handler IS awaited, so its transcript read/parse/write latency is on the
  // session-end path (the dedup-before-read keeps the common no-op path cheap).
  let digestNote = "";
  let digestPath: string | undefined;
  const transcriptHandler = sessionEndTranscriptHandlers.get(substrate(options));
  if (options.transcriptPath && options.sessionId && transcriptHandler) {
    try {
      const fallback = await transcriptHandler({
        homeDir: options.homeDir,
        somaHome,
        now: new Date(timestamp),
        substrate: substrate(options),
        sessionId: options.sessionId,
        transcriptPath: options.transcriptPath,
        subagentId: options.subagentId,
        subagentType: options.subagentType,
        forcePrimary: process.env.SOMA_MEMORY_FORCE_PRIMARY === "1",
        forceSubagent: process.env.SOMA_MEMORY_FORCE_SUBAGENT === "1",
      });
      digestNote = ` | digest: ${fallback.outcome}`;
      digestPath = fallback.path; // so lifecycle reports the written digest file below
    } catch {
      // A fallback failure must never block session end.
    }
  }

  await appendSomaMemoryEvent(somaHome, {
    substrate: substrate(options),
    kind: "lifecycle.session_end",
    summary: `Session ended; captured ${learningFiles.length} Algorithm learning artifact(s).${tierGateNote}${digestNote}`,
    timestamp,
    artifactPaths: normalizeLifecycleArtifactPaths(somaHome, [index.path, index.activePath, ...learningFiles, ...registryFiles]),
    metadata: {
      sessionId: options.sessionId,
      substrate: substrate(options),
    },
  });

  const files = [index.path, index.activePath, ...learningFiles, ...registryFiles, join(somaHome, "memory/STATE/events.jsonl")];
  if (digestPath) files.push(digestPath); // the SessionEnd fallback digest, when written
  return {
    event: "session_end",
    somaHome,
    timestamp,
    files: Array.from(new Set(files)),
  };
}
