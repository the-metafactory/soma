import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPaths } from "./paths";
import { appendSomaMemoryEvent } from "./memory";
import { parseMemoryNote, serializeMemoryNote, MemoryNoteError } from "./memory-note";
import { SOMA_MEMORY_TRIGGER_TRUST } from "./types";
import type {
  SomaMemoryDuplicateCandidate,
  SomaMemoryNote,
  SomaMemoryNoteType,
  SomaMemoryVerifyOptions,
  SomaMemoryVerifyResult,
  SomaMemoryWriteOptions,
  SomaMemoryWriteResult,
} from "./types";

/**
 * Memory write + verify (subsystem M1). Plan v2 §M1 (do not redesign the
 * governance model):
 *
 * - **Trust is derived from the trigger**, never a caller flag — a substrate-side
 *   caller cannot self-assert `principal`. `principal-correction` is the sole path
 *   to `principal` trust and is the documented human-authority gate; `import` is
 *   always `quarantined` (MINJA defense); `consolidation` is `assistant`.
 * - **Recall-first refusal** — `create` walks the durable corpus (`semantic/` +
 *   `procedural/`), hashes normalized bodies, and refuses when an active note is
 *   an exact-body match OR Jaccard ≥ 0.6 (transplant #1 from recall's dedup
 *   idea; reimplemented over files, not copied). `--force` overrides; `merge` /
 *   `supersede` name a target explicitly and skip the gate.
 * - **Invalidate, never delete** — `supersede` sets the old note's `valid_until`
 *   and cross-links; nothing is unlinked. `merge` delta-appends (ACE-style,
 *   never regenerates).
 * - One mutating call → exactly one events journal line: the file write and its
 *   event append are atomic — if the append fails, the file mutation is rolled
 *   back (created files unlinked, edited files restored to prior bytes), so the
 *   journal never under- or over-counts a mutation.
 *
 * Deterministic: dates come from an injected `now` (UTC), no LLM calls, writes
 * stay within the Soma memory tree under `memory/semantic/` + `memory/procedural/`.
 */

// The recall-first refusal fires at/above this Jaccard token-set overlap.
// Adapted from recall's dedup concept (see Plans/2026-07-02-recall-adoption-analysis.md);
// Soma owns the constant after port.
export const MEMORY_DEDUP_JACCARD_THRESHOLD = 0.6;

// The durable, dedup-gated corpus. Episodic notes live elsewhere (M5) and are
// not written through this path.
const WRITABLE_TYPE_DIRS: Record<Exclude<SomaMemoryNoteType, "episodic">, string> = {
  semantic: "semantic",
  procedural: "procedural",
};

type WritableType = Exclude<SomaMemoryNoteType, "episodic">;

function assertNonEmpty(value: string | undefined, field: string): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new MemoryNoteError(`Soma memory write ${field} must not be empty.`, field);
  }
}

// Same slug grammar the M0 parser enforces on `id`. Validated HERE at the write
// boundary — before the id is ever joined into a filesystem path — so a
// traversal id (`../../evil`) is refused up front rather than incidentally by
// serialize's round-trip re-parse. Defense in depth: memoryNotePath must never
// receive an unvalidated id.
const NOTE_ID_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertNoteId(id: string): void {
  if (!NOTE_ID_SLUG.test(id) || id.length > 64) {
    throw new MemoryNoteError(`id "${id}" is not a valid slug (lowercase [a-z0-9-], <=64 chars).`, "id");
  }
}

/**
 * Append the mutation's event; on failure, roll the file mutation back so the
 * "one mutation → one event" invariant holds. `rollback` restores disk to its
 * pre-mutation state (unlink a created file, or rewrite an edited one's prior
 * bytes).
 */
async function appendMutationEvent(
  somaHome: string,
  input: Parameters<typeof appendSomaMemoryEvent>[1],
  rollback: () => Promise<void>,
): ReturnType<typeof appendSomaMemoryEvent> {
  return appendSomaMemoryEvent(somaHome, input).catch(async (error: unknown) => {
    await rollback().catch(() => undefined);
    throw new Error(`Soma memory ${input.kind} event append failed; rolled back the file mutation.`, { cause: error });
  });
}

/** YYYY-MM-DD in UTC — matches the note schema's calendar-date grammar. */
function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Directory holding notes of a writable type. */
function typeDir(somaHome: string, type: WritableType): string {
  return createPaths(somaHome).resolve("memory", WRITABLE_TYPE_DIRS[type]);
}

/**
 * Canonical on-disk path for a note. The id==filename-stem invariant that the M0
 * parser documents but cannot enforce (a content parser has no filename) is
 * bound here.
 */
export function memoryNotePath(somaHome: string, type: WritableType, id: string): string {
  return join(typeDir(somaHome, type), `${id}.md`);
}

// --- dedup engine (transplant #1) --------------------------------------------

/** Normalized body for exact-hash comparison: lowercased, whitespace-collapsed. */
function normalizeBody(body: string): string {
  return body.toLowerCase().replace(/\s+/g, " ").trim();
}

function bodyHash(body: string): string {
  return createHash("sha256").update(normalizeBody(body)).digest("hex");
}

/** Token set for Jaccard near-match — 3+ char alnum tokens, same floor as search. */
function bodyTokens(body: string): Set<string> {
  return new Set(
    body
      .toLowerCase()
      .split(/[^a-z0-9À-ɏ]+/i)
      .filter((token) => token.length >= 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface LoadedNote {
  path: string;
  type: WritableType;
  note: SomaMemoryNote;
  /** The exact on-disk bytes — used to restore the file on event-append rollback. */
  raw: string;
}

/** Parse every `.md` note under the durable corpus; skip unreadable/malformed. */
async function collectDurableNotes(somaHome: string): Promise<LoadedNote[]> {
  // Read files with per-directory parallelism (matches src/memory.ts's search
  // walk) — a create against a large corpus must not serialize on every read.
  const perType = await Promise.all(
    (Object.keys(WRITABLE_TYPE_DIRS) as WritableType[]).map(async (type) => {
      const dir = typeDir(somaHome, type);
      const entries = (await readdir(dir).catch(() => [] as string[])).filter((entry) => entry.endsWith(".md"));
      const notes = await Promise.all(
        entries.map(async (entry): Promise<LoadedNote | undefined> => {
          const path = join(dir, entry);
          const content = await readFile(path, "utf8").catch(() => undefined);
          if (content === undefined) return undefined;
          try {
            return { path, type, note: parseMemoryNote(content), raw: content };
          } catch {
            return undefined; // a hand-broken note must not block a legitimate write
          }
        }),
      );
      return notes.filter((entry): entry is LoadedNote => entry !== undefined);
    }),
  );
  return perType.flat();
}

/**
 * Candidates that would make `create` a duplicate. Only ACTIVE notes
 * (`valid_until === null`) count — a superseded note is already closed, so a new
 * note overlapping it is the intended replacement, not a duplicate.
 */
export async function findDuplicateCandidates(
  somaHome: string,
  body: string,
): Promise<SomaMemoryDuplicateCandidate[]> {
  const hash = bodyHash(body);
  const tokens = bodyTokens(body);
  const candidates: SomaMemoryDuplicateCandidate[] = [];

  for (const { path, type, note } of await collectDurableNotes(somaHome)) {
    if (note.valid_until !== null) continue;
    const exact = bodyHash(note.body) === hash;
    const score = exact ? 1 : jaccard(tokens, bodyTokens(note.body));
    if (exact || score >= MEMORY_DEDUP_JACCARD_THRESHOLD) {
      candidates.push({ id: note.id, type, path, score, exact });
    }
  }

  return candidates.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

// --- trust / provenance derivation -------------------------------------------

/**
 * Resolve provenance from trigger, closing the smuggling hole where tool/web
 * content rides in under `principal` trust:
 * - `principal-correction` → forced `conversation` (a correction happens in the
 *   conversation; a tool-sourced fact is not a principal correction).
 * - `consolidation` → forced `consolidation`.
 * - `import` → caller may pass `import` (default) or `tool:<name>`; anything else
 *   is refused. Either way the derived trust is `quarantined`.
 */
function resolveProvenance(options: SomaMemoryWriteOptions): string {
  switch (options.trigger) {
    case "principal-correction":
      if (options.provenance !== undefined && options.provenance !== "conversation") {
        throw new MemoryNoteError(
          `principal-correction writes are provenance "conversation"; refusing "${options.provenance}" ` +
            `(tool/import content cannot ride in under principal trust).`,
          "provenance",
        );
      }
      return "conversation";
    case "consolidation":
      if (options.provenance !== undefined && options.provenance !== "consolidation") {
        throw new MemoryNoteError(`consolidation writes are provenance "consolidation".`, "provenance");
      }
      return "consolidation";
    case "import": {
      const provenance = options.provenance ?? "import";
      if (provenance !== "import" && !/^tool:.+/.test(provenance)) {
        throw new MemoryNoteError(`import provenance must be "import" or "tool:<name>".`, "provenance");
      }
      return provenance;
    }
  }
}

// --- shared write helpers -----------------------------------------------------

async function writeNoteFile(path: string, note: SomaMemoryNote, flag: "wx" | "w"): Promise<void> {
  const content = serializeMemoryNote(note); // enforces the round-trip law before any byte hits disk
  await mkdir(join(path, ".."), { recursive: true });
  try {
    await writeFile(path, content, { encoding: "utf8", flag });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EEXIST") {
      throw new MemoryNoteError(`Soma memory note already exists: ${path}`, "id");
    }
    throw error;
  }
}

/** Find an active-or-superseded note by id across the durable corpus. */
async function loadNoteById(somaHome: string, id: string): Promise<LoadedNote> {
  for (const loaded of await collectDurableNotes(somaHome)) {
    if (loaded.note.id === id) return loaded;
  }
  throw new MemoryNoteError(`Soma memory note not found: ${id}`, "id");
}

// --- create / merge / supersede ----------------------------------------------

function buildNewNote(options: SomaMemoryWriteOptions, now: Date): SomaMemoryNote {
  assertNonEmpty(options.id, "id");
  assertNoteId(options.id);
  if (options.type === undefined || options.type === "episodic") {
    throw new MemoryNoteError(`type must be "semantic" or "procedural" (episodic writes go through digest/action, M5).`, "type");
  }
  assertNonEmpty(options.body, "body");

  const today = isoDate(now);
  const note: SomaMemoryNote = {
    id: options.id,
    type: options.type,
    created: today,
    last_verified: today,
    valid_until: null,
    provenance: resolveProvenance(options),
    trust: SOMA_MEMORY_TRIGGER_TRUST[options.trigger],
    source_of_truth: options.sourceOfTruth ?? null,
    project: options.project ?? null,
    links: options.links ?? [],
    resurface_count: 0,
    body: options.body,
  };
  if (options.hook !== undefined) note.hook = options.hook;
  if (options.review !== undefined) note.review = options.review;
  return note;
}

async function createNote(somaHome: string, options: SomaMemoryWriteOptions, now: Date): Promise<SomaMemoryWriteResult> {
  const note = buildNewNote(options, now);

  if (!options.force) {
    const candidates = await findDuplicateCandidates(somaHome, note.body);
    if (candidates.length > 0) {
      const list = candidates.map((c) => `${c.id} (${c.exact ? "exact" : c.score.toFixed(2)})`).join(", ");
      throw new MemoryNoteError(
        `Recall-first refusal: ${candidates.length} similar note(s) exist — ${list}. ` +
          `Re-run with --merge <id>, --supersede <id>, or --force.`,
      );
    }
  }

  const path = memoryNotePath(somaHome, note.type as WritableType, note.id);
  await writeNoteFile(path, note, "wx");

  const event = await appendMutationEvent(
    somaHome,
    {
      timestamp: now.toISOString(),
      substrate: options.substrate ?? "custom",
      kind: "memory.write.create",
      summary: `Created memory note ${note.id} (${note.type}, trust ${note.trust})`,
      artifactPaths: [path],
      metadata: { id: note.id, type: note.type, trust: note.trust, trigger: options.trigger },
    },
    () => unlink(path), // roll back: remove the freshly created file
  );

  return { somaHome, mode: "create", path, note, event };
}

async function mergeNote(somaHome: string, options: SomaMemoryWriteOptions, now: Date): Promise<SomaMemoryWriteResult> {
  assertNonEmpty(options.targetId, "targetId");
  assertNonEmpty(options.body, "body");
  const { path, type, note, raw } = await loadNoteById(somaHome, options.targetId);
  if (note.valid_until !== null) {
    throw new MemoryNoteError(`Cannot merge into superseded note ${note.id} (valid_until set).`, "targetId");
  }

  const today = isoDate(now);
  const merged: SomaMemoryNote = {
    ...note,
    last_verified: today,
    body: `${note.body}\n\n**Update (${today}):** ${options.body.trim()}`,
  };
  await writeNoteFile(path, merged, "w");

  const event = await appendMutationEvent(
    somaHome,
    {
      timestamp: now.toISOString(),
      substrate: options.substrate ?? "custom",
      kind: "memory.write.merge",
      summary: `Merged update into memory note ${merged.id} (${type})`,
      artifactPaths: [path],
      metadata: { id: merged.id, type },
    },
    () => writeFile(path, raw, "utf8"), // roll back: restore the pre-merge bytes
  );

  return { somaHome, mode: "merge", path, note: merged, event };
}

async function supersedeNote(somaHome: string, options: SomaMemoryWriteOptions, now: Date): Promise<SomaMemoryWriteResult> {
  assertNonEmpty(options.targetId, "targetId");
  const newNote = buildNewNote(options, now);
  if (newNote.id === options.targetId) {
    throw new MemoryNoteError(`A note cannot supersede itself (${newNote.id}).`, "id");
  }

  const old = await loadNoteById(somaHome, options.targetId);
  if (old.note.valid_until !== null) {
    throw new MemoryNoteError(`Note ${old.note.id} is already superseded (valid_until set).`, "targetId");
  }

  // New note points back at what it replaces; the closed note points forward.
  if (!newNote.links.includes(old.note.id)) newNote.links = [...newNote.links, old.note.id];
  const closed: SomaMemoryNote = {
    ...old.note,
    valid_until: isoDate(now),
    links: old.note.links.includes(newNote.id) ? old.note.links : [...old.note.links, newNote.id],
  };

  const newPath = memoryNotePath(somaHome, newNote.type as WritableType, newNote.id);
  await writeNoteFile(newPath, newNote, "wx");
  try {
    await writeNoteFile(old.path, closed, "w");
  } catch (error) {
    await unlink(newPath).catch(() => undefined); // keep the supersede atomic-ish
    throw error;
  }

  const event = await appendMutationEvent(
    somaHome,
    {
      timestamp: now.toISOString(),
      substrate: options.substrate ?? "custom",
      kind: "memory.write.supersede",
      summary: `Note ${newNote.id} supersedes ${closed.id} (closed ${closed.valid_until})`,
      artifactPaths: [newPath, old.path],
      metadata: { id: newNote.id, supersededId: closed.id },
    },
    // roll back BOTH sides: drop the new note AND reopen the closed one.
    async () => {
      await unlink(newPath).catch(() => undefined);
      await writeFile(old.path, old.raw, "utf8").catch(() => undefined);
    },
  );

  return { somaHome, mode: "supersede", path: newPath, note: newNote, supersededId: closed.id, event };
}

export async function writeMemoryNote(options: SomaMemoryWriteOptions): Promise<SomaMemoryWriteResult> {
  const somaHome = createPaths(options).root();
  const now = options.now ?? new Date();
  switch (options.mode) {
    case "create":
      return createNote(somaHome, options, now);
    case "merge":
      return mergeNote(somaHome, options, now);
    case "supersede":
      return supersedeNote(somaHome, options, now);
  }
}

// --- verify ------------------------------------------------------------------

/**
 * Close the reinforcing loop: a resurfaced note that proved correct bumps
 * `last_verified` to today and increments `resurface_count`. This is the decay
 * signal M3's retention score reads.
 */
export async function verifyMemoryNote(options: SomaMemoryVerifyOptions): Promise<SomaMemoryVerifyResult> {
  assertNonEmpty(options.id, "id");
  const somaHome = createPaths(options).root();
  const now = options.now ?? new Date();
  const { path, type, note, raw } = await loadNoteById(somaHome, options.id);

  const verified: SomaMemoryNote = {
    ...note,
    last_verified: isoDate(now),
    resurface_count: note.resurface_count + 1,
  };
  await writeNoteFile(path, verified, "w");

  const event = await appendMutationEvent(
    somaHome,
    {
      timestamp: now.toISOString(),
      substrate: options.substrate ?? "custom",
      kind: "memory.verify",
      summary: `Verified memory note ${verified.id} (${type}); resurface_count ${verified.resurface_count}`,
      artifactPaths: [path],
      metadata: { id: verified.id, type, resurfaceCount: verified.resurface_count },
    },
    () => writeFile(path, raw, "utf8"), // roll back: restore the pre-verify bytes
  );

  return { somaHome, path, note: verified, event };
}
