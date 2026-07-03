import type { SomaMemoryNote, SomaMemoryNoteType, SomaMemoryTrust } from "./types";

/**
 * File-native memory note parser + serializer (memory subsystem M0).
 *
 * Contract is fixed by the plan v2 §2 (do not redesign): one note = strict
 * frontmatter + markdown body, with a tiny hand-written grammar (no YAML lib —
 * zero new runtime deps). The round-trip law `parse(serialize(n)) === n` holds
 * for any note whose body is already trimmed; both sides normalize the body by
 * trimming, so a parsed note re-serializes byte-stably.
 *
 * Frontmatter grammar: `---\n`, then `key: value` lines, then `---\n`. Values
 * are unquoted strings, `null`, integers, or an inline `links` array `[a, b]`
 * (possibly `[]`). No nesting, no quotes, no multiline values. Unknown or
 * duplicate keys, missing required keys, and any malformed value throw a
 * `MemoryNoteError` naming the offending field.
 */

export class MemoryNoteError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "MemoryNoteError";
  }
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_TYPES: readonly SomaMemoryNoteType[] = ["semantic", "episodic", "procedural"];
const TRUSTS: readonly SomaMemoryTrust[] = ["principal", "agent", "quarantined"];

// Required frontmatter keys in canonical serialization order.
const REQUIRED_KEYS = [
  "id",
  "type",
  "created",
  "last_verified",
  "valid_until",
  "provenance",
  "trust",
  "source_of_truth",
  "project",
  "links",
  "resurface_count",
] as const;
const OPTIONAL_KEYS = ["hook", "review"] as const;
const ALLOWED_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

function assert(condition: unknown, message: string, field?: string): asserts condition {
  if (!condition) throw new MemoryNoteError(message, field);
}

/** Parse the inline `links` array grammar: `[]`, `[a]`, `[a, b]`. */
function parseLinks(raw: string): string[] {
  assert(raw.startsWith("[") && raw.endsWith("]"), `links must be an inline array [a, b]`, "links");
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  const items = inner.split(",").map((s) => s.trim());
  for (const item of items) {
    assert(SLUG.test(item), `links entry "${item}" is not a valid slug`, "links");
  }
  return items;
}

function formatLinks(links: string[]): string {
  return `[${links.join(", ")}]`;
}

/**
 * Parse a memory-note file (frontmatter + body) into a validated
 * `SomaMemoryNote`. Throws `MemoryNoteError` (with `field`) on any violation.
 */
export function parseMemoryNote(content: string): SomaMemoryNote {
  assert(content.startsWith("---\n"), "note must start with a frontmatter block (---)");
  const closeIdx = content.indexOf("\n---\n", 3);
  assert(closeIdx !== -1, "frontmatter block is not closed with ---");

  const frontmatter = content.slice(4, closeIdx + 1); // between the two --- markers, keep trailing \n
  const body = content.slice(closeIdx + 5).trim();

  const raw: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    if (line === "") continue;
    const sep = line.indexOf(":");
    assert(sep !== -1, `malformed frontmatter line (no key): ${line}`);
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    assert(ALLOWED_KEYS.has(key), `unknown frontmatter key: ${key}`, key);
    assert(!(key in raw), `duplicate frontmatter key: ${key}`, key);
    raw[key] = value;
  }

  for (const key of REQUIRED_KEYS) {
    assert(key in raw, `missing required frontmatter key: ${key}`, key);
  }

  const id = raw.id;
  assert(SLUG.test(id) && id.length <= 64, `id "${id}" is not a valid slug (<=64 chars)`, "id");
  assert((NOTE_TYPES as readonly string[]).includes(raw.type), `type "${raw.type}" is not valid`, "type");
  assert((TRUSTS as readonly string[]).includes(raw.trust), `trust "${raw.trust}" is not valid`, "trust");
  assert(DATE.test(raw.created), `created "${raw.created}" must be YYYY-MM-DD`, "created");
  assert(DATE.test(raw.last_verified), `last_verified "${raw.last_verified}" must be YYYY-MM-DD`, "last_verified");
  assert(raw.valid_until === "null" || DATE.test(raw.valid_until), `valid_until must be null or YYYY-MM-DD`, "valid_until");

  const resurface = Number(raw.resurface_count);
  assert(/^\d+$/.test(raw.resurface_count) && Number.isInteger(resurface), `resurface_count must be an integer >= 0`, "resurface_count");
  assert(raw.provenance.length > 0, "provenance must not be empty", "provenance");
  assert(body.length > 0, "body must not be empty", "body");

  const note: SomaMemoryNote = {
    id,
    type: raw.type as SomaMemoryNoteType,
    created: raw.created,
    last_verified: raw.last_verified,
    valid_until: raw.valid_until === "null" ? null : raw.valid_until,
    provenance: raw.provenance,
    trust: raw.trust as SomaMemoryTrust,
    source_of_truth: raw.source_of_truth === "null" ? null : raw.source_of_truth,
    project: raw.project === "null" ? null : raw.project,
    links: parseLinks(raw.links),
    resurface_count: resurface,
    body,
  };
  if ("hook" in raw) note.hook = raw.hook;
  if ("review" in raw) note.review = raw.review;
  return note;
}

/**
 * Serialize a note to its canonical file form. `parse(serialize(n)) === n` for
 * any note whose body is already trimmed (the parser trims, so parsed notes
 * round-trip byte-stably). Validates by round-tripping through the parser's
 * rules is the caller's job; this emits exactly what the grammar accepts.
 */
export function serializeMemoryNote(note: SomaMemoryNote): string {
  const lines = [
    "---",
    `id: ${note.id}`,
    `type: ${note.type}`,
    `created: ${note.created}`,
    `last_verified: ${note.last_verified}`,
    `valid_until: ${note.valid_until ?? "null"}`,
    `provenance: ${note.provenance}`,
    `trust: ${note.trust}`,
    `source_of_truth: ${note.source_of_truth ?? "null"}`,
    `project: ${note.project ?? "null"}`,
    `links: ${formatLinks(note.links)}`,
    `resurface_count: ${note.resurface_count}`,
  ];
  if (note.hook !== undefined) lines.push(`hook: ${note.hook}`);
  if (note.review !== undefined) lines.push(`review: ${note.review}`);
  lines.push("---", "", note.body.trim(), "");
  return lines.join("\n");
}
