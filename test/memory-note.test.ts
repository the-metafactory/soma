import { expect, test } from "bun:test";
import {
  MemoryNoteError,
  parseMemoryNote,
  serializeMemoryNote,
  type SomaMemoryNote,
} from "../src/index";

function fullNote(): SomaMemoryNote {
  return {
    id: "soma-memory-schema",
    type: "semantic",
    created: "2026-07-03",
    last_verified: "2026-07-03",
    valid_until: null,
    provenance: "conversation",
    trust: "principal",
    source_of_truth: "src/memory-note.ts",
    project: "soma",
    links: ["memory-recall", "memory-consolidation"],
    resurface_count: 0,
    hook: "how does memory note parse",
    review: "verify against src/memory-note.ts",
    body: "One note = strict frontmatter + markdown body.",
  };
}

function minimalNote(): SomaMemoryNote {
  return {
    id: "min",
    type: "episodic",
    created: "2026-07-03",
    last_verified: "2026-07-03",
    valid_until: "2026-08-01",
    provenance: "tool:consolidate",
    trust: "assistant",
    source_of_truth: null,
    project: null,
    links: [],
    resurface_count: 3,
    body: "Body text.",
  };
}

// ── round-trip law ──────────────────────────────────────────────────────────

test("parse(serialize(n)) === n for a full note", () => {
  const n = fullNote();
  expect(parseMemoryNote(serializeMemoryNote(n))).toEqual(n);
});

test("parse(serialize(n)) === n for a minimal note (nulls, empty links, no optionals)", () => {
  const n = minimalNote();
  expect(parseMemoryNote(serializeMemoryNote(n))).toEqual(n);
});

test("serialize(parse(s)) === s is byte-stable for a canonical string", () => {
  const s = serializeMemoryNote(fullNote());
  expect(serializeMemoryNote(parseMemoryNote(s))).toBe(s);
});

test("optional keys are omitted from output when undefined", () => {
  const s = serializeMemoryNote(minimalNote());
  expect(s).not.toContain("hook:");
  expect(s).not.toContain("review:");
});

test("body is trimmed on parse so re-serialization is stable", () => {
  const n = { ...minimalNote(), body: "  spaced body  " };
  const parsed = parseMemoryNote(serializeMemoryNote(n));
  expect(parsed.body).toBe("spaced body");
});

// ── validation ──────────────────────────────────────────────────────────────

function serializedMinimal(): string {
  return serializeMemoryNote(minimalNote());
}

test("missing frontmatter block throws", () => {
  expect(() => parseMemoryNote("no frontmatter here")).toThrow(MemoryNoteError);
  expect(() => parseMemoryNote("no frontmatter here")).toThrow("frontmatter block");
});

test("unclosed frontmatter throws", () => {
  expect(() => parseMemoryNote("---\nid: x\n")).toThrow("not closed");
});

test("unknown frontmatter key throws naming the field", () => {
  const bad = serializedMinimal().replace("project: null", "project: null\nbogus: 1");
  try {
    parseMemoryNote(bad);
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(MemoryNoteError);
    expect((e as MemoryNoteError).field).toBe("bogus");
  }
});

test("duplicate frontmatter key throws", () => {
  const bad = serializedMinimal().replace("project: null", "project: null\nproject: soma");
  expect(() => parseMemoryNote(bad)).toThrow("duplicate");
});

test("missing required key throws naming the field", () => {
  const bad = serializedMinimal().replace("resurface_count: 3\n", "");
  try {
    parseMemoryNote(bad);
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as MemoryNoteError).field).toBe("resurface_count");
  }
});

test("invalid id slug throws", () => {
  const bad = serializedMinimal().replace("id: min", "id: Not_A_Slug");
  expect(() => parseMemoryNote(bad)).toThrow("id");
});

test("id over 64 chars throws", () => {
  const long = "a".repeat(65);
  const bad = serializedMinimal().replace("id: min", `id: ${long}`);
  expect(() => parseMemoryNote(bad)).toThrow("id");
});

test("invalid type throws", () => {
  const bad = serializedMinimal().replace("type: episodic", "type: bogus");
  expect(() => parseMemoryNote(bad)).toThrow("type");
});

test("invalid trust throws", () => {
  const bad = serializedMinimal().replace("trust: assistant", "trust: root");
  expect(() => parseMemoryNote(bad)).toThrow("trust");
});

test("non-date created throws", () => {
  const bad = serializedMinimal().replace("created: 2026-07-03", "created: yesterday");
  expect(() => parseMemoryNote(bad)).toThrow("created");
});

test("shape-valid but impossible calendar date throws (2026-99-99)", () => {
  const bad = serializedMinimal().replace("created: 2026-07-03", "created: 2026-99-99");
  expect(() => parseMemoryNote(bad)).toThrow("created");
});

test("Feb 30 is rejected as an impossible date", () => {
  const bad = serializedMinimal().replace("last_verified: 2026-07-03", "last_verified: 2026-02-30");
  expect(() => parseMemoryNote(bad)).toThrow("last_verified");
});

test("valid_until rejects an impossible date", () => {
  const bad = serializedMinimal().replace("valid_until: 2026-08-01", "valid_until: 2026-13-01");
  expect(() => parseMemoryNote(bad)).toThrow("valid_until");
});

test("valid_until accepts null or a date, rejects garbage", () => {
  const bad = serializedMinimal().replace("valid_until: 2026-08-01", "valid_until: soon");
  expect(() => parseMemoryNote(bad)).toThrow("valid_until");
});

test("non-integer resurface_count throws", () => {
  const bad = serializedMinimal().replace("resurface_count: 3", "resurface_count: 2.5");
  expect(() => parseMemoryNote(bad)).toThrow("resurface_count");
});

test("negative resurface_count throws", () => {
  const bad = serializedMinimal().replace("resurface_count: 3", "resurface_count: -1");
  expect(() => parseMemoryNote(bad)).toThrow("resurface_count");
});

test("empty provenance throws", () => {
  const bad = serializedMinimal().replace("provenance: tool:consolidate", "provenance:");
  expect(() => parseMemoryNote(bad)).toThrow("provenance");
});

test("provenance outside the closed set throws", () => {
  const bad = serializedMinimal().replace("provenance: tool:consolidate", "provenance: hearsay");
  expect(() => parseMemoryNote(bad)).toThrow("provenance");
});

test("bare 'tool:' with no name throws", () => {
  const bad = serializedMinimal().replace("provenance: tool:consolidate", "provenance: tool:");
  expect(() => parseMemoryNote(bad)).toThrow("provenance");
});

test("each documented provenance literal is accepted", () => {
  for (const p of ["conversation", "consolidation", "import"]) {
    const n = { ...minimalNote(), provenance: p };
    expect(parseMemoryNote(serializeMemoryNote(n)).provenance).toBe(p);
  }
});

test("tool:<name> provenance round-trips", () => {
  const n = { ...minimalNote(), provenance: "tool:daily-briefing" };
  expect(parseMemoryNote(serializeMemoryNote(n)).provenance).toBe("tool:daily-briefing");
});

test("empty body throws", () => {
  const bad = serializedMinimal().replace("Body text.", "");
  expect(() => parseMemoryNote(bad)).toThrow("body");
});

test("links with an invalid slug entry throws", () => {
  const n = { ...minimalNote(), links: ["ok"] };
  const bad = serializeMemoryNote(n).replace("links: [ok]", "links: [ok, BAD_SLUG]");
  expect(() => parseMemoryNote(bad)).toThrow("links");
});

test("links without brackets throws", () => {
  const bad = serializedMinimal().replace("links: []", "links: a, b");
  expect(() => parseMemoryNote(bad)).toThrow("links");
});

test("serialize rejects the reserved literal \"null\" as source_of_truth", () => {
  const n = { ...minimalNote(), source_of_truth: "null" };
  expect(() => serializeMemoryNote(n)).toThrow(MemoryNoteError);
  expect(() => serializeMemoryNote(n)).toThrow("source_of_truth");
});

test("serialize rejects the reserved literal \"null\" as project", () => {
  const n = { ...minimalNote(), project: "null" };
  expect(() => serializeMemoryNote(n)).toThrow("project");
});

test("serialize rejects the reserved literal \"null\" as valid_until", () => {
  const n = { ...minimalNote(), valid_until: "null" };
  expect(() => serializeMemoryNote(n)).toThrow(MemoryNoteError);
  expect(() => serializeMemoryNote(n)).toThrow("valid_until");
});

test("a genuine null valid_until still serializes and round-trips", () => {
  const n = { ...minimalNote(), valid_until: null };
  expect(parseMemoryNote(serializeMemoryNote(n))).toEqual(n);
});

test("a genuine null source_of_truth/project still serializes and round-trips", () => {
  const n = { ...minimalNote(), source_of_truth: null, project: null };
  expect(parseMemoryNote(serializeMemoryNote(n))).toEqual(n);
});

test("serialize rejects a note with an invalid link slug (no poison file)", () => {
  const n = { ...minimalNote(), links: ["BAD_SLUG"] };
  expect(() => serializeMemoryNote(n)).toThrow(MemoryNoteError);
  expect(() => serializeMemoryNote(n)).toThrow("links");
});

test("serialize rejects a note with an invalid id slug", () => {
  const n = { ...minimalNote(), id: "Not A Slug" };
  expect(() => serializeMemoryNote(n)).toThrow("id");
});

test("serialize rejects a note with an impossible date", () => {
  const n = { ...minimalNote(), created: "2026-99-99" };
  expect(() => serializeMemoryNote(n)).toThrow("created");
});

test("serialize rejects a note with a negative resurface_count", () => {
  const n = { ...minimalNote(), resurface_count: -1 };
  expect(() => serializeMemoryNote(n)).toThrow("resurface_count");
});

test("serialize preserves an already-trimmed body exactly (round-trip law)", () => {
  const n = { ...minimalNote(), body: "already trimmed" };
  expect(parseMemoryNote(serializeMemoryNote(n))).toEqual(n);
});

test("multi-entry links round-trip", () => {
  const n = { ...minimalNote(), links: ["a", "b-two", "c3"] };
  expect(parseMemoryNote(serializeMemoryNote(n)).links).toEqual(["a", "b-two", "c3"]);
});
