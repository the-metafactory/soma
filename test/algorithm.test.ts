import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  addAlgorithmCapabilities,
  advanceAlgorithmRun,
  classifyAlgorithmPrompt,
  createAlgorithmRun,
  getCriteria,
  getRunPhase,
  setAlgorithmPlan,
  updateAlgorithmPlanStep,
  verifyAlgorithmCriterion,
  writeAlgorithmRun,
} from "../src/index";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-algorithm-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("creates deterministic Algorithm runs around ISA criteria", () => {
  const run = createAlgorithmRun({
    id: "ledger-update",
    timestamp: "2026-05-14T10:00:00.000Z",
    prompt: "Create a verified ledger update",
    intent: "Bring ledger state current.",
    currentState: "Ledger is stale.",
    goal: "Ledger is current and verified.",
    criteria: [{ id: "C1", text: "Ledger contains the new entry." }],
  });

  expect(getRunPhase(run)).toBe("observe");
  expect(run.effort).toBe("E1");
  expect(run.effortSource).toBe("auto");
  expect(run.classificationReason).toContain("E1");
  expect(run.isa.frontmatter.phase).toBe("observe");
  expect(getCriteria(run.isa)[0]?.status).toBe("open");
  expect(run.decisions[0]?.text).toContain("Bring ledger state current");
});

test("generates date-first Algorithm run ids", () => {
  const run = createAlgorithmRun({
    timestamp: "2026-05-14T10:00:00.000Z",
    prompt: "Name a run",
    intent: "Exercise generated ids.",
    currentState: "No id provided.",
    goal: "Generated id is sortable.",
    criteria: [{ id: "C1", text: "Id starts with date." }],
  });

  expect(run.id).toMatch(/^20260514_alg_[a-f0-9]{8}$/);
});

test("classifies prompts into Algorithm mode and effort tiers", () => {
  expect(classifyAlgorithmPrompt("ok")).toMatchObject({
    mode: "minimal",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("great, that works nicely")).toMatchObject({
    mode: "minimal",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("what's next?")).toMatchObject({
    mode: "native",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("run the tests")).toMatchObject({
    mode: "native",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("how does PAI handle the classification?")).toMatchObject({
    mode: "native",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("Implement a multi-file migration for the adapter")).toMatchObject({
    mode: "algorithm",
    effort: "E3",
    source: "auto",
  });
  expect(
    classifyAlgorithmPrompt(
      "Identify a genuinely surprising, telos-aligned outcome of Jens-Christian's AI-consulting work, with clear reasoning and implications.",
    ),
  ).toMatchObject({
    mode: "algorithm",
    effort: "E2",
    source: "auto",
  });
  expect(classifyAlgorithmPrompt("/e4 redesign the policy enforcement architecture")).toMatchObject({
    mode: "algorithm",
    effort: "E4",
    source: "explicit",
  });
});

test("enforces Algorithm phase gates", () => {
  let run = createAlgorithmRun({
    id: "portable-test",
    timestamp: "2026-05-14T10:00:00.000Z",
    prompt: "Make this portable",
    intent: "Create a portable harness.",
    currentState: "Algorithm is declarative.",
    goal: "Algorithm has enforced phase gates.",
    criteria: [{ id: "C1", text: "Phase gates reject incomplete work." }],
  });

  run = advanceAlgorithmRun(run, "2026-05-14T10:01:00.000Z");
  expect(getRunPhase(run)).toBe("think");

  expect(() => advanceAlgorithmRun(run)).toThrow("selected capabilities");
  run = addAlgorithmCapabilities(run, ["sequential-analysis"], "2026-05-14T10:02:00.000Z");
  run = advanceAlgorithmRun(run, "2026-05-14T10:03:00.000Z");
  expect(getRunPhase(run)).toBe("plan");

  expect(() => advanceAlgorithmRun(run)).toThrow("criterion-mapped plan");
  run = setAlgorithmPlan(
    run,
    [{ id: "P1", text: "Add harness tests.", criteriaIds: ["C1"], status: "open" }],
    "2026-05-14T10:04:00.000Z",
  );
  run = advanceAlgorithmRun(run, "2026-05-14T10:05:00.000Z");
  expect(getRunPhase(run)).toBe("build");

  run = {
    ...run,
    changelog: [{ timestamp: "2026-05-14T10:06:00.000Z", phase: "build", text: "Added harness." }],
  };
  run = advanceAlgorithmRun(run, "2026-05-14T10:07:00.000Z");
  expect(getRunPhase(run)).toBe("execute");

  expect(() => advanceAlgorithmRun(run)).toThrow("plan step");
  run = updateAlgorithmPlanStep(run, "P1", "done", "Harness tests pass.", "2026-05-14T10:08:00.000Z");
  run = advanceAlgorithmRun(run, "2026-05-14T10:09:00.000Z");
  expect(getRunPhase(run)).toBe("verify");

  expect(() => advanceAlgorithmRun(run)).toThrow("criterion");
  run = verifyAlgorithmCriterion(run, "C1", "passed", "Test asserted gate failures and success path.", "2026-05-14T10:10:00.000Z");
  run = advanceAlgorithmRun(run, "2026-05-14T10:11:00.000Z");
  expect(getRunPhase(run)).toBe("learn");

  run = {
    ...run,
    learning: [{ timestamp: "2026-05-14T10:12:00.000Z", phase: "learn", text: "Harness gates doctrine." }],
  };
  run = advanceAlgorithmRun(run, "2026-05-14T10:13:00.000Z");
  expect(getRunPhase(run)).toBe("complete");
});

test("abandoned runs cannot advance", async () => {
  const { abandonAlgorithmRun } = await import("../src/index");
  const run = createAlgorithmRun({
    id: "abandoned-test",
    timestamp: "2026-05-16T10:00:00.000Z",
    prompt: "Test abandonment",
    intent: "Verify terminal state",
    currentState: "Run starts fresh",
    goal: "Run cannot advance after abandonment",
    criteria: [{ id: "C1", text: "Abandonment is terminal" }],
  });
  const abandoned = abandonAlgorithmRun(run, "intentional test abort", "2026-05-16T10:01:00.000Z");
  expect(getRunPhase(abandoned)).toBe("abandoned");
  expect(() => advanceAlgorithmRun(abandoned)).toThrow("abandoned");
});

test("persists Algorithm runs under Soma WORK memory", async () => {
  await withTempHome(async (homeDir) => {
    const run = createAlgorithmRun({
      id: "stored-run",
      prompt: "Store this run",
      intent: "Persist deterministic work state.",
      currentState: "No persisted run.",
      goal: "Run is stored in Soma memory.",
      criteria: [{ id: "C1", text: "JSON file exists." }],
    });
    const written = await writeAlgorithmRun(run, { homeDir });

    expect(written.path).toBe(join(homeDir, ".soma/memory/WORK/algorithm-runs/stored-run.json"));
    await expect(readFile(written.path, "utf8")).resolves.toContain('"phase": "observe"');
  });
});
