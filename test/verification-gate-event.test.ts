import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlgorithmRun, verifyAlgorithmCriterion, somaMemoryEventsPath } from "../src/index";
// VerificationGateError is intentionally not on the public barrel (Sage review,
// PR #455) — import it from its defining module, as the CLI does.
import { VerificationGateError } from "../src/algorithm";
import { appendVerificationGateViolationEvent } from "../src/cli/algorithm";

function makeRun() {
  return createAlgorithmRun({
    id: "gate-event-test",
    prompt: "p",
    intent: "i",
    currentState: "c",
    goal: "g",
    criteria: [{ id: "C1", text: "The thing demonstrably works." }],
    effort: "E1",
  });
}

describe("VerificationGateError", () => {
  test("hollow pass throws the typed error with reason fields", () => {
    const run = makeRun();
    let caught: unknown;
    try {
      verifyAlgorithmCriterion(run, "C1", "passed", "done");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VerificationGateError);
    const gate = caught as VerificationGateError;
    expect(gate.criterionId).toBe("C1");
    expect(gate.reason).toBe("rote_evidence");
  });

  test("specification-only pass carries the specification_only reason", () => {
    const run = makeRun();
    let caught: unknown;
    try {
      verifyAlgorithmCriterion(run, "C1", "passed", "the spec describes this behaviour in detail");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VerificationGateError);
    expect((caught as VerificationGateError).reason).toBe("specification_only");
  });

  test("probed evidence passes without throwing", () => {
    const run = makeRun();
    const updated = verifyAlgorithmCriterion(
      run,
      "C1",
      "passed",
      "bun test ran 4 tests, 0 failures",
      undefined,
      undefined,
      "tested",
    );
    expect(updated.verification.length).toBeGreaterThan(0);
  });
});

describe("appendVerificationGateViolationEvent", () => {
  test("appends a verification.gate_violation event with run and criterion metadata", async () => {
    const somaHome = mkdtempSync(join(tmpdir(), "soma-gate-event-"));
    const error = new VerificationGateError({
      criterionId: "C2",
      reason: "specification_only",
      message: "specification-only evidence",
      evidenceKind: "specified",
    });
    await appendVerificationGateViolationEvent({ somaHome }, "run-42", error);

    const lines = readFileSync(somaMemoryEventsPath(somaHome), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.kind).toBe("verification.gate_violation");
    expect(event.metadata).toEqual({
      runId: "run-42",
      criterionId: "C2",
      reason: "specification_only",
      evidenceKind: "specified",
    });
  });
});
