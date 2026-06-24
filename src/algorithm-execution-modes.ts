import type {
  AlgorithmCriteriaPartition,
  AlgorithmLoopIterationResult,
  AlgorithmLoopState,
  AlgorithmNotificationEvent,
  AlgorithmPhase,
  AlgorithmRun,
  Checkpoint,
  IdeateParameters,
  IdeatePresetName,
  OptimizeParameters,
  OptimizePresetName,
} from "./types";
import { getCriteria } from "./vsa-accessors";

export const DEFAULT_ALGORITHM_LOOP_STATE: AlgorithmLoopState = {
  status: "paused",
  iterationCount: 0,
  plateauCounter: 0,
  iterations: [],
};

export const DEFAULT_ALGORITHM_LOOP_ITERATION_HISTORY_LIMIT = 200;

export const IDEATE_PRESETS: Record<IdeatePresetName, IdeateParameters> = {
  dream: {
    problemConnection: 0.1,
    selectionPressure: 0.1,
    domainDiversity: 0.95,
    phaseBalance: 0.35,
    ideaVolume: 80,
    mutationRate: 0.8,
    generativeTemperature: 0.95,
    maxCycles: 5,
    contextCarryover: false,
    parallelAgents: 6,
  },
  explore: {
    problemConnection: 0.3,
    selectionPressure: 0.25,
    domainDiversity: 0.8,
    phaseBalance: 0.45,
    ideaVolume: 50,
    mutationRate: 0.6,
    generativeTemperature: 0.8,
    maxCycles: 4,
    contextCarryover: true,
    parallelAgents: 4,
  },
  balanced: {
    problemConnection: 0.5,
    selectionPressure: 0.5,
    domainDiversity: 0.6,
    phaseBalance: 0.5,
    ideaVolume: 32,
    mutationRate: 0.4,
    generativeTemperature: 0.65,
    maxCycles: 3,
    contextCarryover: true,
    parallelAgents: 3,
  },
  directed: {
    problemConnection: 0.7,
    selectionPressure: 0.75,
    domainDiversity: 0.35,
    phaseBalance: 0.65,
    ideaVolume: 18,
    mutationRate: 0.2,
    generativeTemperature: 0.45,
    maxCycles: 2,
    contextCarryover: true,
    parallelAgents: 2,
  },
  surgical: {
    problemConnection: 0.9,
    selectionPressure: 0.9,
    domainDiversity: 0.15,
    phaseBalance: 0.8,
    ideaVolume: 8,
    mutationRate: 0.08,
    generativeTemperature: 0.25,
    maxCycles: 1,
    contextCarryover: true,
    parallelAgents: 1,
  },
};

export const OPTIMIZE_PRESETS: Record<OptimizePresetName, OptimizeParameters> = {
  cautious: {
    stepSize: 0.1,
    regressionTolerance: 0.01,
    earlyStopPatience: 5,
    maxIterations: 24,
  },
  "standard-optimize": {
    stepSize: 0.25,
    regressionTolerance: 0.03,
    earlyStopPatience: 3,
    maxIterations: 48,
  },
  aggressive: {
    stepSize: 0.5,
    regressionTolerance: 0.08,
    earlyStopPatience: 2,
    maxIterations: 96,
  },
};

function assertUnitInterval(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1.`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
}

export function validateIdeateParameters(parameters: IdeateParameters): IdeateParameters {
  assertUnitInterval(parameters.problemConnection, "problemConnection");
  assertUnitInterval(parameters.selectionPressure, "selectionPressure");
  assertUnitInterval(parameters.domainDiversity, "domainDiversity");
  assertUnitInterval(parameters.phaseBalance, "phaseBalance");
  assertUnitInterval(parameters.mutationRate, "mutationRate");
  assertUnitInterval(parameters.generativeTemperature, "generativeTemperature");
  assertPositiveInteger(parameters.ideaVolume, "ideaVolume");
  assertPositiveInteger(parameters.maxCycles, "maxCycles");
  assertPositiveInteger(parameters.parallelAgents, "parallelAgents");
  if (typeof parameters.contextCarryover !== "boolean") {
    throw new Error("contextCarryover must be a boolean.");
  }
  return parameters;
}

export function validateOptimizeParameters(parameters: OptimizeParameters): OptimizeParameters {
  assertUnitInterval(parameters.stepSize, "stepSize");
  assertUnitInterval(parameters.regressionTolerance, "regressionTolerance");
  assertPositiveInteger(parameters.earlyStopPatience, "earlyStopPatience");
  assertPositiveInteger(parameters.maxIterations, "maxIterations");
  return parameters;
}

export function detectPlateau(run: Pick<AlgorithmRun, "loop">, threshold = 3): boolean {
  assertPositiveInteger(threshold, "threshold");
  if (run.loop.plateauCounter >= threshold) return true;
  const recent = run.loop.iterations.slice(-threshold);
  return recent.length === threshold && recent.every((iteration) => iteration.progressBefore === iteration.progressAfter);
}

export function recordAlgorithmLoopIterationResult(
  result: AlgorithmLoopIterationResult,
  timestamp = new Date().toISOString(),
  maxRecordedIterations = DEFAULT_ALGORITHM_LOOP_ITERATION_HISTORY_LIMIT,
): AlgorithmRun {
  assertPositiveInteger(maxRecordedIterations, "maxRecordedIterations");
  const iteration = result.run.loop.iterationCount + 1;
  const madeProgress = result.progressBefore !== result.progressAfter;
  const loopIteration = {
    iteration,
    timestamp,
    progressBefore: result.progressBefore,
    progressAfter: result.progressAfter,
    ...(result.summary !== undefined ? { summary: result.summary } : {}),
  };
  const retainedIterations =
    maxRecordedIterations === 1 ? [] : result.run.loop.iterations.slice(-(maxRecordedIterations - 1));

  return {
    ...result.run,
    updatedAt: timestamp,
    loop: {
      ...result.run.loop,
      iterationCount: iteration,
      plateauCounter: madeProgress ? 0 : result.run.loop.plateauCounter + 1,
      iterations: [...retainedIterations, loopIteration],
    },
  };
}

function domainFromCriterionId(id: string): string {
  const match = /^(?:ISC|C)-([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(id);
  return match ? match[1].toLowerCase() : "general";
}

export function partitionCriteriaByDomain(
  criteria: readonly Checkpoint[],
  maxPartitions?: number,
): AlgorithmCriteriaPartition[] {
  if (maxPartitions !== undefined) assertPositiveInteger(maxPartitions, "maxPartitions");
  const grouped = new Map<string, Checkpoint[]>();
  for (const criterion of criteria) {
    const domain = domainFromCriterionId(criterion.id);
    const group = grouped.get(domain);
    if (group) group.push(criterion);
    else grouped.set(domain, [criterion]);
  }

  const domainPartitions = Array.from(grouped.entries())
    .map(([domain, group]) => ({ id: domain, domain, criteria: group }))
    .sort((a, b) => b.criteria.length - a.criteria.length || a.domain.localeCompare(b.domain));

  if (maxPartitions === undefined || domainPartitions.length <= maxPartitions) return domainPartitions;

  const partitions: AlgorithmCriteriaPartition[] = Array.from({ length: maxPartitions }, (_, index) => ({
    id: `partition-${index + 1}`,
    domain: `partition-${index + 1}`,
    criteria: [],
  }));

  for (const partition of domainPartitions) {
    const target = partitions.reduce((leastLoaded, candidate) =>
      candidate.criteria.length < leastLoaded.criteria.length ? candidate : leastLoaded,
    );
    target.criteria.push(...partition.criteria);
  }

  return partitions.filter((partition) => partition.criteria.length > 0);
}

export function partitionRunCriteriaByDomain(run: Pick<AlgorithmRun, "isa">, maxPartitions?: number): AlgorithmCriteriaPartition[] {
  return partitionCriteriaByDomain(getCriteria(run.isa), maxPartitions);
}

export function algorithmPhaseEnteredEvent(
  run: Pick<AlgorithmRun, "id">,
  phase: AlgorithmPhase,
  timestamp = new Date().toISOString(),
): AlgorithmNotificationEvent {
  return { kind: "algorithm.phase.entered", runId: run.id, phase, timestamp };
}

export function algorithmLoopStateChangedEvent(
  run: Pick<AlgorithmRun, "id">,
  from: AlgorithmLoopState["status"],
  to: AlgorithmLoopState["status"],
  iterationCount: number,
  timestamp = new Date().toISOString(),
): AlgorithmNotificationEvent {
  return { kind: "algorithm.loop.state_changed", runId: run.id, from, to, iterationCount, timestamp };
}

export function algorithmLoopBlockedEvent(
  run: Pick<AlgorithmRun, "id" | "loop">,
  threshold = 3,
  timestamp = new Date().toISOString(),
): AlgorithmNotificationEvent {
  return {
    kind: "algorithm.loop.blocked",
    runId: run.id,
    plateauCounter: run.loop.plateauCounter,
    threshold,
    timestamp,
  };
}
