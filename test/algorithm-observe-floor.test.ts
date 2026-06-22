import { expect, test } from "bun:test";
import {
  advanceAlgorithmRun,
  createAlgorithmRun,
  getRunPhase,
  hasCurrentStateProbe,
  recordAlgorithmObservation,
} from "../src/index";

function freshRun() {
  return createAlgorithmRun({
    id: "observe-floor",
    timestamp: "2026-06-22T10:00:00.000Z",
    prompt: "Add the OBSERVE current-state floor",
    intent: "Verify current-state assumptions before THINK.",
    currentState: "Run is at observe.",
    goal: "OBSERVE→THINK requires a current-state probe.",
    criteria: [{ id: "C1", text: "Gate blocks advance without a probe." }],
  });
}

test("OBSERVE→THINK is blocked until a current-state probe is recorded", () => {
  const run = freshRun();
  expect(getRunPhase(run)).toBe("observe");
  expect(run.observations).toEqual([]);
  expect(() => advanceAlgorithmRun(run, "2026-06-22T10:01:00.000Z")).toThrow("current-state probe");
});

test("a probed observation clears the OBSERVE floor", () => {
  let run = freshRun();
  run = recordAlgorithmObservation(
    run,
    { claim: "criterion C1 exists in the ISA", evidence: "confirmed by reading run.isa", evidenceKind: "probed" },
    "2026-06-22T10:01:00.000Z",
  );
  run = advanceAlgorithmRun(run, "2026-06-22T10:02:00.000Z");
  expect(getRunPhase(run)).toBe("think");
});

test("a tested observation clears the OBSERVE floor", () => {
  let run = freshRun();
  run = recordAlgorithmObservation(
    run,
    { claim: "the gate fires", evidence: "covered by this test file", evidenceKind: "tested" },
    "2026-06-22T10:01:00.000Z",
  );
  run = advanceAlgorithmRun(run, "2026-06-22T10:02:00.000Z");
  expect(getRunPhase(run)).toBe("think");
});

test("a 'specified' observation does NOT clear the floor — it only restates a spec", () => {
  let run = freshRun();
  run = recordAlgorithmObservation(
    run,
    { claim: "the design says C1 exists", evidence: "per the design doc", evidenceKind: "specified" },
    "2026-06-22T10:01:00.000Z",
  );
  expect(run.observations).toHaveLength(1);
  expect(hasCurrentStateProbe(run.observations)).toBe(false);
  expect(() => advanceAlgorithmRun(run, "2026-06-22T10:02:00.000Z")).toThrow("current-state probe");
});

test("recordAlgorithmObservation appends a typed observation + provenance", () => {
  const run = recordAlgorithmObservation(
    freshRun(),
    { claim: "route /health exists", evidence: "grep src/server.ts:42", evidenceKind: "probed" },
    "2026-06-22T10:01:00.000Z",
    { substrate: "claude-code" },
  );
  expect(run.observations).toEqual([
    {
      timestamp: "2026-06-22T10:01:00.000Z",
      claim: "route /health exists",
      evidence: "grep src/server.ts:42",
      evidenceKind: "probed",
    },
  ]);
  expect(run.provenance.at(-1)).toMatchObject({ operation: "observation.record", substrate: "claude-code", detail: "route /health exists" });
});

test("recordAlgorithmObservation rejects empty claim or evidence", () => {
  expect(() =>
    recordAlgorithmObservation(freshRun(), { claim: "  ", evidence: "x", evidenceKind: "probed" }),
  ).toThrow("observation claim");
  expect(() =>
    recordAlgorithmObservation(freshRun(), { claim: "x", evidence: "  ", evidenceKind: "probed" }),
  ).toThrow("observation evidence");
});

test("hasCurrentStateProbe is true only for probed/tested observations", () => {
  expect(hasCurrentStateProbe([])).toBe(false);
  expect(hasCurrentStateProbe([{ timestamp: "t", claim: "c", evidence: "e", evidenceKind: "specified" }])).toBe(false);
  expect(hasCurrentStateProbe([{ timestamp: "t", claim: "c", evidence: "e", evidenceKind: "probed" }])).toBe(true);
  expect(hasCurrentStateProbe([{ timestamp: "t", claim: "c", evidence: "e", evidenceKind: "tested" }])).toBe(true);
});
