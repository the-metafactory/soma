import { describe, expect, test } from "bun:test";
import {
  type Baseline,
  type HarnessData,
  METRICS,
  checkAgainstBaseline,
  computeMetrics,
  isProbeBacked,
  runCriteria,
} from "../scripts/harness-eval";

const NOW = new Date("2026-07-10T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeData(overrides: Partial<HarnessData> = {}): HarnessData {
  return { runs: [], events: [], now: NOW, windowDays: 60, ...overrides };
}

function completedRun(id: string, createdDaysAgo: number, learnings = 1) {
  return {
    id,
    createdAt: daysAgo(createdDaysAgo),
    updatedAt: daysAgo(createdDaysAgo - 1),
    phase: "complete",
    vsa: {
      frontmatter: { phase: "complete", verified: true },
      sections: [
        { name: "Checkpoints", content: "- [x] C1: The API returns paginated results." },
      ],
    },
    verification: [
      {
        timestamp: daysAgo(createdDaysAgo - 1),
        phase: "verify",
        text: "C1: passed. curl /api/items?page=2 returned 20 rows, HTTP 200, next cursor present.",
      },
    ],
    learning: Array.from({ length: learnings }, () => "lesson"),
  };
}

function stalledRun(id: string, createdDaysAgo: number, idleDays: number) {
  return {
    id,
    createdAt: daysAgo(createdDaysAgo),
    updatedAt: daysAgo(idleDays),
    phase: "observe",
    vsa: {
      frontmatter: { phase: "observe" },
      sections: [{ name: "Checkpoints", content: "- [ ] C1: Something that never got done." }],
    },
    verification: [],
    learning: [],
  };
}

describe("isProbeBacked", () => {
  test("accepts evidence with probe signatures and novel content", () => {
    expect(
      isProbeBacked(
        "bun test ran 42 tests, 0 failures; output in test/report.txt",
        "The test suite passes.",
      ),
    ).toBe(true);
  });

  test("rejects short assertions", () => {
    expect(isProbeBacked("it works", "The feature works.")).toBe(false);
  });

  test("rejects evidence with no probe signature", () => {
    expect(isProbeBacked("the implementation is correct and complete now", undefined)).toBe(false);
  });

  test("rejects tautological restatement of the criterion", () => {
    expect(
      isProbeBacked(
        "The API returns paginated results, HTTP 200",
        "The API returns paginated results.",
      ),
    ).toBe(false);
  });

  test("bare digits or slashes are not observable artifacts", () => {
    expect(isProbeBacked("checked the 3 main flows and/or edge cases by inspection", undefined)).toBe(
      false,
    );
  });
});

describe("runCriteria", () => {
  test("parses checkpoint lines from vsa sections", () => {
    const criteria = runCriteria(completedRun("r1", 10));
    expect(criteria.get("C1")).toBe("The API returns paginated results.");
  });

  test("reads legacy isa documents", () => {
    const criteria = runCriteria({
      isa: { sections: [{ name: "Criteria", content: "- [ ] C2: Old style criterion." }] },
    });
    expect(criteria.get("C2")).toBe("Old style criterion.");
  });
});

describe("computeMetrics", () => {
  test("computes completion, stall, learning and evidence rates from runs", () => {
    const data = makeData({
      runs: [
        completedRun("done-1", 20),
        completedRun("done-2", 15, 0),
        stalledRun("stalled-1", 30, 10),
        stalledRun("fresh-1", 30, 1), // idle only 1d — not stalled
      ],
    });
    const byId = Object.fromEntries(computeMetrics(data).map((m) => [m.id, m]));
    expect(byId.true_finish_rate.value).toBe(50);
    expect(byId.abandoned_run_share.numerator).toBe(1);
    expect(byId.abandoned_run_share.denominator).toBe(4);
    expect(byId.learning_capture_rate.value).toBe(50);
    expect(byId.probe_evidence_rate.value).toBe(100);
  });

  test("runs outside the window are excluded", () => {
    const data = makeData({ runs: [completedRun("old", 90)], windowDays: 60 });
    const byId = Object.fromEntries(computeMetrics(data).map((m) => [m.id, m]));
    expect(byId.true_finish_rate.denominator).toBe(0);
    expect(byId.true_finish_rate.value).toBeNull();
  });

  test("sync-minted evidence is excluded from the evidence denominator", () => {
    const run = completedRun("synced", 10);
    run.verification.push({
      timestamp: daysAgo(9),
      phase: "observe",
      text: "C1: passed. synced from ISA: The API returns paginated results.",
    });
    const byId = Object.fromEntries(computeMetrics(makeData({ runs: [run] })).map((m) => [m.id, m]));
    expect(byId.probe_evidence_rate.denominator).toBe(1); // only the real probe counts
    expect(byId.probe_evidence_rate.value).toBe(100);
  });

  test("hollow_pass_attempt_rate: gate violations over total gate decisions", () => {
    const run = {
      id: "gate-run",
      createdAt: daysAgo(5),
      updatedAt: daysAgo(4),
      vsa: {
        sections: [
          { name: "Checkpoints", content: "- [x] C1: The API returns paginated results." },
        ],
      },
      verification: Array.from({ length: 8 }, (_, i) => ({
        timestamp: daysAgo(4),
        phase: "verify",
        text: `V${i}: passed. curl /api/items?page=${i} returned 20 rows, HTTP 200, cursor present.`,
      })),
      learning: [],
    };
    const data = makeData({
      runs: [run],
      events: [
        { timestamp: daysAgo(3), kind: "verification.gate_violation" },
        { timestamp: daysAgo(2), kind: "verification.gate_violation" },
      ],
    });
    const byId = Object.fromEntries(computeMetrics(data).map((m) => [m.id, m]));
    expect(byId.hollow_pass_attempt_rate.numerator).toBe(2); // two gate refusals
    expect(byId.hollow_pass_attempt_rate.denominator).toBe(10); // 2 refusals + 8 passes
    expect(byId.hollow_pass_attempt_rate.value).toBe(20);
  });

  test("computes feedback closure and memory loop from events", () => {
    const data = makeData({
      events: [
        { timestamp: daysAgo(5), kind: "feedback.candidate" },
        { timestamp: daysAgo(5), kind: "feedback.candidate" },
        { timestamp: daysAgo(4), kind: "memory.write.create" },
        { timestamp: daysAgo(3), kind: "memory.recall" },
        { timestamp: daysAgo(2), kind: "memory.promotion" },
      ],
    });
    const byId = Object.fromEntries(computeMetrics(data).map((m) => [m.id, m]));
    expect(byId.feedback_closure_rate.denominator).toBe(2);
    expect(byId.memory_loop_closure.numerator).toBe(2); // recall + promotion
    expect(byId.memory_loop_closure.denominator).toBe(1);
  });

  test("promotion_rate: promotion events over finished runs", () => {
    const data = makeData({
      runs: [
        completedRun("a", 10),
        completedRun("b", 8),
        completedRun("c", 6),
        completedRun("d", 4),
      ],
      events: [
        { timestamp: daysAgo(5), kind: "memory.promotion" },
        { timestamp: daysAgo(3), kind: "memory.promotion" },
      ],
    });
    const byId = Object.fromEntries(computeMetrics(data).map((m) => [m.id, m]));
    expect(byId.promotion_rate.numerator).toBe(2);
    expect(byId.promotion_rate.denominator).toBe(4); // four finished runs
    expect(byId.promotion_rate.value).toBe(50);
  });
});

describe("checkAgainstBaseline", () => {
  const healthyRuns = Array.from({ length: 10 }, (_, i) => completedRun(`ok-${i}`, 20 - i));

  function baselineFrom(data: HarnessData): Baseline {
    return {
      capturedAt: NOW.toISOString(),
      windowDays: 60,
      metrics: Object.fromEntries(
        computeMetrics(data).map((r) => [r.id, { value: r.value, denominator: r.denominator }]),
      ),
    };
  }

  test("no regressions when nothing changed", () => {
    const data = makeData({
      runs: healthyRuns,
      events: [{ timestamp: daysAgo(5), kind: "feedback.candidate" }],
    });
    expect(checkAgainstBaseline(computeMetrics(data), baselineFrom(data))).toHaveLength(0);
  });

  test("flags degradation past tolerance and exits the gate", () => {
    const baseline = baselineFrom(makeData({ runs: healthyRuns }));
    const degraded = makeData({
      runs: [
        ...healthyRuns.slice(0, 3),
        ...Array.from({ length: 7 }, (_, i) => stalledRun(`dead-${i}`, 25 - i, 10)),
      ],
    });
    const regressions = checkAgainstBaseline(computeMetrics(degraded), baseline);
    const ids = regressions.map((r) => r.id);
    expect(ids).toContain("true_finish_rate"); // 100% -> 30%
    expect(ids).toContain("abandoned_run_share"); // 0% -> 70%
  });

  test("degradation within tolerance does not trip the gate", () => {
    const spec = METRICS.find((m) => m.id === "true_finish_rate");
    expect(spec).toBeDefined();
    const baseline: Baseline = {
      capturedAt: NOW.toISOString(),
      windowDays: 60,
      metrics: { true_finish_rate: { value: 52, denominator: 20 } },
    };
    const data = makeData({
      runs: [
        ...Array.from({ length: 5 }, (_, i) => completedRun(`ok-${i}`, 20 - i)),
        ...Array.from({ length: 5 }, (_, i) => stalledRun(`slow-${i}`, 20 - i, 1)),
      ],
    }); // 50% vs baseline 52, tolerance 5 -> fine
    expect(checkAgainstBaseline(computeMetrics(data), baseline).map((r) => r.id)).not.toContain(
      "true_finish_rate",
    );
  });

  test("small samples are exempt from the gate", () => {
    const baseline: Baseline = {
      capturedAt: NOW.toISOString(),
      windowDays: 60,
      metrics: { true_finish_rate: { value: 100, denominator: 20 } },
    };
    const data = makeData({ runs: [stalledRun("only-one", 20, 10)] }); // denominator 1 < minSample 5
    expect(checkAgainstBaseline(computeMetrics(data), baseline).map((r) => r.id)).not.toContain(
      "true_finish_rate",
    );
  });

  test("silent feedback capture while runs continue is itself a regression", () => {
    const baseline = baselineFrom(
      makeData({ runs: healthyRuns, events: [{ timestamp: daysAgo(5), kind: "feedback.candidate" }] }),
    );
    const silent = makeData({ runs: healthyRuns, events: [] });
    const regressions = checkAgainstBaseline(computeMetrics(silent), baseline);
    expect(regressions.map((r) => r.id)).toContain("feedback_candidate_volume");
  });
});

describe("metric registry contract", () => {
  test("every metric documents its Goodhart mode and countermeasure", () => {
    for (const metric of METRICS) {
      expect(metric.goodhart.length).toBeGreaterThan(20);
      expect(metric.countermeasure.length).toBeGreaterThan(20);
    }
  });
});
