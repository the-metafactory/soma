import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listAlgorithmRunSummaries, listAlgorithmRuns } from "./algorithm-store";
import { appendSomaMemoryEvent } from "./memory";
import { loadSomaHome } from "./soma-home";
import { getCriteria, getGoal } from "./isa-accessors";
import { getRunPhase } from "./algorithm-lifecycle";
import {
  checkCompleteness,
  getActiveIsa,
  readIsa,
  recordIsaChangelog,
  recordIsaDecision,
  recordIsaVerification,
} from "./isa";
import type {
  AlgorithmRun,
  AlgorithmRunSummary,
  AlgorithmWorkIndex,
  IdealStateArtifact,
  IsaUpdatePayload,
  SomaLifecycleOptions,
  SomaLifecycleResult,
  SomaStartupContext,
  SubstrateId,
} from "./types";

function resolveSomaHome(options: SomaLifecycleOptions = {}): string {
  const home = resolve(options.homeDir ?? homedir());
  return resolve(options.somaHome ?? join(home, ".soma"));
}

function substrate(options: SomaLifecycleOptions): SubstrateId {
  return options.substrate ?? "custom";
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
  const profile = await loadSomaHome(somaHome);
  const summaries = await listAlgorithmRunSummaries({ somaHome });
  const activeRuns = summaries.filter((run) => run.phase !== "complete").slice(0, 8);
  const recentLearnings = await readRecentMarkdown(join(somaHome, "memory/LEARNING"), 8);
  const relationshipNotes = await readRecentMarkdown(join(somaHome, "memory/RELATIONSHIP"), 8);
  const context = renderStartupContext({
    assistantName: profile.profile.assistant.displayName ?? profile.profile.assistant.name,
    principalName: profile.profile.principal.preferredName ?? profile.profile.principal.name,
    mission: profile.profile.telos.mission,
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
    `Goal: ${getGoal(run.isa) ?? ""}`,
    `Effort: ${run.effort}`,
    "",
    "## Criteria",
    ...getCriteria(run.isa).map((criterion) => `- [${criterion.status === "passed" ? "x" : " "}] ${criterion.id}: ${criterion.text}`),
    "",
    "## Verification",
    ...(run.verification.length > 0 ? run.verification.map((entry) => `- ${entry.timestamp} ${entry.text}`) : ["No verification entries recorded."]),
    "",
    "## Learning",
    ...(run.learning.length > 0 ? run.learning.map((entry) => `- ${entry.timestamp} ${entry.text}`) : ["No learning entries recorded."]),
  ].join("\n");
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

async function loadActiveIsaForLifecycle(somaHome: string): Promise<{ slug: string; isa: IdealStateArtifact } | null> {
  const state = await getActiveIsa({ somaHome });
  if (state?.activeSlug == null) return null;
  try {
    const isa = await readIsa(state.activeSlug, { somaHome });
    return { slug: state.activeSlug, isa };
  } catch {
    // Active state points at a missing/unreadable ISA — treat as no
    // active ISA. Caller's events.jsonl will pick up an isa.missing
    // warning if we choose to emit one; for now lifecycle stays silent
    // and non-blocking per #38 spec ("never halt").
    return null;
  }
}

export async function runSomaLifecycleSessionStart(options: SomaLifecycleOptions = {}): Promise<SomaLifecycleResult> {
  const startup = await buildSomaStartupContext(options);
  const active = await loadActiveIsaForLifecycle(startup.somaHome);
  const activeNote = active === null ? "" : ` | active ISA: ${active.slug} (${active.isa.frontmatter.phase})`;
  await appendSomaMemoryEvent(startup.somaHome, {
    substrate: startup.substrate,
    kind: "lifecycle.session_start",
    summary: `Session started${startup.sessionId ? `: ${startup.sessionId}` : ""}${activeNote}`,
    timestamp: startup.timestamp,
    metadata: {
      sessionId: startup.sessionId,
      activeRuns: startup.activeRuns.map((run) => run.id),
      activeIsaSlug: active?.slug ?? null,
    },
  });

  return {
    event: "session_start",
    somaHome: startup.somaHome,
    timestamp: startup.timestamp,
    files: [join(startup.somaHome, "memory/STATE/events.jsonl")],
    context: startup.context,
    activeIsa: active === null ? null : { slug: active.slug, phase: active.isa.frontmatter.phase },
  };
}

/**
 * Append decisions / changelog / verification entries to the active
 * ISA (or the explicit slug in the payload). Pure file-backed writes
 * through the library's record* helpers; no prompt-driven mutation.
 * No-op when no active ISA is set AND no slug in payload — Layer 7
 * never halts session work for a missing ISA.
 */
export async function runSomaLifecycleIsaUpdated(
  payload: IsaUpdatePayload,
  options: SomaLifecycleOptions = {},
): Promise<SomaLifecycleResult> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const slug = payload.slug ?? (await getActiveIsa({ somaHome }))?.activeSlug ?? null;
  if (slug === null) {
    await appendSomaMemoryEvent(somaHome, {
      substrate: substrate(options),
      kind: "lifecycle.isa_updated.no_active",
      summary: "isa_updated event received but no active ISA set; no writes made.",
      timestamp,
    });
    return {
      event: "isa_updated",
      somaHome,
      timestamp,
      files: [join(somaHome, "memory/STATE/events.jsonl")],
      writes: [],
    };
  }

  const writes: string[] = [];
  for (const entry of payload.decisions ?? []) {
    const r = await recordIsaDecision(slug, entry.text, {
      somaHome,
      phase: entry.phase,
      timestamp: entry.timestamp ?? timestamp,
    });
    writes.push(r.path);
  }
  for (const entry of payload.changelogEntries ?? []) {
    const r = await recordIsaChangelog(slug, entry.text, {
      somaHome,
      phase: entry.phase,
      timestamp: entry.timestamp ?? timestamp,
    });
    writes.push(r.path);
  }
  for (const entry of payload.verificationEntries ?? []) {
    const r = await recordIsaVerification(slug, entry.text, {
      somaHome,
      phase: entry.phase,
      timestamp: entry.timestamp ?? timestamp,
    });
    writes.push(r.path);
  }
  await appendSomaMemoryEvent(somaHome, {
    substrate: substrate(options),
    kind: "lifecycle.isa_updated",
    summary: `Appended ${(payload.decisions?.length ?? 0) + (payload.changelogEntries?.length ?? 0) + (payload.verificationEntries?.length ?? 0)} entr(ies) to ISA ${slug}.`,
    timestamp,
    metadata: { slug },
    artifactPaths: Array.from(new Set(writes)),
  });
  return {
    event: "isa_updated",
    somaHome,
    timestamp,
    files: Array.from(new Set([...writes, join(somaHome, "memory/STATE/events.jsonl")])),
    writes,
  };
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

export async function runSomaLifecycleSessionEnd(options: SomaLifecycleOptions = {}): Promise<SomaLifecycleResult> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const index = await writeAlgorithmWorkIndex({ ...options, somaHome, timestamp });
  const learningFiles = await captureCompletedAlgorithmLearnings({ ...options, somaHome, timestamp });

  // #38 AC-4: If an active ISA is set, run checkCompleteness and emit a
  // warning event when tier gate is unmet. NEVER blocks session end.
  const active = await getActiveIsa({ somaHome });
  let tierGateNote = "";
  if (active?.activeSlug != null) {
    try {
      const report = await checkCompleteness(active.activeSlug, { somaHome });
      if (!report.passed) {
        await appendSomaMemoryEvent(somaHome, {
          substrate: substrate(options),
          kind: "lifecycle.tier-gate-unmet",
          summary: `Tier gate unmet for active ISA ${active.activeSlug} at ${report.tier}: ${report.gaps.length} gap(s).`,
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
      // checkCompleteness can fail if the ISA file was removed; ignore
      // — session end stays non-blocking.
    }
  }

  await appendSomaMemoryEvent(somaHome, {
    substrate: substrate(options),
    kind: "lifecycle.session_end",
    summary: `Session ended; captured ${learningFiles.length} Algorithm learning artifact(s).${tierGateNote}`,
    timestamp,
    artifactPaths: [index.path, index.activePath, ...learningFiles],
    metadata: {
      sessionId: options.sessionId,
    },
  });

  return {
    event: "session_end",
    somaHome,
    timestamp,
    files: [index.path, index.activePath, ...learningFiles, join(somaHome, "memory/STATE/events.jsonl")],
  };
}
