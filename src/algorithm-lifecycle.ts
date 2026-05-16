import type { AlgorithmPhase, AlgorithmRun } from "./types";

/**
 * Phase accessor — `AlgorithmRun.phase` was removed in #41.
 * `run.isa.frontmatter.phase` is the only source of truth.
 */
export function getRunPhase(run: AlgorithmRun): AlgorithmPhase {
  return run.isa.frontmatter.phase;
}

/**
 * Pure terminal phase transition — sets phase to `complete`.
 *
 * This helper does NOT touch active.json, NOT emit lifecycle events, NOT
 * persist to disk. It is a pure function over an in-memory `AlgorithmRun`.
 *
 * The end-of-run service (active.json clearing, `algorithm.completed`
 * event emission, persistence) will live in `algorithm-lifecycle-service.ts`
 * shipped by #32+#34 — a separate API that accepts the store/event-emitter
 * context as constructor arguments. That service composes this pure helper
 * with the IO side effects, so the public surface for IO is added at the
 * service boundary, not retrofitted onto this pure function.
 */
export function completeAlgorithmRun(run: AlgorithmRun, timestamp = new Date().toISOString()): AlgorithmRun {
  return setRunPhase(run, "complete", timestamp);
}

/**
 * Pure terminal phase transition — sets phase to `abandoned` and records
 * the reason in the run's `decisions` log so the abandonment is auditable.
 *
 * Mirror of `completeAlgorithmRun` — no IO, no events, no store dependency.
 * The IO composition lives in the end-of-run service (see above).
 */
export function abandonAlgorithmRun(run: AlgorithmRun, reason: string, timestamp = new Date().toISOString()): AlgorithmRun {
  if (reason.trim().length === 0) {
    throw new Error("abandonAlgorithmRun reason must not be empty.");
  }
  const abandoned = setRunPhase(run, "abandoned", timestamp);
  return {
    ...abandoned,
    decisions: [
      ...abandoned.decisions,
      { timestamp, phase: "abandoned", text: `Abandoned: ${reason}` },
    ],
  };
}

function setRunPhase(run: AlgorithmRun, phase: AlgorithmPhase, timestamp: string): AlgorithmRun {
  return {
    ...run,
    updatedAt: timestamp,
    isa: {
      ...run.isa,
      frontmatter: { ...run.isa.frontmatter, phase, updated: timestamp },
    },
  };
}
