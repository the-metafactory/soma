import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  computeGatesFired,
  createAlgorithmRun,
  recordAlgorithmMetaReflection,
  recordAlgorithmObservation,
  verifyAlgorithmCriterion,
  buildReflectionDigest,
  renderReflectionDigest,
  parsePaiReflections,
  type ReflectionForDigest,
} from "../src/index";

function freshRun() {
  return createAlgorithmRun({
    id: "reflect-run",
    timestamp: "2026-06-23T10:00:00.000Z",
    prompt: "Port the meta-reflection layer",
    intent: "Capture how the Algorithm should have behaved.",
    currentState: "No reflection layer.",
    goal: "A run produces a meta-reflection.",
    criteria: [{ id: "C1", text: "Reflection is recorded." }],
  });
}

test("computeGatesFired reads the real gate predicates off the run", () => {
  let run = freshRun();
  // Fresh run: no probe, criterion open.
  expect(computeGatesFired(run)).toEqual({ currentStateFloor: false, learnGateClean: false, completeness: false });

  run = recordAlgorithmObservation(run, { claim: "C1 exists", evidence: "read the isa", evidenceKind: "probed" }, "2026-06-23T10:00:30.000Z");
  expect(computeGatesFired(run).currentStateFloor).toBe(true);

  run = verifyAlgorithmCriterion(run, "C1", "passed", "Test asserts the record.", "2026-06-23T10:01:00.000Z", undefined, "tested");
  expect(computeGatesFired(run)).toEqual({ currentStateFloor: true, learnGateClean: true, completeness: true });
});

test("recordAlgorithmMetaReflection computes gates + keeps the model's q-signals + provenance", () => {
  let run = recordAlgorithmObservation(freshRun(), { claim: "C1 exists", evidence: "grep", evidenceKind: "probed" }, "2026-06-23T10:00:30.000Z");
  run = recordAlgorithmMetaReflection(
    run,
    { smarterRun: { missedVerifyOrParallel: "should have verified current-state before planning" }, satisfaction: 7, withinBudget: true },
    "2026-06-23T10:05:00.000Z",
    { substrate: "claude-code" },
  );
  expect(run.metaReflection).toHaveLength(1);
  const r = run.metaReflection[0];
  expect(r.gatesFired.currentStateFloor).toBe(true);
  expect(r.gatesFired.completeness).toBe(false); // C1 still open
  expect(r.smarterRun.missedVerifyOrParallel).toContain("verified current-state");
  expect(r.satisfaction).toBe(7);
  expect(r.withinBudget).toBe(true);
  expect(run.provenance.at(-1)).toMatchObject({ operation: "reflection.record", substrate: "claude-code" });
});

test("recordAlgorithmMetaReflection rejects an empty reflection and out-of-range satisfaction", () => {
  expect(() => recordAlgorithmMetaReflection(freshRun(), { smarterRun: {} })).toThrow("at least one smarterRun signal");
  expect(() => recordAlgorithmMetaReflection(freshRun(), { smarterRun: { missedEarlyStep: "   " } })).toThrow("at least one smarterRun signal");
  expect(() =>
    recordAlgorithmMetaReflection(freshRun(), { smarterRun: { highestValueMove: "x" }, satisfaction: 11 }),
  ).toThrow("between 0 and 10");
});

test("digest ranks gate-misses first, enriches with prose buckets", () => {
  // Two reflections miss the current-state floor; one misses completeness.
  const reflections: ReflectionForDigest[] = [
    {
      runId: "r1",
      reflection: {
        timestamp: "t1",
        phase: "learn",
        gatesFired: { currentStateFloor: false, learnGateClean: true, completeness: true },
        smarterRun: { missedVerifyOrParallel: "verify current-state assumptions before proceeding" },
      },
    },
    {
      runId: "r2",
      reflection: {
        timestamp: "t2",
        phase: "learn",
        gatesFired: { currentStateFloor: false, learnGateClean: true, completeness: true },
        smarterRun: { missedEarlyStep: "check field existence before asking" },
      },
    },
    {
      runId: "r3",
      reflection: {
        timestamp: "t3",
        phase: "learn",
        gatesFired: { currentStateFloor: true, learnGateClean: true, completeness: false },
        smarterRun: { highestValueMove: "the parallel launch was the highest-value move" },
      },
    },
  ];
  const digest = buildReflectionDigest(reflections);
  // current-state has 2 gate-misses → ranks first.
  expect(digest[0].category).toBe("current-state");
  expect(digest[0].gateMissCount).toBe(2);
  expect(digest[0].signalCount).toBe(2);
  // completeness (1 gate-miss) outranks a pure-prose parallelization bucket (0 gate-miss).
  const completenessIdx = digest.findIndex((e) => e.category === "completeness");
  const parallelIdx = digest.findIndex((e) => e.category === "parallelization");
  expect(completenessIdx).toBeLessThan(parallelIdx);
});

test("digest over a sample of the historical PAI corpus surfaces the P2 (current-state) signal on top", async () => {
  // Reads a committed fixture vendored from the historical PAI reflections jsonl
  // (4 records mirroring the real shape: 3 of 4 missed live_probe = current-state
  // floor). The full live corpus lives at ~/.soma and is not version-controlled.
  const fixture = join(import.meta.dir, "fixtures", "pai-algorithm-reflections-sample.jsonl");
  const imported = parsePaiReflections(await readFile(fixture, "utf8"));
  expect(imported).toHaveLength(4);
  expect(imported[0].runId).toBe("20260505-course-sales-strategy");
  expect(imported[0].reflection.gatesFired.currentStateFloor).toBe(false);

  const digest = buildReflectionDigest(imported);
  expect(digest[0].category).toBe("current-state");
  expect(digest[0].gateMissCount).toBe(3); // three runs missed live_probe
  expect(renderReflectionDigest(digest)).toContain("Current-state verification");
});

test("parsePaiReflections tolerates blank and malformed lines", () => {
  const jsonl = [
    JSON.stringify({ prd_id: "ok", reflection_q1: "check field existence before asking", doctrine_fired: { live_probe: false } }),
    "",
    "{not json",
    JSON.stringify({ prd_id: "no-signals", doctrine_fired: { live_probe: true } }), // dropped: no q-signal
  ].join("\n");
  const imported = parsePaiReflections(jsonl);
  expect(imported).toHaveLength(1);
  expect(imported[0].runId).toBe("ok");
});

test("renderReflectionDigest handles the empty corpus", () => {
  expect(renderReflectionDigest(buildReflectionDigest([]))).toBe("No meta-reflections found.");
});
