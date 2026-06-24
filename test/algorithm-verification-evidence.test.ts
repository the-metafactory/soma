import { expect, test } from "bun:test";
import {
  addAlgorithmCapabilities,
  advanceAlgorithmRun,
  createAlgorithmRun,
  getCriteria,
  getRunPhase,
  recordAlgorithmObservation,
  setAlgorithmPlan,
  updateAlgorithmPlanStep,
  verifyAlgorithmCriterion,
} from "../src/index";

// Fast-forward a fresh run to the VERIFY phase with one criterion C1.
function toVerify(): ReturnType<typeof createAlgorithmRun> {
  let run = createAlgorithmRun({
    id: "evidence-kind-test",
    timestamp: "2026-06-22T10:00:00.000Z",
    prompt: "Exercise verification evidence kinds",
    intent: "Close the tautological-verification hole.",
    currentState: "Verify gate accepts assertion as evidence.",
    goal: "Behavioral criteria require a probe.",
    criteria: [{ id: "C1", text: "Endpoint returns 200 under test." }],
  });
  run = recordAlgorithmObservation(
    run,
    { claim: "endpoint exists", evidence: "probed the running server", evidenceKind: "probed" },
    "2026-06-22T10:00:30.000Z",
  ); // OBSERVE current-state floor
  run = advanceAlgorithmRun(run, "2026-06-22T10:01:00.000Z"); // observe -> think
  run = addAlgorithmCapabilities(run, ["sequential-analysis"], "2026-06-22T10:02:00.000Z");
  run = advanceAlgorithmRun(run, "2026-06-22T10:03:00.000Z"); // think -> plan
  run = setAlgorithmPlan(
    run,
    [{ id: "P1", text: "Implement + test.", criteriaIds: ["C1"], status: "open" }],
    "2026-06-22T10:04:00.000Z",
  );
  run = advanceAlgorithmRun(run, "2026-06-22T10:05:00.000Z"); // plan -> build
  run = {
    ...run,
    changelog: [{ timestamp: "2026-06-22T10:06:00.000Z", phase: "build", text: "Implemented." }],
  };
  run = advanceAlgorithmRun(run, "2026-06-22T10:07:00.000Z"); // build -> execute
  run = updateAlgorithmPlanStep(run, "P1", "done", "Tests pass.", "2026-06-22T10:08:00.000Z");
  run = advanceAlgorithmRun(run, "2026-06-22T10:09:00.000Z"); // execute -> verify
  expect(getRunPhase(run)).toBe("verify");
  return run;
}

test("verifyAlgorithmCriterion records the evidence kind on the criterion", () => {
  let run = toVerify();
  run = verifyAlgorithmCriterion(run, "C1", "passed", "curl /health -> 200", "2026-06-22T10:10:00.000Z", undefined, "probed");
  const c1 = getCriteria(run.vsa).find((c) => c.id === "C1");
  expect(c1?.status).toBe("passed");
  expect(c1?.evidenceKind).toBe("probed");
});

test("evidence kind round-trips through VSA markdown serialization", () => {
  let run = toVerify();
  run = verifyAlgorithmCriterion(run, "C1", "passed", "ran bun test", "2026-06-22T10:10:00.000Z", undefined, "tested");
  // Re-parse from the serialized VSA sections.
  const reparsed = getCriteria(run.vsa).find((c) => c.id === "C1");
  expect(reparsed?.evidenceKind).toBe("tested");
});

test("a passed criterion verified only as 'specified' blocks advance to LEARN", () => {
  let run = toVerify();
  run = verifyAlgorithmCriterion(run, "C1", "passed", "the design says it returns 200", "2026-06-22T10:10:00.000Z", undefined, "specified");
  let thrown: unknown;
  try {
    advanceAlgorithmRun(run, "2026-06-22T10:11:00.000Z");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(/C1/);
  expect((thrown as Error).message).toMatch(/probe|specified|deferred/i);
});

test("a probed pass advances to LEARN", () => {
  let run = toVerify();
  run = verifyAlgorithmCriterion(run, "C1", "passed", "curl -> 200", "2026-06-22T10:10:00.000Z", undefined, "probed");
  run = advanceAlgorithmRun(run, "2026-06-22T10:11:00.000Z");
  expect(getRunPhase(run)).toBe("learn");
});

test("deferred-probe is an honest resolved state accepted by the LEARN gate", () => {
  let run = toVerify();
  run = verifyAlgorithmCriterion(run, "C1", "deferred-probe", "design-only; real probe deferred to follow-up", "2026-06-22T10:10:00.000Z");
  const c1 = getCriteria(run.vsa).find((c) => c.id === "C1");
  expect(c1?.status).toBe("deferred-probe");
  // verified should NOT be true when a criterion is only deferred-probe.
  expect(run.vsa.frontmatter.verified).toBe(false);
  run = advanceAlgorithmRun(run, "2026-06-22T10:11:00.000Z");
  expect(getRunPhase(run)).toBe("learn");
});

test("legacy passed verification without an evidence kind is grandfathered", () => {
  let run = toVerify();
  // old call signature: no evidenceKind -> undefined, not 'specified'
  run = verifyAlgorithmCriterion(run, "C1", "passed", "verified", "2026-06-22T10:10:00.000Z");
  run = advanceAlgorithmRun(run, "2026-06-22T10:11:00.000Z");
  expect(getRunPhase(run)).toBe("learn");
});
