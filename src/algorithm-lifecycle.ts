import type { AlgorithmPhase, AlgorithmRun } from "./types";

/**
 * Phase accessor — `AlgorithmRun.phase` was removed in #41.
 * `run.isa.frontmatter.phase` is the only source of truth.
 */
export function getRunPhase(run: AlgorithmRun): AlgorithmPhase {
  return run.isa.frontmatter.phase;
}

/**
 * Terminal transition — completes the run.
 *
 * Composes phase advancement to `complete` plus side effects that belong to
 * end-of-run (active.json clearing, completion event emission). Until #32+#34
 * land, the active.json clearing is a no-op stub — callers wanting just the
 * pure phase transition continue to use `advanceAlgorithmRun`.
 */
export function completeAlgorithmRun(run: AlgorithmRun, timestamp = new Date().toISOString()): AlgorithmRun {
  return setRunPhase(run, "complete", timestamp);
}

/**
 * Terminal transition — abandons the run with a reason.
 *
 * Mirror of `completeAlgorithmRun`. Records the reason in the run's
 * `decisions` log so the abandonment is auditable.
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
