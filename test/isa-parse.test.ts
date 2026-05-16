import { expect, test } from "bun:test";
import { parseIsa, serializeIsa } from "../src/index";
import { SECTION_NAME_MAP } from "../src/isa-accessors";

const SAMPLE = `---
task: Build the Algorithm
effort: E3
phase: build
progress: 1/2
mode: algorithm
started: 2026-05-16T10:00:00.000Z
updated: 2026-05-16T10:05:00.000Z
verified: false
project: soma
---

## Goal

Ship the unified ISA type.

## Criteria

- [x] C1: Type exported
- [ ] C2: Tests pass
`;

test("parseIsa extracts frontmatter, sections, and slug from sourcePath", () => {
  const isa = parseIsa(SAMPLE, "/tmp/foo/demo-slug.md");
  expect(isa.slug).toBe("demo-slug");
  expect(isa.frontmatter.task).toBe("Build the Algorithm");
  expect(isa.frontmatter.effort).toBe("E3");
  expect(isa.frontmatter.phase).toBe("build");
  expect(isa.frontmatter.verified).toBe(false);
  expect(isa.sourcePath).toBe("/tmp/foo/demo-slug.md");
  expect(isa.sections).toHaveLength(2);
  expect(isa.sections[0]?.name).toBe(SECTION_NAME_MAP.goal);
});

test("parseIsa buckets unknown YAML keys into frontmatter.custom", () => {
  const isa = parseIsa(SAMPLE);
  expect(isa.frontmatter.custom).toMatchObject({ project: "soma" });
});

test("serializeIsa round-trips parsed ISA via semantic equivalence", () => {
  const isa = parseIsa(SAMPLE);
  const serialized = serializeIsa(isa);
  const reparsed = parseIsa(serialized);
  expect(reparsed.frontmatter.task).toBe(isa.frontmatter.task);
  expect(reparsed.frontmatter.phase).toBe(isa.frontmatter.phase);
  expect(reparsed.frontmatter.custom).toEqual(isa.frontmatter.custom);
  expect(reparsed.sections).toEqual(isa.sections);
});

test("serializeIsa reuses raw input when no structural mutation occurred", () => {
  const isa = parseIsa(SAMPLE);
  const first = serializeIsa(isa);
  const second = serializeIsa(isa);
  expect(first).toBe(second);
});

test("serializeIsa preserves raw input verbatim even when renderer would normalize", () => {
  // Different key order, no derived defaults, comment-like whitespace — renderer
  // would reorder/normalize, but the raw round-trip must return the exact input.
  const oddOrderInput = `---
phase: build
task: Odd order
effort: E3
custom_key: value
---

## Goal

Something
`;
  const isa = parseIsa(oddOrderInput);
  expect(serializeIsa(isa)).toBe(oddOrderInput);
});

test("serializeIsa re-renders after structural mutation via accessor", async () => {
  const { setSection: setSectionFn, SECTION_NAME_MAP: SNM } = await import("../src/isa-accessors");
  const isa = parseIsa(SAMPLE);
  const mutated = setSectionFn(isa, SNM.goal, "Different goal text");
  const serialized = serializeIsa(mutated);
  expect(serialized).toContain("Different goal text");
  expect(serialized).not.toBe(SAMPLE);
});

test("serializeIsa recomputes derived frontmatter fields from sections", () => {
  const isa = parseIsa(SAMPLE);
  const serialized = serializeIsa(isa);
  // The frontmatter `progress` in SAMPLE says "1/2" — recomputed should match parsed criteria (1 passed of 2)
  expect(serialized).toContain("progress: 1/2");
  expect(serialized).toContain("verified: false");
});

test("authored frontmatter fields survive round-trip verbatim", () => {
  const isa = parseIsa(SAMPLE);
  const serialized = serializeIsa(isa);
  const reparsed = parseIsa(serialized);
  expect(reparsed.frontmatter.task).toBe("Build the Algorithm");
  expect(reparsed.frontmatter.started).toBe("2026-05-16T10:00:00.000Z");
  expect(reparsed.frontmatter.custom).toMatchObject({ project: "soma" });
});

test("hyphenated custom YAML keys round-trip through parse and serialize", () => {
  const markdown = `---
task: Demo
effort: E1
phase: observe
project-id: soma
foo_bar: baz
nested-thing: hello
---

## Goal

Test broader YAML key support.

## Criteria

- [ ] C1: hyphenated key survives
`;
  const isa = parseIsa(markdown);
  expect(isa.frontmatter.custom).toMatchObject({
    "project-id": "soma",
    foo_bar: "baz",
    "nested-thing": "hello",
  });
  const serialized = serializeIsa(isa);
  expect(serialized).toContain("project-id: soma");
  expect(serialized).toContain("nested-thing: hello");
  const reparsed = parseIsa(serialized);
  expect(reparsed.frontmatter.custom).toMatchObject({
    "project-id": "soma",
    "nested-thing": "hello",
  });
});

test("parser rejects __proto__ / prototype / constructor keys to prevent pollution", () => {
  const markdown = `---
task: pollution test
effort: E1
phase: observe
__proto__:
  polluted: true
constructor: { polluted: true }
prototype: yes
---

## Goal

Test prototype safety.
`;
  const isa = parseIsa(markdown);
  // Object.prototype must not be polluted
  const probe = {};
  expect((probe as Record<string, unknown>).polluted).toBeUndefined();
  expect(isa.frontmatter.custom?.__proto__).toBeUndefined();
});

test("frontmatter delimiter requires a full --- line, not a prefix", () => {
  const markdown = `---
task: edge case
effort: E1
phase: observe
---not-a-delimiter: still part of frontmatter? no, this is invalid yaml ignored
---

## Goal

After real delimiter
`;
  const isa = parseIsa(markdown);
  expect(isa.frontmatter.task).toBe("edge case");
  expect(isa.sections[0]?.content).toContain("After real delimiter");
});

test("nested custom YAML objects round-trip as objects, not JSON-stringified", () => {
  const markdown = `---
task: Demo
effort: E1
phase: observe
metadata:
  owner: jc
  team: soma
---

## Goal

Test nested custom YAML round-trip.

## Criteria

- [ ] C1: nested round-trips
`;
  const isa = parseIsa(markdown);
  expect(isa.frontmatter.custom?.metadata).toEqual({ owner: "jc", team: "soma" });
  const serialized = serializeIsa(isa);
  expect(serialized).toContain("metadata:\n  owner: jc\n  team: soma");
  const reparsed = parseIsa(serialized);
  expect(reparsed.frontmatter.custom?.metadata).toEqual({ owner: "jc", team: "soma" });
});

test("derived frontmatter fields are recomputed on serialize", () => {
  const isa = parseIsa(SAMPLE);
  const mutated = {
    ...isa,
    sections: [
      { name: SECTION_NAME_MAP.goal, content: "Different goal" },
      { name: SECTION_NAME_MAP.criteria, content: "- [x] C1: done\n- [x] C2: done" },
    ],
  };
  const serialized = serializeIsa(mutated);
  expect(serialized).toContain("progress: 2/2");
  expect(serialized).toContain("verified: true");
});
