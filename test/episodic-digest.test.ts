import { expect, test } from "bun:test";
import { parseDigestPointerIds, renderDigestPointer } from "../src/episodic-digest";
import type { SomaMemoryNote } from "../src/types";

function note(id: string, body: string): SomaMemoryNote {
  return {
    id,
    type: "episodic",
    created: "2026-07-04",
    last_verified: "2026-07-04",
    valid_until: null,
    provenance: "tool:test",
    trust: "assistant",
    source_of_truth: null,
    project: null,
    links: [],
    resurface_count: 0,
    body,
  } as SomaMemoryNote;
}

test("episodic digest pointer rendering and parsing are mutual for normal ids", () => {
  const notes = [
    note("20260704-a", "first summary\nsecond line"),
    note("20260704-b", "\n\nsecond summary"),
  ];

  const content = notes.map(renderDigestPointer).join("\n");

  expect(content).toContain("- 20260704-a: first summary");
  expect(content).toContain("- 20260704-b: second summary");
  expect(parseDigestPointerIds(content)).toEqual(notes.map((n) => n.id));
});

test("episodic digest pointer grammar round-trips ids containing colons", () => {
  const notes = [
    note("session:alpha", "alpha body"),
    note("session:beta:with-more", "beta body"),
  ];

  const content = notes.map(renderDigestPointer).join("\n");

  expect(content).toContain("- session\\:alpha: alpha body");
  expect(content).toContain("- session\\:beta\\:with-more: beta body");
  expect(parseDigestPointerIds(content)).toEqual(notes.map((n) => n.id));
});
