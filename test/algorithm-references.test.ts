import { expect, test } from "bun:test";
import {
  applyAlgorithmBatch,
  createAlgorithmRun,
  getAlgorithmReferences,
  recordAlgorithmReference,
  resolveAlgorithmReference,
} from "../src/index";
import { loadAlgorithmRun } from "../src/algorithm-store";
import { ReservedReferenceLetterError } from "../src/communication-contract";
import type { AlgorithmRun } from "../src/types";

function newRun(): AlgorithmRun {
  return createAlgorithmRun({
    id: "refs",
    prompt: "p",
    intent: "i",
    currentState: "c",
    goal: "g",
    criteria: [{ id: "C1", text: "something" }],
    effort: "E1",
  });
}

test("a reference is recorded with its letter and ordinal split out", () => {
  const run = recordAlgorithmReference(newRun(), { code: "f1", text: "The parser truncates.", label: "findings" });
  const [reference] = getAlgorithmReferences(run);

  expect(reference.code).toBe("F1");
  expect(reference.letter).toBe("F");
  expect(reference.ordinal).toBe(1);
  expect(reference.label).toBe("findings");
  expect(reference.verdict).toBeUndefined();
});

test("C and P are refused — the Algorithm already owns them", () => {
  // The point of the reservation: `keep C1` must never be ambiguous between a
  // VSA criterion and a chat finding.
  expect(() => recordAlgorithmReference(newRun(), { code: "C1", text: "x" })).toThrow(ReservedReferenceLetterError);
  expect(() => recordAlgorithmReference(newRun(), { code: "p2", text: "x" })).toThrow(ReservedReferenceLetterError);
  expect(() => recordAlgorithmReference(newRun(), { code: "F", text: "x" })).toThrow(/letter followed by a positive ordinal/);
  expect(() => recordAlgorithmReference(newRun(), { code: "F0", text: "x" })).toThrow(/letter followed by a positive ordinal/);
});

test("a code is stable within a run — reuse is refused, not silently overwritten", () => {
  const run = recordAlgorithmReference(newRun(), { code: "O1", text: "first" });
  expect(() => recordAlgorithmReference(run, { code: "O1", text: "second" })).toThrow(/already exists/);
});

test("resolving records the verdict and note, and re-resolving overwrites", () => {
  let run = recordAlgorithmReference(newRun(), { code: "O2", text: "Use redis." });
  run = resolveAlgorithmReference(run, { code: "o2", verdict: "rejected", note: "No cross-host requirement." });

  let [reference] = getAlgorithmReferences(run);
  expect(reference.verdict).toBe("rejected");
  expect(reference.verdictNote).toBe("No cross-host requirement.");
  expect(reference.resolvedAt).toBeDefined();

  // A decision revisited later is a real event; refusing it would push the
  // correction back into prose where nothing can read it.
  // Re-resolving with no note must clear the old one: a "kept" carrying the
  // rejection's rationale is worse than a "kept" with no rationale at all.
  run = resolveAlgorithmReference(run, { code: "O2", verdict: "kept" });
  [reference] = getAlgorithmReferences(run);
  expect(reference.verdict).toBe("kept");
  expect(reference.verdictNote).toBeUndefined();
});

test("resolving an unknown code fails rather than inventing the reference", () => {
  expect(() => resolveAlgorithmReference(newRun(), { code: "Q1", verdict: "answered" })).toThrow(/does not exist/);
});

test("D references mirror into the run's decisions, both on record and on resolve", () => {
  const base = newRun();
  // createAlgorithmRun seeds one decision (the intent), so count from there.
  const seeded = base.decisions.length;
  let run = recordAlgorithmReference(base, { code: "D1", text: "Drop the co-author rule." });
  expect(run.decisions.at(-1)?.text).toBe("D1: Drop the co-author rule.");

  run = resolveAlgorithmReference(run, { code: "D1", verdict: "kept", note: "Applied in the starter." });
  expect(run.decisions.at(-1)?.text).toBe("D1 kept: Applied in the starter.");
  // One durable home, not two: the reference is a handle on the decisions log.
  expect(run.decisions).toHaveLength(seeded + 2);
});

test("non-D references do not touch the decisions log", () => {
  const base = newRun();
  const run = recordAlgorithmReference(base, { code: "R1", text: "The banned list will rot." });
  expect(run.decisions).toHaveLength(base.decisions.length);
});

test("batch records and resolves references in one call", () => {
  const run = applyAlgorithmBatch(newRun(), [
    { kind: "ref", code: "F1", text: "Unwired file." },
    { kind: "ref", code: "D1", text: "Wire it." },
    { kind: "resolve", code: "D1", verdict: "kept", note: "Shipped." },
  ]);

  expect(getAlgorithmReferences(run).map((reference) => `${reference.code}:${reference.verdict ?? "open"}`)).toEqual([
    "F1:open",
    "D1:kept",
  ]);
});

test("runs written before references existed load with an empty list", () => {
  const legacy = loadAlgorithmRun({
    ...newRun(),
    references: undefined,
  });
  // Additive optional field, defaulted by the store — no schemaVersion bump.
  expect(legacy.schemaVersion).toBe(3);
  expect(legacy.references).toEqual([]);
  expect(getAlgorithmReferences(legacy)).toEqual([]);
});
