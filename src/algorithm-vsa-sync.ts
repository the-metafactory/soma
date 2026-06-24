/**
 * Algorithm ↔ VSA-file sync (the "hook bridge").
 *
 * Mirrors a PAI VSA markdown file into a soma Algorithm RUN so the run is
 * resumable on other substrates (codex, pi.dev) and its learning can be
 * promoted home. Designed to be called on EVERY VSA edit by the Claude Code
 * PostToolUse hook, so it is:
 *
 *   - IDEMPOTENT — a second call on an unchanged VSA is a fast no-op.
 *   - FAILURE-ISOLATED — a malformed / non-VSA / missing path is a no-op that
 *     resolves (never throws) so the hook is never broken.
 *
 * Identity model: soma `AlgorithmRun.isa` IS an `VerificationStateArtifact`, so a run
 * already embeds an VSA. The missing link is slug → runId continuity across
 * edits and substrates. We persist that mapping in a small durable index under
 * the soma STATE dir (`memory/STATE/vsa-run-index.json`). This is the simplest
 * durable approach and is substrate-agnostic (every host writes the same file).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  advanceAlgorithmRun,
  createAlgorithmRun,
  hasCurrentStateProbe,
  learnGateViolations,
  nextAlgorithmPhase,
  recordAlgorithmChange,
  recordAlgorithmLearning,
  recordAlgorithmObservation,
  setAlgorithmPlan,
  verifyAlgorithmCriterion,
} from "./algorithm";
import {
  registerSomaHomeAlgorithmCapabilities,
  selectAlgorithmCapability,
} from "./algorithm-capabilities";
import { readAlgorithmRunById, writeAlgorithmRun } from "./algorithm-store";
import { datePrefixSlug } from "./dated-slug";
import { getRunPhase } from "./algorithm-lifecycle";
import { parseVsa, serializeVsa } from "./vsa-parse";
import { getCriteria, getDecisions, getGoal, isClosedCriterion } from "./vsa-accessors";
import { promoteAlgorithmRunMemory } from "./memory-promotion";
import type {
  AlgorithmPhase,
  AlgorithmRun,
  VerificationStateArtifact,
  Checkpoint,
  SubstrateId,
} from "./types";

export interface SyncAlgorithmRunFromVsaOptions {
  /** Absolute path to the VSA markdown file. */
  vsaPath: string;
  /** Substrate id to tag the run + events with. */
  substrate: SubstrateId;
  homeDir?: string;
  somaHome?: string;
  /** When set and the VSA is complete, promote learning to the knowledge store. */
  promoteOnComplete?: boolean;
  timestamp?: string;
}

export interface SyncAlgorithmRunFromVsaResult {
  /** True when nothing actionable happened (malformed path, or unchanged VSA). */
  noop: boolean;
  /** True when a brand-new run was created for this slug. */
  created: boolean;
  slug: string | null;
  runId: string | null;
  phase: AlgorithmPhase | null;
  criteriaPassed: number;
  criteriaTotal: number;
  promoted: boolean;
  promotionPath: string | null;
}

const PHASE_ORDER: AlgorithmPhase[] = ["observe", "think", "plan", "build", "execute", "verify", "learn", "complete"];

/** Capability selectable in think/plan; used to satisfy the PLAN gate during sync. */
const SYNC_CAPABILITY = "sequential-analysis";

function resolveSomaHome(options: Pick<SyncAlgorithmRunFromVsaOptions, "homeDir" | "somaHome">): string {
  return resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

function indexPath(somaHome: string): string {
  return join(somaHome, "memory", "STATE", "vsa-run-index.json");
}

function noopResult(slug: string | null = null): SyncAlgorithmRunFromVsaResult {
  return {
    noop: true,
    created: false,
    slug,
    runId: null,
    phase: null,
    criteriaPassed: 0,
    criteriaTotal: 0,
    promoted: false,
    promotionPath: null,
  };
}

interface VsaRunIndex {
  bySlug: Record<string, string>;
}

function debugSyncFromVsa(message: string, error?: unknown): void {
  try {
    const detail = formatDebugError(error);
    const line = `[soma sync-from-isa] ${message}${detail ? `: ${detail}` : ""}`;
    process.stderr.write(`${line.slice(0, 300)}\n`);
  } catch (_err) {
    void _err;
    // Debug output must never compromise hook failure isolation.
  }
}

function formatDebugError(error: unknown): string {
  if (error === undefined) return "";
  if (error instanceof Error) {
    const errorWithCode: Error & { code?: unknown } = error;
    const code = typeof errorWithCode.code === "string" ? ` ${errorWithCode.code}` : "";
    return `${error.name}${code}: ${error.message}`.slice(0, 180);
  }
  if (typeof error === "string") return error.slice(0, 180);
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint" || typeof error === "symbol") {
    return String(error).slice(0, 180);
  }
  return "non-error thrown";
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

async function readIndex(somaHome: string): Promise<VsaRunIndex> {
  let raw: string;
  try {
    raw = await readFile(indexPath(somaHome), "utf8");
  } catch (error) {
    if (!isEnoent(error)) debugSyncFromVsa("could not read vsa-run-index.json; starting fresh", error);
    return { bySlug: {} };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "bySlug" in parsed) {
      const bySlug = parsed.bySlug;
      if (bySlug && typeof bySlug === "object" && !Array.isArray(bySlug)) {
        return { bySlug: bySlug as Record<string, string> };
      }
    }
    debugSyncFromVsa("ignored malformed vsa-run-index.json; expected bySlug object");
  } catch (error) {
    debugSyncFromVsa("ignored malformed vsa-run-index.json", error);
  }
  return { bySlug: {} };
}

async function writeIndexAtomic(somaHome: string, index: VsaRunIndex): Promise<void> {
  const path = indexPath(somaHome);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  // write-tmp + rename is atomic for a single writer. Concurrent syncs for
  // DIFFERENT slugs can still race (both read, both append, one rename wins) —
  // accepted within the fire-and-forget budget: a lost mapping self-heals,
  // since a missing slug entry is recreated on the next sync for that slug.
  await rename(tmp, path);
}

function phaseIndex(phase: AlgorithmPhase): number {
  // "abandoned" is terminal and not part of the linear advance order; map it
  // past the end so sync never tries to advance an abandoned run. Other unknown
  // phases fall back to 0 (harmless — nextAlgorithmPhase guards the advance loop).
  if (phase === "abandoned") return PHASE_ORDER.length;
  const idx = PHASE_ORDER.indexOf(phase);
  return idx === -1 ? 0 : idx;
}

/**
 * Cap the VSA's target phase to the furthest phase the gates can satisfy given
 * the current criteria state. The Algorithm refuses LEARN until every criterion
 * is passed/dropped, so we never try to advance past VERIFY when criteria are
 * still open — even if the VSA claims `learn`/`complete`.
 */
function reachableTargetPhase(target: AlgorithmPhase, criteria: readonly Checkpoint[]): AlgorithmPhase {
  // Mirror the LEARN integrity gate via the shared rule so the two cannot drift:
  // a `passed` criterion verified by specification only (e.g. a pass fabricated
  // from a frontmatter progress counter) cannot clear LEARN, so sync caps such a
  // run at VERIFY rather than attempt an advance the gate will reject.
  const { unresolved, hollow } = learnGateViolations(criteria);
  const learnReachable = criteria.length > 0 && unresolved.length === 0 && hollow.length === 0;
  // `complete` is never a sync target — we stop at `learn`. `complete` requires
  // a learning entry + invoked capabilities, which the LEARN handling provides;
  // but leaving the run at `learn` keeps it resumable rather than terminal.
  const capped = target === "complete" ? "learn" : target;
  if (!learnReachable && phaseIndex(capped) > phaseIndex("verify")) {
    return "verify";
  }
  return capped;
}

/**
 * Satisfy the gate guarding entry into `target` by mutating the run as the
 * Algorithm requires, then advance one phase. Synthetic artifacts are tagged so
 * they are recognizable as sync-generated.
 */
function prepareAndAdvance(run: AlgorithmRun, target: AlgorithmPhase, timestamp: string, substrate: SubstrateId): AlgorithmRun {
  let next = run;
  switch (target) {
    case "think":
      // Satisfy the OBSERVE current-state floor. An VSA being synced already
      // declares it advanced past OBSERVE, so we reconstruct that declared probe,
      // like the synthetic changelog/plan below. NOTE: AlgorithmObservation has no
      // structured "synthetic" flag — the sync origin lives only in the claim/
      // evidence prose, and hasCurrentStateProbe counts this reconstruction as a
      // real probe. That is the same caller-asserted boundary as every evidence
      // surface: sync reconstructs *declared* state, it does not re-probe reality.
      if (!hasCurrentStateProbe(next.observations)) {
        next = recordAlgorithmObservation(
          next,
          { claim: "synced from VSA observe phase", evidence: "reconstructed from VSA declared phase", evidenceKind: "probed" },
          timestamp,
          { substrate },
        );
      }
      break;
    case "plan":
      if (next.capabilities.length === 0) {
        // sequential-analysis is valid in think/plan; current phase is `think`.
        next = selectAlgorithmCapability(
          next,
          { name: SYNC_CAPABILITY, phase: "think", reason: "synced from VSA: ordered phase analysis" },
          timestamp,
        );
      }
      break;
    case "build":
      if (next.planSteps.length === 0) {
        const criteriaIds = getCriteria(next.vsa).map((c) => c.id);
        next = setAlgorithmPlan(
          next,
          [{ id: "sync-step", criteriaIds, text: "synced from VSA plan phase", status: "open" }],
          timestamp,
        );
      }
      break;
    case "execute":
      if (next.changelog.length === 0) {
        next = recordAlgorithmChange(next, "synced from VSA build phase", timestamp);
      }
      break;
    case "verify":
      next = {
        ...next,
        planSteps: next.planSteps.map((step) =>
          step.status === "open" ? { ...step, status: "done" as const, evidence: step.evidence ?? "synced from VSA" } : step,
        ),
      };
      break;
    default:
      break;
  }
  return advanceAlgorithmRun(next, timestamp, { substrate });
}

function advanceRunToPhase(run: AlgorithmRun, target: AlgorithmPhase, timestamp: string, substrate: SubstrateId): AlgorithmRun {
  let next = run;
  let guard = 0;
  while (phaseIndex(getRunPhase(next)) < phaseIndex(target) && guard < PHASE_ORDER.length) {
    const upcoming = nextAlgorithmPhase(getRunPhase(next));
    if (upcoming === undefined) return next;
    next = prepareAndAdvance(next, upcoming, timestamp, substrate);
    guard += 1;
  }
  return next;
}

function progressCompletedCount(progress: string, total: number): number | null {
  const match = /^(\d+)\/(\d+)$/.exec(progress.trim());
  if (!match) return null;
  const completed = Number.parseInt(match[1], 10);
  const denominator = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(denominator)) return null;
  if (denominator !== total || completed < 0 || completed > total) return null;
  return completed;
}

function frontmatterCompletionCount(isa: VerificationStateArtifact, vsaCriteria: readonly Checkpoint[]): number {
  const checked = vsaCriteria.filter(isClosedCriterion).length;
  const progress = progressCompletedCount(isa.frontmatter.progress, vsaCriteria.length) ?? 0;
  const phaseCompleted = phaseIndex(isa.frontmatter.phase) >= phaseIndex("learn") ? vsaCriteria.length : 0;
  return Math.max(checked, progress, phaseCompleted);
}

/** Mark run criteria passed for every completed VSA signal. Idempotent. */
function reconcileCriteria(
  run: AlgorithmRun,
  isa: VerificationStateArtifact,
  vsaCriteria: readonly Checkpoint[],
  timestamp: string,
  substrate: SubstrateId,
): AlgorithmRun {
  let next = run;
  const runCriteriaById = new Map(getCriteria(next.vsa).map((c) => [c.id, c]));
  for (const vsaCriterion of vsaCriteria) {
    if (!isClosedCriterion(vsaCriterion)) continue;
    const existing = runCriteriaById.get(vsaCriterion.id);
    if (existing === undefined) continue;
    // Idempotent only when BOTH status and the declared evidence kind already
    // match — otherwise an author upgrading `Evidence:` to `Evidence (specified):`
    // (to flag an already-passed criterion hollow) would never sync the kind.
    if (existing.status === vsaCriterion.status && existing.evidenceKind === vsaCriterion.evidenceKind) {
      continue;
    }
    const verification = vsaCriterion.verification?.trim();
    const evidence = verification && verification.length > 0 ? verification : `synced from VSA: ${vsaCriterion.text}`;
    // Preserve the markdown-declared evidence kind (`Evidence (probed): ...`).
    // That kind is CALLER-ASSERTED, like every surface: an VSA author can write
    // `Evidence (probed):` with no real probe and clear the gate. The gate does not
    // close that — it makes a hollow pass an explicit, auditable, declared claim
    // instead of the silent default. A bare `Evidence:` carries no kind and stays
    // grandfathered. Only the synthetic progress-counter pass below is forced to
    // `specified`, because nothing about it is even a claim of observation.
    next = verifyAlgorithmCriterion(
      next,
      vsaCriterion.id,
      vsaCriterion.status,
      evidence,
      timestamp,
      { substrate },
      vsaCriterion.evidenceKind,
    );
  }

  const targetCompleted = frontmatterCompletionCount(isa, vsaCriteria);
  let runCriteria = getCriteria(next.vsa);
  let completed = runCriteria.filter(isClosedCriterion).length;
  // Frontmatter progress is count-only; when it is partial, document order is
  // the only deterministic way to choose which unchecked criteria to catch up.
  for (const vsaCriterion of vsaCriteria) {
    if (completed >= targetCompleted) break;
    const existing = runCriteria.find((criterion) => criterion.id === vsaCriterion.id);
    if (existing === undefined || isClosedCriterion(existing)) continue;
    const goal = getGoal(isa);
    const evidence = goal ? `synced from VSA progress: ${goal}` : `synced from VSA progress: ${vsaCriterion.text}`;
    // A pass fabricated to match a frontmatter progress counter is specification
    // grade only — it must not clear the LEARN integrity gate as if probed.
    next = verifyAlgorithmCriterion(next, vsaCriterion.id, "passed", evidence, timestamp, { substrate }, "specified");
    runCriteria = getCriteria(next.vsa);
    completed = runCriteria.filter(isClosedCriterion).length;
  }

  return next;
}

function deriveLearningText(isa: VerificationStateArtifact): string {
  const decisions = getDecisions(isa);
  const lastDecision = decisions.at(-1)?.text;
  if (lastDecision) return `synced from VSA: ${lastDecision}`;
  const goal = getGoal(isa);
  return goal ? `synced from VSA goal: ${goal}` : "synced from VSA: completed";
}

function buildRunFromVsa(isa: VerificationStateArtifact, slug: string, substrate: SubstrateId, timestamp: string): AlgorithmRun {
  const goal = getGoal(isa) ?? slug;
  const criteria = getCriteria(isa);
  return createAlgorithmRun({
    id: slug,
    substrate,
    prompt: isa.frontmatter.task || goal,
    intent: isa.frontmatter.task || goal,
    currentState: `Synced from VSA at ${isa.sourcePath ?? slug}`,
    goal,
    effort: isa.frontmatter.effort,
    criteria: criteria.map((c) => ({ id: c.id, text: c.text, verification: c.verification })),
    timestamp,
  });
}

async function normalizeVsaSlugInPlace(
  isa: VerificationStateArtifact,
  slug: string,
  path: string,
): Promise<VerificationStateArtifact> {
  if (isa.slug === slug) return isa;
  const normalized: VerificationStateArtifact = {
    ...isa,
    slug,
    frontmatter: {
      ...isa.frontmatter,
      custom: {
        ...(isa.frontmatter.custom ?? {}),
        slug,
      },
    },
  };
  await writeFile(path, serializeVsa(normalized), "utf8");
  return normalized;
}

async function loadOrCreateRun(
  somaHome: string,
  slug: string,
  isa: VerificationStateArtifact,
  substrate: SubstrateId,
  timestamp: string,
): Promise<{ run: AlgorithmRun; created: boolean }> {
  const index = await readIndex(somaHome);
  const existingId = index.bySlug[slug];
  if (existingId) {
    try {
      const { run } = await readAlgorithmRunById(existingId, { somaHome });
      return { run, created: false };
    } catch {
      // Index points at a missing run — fall through and recreate.
    }
  }
  const created = await registerSomaHomeAlgorithmCapabilities(
    buildRunFromVsa(isa, slug, substrate, timestamp),
    { somaHome, substrate },
    timestamp,
  );
  index.bySlug[slug] = created.id;
  await writeIndexAtomic(somaHome, index);
  return { run: created, created: true };
}

/**
 * IDEMPOTENT, FAILURE-ISOLATED sync of one VSA file into a soma Algorithm run.
 * Never throws — a malformed/non-VSA/missing path resolves to a no-op result.
 */
export async function syncAlgorithmRunFromVsa(
  options: SyncAlgorithmRunFromVsaOptions,
): Promise<SyncAlgorithmRunFromVsaResult> {
  try {
    return await syncAlgorithmRunFromVsaInner(options);
  } catch {
    // Failure isolation: the hook must never break on a bad VSA.
    return noopResult();
  }
}

async function syncAlgorithmRunFromVsaInner(
  options: SyncAlgorithmRunFromVsaOptions,
): Promise<SyncAlgorithmRunFromVsaResult> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();

  let markdown: string;
  try {
    markdown = await readFile(options.vsaPath, "utf8");
  } catch {
    return noopResult();
  }

  const isa = parseVsa(markdown, options.vsaPath);
  const slug = datePrefixSlug(isa.slug, timestamp);
  const vsaCriteria = getCriteria(isa);
  // A real VSA has a frontmatter slug AND criteria. Reject non-VSA markdown.
  if (!isValidSlug(isa.slug) || vsaCriteria.length === 0 || getGoal(isa) === null) {
    return noopResult();
  }

  const normalizedVsa = await normalizeVsaSlugInPlace(isa, slug, options.vsaPath);
  const { run: baseRun, created } = await loadOrCreateRun(somaHome, slug, normalizedVsa, options.substrate, timestamp);

  let run = baseRun;
  const before = snapshot(run);

  // 1. Reconcile checked criteria FIRST. The LEARN gate refuses entry until
  //    every criterion is passed/dropped, so criteria state must be current
  //    before we attempt to advance the phase.
  run = reconcileCriteria(run, isa, vsaCriteria, timestamp, options.substrate);
  const reconciledCriteria = getCriteria(run.vsa);

  // 2. Advance forward to (a reachable cap of) the VSA's declared phase. Never backward.
  const targetPhase = reachableTargetPhase(isa.frontmatter.phase, reconciledCriteria);
  if (phaseIndex(getRunPhase(run)) < phaseIndex(targetPhase)) {
    run = advanceRunToPhase(run, targetPhase, timestamp, options.substrate);
  }

  // 3. If at learn (or all criteria closed), record a learn entry. Idempotent.
  const allClosed = getCriteria(run.vsa).every(isClosedCriterion);
  const atLearn = getRunPhase(run) === "learn" || getRunPhase(run) === "complete";
  if ((atLearn || allClosed) && run.learning.length === 0) {
    run = recordAlgorithmLearning(run, deriveLearningText(isa), timestamp, { substrate: options.substrate });
  }

  const after = snapshot(run);
  const changed = created || before !== after;

  if (changed) {
    await writeAlgorithmRun(run, { somaHome });
  }

  // 4. Optional promote-on-complete.
  let promoted = false;
  let promotionPath: string | null = null;
  if (options.promoteOnComplete === true && (allClosed || atLearn) && run.learning.length > 0) {
    try {
      const result = await promoteAlgorithmRunMemory({
        somaHome,
        fromRun: run.id,
        store: "knowledge",
        title: getGoal(isa) ?? slug,
        substrate: options.substrate,
        timestamp,
      });
      promoted = true;
      promotionPath = result.path;
    } catch {
      // Promotion is best-effort (e.g. already-promoted EEXIST); never break sync.
    }
  }

  const finalCriteria = getCriteria(run.vsa);
  return {
    noop: !changed && !promoted,
    created,
    slug,
    runId: run.id,
    phase: getRunPhase(run),
    criteriaPassed: finalCriteria.filter((c) => c.status === "passed").length,
    criteriaTotal: finalCriteria.length,
    promoted,
    promotionPath,
  };
}

function snapshot(run: AlgorithmRun): string {
  // Exclude updatedAt (touched by every spread) so identical content compares equal.
  const { updatedAt: _updatedAt, ...rest } = run;
  void _updatedAt;
  return JSON.stringify(rest);
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export function formatSyncResult(result: SyncAlgorithmRunFromVsaResult): string {
  if (result.runId === null) {
    return ["Soma Algorithm sync-from-isa", "result: no-op (not an VSA file)"].join("\n");
  }
  return [
    "Soma Algorithm sync-from-isa",
    `slug: ${result.slug}`,
    `runId: ${result.runId}`,
    `phase: ${result.phase}`,
    `criteria: ${result.criteriaPassed}/${result.criteriaTotal} passed`,
    `state: ${result.created ? "created" : result.noop ? "no-op (unchanged)" : "resumed"}`,
    `promoted: ${result.promoted ? (result.promotionPath ?? "yes") : "no"}`,
  ].join("\n");
}
