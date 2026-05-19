import { expect, test } from "bun:test";
import {
  IDEATE_PRESETS,
  OPTIMIZE_PRESETS,
  algorithmLoopBlockedEvent,
  algorithmLoopStateChangedEvent,
  algorithmPhaseEnteredEvent,
  createAlgorithmRun,
  detectPlateau,
  partitionCriteriaByDomain,
  partitionRunCriteriaByDomain,
  validateIdeateParameters,
  validateOptimizeParameters,
} from "../src";
import type { AlgorithmRun, IdealStateCriterion } from "../src";
import { loadAlgorithmRun } from "../src/algorithm-store";

function criterion(id: string): IdealStateCriterion {
  return { id, text: `${id} criterion`, status: "open" };
}

test("#133 AlgorithmRun carries default loop state", () => {
  const run = createAlgorithmRun({
    id: "loop-state-test",
    timestamp: "2026-05-19T12:00:00.000Z",
    prompt: "Exercise loop state",
    intent: "Verify loop defaults.",
    currentState: "Run has just been created.",
    goal: "Loop state is present.",
    criteria: [{ id: "C1", text: "Loop state exists." }],
  });

  expect(run.loop).toEqual({
    status: "paused",
    iterationCount: 0,
    plateauCounter: 0,
    iterations: [],
  });
});

test("#133 loadAlgorithmRun backfills loop state for existing schema-2 runs", () => {
  const run = loadAlgorithmRun({
    schemaVersion: 2,
    id: "modern-run-without-loop",
    createdAt: "2026-05-16T10:00:00.000Z",
    updatedAt: "2026-05-16T10:00:00.000Z",
    prompt: "Modern run",
    intent: "Modern intent",
    effort: "E1",
    effortSource: "auto",
    mode: "algorithm",
    classificationReason: "Modern",
    currentState: "ISA is unified",
    isa: {
      slug: "modern-run-without-loop",
      frontmatter: {
        task: "Modern intent",
        effort: "E1",
        mode: "algorithm",
        phase: "observe",
        progress: "0/1",
        verified: false,
        updated: "2026-05-16T10:00:00.000Z",
      },
      sections: [
        { name: "Goal", content: "Already unified" },
        { name: "Criteria", content: "- [ ] C1: Modern criterion" },
      ],
    },
    antiCriteria: [],
    capabilities: [],
    planSteps: [],
    decisions: [],
    changelog: [],
    verification: [],
    learning: [],
  });

  expect(run.loop.status).toBe("paused");
  expect(run.loop.iterationCount).toBe(0);
});

test("#133 detectPlateau uses plateau counter and consecutive zero-progress iterations", () => {
  const base = createAlgorithmRun({
    id: "plateau-test",
    timestamp: "2026-05-19T12:00:00.000Z",
    prompt: "Detect a plateau",
    intent: "Verify plateau detection.",
    currentState: "Loop is running.",
    goal: "Plateau is detected.",
    criteria: [{ id: "C1", text: "Plateau detection is deterministic." }],
  });
  const zeroProgress: AlgorithmRun = {
    ...base,
    loop: {
      status: "running",
      iterationCount: 3,
      plateauCounter: 0,
      iterations: [
        { iteration: 1, timestamp: "2026-05-19T12:01:00.000Z", progressBefore: "0/3", progressAfter: "0/3" },
        { iteration: 2, timestamp: "2026-05-19T12:02:00.000Z", progressBefore: "0/3", progressAfter: "0/3" },
        { iteration: 3, timestamp: "2026-05-19T12:03:00.000Z", progressBefore: "0/3", progressAfter: "0/3" },
      ],
    },
  };
  const counterPlateau: AlgorithmRun = {
    ...base,
    loop: { ...base.loop, status: "blocked", plateauCounter: 3 },
  };
  const progressMade: AlgorithmRun = {
    ...zeroProgress,
    loop: {
      ...zeroProgress.loop,
      iterations: [
        zeroProgress.loop.iterations[0]!,
        { iteration: 2, timestamp: "2026-05-19T12:02:00.000Z", progressBefore: "0/3", progressAfter: "1/3" },
        zeroProgress.loop.iterations[2]!,
      ],
    },
  };

  expect(detectPlateau(zeroProgress)).toBe(true);
  expect(detectPlateau(counterPlateau)).toBe(true);
  expect(detectPlateau(progressMade)).toBe(false);
});

test("#133 partitions criteria by ISC domain and load-balances when worker count is lower", () => {
  const criteria = [
    criterion("ISC-UI-1"),
    criterion("ISC-UI-2"),
    criterion("ISC-PERF-1"),
    criterion("ISC-DOCS-1"),
    criterion("C1"),
  ];
  const byDomain = partitionCriteriaByDomain(criteria);
  expect(byDomain.map((partition) => partition.domain)).toEqual(["ui", "docs", "general", "perf"]);
  expect(byDomain.find((partition) => partition.domain === "ui")?.criteria.map((item) => item.id)).toEqual(["ISC-UI-1", "ISC-UI-2"]);

  const balanced = partitionCriteriaByDomain(criteria, 2);
  expect(balanced).toHaveLength(2);
  expect(balanced.flatMap((partition) => partition.criteria).map((item) => item.id).sort()).toEqual(criteria.map((item) => item.id).sort());
  expect(Math.abs(balanced[0]!.criteria.length - balanced[1]!.criteria.length)).toBeLessThanOrEqual(1);
});

test("#133 partitions run criteria through the ISA accessor", () => {
  const run = createAlgorithmRun({
    id: "partition-run",
    timestamp: "2026-05-19T12:00:00.000Z",
    prompt: "Partition run criteria",
    intent: "Verify run-level partitioning.",
    currentState: "Run has criteria.",
    goal: "Criteria are grouped.",
    criteria: [
      { id: "ISC-UI-1", text: "UI criterion." },
      { id: "ISC-PERF-1", text: "Performance criterion." },
    ],
  });

  expect(partitionRunCriteriaByDomain(run).map((partition) => partition.domain)).toEqual(["perf", "ui"]);
});

test("#133 ideate and optimize presets validate and reject out-of-range values", () => {
  expect(Object.keys(IDEATE_PRESETS)).toEqual(["dream", "explore", "balanced", "directed", "surgical"]);
  expect(Object.keys(OPTIMIZE_PRESETS)).toEqual(["cautious", "standard-optimize", "aggressive"]);
  expect(validateIdeateParameters(IDEATE_PRESETS.balanced)).toBe(IDEATE_PRESETS.balanced);
  expect(validateOptimizeParameters(OPTIMIZE_PRESETS["standard-optimize"])).toBe(OPTIMIZE_PRESETS["standard-optimize"]);
  expect(() => validateIdeateParameters({ ...IDEATE_PRESETS.dream, problemConnection: 1.1 })).toThrow("problemConnection");
  expect(() => validateOptimizeParameters({ ...OPTIMIZE_PRESETS.cautious, maxIterations: 0 })).toThrow("maxIterations");
});

test("#133 notification events are substrate-neutral data contracts", () => {
  const run = createAlgorithmRun({
    id: "notify-run",
    timestamp: "2026-05-19T12:00:00.000Z",
    prompt: "Build notification events",
    intent: "Verify event contracts.",
    currentState: "No events.",
    goal: "Events are typed data.",
    criteria: [{ id: "C1", text: "Events are emitted as data." }],
  });

  expect(algorithmPhaseEnteredEvent(run, "execute", "2026-05-19T12:01:00.000Z")).toEqual({
    kind: "algorithm.phase.entered",
    runId: "notify-run",
    phase: "execute",
    timestamp: "2026-05-19T12:01:00.000Z",
  });
  expect(algorithmLoopStateChangedEvent(run, "paused", "running", 4, "2026-05-19T12:02:00.000Z")).toMatchObject({
    kind: "algorithm.loop.state_changed",
    from: "paused",
    to: "running",
    iterationCount: 4,
  });
  expect(algorithmLoopBlockedEvent({ ...run, loop: { ...run.loop, plateauCounter: 3 } }, 3, "2026-05-19T12:03:00.000Z")).toMatchObject({
    kind: "algorithm.loop.blocked",
    plateauCounter: 3,
    threshold: 3,
  });
});
