import { expect, test } from "bun:test";
import { memoryTerms, memoryTermSet, MEMORY_TERM_MIN_LEN } from "../src/memory-terms";

test("memoryTerms lowercases, drops sub-3-char tokens, and de-dups in first-occurrence order", () => {
  expect(memoryTerms("Gateway RETRIES gateway a to the")).toEqual(["gateway", "retries", "the"]);
  // sub-3-char tokens ("a", "to") are dropped; "the" (3 chars) survives
  expect(MEMORY_TERM_MIN_LEN).toBe(3);
});

test("memoryTerms keeps accented Latin letters as term characters", () => {
  expect(memoryTerms("Zürich café ÿ")).toEqual(["zürich", "café"]);
});

test("memoryTerms splits on any non-alphanumeric run", () => {
  expect(memoryTerms("em-dashes, colon; commas...")).toEqual(["dashes", "colon", "commas"]);
});

test("memoryTermSet takes already-lowercased input and returns a set (dedup shape)", () => {
  const set = memoryTermSet("gateway gateway retries");
  expect(set).toBeInstanceOf(Set);
  expect([...set].sort()).toEqual(["gateway", "retries"]);
});

test("memoryTerms and memoryTermSet agree on membership for lowercased input", () => {
  const text = "widget tolerance is five mm";
  const fromTerms = new Set(memoryTerms(text));
  const fromSet = memoryTermSet(text.toLowerCase());
  expect([...fromTerms].sort()).toEqual([...fromSet].sort());
});
