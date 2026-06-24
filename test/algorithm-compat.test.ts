import { expect, test } from "bun:test";
import { getCriteria, getGoal, getRunPhase } from "../src/index";
import { loadAlgorithmRun } from "../src/algorithm-store";

const LEGACY_V1_RUN = {
  id: "legacy-run-1",
  createdAt: "2026-04-01T10:00:00.000Z",
  updatedAt: "2026-04-02T10:00:00.000Z",
  prompt: "Pre-#41 run",
  intent: "Test legacy migration",
  effort: "E2",
  effortSource: "auto",
  mode: "algorithm",
  classificationReason: "Pre-#41 fixture",
  currentState: "VSA was embedded JSON",
  phase: "verify",
  isa: {
    slug: "legacy-run-1",
    phase: "verify",
    goal: "Migrate cleanly",
    criteria: [
      { id: "C1", text: "Legacy parses", status: "passed", verification: "test" },
      { id: "C2", text: "Frontmatter populated", status: "open" },
    ],
  },
  antiCriteria: [],
  capabilities: ["test"],
  planSteps: [],
  decisions: [{ timestamp: "2026-04-01T10:00:00.000Z", phase: "observe", text: "Intent: Test legacy migration" }],
  changelog: [],
  verification: [],
  learning: [],
};

test("loadAlgorithmRun migrates legacy v1 JSON to unified schema 3", () => {
  const run = loadAlgorithmRun(LEGACY_V1_RUN);
  expect(run.schemaVersion).toBe(3);
  expect(run.id).toBe("legacy-run-1");
  expect(run.vsa.frontmatter.phase).toBe("verify");
  expect(run.vsa.frontmatter.task).toBe("Test legacy migration");
  expect(run.vsa.sections.find((s) => s.name === "Goal")?.content).toBe("Migrate cleanly");
});

test("loadAlgorithmRun preserves criteria status from legacy JSON", () => {
  const run = loadAlgorithmRun(LEGACY_V1_RUN);
  const criteria = getCriteria(run.vsa);
  expect(criteria).toHaveLength(2);
  expect(criteria[0]).toMatchObject({ id: "C1", status: "passed", verification: "test" });
  expect(criteria[1]).toMatchObject({ id: "C2", status: "open" });
});

test("loadAlgorithmRun recomputes progress and verified from legacy criteria", () => {
  const run = loadAlgorithmRun(LEGACY_V1_RUN);
  expect(run.vsa.frontmatter.progress).toBe("1/2");
  expect(run.vsa.frontmatter.verified).toBe(false);
});

// soma#329 slice 3: a v2 on-disk run carries the embedded VSA under the legacy
// `isa` key. The reader dual-reads it, re-keys to `vsa`, and bumps to v3.
test("loadAlgorithmRun upgrades schema 2 runs (legacy isa key) to v3 vsa key", () => {
  const v2Run = {
    schemaVersion: 2,
    id: "modern-run",
    createdAt: "2026-05-16T10:00:00.000Z",
    updatedAt: "2026-05-16T10:00:00.000Z",
    prompt: "Modern run",
    intent: "Modern intent",
    effort: "E1",
    effortSource: "auto",
    mode: "algorithm",
    classificationReason: "Modern",
    currentState: "VSA is unified",
    isa: {
      slug: "modern-run",
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
  };
  const run = loadAlgorithmRun(v2Run);
  expect(run.schemaVersion).toBe(3);
  expect(getGoal(run.vsa)).toBe("Already unified");
  expect(getRunPhase(run)).toBe("observe");
  expect(run.capabilitySelections).toEqual([]);
  // The stale legacy `isa` key is dropped — only `vsa` survives.
  expect((run as unknown as { isa?: unknown }).isa).toBeUndefined();
});

test("loadAlgorithmRun reads a v3 run (vsa key) unchanged", () => {
  const v3Run = {
    schemaVersion: 3,
    id: "v3-run",
    createdAt: "2026-06-24T10:00:00.000Z",
    updatedAt: "2026-06-24T10:00:00.000Z",
    prompt: "v3 run",
    intent: "v3 intent",
    effort: "E1",
    effortSource: "auto",
    mode: "algorithm",
    classificationReason: "v3",
    currentState: "VSA under vsa key",
    vsa: {
      slug: "v3-run",
      frontmatter: {
        task: "v3 intent",
        effort: "E1",
        mode: "algorithm",
        phase: "observe",
        progress: "0/1",
        verified: false,
        updated: "2026-06-24T10:00:00.000Z",
      },
      sections: [
        { name: "Goal", content: "Native v3" },
        { name: "Criteria", content: "- [ ] C1: v3 criterion" },
      ],
    },
    antiCriteria: [],
    capabilities: [],
    planSteps: [],
    decisions: [],
    changelog: [],
    verification: [],
    learning: [],
  };
  const run = loadAlgorithmRun(v3Run);
  expect(run.schemaVersion).toBe(3);
  expect(getGoal(run.vsa)).toBe("Native v3");
  expect(getRunPhase(run)).toBe("observe");
});

test("AlgorithmRun has no top-level phase field (AC-11)", () => {
  const run = loadAlgorithmRun(LEGACY_V1_RUN);
  // The migrated run object should NOT carry a top-level phase field; phase is in frontmatter only.
  expect((run as unknown as { phase?: unknown }).phase).toBeUndefined();
  // The accessor is the single source of truth.
  expect(getRunPhase(run)).toBe("verify");
});

test("loadAlgorithmRun rejects non-object input", () => {
  expect(() => loadAlgorithmRun(null)).toThrow();
  expect(() => loadAlgorithmRun("not-an-object")).toThrow();
});
