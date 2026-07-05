import { SOMA_MEMORY_NOTE_TYPES, SOMA_MEMORY_TRUSTS } from "./types";
import type { SomaMemoryNote, SomaMemoryNoteType, SomaMemoryTrust } from "./types";

/**
 * File-native memory note parser + serializer (memory subsystem M0).
 *
 * Contract is fixed by the plan v2 §2 (do not redesign): one note = strict
 * frontmatter + markdown body, with a tiny hand-written grammar (no YAML lib —
 * zero new runtime deps). The round-trip law `parse(serialize(n)) === n` holds
 * for any note whose body is already trimmed (both sides trim the body, so a
 * parsed note re-serializes byte-stably; an untrimmed body is the one lossy
 * case). `serializeMemoryNote` throws rather than emit a file that `parse`
 * would reject *or* that would parse back to a different note (it re-parses and
 * compares before returning) — see its docstring for the exact contract.
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

// The note-id / slug grammar (#410's "id grammar definition"): lowercase
// [a-z0-9], single hyphens between runs, no leading/trailing/double hyphens.
// Exported so every module that validates or MINTS an id (memory-write.ts's
// write-boundary guard, memory-consolidate.ts's episodic-id safety re-check,
// memory-episodic.ts's slug validation, and the generative slugifiers below)
// shares this ONE definition instead of re-declaring the same regex.
export const NOTE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const NOTE_ID_MAX_LEN = 64;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_TYPES: readonly SomaMemoryNoteType[] = SOMA_MEMORY_NOTE_TYPES;
const TRUSTS: readonly SomaMemoryTrust[] = SOMA_MEMORY_TRUSTS;

/** True iff `id` matches the note-id slug grammar and fits within `maxLen`
 *  (default 64, the frontmatter `id` field's own cap; a caller building a
 *  narrower id — e.g. an episodic action id that must leave room for its
 *  `YYYYMMDD-` prefix — passes a smaller cap). */
export function isValidNoteId(id: string, maxLen: number = NOTE_ID_MAX_LEN): boolean {
  return NOTE_ID_PATTERN.test(id) && id.length <= maxLen;
}

/**
 * Pure slug-shape transform: lowercase, collapse non-[a-z0-9] runs to a single
 * hyphen, trim leading/trailing hyphens, cap at `maxLen` (re-trimming a hyphen
 * that truncation may expose). May return `""` if nothing sluggable remains — the
 * building block for {@link toNoteIdSlug} below, exposed directly for a
 * composing caller that needs its own non-generic empty-input fallback (e.g.
 * memory-episodic.ts's collision-resistant session slug, which appends a hash
 * suffix rather than a placeholder word).
 */
export function noteIdSlugSegment(base: string, maxLen: number = NOTE_ID_MAX_LEN): string {
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
}

/**
 * Slugify `base` into a note-id-shaped slug — valid-by-construction: a caller
 * never needs to re-test the result against {@link isValidNoteId}. Replaces
 * the produce-then-validate scatter across memory-backfill.ts's `slugifyId`
 * and memory-promotion.ts's `slugify` (both delegate to this).
 *
 * If nothing sluggable remains (e.g. an all-punctuation title), returns
 * `fallback` (default `"note"`) — asserted to itself be a valid slug so this
 * function can never silently break its own guarantee.
 */
export function toNoteIdSlug(base: string, options: { maxLen?: number; fallback?: string } = {}): string {
  const maxLen = options.maxLen ?? NOTE_ID_MAX_LEN;
  const slug = noteIdSlugSegment(base, maxLen);
  if (slug.length > 0) return slug;
  const fallback = options.fallback ?? "note";
  if (!isValidNoteId(fallback, maxLen)) {
    throw new Error(`toNoteIdSlug: fallback "${fallback}" is not itself a valid slug (<=${maxLen} chars).`);
  }
  return fallback;
}

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
    assert(NOTE_ID_PATTERN.test(item), `links entry "${item}" is not a valid slug`, "links");
  }
  return items;
}

function formatLinks(links: string[]): string {
  return `[${links.join(", ")}]`;
}

// Fields compared verbatim between an input note and its re-parsed form to
// enforce the round-trip law by construction (body handled separately — it is
// the one field serialize normalizes, by trimming).
const ROUND_TRIP_SCALARS = [
  "id",
  "type",
  "created",
  "last_verified",
  "valid_until",
  "provenance",
  "trust",
  "source_of_truth",
  "project",
  "resurface_count",
  "hook",
  "review",
] as const;

/**
 * Return the first field whose value would not survive `serialize`→`parse`
 * unchanged, or `null` if the note round-trips exactly (body compared trimmed).
 *
 * This is what makes the round-trip law total: any field value that the
 * quote-less grammar would normalize or reinterpret — a newline forging extra
 * keys, stray leading/trailing whitespace the parser trims, or the reserved
 * literal "null" collapsing to the null sentinel — shows up here as a mismatch
 * between the input and its re-parsed form.
 */
function roundTripMismatch(input: SomaMemoryNote, reparsed: SomaMemoryNote): string | null {
  for (const field of ROUND_TRIP_SCALARS) {
    if (reparsed[field] !== input[field]) return field;
  }
  if (reparsed.body !== input.body.trim()) return "body";
  if (
    reparsed.links.length !== input.links.length ||
    reparsed.links.some((link, i) => link !== input.links[i])
  ) {
    return "links";
  }
  return null;
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
  assert(isValidNoteId(id), `id "${id}" is not a valid slug (<=${NOTE_ID_MAX_LEN} chars)`, "id");
  assert((NOTE_TYPES as readonly string[]).includes(raw.type), `type "${raw.type}" is not valid`, "type");
  assert((TRUSTS as readonly string[]).includes(raw.trust), `trust "${raw.trust}" is not valid`, "trust");
  assert(isCalendarDate(raw.created), `created "${raw.created}" must be a valid YYYY-MM-DD date`, "created");
  assert(isCalendarDate(raw.last_verified), `last_verified "${raw.last_verified}" must be a valid YYYY-MM-DD date`, "last_verified");
  assert(raw.valid_until === "null" || isCalendarDate(raw.valid_until), `valid_until must be null or a valid YYYY-MM-DD date`, "valid_until");

  const resurface = Number(raw.resurface_count);
  assert(
    /^\d+$/.test(raw.resurface_count) && Number.isSafeInteger(resurface),
    `resurface_count must be a safe integer >= 0`,
    "resurface_count",
  );
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
 * Serialize a note to its canonical file form.
 *
 * Round-trip law, enforced by construction: for any note this function
 * *accepts*, `parse(serialize(n))` equals `n` — with one normalization, the
 * body is trimmed (`serialize` writes `body.trim()`), so pass an already-trimmed
 * body for exact equality.
 *
 * `serialize` throws `MemoryNoteError` rather than emit a file that fails to
 * parse or that parses back to a *different* note. After building the output it
 * re-parses it (rejecting a bad slug/date/links/count/provenance) and compares
 * the result field-by-field against the input, so any value the grammar would
 * normalize or reinterpret — a newline forging extra keys, stray whitespace the
 * parser trims, or the reserved literal "null" collapsing to the null sentinel —
 * is caught here, naming the offending field.
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
  const output = lines.join("\n");
  // Enforce the round-trip law by construction: re-parse (validates every field)
  // and confirm the note survives unchanged. A mismatch means a value would be
  // normalized or reinterpreted (newline, whitespace, reserved "null") — refuse
  // to emit it rather than silently produce a note that won't round-trip.
  const mismatch = roundTripMismatch(note, parseMemoryNote(output));
  assert(
    mismatch === null,
    `field "${mismatch}" would not survive serialization unchanged ` +
      `(a newline, stray whitespace, or the reserved literal "null")`,
    mismatch ?? undefined,
  );
  return output;
}
