import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_ALGORITHM_LOOP_ITERATION_HISTORY_LIMIT,
  IDEATE_PRESETS,
  OPTIMIZE_PRESETS,
  algorithmLoopBlockedEvent,
  algorithmLoopStateChangedEvent,
  algorithmPhaseEnteredEvent,
  createAlgorithmRun,
  detectPlateau,
  partitionCriteriaByDomain,
  partitionRunCriteriaByDomain,
  recordAlgorithmLoopIterationResult,
  validateIdeateParameters,
  validateOptimizeParameters,
} from "../src";
import type { AlgorithmRun, IdealStateCriterion } from "../src";
import { loadAlgorithmRun } from "../src/algorithm-store";

const algorithmExecutionModesDocs = readFileSync("docs/algorithm-execution-modes.md", "utf8");
const normalizedAlgorithmExecutionModesDocs = algorithmExecutionModesDocs.replace(/\s+/g, " ");

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
        zeroProgress.loop.iterations[0],
        { iteration: 2, timestamp: "2026-05-19T12:02:00.000Z", progressBefore: "0/3", progressAfter: "1/3" },
        zeroProgress.loop.iterations[2],
      ],
    },
  };

  expect(detectPlateau(zeroProgress)).toBe(true);
  expect(detectPlateau(counterPlateau)).toBe(true);
  expect(detectPlateau(progressMade)).toBe(false);
});

test("#222 records executor iteration results into portable loop metadata", () => {
  const run: AlgorithmRun = {
    ...createAlgorithmRun({
      id: "loop-record-test",
      timestamp: "2026-05-27T12:20:00.000Z",
      prompt: "Record loop iterations",
      intent: "Verify substrate-neutral loop metadata.",
      currentState: "Executor has not run.",
      goal: "Loop iterations are tracked.",
      criteria: [{ id: "C1", text: "Iteration metadata is present." }],
    }),
    loop: {
      status: "running",
      iterationCount: 0,
      plateauCounter: 0,
      iterations: [],
    },
  };

  const stalled = recordAlgorithmLoopIterationResult(
    { run, progressBefore: "0/1", progressAfter: "0/1", summary: "No criterion moved." },
    "2026-05-27T12:21:00.000Z",
  );
  expect(stalled.updatedAt).toBe("2026-05-27T12:21:00.000Z");
  expect(stalled.loop).toEqual({
    status: "running",
    iterationCount: 1,
    plateauCounter: 1,
    iterations: [
      {
        iteration: 1,
        timestamp: "2026-05-27T12:21:00.000Z",
        progressBefore: "0/1",
        progressAfter: "0/1",
        summary: "No criterion moved.",
      },
    ],
  });

  const progressed = recordAlgorithmLoopIterationResult(
    { run: stalled, progressBefore: "0/1", progressAfter: "1/1" },
    "2026-05-27T12:22:00.000Z",
  );
  expect(progressed.loop.iterationCount).toBe(2);
  expect(progressed.loop.plateauCounter).toBe(0);
  expect(progressed.loop.iterations.at(-1)).toEqual({
    iteration: 2,
    timestamp: "2026-05-27T12:22:00.000Z",
    progressBefore: "0/1",
    progressAfter: "1/1",
  });
});

test("#222 loop result recording keeps bounded recent history", () => {
  expect(DEFAULT_ALGORITHM_LOOP_ITERATION_HISTORY_LIMIT).toBe(200);
  const base = createAlgorithmRun({
    id: "loop-history-limit-test",
    timestamp: "2026-05-27T12:25:00.000Z",
    prompt: "Bound loop history",
    intent: "Verify loop history cap.",
    currentState: "Two iterations are already recorded.",
    goal: "Only recent iterations are retained.",
    criteria: [{ id: "C1", text: "History is bounded." }],
  });
  const run: AlgorithmRun = {
    ...base,
    loop: {
      status: "running",
      iterationCount: 2,
      plateauCounter: 2,
      iterations: [
        { iteration: 1, timestamp: "2026-05-27T12:25:00.000Z", progressBefore: "0/1", progressAfter: "0/1" },
        { iteration: 2, timestamp: "2026-05-27T12:26:00.000Z", progressBefore: "0/1", progressAfter: "0/1" },
      ],
    },
  };

  const bounded = recordAlgorithmLoopIterationResult(
    { run, progressBefore: "0/1", progressAfter: "0/1" },
    "2026-05-27T12:27:00.000Z",
    2,
  );

  expect(bounded.loop.iterationCount).toBe(3);
  expect(bounded.loop.plateauCounter).toBe(3);
  expect(bounded.loop.iterations.map((iteration) => iteration.iteration)).toEqual([2, 3]);
  const lastOnly = recordAlgorithmLoopIterationResult(
    { run, progressBefore: "0/1", progressAfter: "0/1" },
    "2026-05-27T12:28:00.000Z",
    1,
  );
  expect(lastOnly.loop.iterations.map((iteration) => iteration.iteration)).toEqual([3]);
  expect(() =>
    recordAlgorithmLoopIterationResult(
      { run, progressBefore: "0/1", progressAfter: "0/1" },
      "2026-05-27T12:29:00.000Z",
      0,
    ),
  ).toThrow("maxRecordedIterations");
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
  expect(Math.abs(balanced[0].criteria.length - balanced[1].criteria.length)).toBeLessThanOrEqual(1);
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

test("#222 execution-mode contracts avoid hardcoded Claude invocation paths", () => {
  const executionModeSource = readFileSync("src/algorithm-execution-modes.ts", "utf8");
  const contractSurface = `${executionModeSource}\n${algorithmExecutionModesDocs}`;

  for (const forbidden of ["~/.claude", ".claude/", "claude -p", "ClaudeCLI", "CodexAPI", "Pi.dev API"]) {
    expect(contractSurface).not.toContain(forbidden);
  }
});

test("#220 documents FeatureRegistry as an Algorithm plan-state decision", () => {
  expect(algorithmExecutionModesDocs).toContain("## FeatureRegistry");
  expect(normalizedAlgorithmExecutionModesDocs).toContain("FeatureRegistry is not migrated as a standalone Soma tool");
  expect(normalizedAlgorithmExecutionModesDocs).toContain("No `soma feature-registry` command");

  for (const command of ["init", "add", "update", "verify", "next"]) {
    expect(algorithmExecutionModesDocs).toContain(`\`${command}\``);
  }

  expect(algorithmExecutionModesDocs).toContain("`planSteps[]`");
  expect(algorithmExecutionModesDocs).toContain("`setAlgorithmPlan`");
  expect(algorithmExecutionModesDocs).toContain("`updateAlgorithmPlanStep`");
  expect(algorithmExecutionModesDocs).toContain("`verifyAlgorithmCriterion`");
  expect(algorithmExecutionModesDocs).toContain("extend `AlgorithmPlanStep`");
});
