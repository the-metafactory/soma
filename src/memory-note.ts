import { SOMA_MEMORY_NOTE_TYPES, SOMA_MEMORY_TRUSTS } from "./types";
import type { SomaMemoryNote, SomaMemoryNoteType, SomaMemoryTrust } from "./types";

/**
 * File-native memory note parser + serializer (memory subsystem M0).
 *
 * Contract is fixed by the plan v2 §2 (do not redesign): one note = strict
 * frontmatter + markdown body, with a tiny hand-written grammar (no YAML lib —
 * zero new runtime deps). The round-trip law `parse(serialize(n)) === n` holds
 * for any note whose body is already trimmed; both sides normalize the body by
 * trimming, so a parsed note re-serializes byte-stably. The quote-less grammar
 * uses bare `null` as the null sentinel, so a nullable string field cannot also
 * carry the literal string "null" — `serializeMemoryNote` rejects that value up
 * front, keeping the law total rather than caveated.
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
const NOTE_TYPES: readonly SomaMemoryNoteType[] = SOMA_MEMORY_NOTE_TYPES;
const TRUSTS: readonly SomaMemoryTrust[] = SOMA_MEMORY_TRUSTS;

// Provenance is a closed set plus the open `tool:<name>` family (plan v2 §2.2,
// design doc line 105): conversation | consolidation | import | tool:<name>.
const PROVENANCE_LITERALS = new Set(["conversation", "consolidation", "import"]);

/**
 * True iff `s` is `YYYY-MM-DD` AND a real calendar date. The shape regex alone
 * accepts impossible dates like `2026-99-99`; round-tripping through a UTC Date
 * rejects them (Feb 30, month 13, day 00, …).
 */
function isCalendarDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

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
 * Guard a nullable string field against the reserved literal "null", which the
 * quote-less grammar cannot distinguish from the `null` sentinel. Rejecting it
 * on serialize makes the round-trip law total.
 */
function assertNotReservedNull(value: string | null, field: string): void {
  assert(
    value !== "null",
    `${field} cannot be the reserved literal "null" (collides with the null sentinel)`,
    field,
  );
}

/**
 * Parse a memory-note file (frontmatter + body) into a validated
 * `SomaMemoryNote`. Throws `MemoryNoteError` (with `field`) on any violation.
 *
 * Validates the `id` slug *shape* only; the id==filename-stem invariant is the
 * storage layer's contract (M1 `memoryNotePath`), since a pure content parser
 * has no filename to compare against.
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
  assert(isCalendarDate(raw.created), `created "${raw.created}" must be a valid YYYY-MM-DD date`, "created");
  assert(isCalendarDate(raw.last_verified), `last_verified "${raw.last_verified}" must be a valid YYYY-MM-DD date`, "last_verified");
  assert(raw.valid_until === "null" || isCalendarDate(raw.valid_until), `valid_until must be null or a valid YYYY-MM-DD date`, "valid_until");

  const resurface = Number(raw.resurface_count);
  assert(/^\d+$/.test(raw.resurface_count) && Number.isInteger(resurface), `resurface_count must be an integer >= 0`, "resurface_count");
  assert(
    PROVENANCE_LITERALS.has(raw.provenance) || /^tool:.+/.test(raw.provenance),
    `provenance "${raw.provenance}" must be conversation, consolidation, import, or tool:<name>`,
    "provenance",
  );
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
 * round-trip byte-stably). Throws `MemoryNoteError` if a nullable string field
 * holds the reserved literal "null" — the one value the quote-less grammar
 * cannot round-trip — so the law is total, not caveated.
 */
export function serializeMemoryNote(note: SomaMemoryNote): string {
  assertNotReservedNull(note.source_of_truth, "source_of_truth");
  assertNotReservedNull(note.project, "project");
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
