/**
 * Algorithm ↔ ISA-file sync (the "hook bridge").
 *
 * Mirrors a PAI ISA markdown file into a soma Algorithm RUN so the run is
 * resumable on other substrates (codex, pi.dev) and its learning can be
 * promoted home. Designed to be called on EVERY ISA edit by the Claude Code
 * PostToolUse hook, so it is:
 *
 *   - IDEMPOTENT — a second call on an unchanged ISA is a fast no-op.
 *   - FAILURE-ISOLATED — a malformed / non-ISA / missing path is a no-op that
 *     resolves (never throws) so the hook is never broken.
 *
 * Identity model: soma `AlgorithmRun.isa` IS an `IdealStateArtifact`, so a run
 * already embeds an ISA. The missing link is slug → runId continuity across
 * edits and substrates. We persist that mapping in a small durable index under
 * the soma STATE dir (`memory/STATE/isa-run-index.json`). This is the simplest
 * durable approach and is substrate-agnostic (every host writes the same file).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  advanceAlgorithmRun,
  createAlgorithmRun,
  nextAlgorithmPhase,
  recordAlgorithmChange,
  recordAlgorithmLearning,
  setAlgorithmPlan,
  verifyAlgorithmCriterion,
} from "./algorithm";
import {
  registerSomaHomeAlgorithmCapabilities,
  selectAlgorithmCapability,
} from "./algorithm-capabilities";
import { readAlgorithmRunById, writeAlgorithmRun } from "./algorithm-store";
import { getRunPhase } from "./algorithm-lifecycle";
import { parseIsa } from "./isa-parse";
import { getCriteria, getDecisions, getGoal } from "./isa-accessors";
import { promoteAlgorithmRunMemory } from "./memory-promotion";
import type {
  AlgorithmPhase,
  AlgorithmRun,
  IdealStateArtifact,
  IdealStateCriterion,
  SubstrateId,
} from "./types";

export interface SyncAlgorithmRunFromIsaOptions {
  /** Absolute path to the ISA markdown file. */
  isaPath: string;
  /** Substrate id to tag the run + events with. */
  substrate: SubstrateId;
  homeDir?: string;
  somaHome?: string;
  /** When set and the ISA is complete, promote learning to the knowledge store. */
  promoteOnComplete?: boolean;
  timestamp?: string;
}

export interface SyncAlgorithmRunFromIsaResult {
  /** True when nothing actionable happened (malformed path, or unchanged ISA). */
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

function resolveSomaHome(options: Pick<SyncAlgorithmRunFromIsaOptions, "homeDir" | "somaHome">): string {
  return resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

function indexPath(somaHome: string): string {
  return join(somaHome, "memory", "STATE", "isa-run-index.json");
}

function noopResult(slug: string | null = null): SyncAlgorithmRunFromIsaResult {
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

interface IsaRunIndex {
  bySlug: Record<string, string>;
}

function debugSyncFromIsa(message: string, error?: unknown): void {
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

async function readIndex(somaHome: string): Promise<IsaRunIndex> {
  let raw: string;
  try {
    raw = await readFile(indexPath(somaHome), "utf8");
  } catch (error) {
    if (!isEnoent(error)) debugSyncFromIsa("could not read isa-run-index.json; starting fresh", error);
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
    debugSyncFromIsa("ignored malformed isa-run-index.json; expected bySlug object");
  } catch (error) {
    debugSyncFromIsa("ignored malformed isa-run-index.json", error);
  }
  return { bySlug: {} };
}

async function writeIndexAtomic(somaHome: string, index: IsaRunIndex): Promise<void> {
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
 * Cap the ISA's target phase to the furthest phase the gates can satisfy given
 * the current criteria state. The Algorithm refuses LEARN until every criterion
 * is passed/dropped, so we never try to advance past VERIFY when criteria are
 * still open — even if the ISA claims `learn`/`complete`.
 */
function reachableTargetPhase(target: AlgorithmPhase, criteria: readonly IdealStateCriterion[]): AlgorithmPhase {
  const allClosed = criteria.length > 0 && criteria.every((c) => c.status === "passed" || c.status === "dropped");
  // `complete` is never a sync target — we stop at `learn`. `complete` requires
  // a learning entry + invoked capabilities, which the LEARN handling provides;
  // but leaving the run at `learn` keeps it resumable rather than terminal.
  const capped = target === "complete" ? "learn" : target;
  if (!allClosed && phaseIndex(capped) > phaseIndex("verify")) {
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
    case "plan":
      if (next.capabilities.length === 0) {
        // sequential-analysis is valid in think/plan; current phase is `think`.
        next = selectAlgorithmCapability(
          next,
          { name: SYNC_CAPABILITY, phase: "think", reason: "synced from ISA: ordered phase analysis" },
          timestamp,
        );
      }
      break;
    case "build":
      if (next.planSteps.length === 0) {
        const criteriaIds = getCriteria(next.isa).map((c) => c.id);
        next = setAlgorithmPlan(
          next,
          [{ id: "sync-step", criteriaIds, text: "synced from ISA plan phase", status: "open" }],
          timestamp,
        );
      }
      break;
    case "execute":
      if (next.changelog.length === 0) {
        next = recordAlgorithmChange(next, "synced from ISA build phase", timestamp);
      }
      break;
    case "verify":
      next = {
        ...next,
        planSteps: next.planSteps.map((step) =>
          step.status === "open" ? { ...step, status: "done" as const, evidence: step.evidence ?? "synced from ISA" } : step,
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

function isClosedCriterion(
  criterion: IdealStateCriterion,
): criterion is IdealStateCriterion & { status: "passed" | "dropped" } {
  return criterion.status === "passed" || criterion.status === "dropped";
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

function frontmatterCompletionCount(isa: IdealStateArtifact, isaCriteria: readonly IdealStateCriterion[]): number {
  const checked = isaCriteria.filter(isClosedCriterion).length;
  const progress = progressCompletedCount(isa.frontmatter.progress, isaCriteria.length) ?? 0;
  const phaseCompleted = phaseIndex(isa.frontmatter.phase) >= phaseIndex("learn") ? isaCriteria.length : 0;
  return Math.max(checked, progress, phaseCompleted);
}

/** Mark run criteria passed for every completed ISA signal. Idempotent. */
function reconcileCriteria(
  run: AlgorithmRun,
  isa: IdealStateArtifact,
  isaCriteria: readonly IdealStateCriterion[],
  timestamp: string,
  substrate: SubstrateId,
): AlgorithmRun {
  let next = run;
  const runCriteriaById = new Map(getCriteria(next.isa).map((c) => [c.id, c]));
  for (const isaCriterion of isaCriteria) {
    if (!isClosedCriterion(isaCriterion)) continue;
    const existing = runCriteriaById.get(isaCriterion.id);
    if (existing === undefined) continue;
    if (existing.status === isaCriterion.status) continue; // already reconciled — idempotent
    const verification = isaCriterion.verification?.trim();
    const evidence = verification && verification.length > 0 ? verification : `synced from ISA: ${isaCriterion.text}`;
    next = verifyAlgorithmCriterion(next, isaCriterion.id, isaCriterion.status, evidence, timestamp, { substrate });
  }

  const targetCompleted = frontmatterCompletionCount(isa, isaCriteria);
  let runCriteria = getCriteria(next.isa);
  let completed = runCriteria.filter(isClosedCriterion).length;
  // Frontmatter progress is count-only; when it is partial, document order is
  // the only deterministic way to choose which unchecked criteria to catch up.
  for (const isaCriterion of isaCriteria) {
    if (completed >= targetCompleted) break;
    const existing = runCriteria.find((criterion) => criterion.id === isaCriterion.id);
    if (existing === undefined || isClosedCriterion(existing)) continue;
    const goal = getGoal(isa);
    const evidence = goal ? `synced from ISA progress: ${goal}` : `synced from ISA progress: ${isaCriterion.text}`;
    next = verifyAlgorithmCriterion(next, isaCriterion.id, "passed", evidence, timestamp, { substrate });
    runCriteria = getCriteria(next.isa);
    completed = runCriteria.filter(isClosedCriterion).length;
  }

  return next;
}

function deriveLearningText(isa: IdealStateArtifact): string {
  const decisions = getDecisions(isa);
  const lastDecision = decisions.at(-1)?.text;
  if (lastDecision) return `synced from ISA: ${lastDecision}`;
  const goal = getGoal(isa);
  return goal ? `synced from ISA goal: ${goal}` : "synced from ISA: completed";
}

function buildRunFromIsa(isa: IdealStateArtifact, slug: string, substrate: SubstrateId, timestamp: string): AlgorithmRun {
  const goal = getGoal(isa) ?? slug;
  const criteria = getCriteria(isa);
  return createAlgorithmRun({
    id: slug,
    substrate,
    prompt: isa.frontmatter.task || goal,
    intent: isa.frontmatter.task || goal,
    currentState: `Synced from ISA at ${isa.sourcePath ?? slug}`,
    goal,
    effort: isa.frontmatter.effort,
    criteria: criteria.map((c) => ({ id: c.id, text: c.text, verification: c.verification })),
    timestamp,
  });
}

async function loadOrCreateRun(
  somaHome: string,
  slug: string,
  isa: IdealStateArtifact,
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
    buildRunFromIsa(isa, slug, substrate, timestamp),
    { somaHome, substrate },
    timestamp,
  );
  index.bySlug[slug] = created.id;
  await writeIndexAtomic(somaHome, index);
  return { run: created, created: true };
}

/**
 * IDEMPOTENT, FAILURE-ISOLATED sync of one ISA file into a soma Algorithm run.
 * Never throws — a malformed/non-ISA/missing path resolves to a no-op result.
 */
export async function syncAlgorithmRunFromIsa(
  options: SyncAlgorithmRunFromIsaOptions,
): Promise<SyncAlgorithmRunFromIsaResult> {
  try {
    return await syncAlgorithmRunFromIsaInner(options);
  } catch {
    // Failure isolation: the hook must never break on a bad ISA.
    return noopResult();
  }
}

async function syncAlgorithmRunFromIsaInner(
  options: SyncAlgorithmRunFromIsaOptions,
): Promise<SyncAlgorithmRunFromIsaResult> {
  const somaHome = resolveSomaHome(options);
  const timestamp = options.timestamp ?? new Date().toISOString();

  let markdown: string;
  try {
    markdown = await readFile(options.isaPath, "utf8");
  } catch {
    return noopResult();
  }

  const isa = parseIsa(markdown, options.isaPath);
  const slug = isa.slug;
  const isaCriteria = getCriteria(isa);
  // A real ISA has a frontmatter slug AND criteria. Reject non-ISA markdown.
  if (!isValidSlug(slug) || isaCriteria.length === 0 || getGoal(isa) === null) {
    return noopResult();
  }

  const { run: baseRun, created } = await loadOrCreateRun(somaHome, slug, isa, options.substrate, timestamp);

  let run = baseRun;
  const before = snapshot(run);

  // 1. Reconcile checked criteria FIRST. The LEARN gate refuses entry until
  //    every criterion is passed/dropped, so criteria state must be current
  //    before we attempt to advance the phase.
  run = reconcileCriteria(run, isa, isaCriteria, timestamp, options.substrate);
  const reconciledCriteria = getCriteria(run.isa);

  // 2. Advance forward to (a reachable cap of) the ISA's declared phase. Never backward.
  const targetPhase = reachableTargetPhase(isa.frontmatter.phase, reconciledCriteria);
  if (phaseIndex(getRunPhase(run)) < phaseIndex(targetPhase)) {
    run = advanceRunToPhase(run, targetPhase, timestamp, options.substrate);
  }

  // 3. If at learn (or all criteria closed), record a learn entry. Idempotent.
  const allClosed = getCriteria(run.isa).every(isClosedCriterion);
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

  const finalCriteria = getCriteria(run.isa);
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

export function formatSyncResult(result: SyncAlgorithmRunFromIsaResult): string {
  if (result.runId === null) {
    return ["Soma Algorithm sync-from-isa", "result: no-op (not an ISA file)"].join("\n");
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
