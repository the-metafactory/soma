import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPaths } from "./paths";
import { runBoundedConcurrent } from "./internal-concurrency";
import { appendSomaMemoryEvent } from "./memory";
import { parseMemoryNote, serializeMemoryNote, MemoryNoteError } from "./memory-note";
import { SOMA_MEMORY_TRIGGER_TRUST } from "./types";
import type {
  SomaMemoryDuplicateCandidate,
  SomaMemoryNote,
  SomaMemoryNoteType,
  SomaMemoryTrust,
  SomaMemoryVerifyOptions,
  SomaMemoryVerifyResult,
  SomaMemoryWriteOptions,
  SomaMemoryWriteResult,
  SomaMemoryWriteTrigger,
} from "./types";

/**
 * Memory write + verify (subsystem M1). Plan v2 §M1 (do not redesign the
 * governance model):
 *
 * - **Trust is derived from the trigger**, never a caller flag — a substrate-side
 *   caller cannot self-assert `principal`. `principal-correction` is the sole path
 *   to `principal` trust AND requires an explicit `principalAuthority` escalation
 *   (sudo-style: deliberate + logged, refused by default — not cryptographic
 *   auth, which soma has no primitive for); `import` is always `quarantined`
 *   (MINJA defense); `consolidation` is `assistant`.
 * - **Recall-first refusal** — `create` walks the durable corpus (`semantic/` +
 *   `procedural/`), hashes normalized bodies, and refuses when an active note is
 *   an exact-body match OR Jaccard ≥ 0.6 (transplant #1 from recall's dedup
 *   idea; reimplemented over files, not copied). Unreadable/malformed notes
 *   can't be scanned, so their count is surfaced (in the refusal message and the
 *   create event) — the gate never fails open silently. `--force` overrides;
 *   `merge` / `supersede` name a target explicitly and skip the gate.
 * - **Invalidate, never delete** — `supersede` sets the old note's `valid_until`
 *   and cross-links; nothing is unlinked. `merge` delta-appends (ACE-style,
 *   never regenerates).
 * - One mutating call → one events journal line: if the event append fails, the
 *   file mutation is rolled back (created files unlinked, edited files restored
 *   to prior bytes), so an append failure never leaves a note without its event.
 *   This is NOT crash-atomic — a process kill in the window between the file
 *   write and the append can still orphan a file from its event (a documented
 *   gap reconciled by the M7 audit; soma has no WAL/2PC primitive).
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

// One source of truth for the writable-type enumeration — every helper that
// walks both durable dirs reuses this instead of re-casting Object.keys.
const WRITABLE_TYPES = Object.keys(WRITABLE_TYPE_DIRS) as WritableType[];

// Trust ordering for the mutation gate: content may never be injected into a
// note of HIGHER trust than the mutation's own trigger carries.
const TRUST_RANK: Record<SomaMemoryTrust, number> = { quarantined: 0, assistant: 1, principal: 2 };

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
 * Append the mutation's event; if the append fails, roll the file mutation back
 * so no file mutation is ever left without its event. `rollback` restores disk
 * to its pre-mutation state (unlink a created file, or rewrite an edited one's
 * prior bytes) and MUST throw if it cannot — a swallowed rollback failure would
 * report "rolled back" while leaving the note in a mutated state.
 *
 * NOTE (honest limitation): this guards against an append *rejection*, not a
 * process crash/kill in the window between the file write and this append. A
 * hard crash there can still leave a file without an event; the journal is
 * best-effort append-only and that gap is reconciled by a later audit (M7), not
 * prevented here. Soma has no write-ahead-log / 2-phase-commit primitive.
 */
async function appendMutationEvent(
  somaHome: string,
  input: Parameters<typeof appendSomaMemoryEvent>[1],
  rollback: () => Promise<void>,
): ReturnType<typeof appendSomaMemoryEvent> {
  return appendSomaMemoryEvent(somaHome, input).catch(async (appendError: unknown) => {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new Error(
        `Soma memory ${input.kind} event append failed AND the rollback failed — ` +
          `memory may be inconsistent; reconcile manually.`,
        { cause: rollbackError },
      );
    }
    throw new Error(`Soma memory ${input.kind} event append failed; rolled back the file mutation.`, { cause: appendError });
  });
}

/**
 * Fill the shared event envelope (timestamp + substrate) for a note mutation so
 * the four mutation paths can't drift on journal shape, then append-with-rollback.
 */
async function appendNoteMutationEvent(
  somaHome: string,
  now: Date,
  substrate: SomaMemoryWriteOptions["substrate"],
  fields: { kind: string; summary: string; artifactPaths: string[]; metadata: Record<string, unknown> },
  rollback: () => Promise<void>,
): ReturnType<typeof appendSomaMemoryEvent> {
  return appendMutationEvent(
    somaHome,
    { timestamp: now.toISOString(), substrate: substrate ?? "custom", ...fields },
    rollback,
  );
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

interface ScannedNote {
  path: string;
  type: WritableType;
  note: SomaMemoryNote;
}

interface LoadedNote extends ScannedNote {
  /** The exact on-disk bytes — used to restore the file on event-append rollback. */
  raw: string;
}

/**
 * Guard every mutation of an EXISTING note (merge body, supersede-close). Two
 * rules, both anti-injection:
 *   1. The mutation's trigger-trust must be ≥ the target's trust — a tool/import
 *      caller (quarantined) can never inject content into an assistant/principal
 *      note while the note keeps its higher trust ("import is always quarantined"
 *      would otherwise be a lie for merges).
 *   2. Mutating a `principal` note additionally needs the explicit
 *      `principalAuthority` escalation — the same deliberate, logged act that
 *      minted it.
 */
function assertMayMutate(target: SomaMemoryNote, trigger: SomaMemoryWriteTrigger, principalAuthority: boolean): void {
  const incoming = SOMA_MEMORY_TRIGGER_TRUST[trigger];
  if (TRUST_RANK[incoming] < TRUST_RANK[target.trust]) {
    throw new MemoryNoteError(
      `Cannot mutate ${target.trust}-trust note ${target.id} with ${incoming}-trust content ` +
        `(trigger ${trigger}) — a mutation may not inject lower-trust content.`,
      "trigger",
    );
  }
  if (target.trust === "principal" && !principalAuthority) {
    throw new MemoryNoteError(
      `Mutating principal-trust note ${target.id} requires --principal-authority ` +
        `(the same deliberate escalation that minted it).`,
      "principalAuthority",
    );
  }
}

/**
 * Event metadata that records the principal-authority escalation, so an audit
 * can prove from the journal alone that a principal-trust mutation was
 * authorized. Emitted whenever the resulting/target note is principal-trust.
 */
function principalAuthorityMeta(trust: SomaMemoryTrust): Record<string, unknown> {
  return trust === "principal" ? { principalAuthority: true } : {};
}

// Bounded read concurrency for the dedup scan — parallel enough to not serialize
// on every note, capped so a large corpus can't spike FDs on the write path.
const DEDUP_SCAN_CONCURRENCY = 16;

interface CorpusScan {
  notes: ScannedNote[];
  /** Paths that exist but could not be read or parsed — invisible to dedup. */
  unreadable: string[];
}

/**
 * Parse every `.md` note under the durable corpus. Unreadable/malformed files
 * cannot block a legitimate write, but they are NOT silently dropped: their
 * paths are returned so the caller can surface that the corpus was only
 * partially scanned (the dedup gate would otherwise fail open on a corrupt
 * near-duplicate). Returns `ScannedNote` (no `raw`) — the dedup scan never needs
 * the bytes; `loadNoteById` reads raw itself for its rollback path.
 */
async function collectDurableNotes(somaHome: string): Promise<CorpusScan> {
  // Enumerate all note files across both durable dirs, then read them with a
  // bounded concurrency window (shared helper) rather than one unbounded
  // Promise.all over the whole tree.
  const targets: { path: string; type: WritableType }[] = [];
  const unreadableDirs: string[] = [];
  for (const type of WRITABLE_TYPES) {
    const dir = typeDir(somaHome, type);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      // A missing dir is genuinely empty; any OTHER error (e.g. permissions) is
      // an unscanned blind spot and must be surfaced, not treated as empty.
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") unreadableDirs.push(dir);
      continue;
    }
    for (const entry of entries.filter((entry) => entry.endsWith(".md"))) {
      targets.push({ path: join(dir, entry), type });
    }
  }

  const scanned = await runBoundedConcurrent(
    targets,
    async ({ path, type }): Promise<ScannedNote | { unreadable: string }> => {
      const content = await readFile(path, "utf8").catch(() => undefined);
      if (content === undefined) return { unreadable: path };
      try {
        return { path, type, note: parseMemoryNote(content) };
      } catch {
        return { unreadable: path };
      }
    },
    DEDUP_SCAN_CONCURRENCY,
  );

  const notes: ScannedNote[] = [];
  const unreadable: string[] = [...unreadableDirs]; // dir-level blind spots count too
  for (const entry of scanned) {
    if ("unreadable" in entry) unreadable.push(entry.unreadable);
    else notes.push(entry);
  }
  return { notes, unreadable };
}

export interface DuplicateScanResult {
  candidates: SomaMemoryDuplicateCandidate[];
  /** Active-corpus files that could not be scanned — the gate's blind spot. */
  unreadable: string[];
}

/**
 * Candidates that would make `create` a duplicate. Only ACTIVE notes
 * (`valid_until === null`) count — a superseded note is already closed, so a new
 * note overlapping it is the intended replacement, not a duplicate. Also returns
 * the unreadable-file list so callers never treat "no candidates" as "corpus
 * fully checked" (the gate must not fail open silently).
 */
export async function findDuplicateCandidates(somaHome: string, body: string): Promise<DuplicateScanResult> {
  const hash = bodyHash(body);
  const tokens = bodyTokens(body);
  const candidates: SomaMemoryDuplicateCandidate[] = [];

  const { notes, unreadable } = await collectDurableNotes(somaHome);
  for (const { path, type, note } of notes) {
    if (note.valid_until !== null) continue;
    const exact = bodyHash(note.body) === hash;
    const score = exact ? 1 : jaccard(tokens, bodyTokens(note.body));
    if (exact || score >= MEMORY_DEDUP_JACCARD_THRESHOLD) {
      candidates.push({ id: note.id, type, path, score, exact });
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return { candidates, unreadable };
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
      // Anchored safe grammar at the trust boundary: a `tool:` name is a bounded
      // slug, so untrusted import input can't smuggle a newline/extra frontmatter
      // field (e.g. `tool:x\ntrust: principal`) through this check.
      if (provenance !== "import" && !/^tool:[a-z0-9][a-z0-9._-]{0,63}$/i.test(provenance)) {
        throw new MemoryNoteError(`import provenance must be "import" or "tool:<name>" (name: [a-z0-9._-], <=64 chars).`, "provenance");
      }
      return provenance;
    }
  }
}

// --- shared write helpers -----------------------------------------------------

async function writeNoteFile(path: string, note: SomaMemoryNote, flag: "wx" | "w"): Promise<void> {
  const content = serializeMemoryNote(note); // enforces the round-trip law before any byte hits disk
  await mkdir(dirname(path), { recursive: true });
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

/**
 * Restore raw bytes to `path` on a rollback, recreating the parent dir first —
 * a normal write always recreates parents (writeNoteFile), so the restore path
 * must too, or an externally-removed directory would defeat the rollback.
 */
async function restoreBytes(path: string, raw: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, raw, "utf8");
}

/**
 * Load one note by id by probing its two possible paths directly
 * (`semantic/<id>.md`, `procedural/<id>.md`) — O(1) I/O, not an O(corpus) scan.
 * Ids are globally unique across types (enforced at create/supersede), so at
 * most one path resolves; if both somehow exist, semantic wins deterministically.
 */
async function loadNoteById(somaHome: string, id: string): Promise<LoadedNote> {
  assertNoteId(id); // a lookup id is also a path segment — never probe an unsafe one
  for (const type of WRITABLE_TYPES) {
    const path = memoryNotePath(somaHome, type, id);
    const raw = await readFile(path, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    return { path, type, note: parseMemoryNote(raw), raw };
  }
  throw new MemoryNoteError(`Soma memory note not found: ${id}`, "id");
}

/**
 * True iff a note FILE with this id already exists under either durable type.
 * A pure presence check (`access`), NOT a parse — a malformed `semantic/<id>.md`
 * must still block a colliding `procedural/<id>.md`, so id uniqueness holds even
 * over a hand-corrupted corpus.
 */
async function noteIdExists(somaHome: string, id: string): Promise<boolean> {
  assertNoteId(id);
  for (const type of WRITABLE_TYPES) {
    const exists = await access(memoryNotePath(somaHome, type, id)).then(
      () => true,
      () => false,
    );
    if (exists) return true;
  }
  return false;
}

// --- create / merge / supersede ----------------------------------------------

function buildNewNote(options: SomaMemoryWriteOptions, now: Date): SomaMemoryNote {
  assertNonEmpty(options.id, "id");
  assertNoteId(options.id);
  if (options.type === undefined || options.type === "episodic") {
    throw new MemoryNoteError(`type must be "semantic" or "procedural" (episodic writes go through digest/action, M5).`, "type");
  }
  assertNonEmpty(options.body, "body");

  // The deliberate-escalation gate: `principal` trust is never the incidental
  // result of a bare trigger flag. Without an explicit authority signal, a
  // principal-correction write is REFUSED (not downgraded) — an automated
  // assistant invocation defaults safe.
  if (options.trigger === "principal-correction" && options.principalAuthority !== true) {
    throw new MemoryNoteError(
      `principal-correction mints principal trust and requires explicit principal authority ` +
        `(--principal-authority). This is a deliberate, logged escalation — not automatic from the trigger.`,
      "trigger",
    );
  }

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

  // Cheap path-existence check FIRST — reject an id collision before paying for
  // the whole-corpus dedup scan. Ids are globally unique across types, so this
  // also rejects `procedural/foo` when `semantic/foo` exists (`wx` below only
  // catches a same-path collision).
  if (await noteIdExists(somaHome, note.id)) {
    throw new MemoryNoteError(`Soma memory note id already exists: ${note.id}`, "id");
  }

  // --force bypasses the gate, so skip the O(corpus) scan entirely — a forced
  // create should not pay to read/parse every note. When we DO scan (the normal
  // path), the unreadable count is recorded so the gate never fails open silently.
  let unreadable: string[] = [];
  if (!options.force) {
    const scan = await findDuplicateCandidates(somaHome, note.body);
    unreadable = scan.unreadable;
    if (scan.candidates.length > 0) {
      const list = scan.candidates.map((c) => `${c.id} (${c.exact ? "exact" : c.score.toFixed(2)})`).join(", ");
      const blindSpot = unreadable.length > 0 ? ` (${unreadable.length} note(s)/dir(s) were unreadable and not checked)` : "";
      throw new MemoryNoteError(
        `Recall-first refusal: ${scan.candidates.length} similar note(s) exist — ${list}${blindSpot}. ` +
          `Re-run with --merge <id>, --supersede <id>, or --force.`,
      );
    }
  }

  const path = memoryNotePath(somaHome, note.type as WritableType, note.id);
  await writeNoteFile(path, note, "wx");

  const event = await appendNoteMutationEvent(
    somaHome,
    now,
    options.substrate,
    {
      kind: "memory.write.create",
      summary: `Created memory note ${note.id} (${note.type}, trust ${note.trust})`,
      artifactPaths: [path],
      metadata: {
        id: note.id,
        type: note.type,
        trust: note.trust,
        trigger: options.trigger,
        ...principalAuthorityMeta(note.trust), // audit the escalation when principal
        // Record the dedup gate's blind spot so "dedup-gated" is never a silent
        // overstatement when part of the corpus was unreadable.
        ...(unreadable.length > 0 ? { dedupUnreadable: unreadable.length } : {}),
      },
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
  assertMayMutate(note, options.trigger, options.principalAuthority === true);

  const today = isoDate(now);
  const merged: SomaMemoryNote = {
    ...note,
    last_verified: today,
    body: `${note.body}\n\n**Update (${today}):** ${options.body.trim()}`,
  };
  await writeNoteFile(path, merged, "w");

  const event = await appendNoteMutationEvent(
    somaHome,
    now,
    options.substrate,
    {
      kind: "memory.write.merge",
      summary: `Merged update into memory note ${merged.id} (${type})`,
      artifactPaths: [path],
      // Log the escalation so an audit can prove a principal-note mutation was authorized.
      metadata: { id: merged.id, type, trust: merged.trust, trigger: options.trigger, ...principalAuthorityMeta(merged.trust) },
    },
    () => restoreBytes(path, raw), // roll back: restore the pre-merge bytes
  );

  return { somaHome, mode: "merge", path, note: merged, event };
}

async function supersedeNote(somaHome: string, options: SomaMemoryWriteOptions, now: Date): Promise<SomaMemoryWriteResult> {
  assertNonEmpty(options.targetId, "targetId");
  const newNote = buildNewNote(options, now);
  if (newNote.id === options.targetId) {
    throw new MemoryNoteError(`A note cannot supersede itself (${newNote.id}).`, "id");
  }

  if (await noteIdExists(somaHome, newNote.id)) {
    throw new MemoryNoteError(`Soma memory note id already exists: ${newNote.id}`, "id");
  }

  const old = await loadNoteById(somaHome, options.targetId);
  if (old.note.valid_until !== null) {
    throw new MemoryNoteError(`Note ${old.note.id} is already superseded (valid_until set).`, "targetId");
  }
  // Closing an existing note is a mutation of it — same trust gate as merge
  // (can't close a higher-trust note with lower-trust content; principal needs
  // the escalation). The new replacement note's own trust was already gated in
  // buildNewNote.
  assertMayMutate(old.note, options.trigger, options.principalAuthority === true);

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

  const event = await appendNoteMutationEvent(
    somaHome,
    now,
    options.substrate,
    {
      kind: "memory.write.supersede",
      summary: `Note ${newNote.id} supersedes ${closed.id} (closed ${closed.valid_until})`,
      artifactPaths: [newPath, old.path],
      // Log the escalation when either the new note or the closed one is principal-trust.
      metadata: {
        id: newNote.id,
        supersededId: closed.id,
        trigger: options.trigger,
        ...principalAuthorityMeta(TRUST_RANK[newNote.trust] >= TRUST_RANK[closed.trust] ? newNote.trust : closed.trust),
      },
    },
    // roll back BOTH sides — reopen the closed note FIRST (the trusted state we
    // most need to restore), then drop the new one. Failures are NOT swallowed:
    // appendMutationEvent surfaces them as an inconsistency error.
    async () => {
      await restoreBytes(old.path, old.raw);
      await unlink(newPath);
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
 * Close the reinforcing loop: the caller ASSERTS a resurfaced note still holds,
 * bumping `last_verified` to today and incrementing `resurface_count`. This
 * records the assertion only — verify captures no evidence/source/proof, so
 * `last_verified` is a caller-asserted freshness signal (the same caller-asserted
 * model as EvidenceKind elsewhere), not a machine-checked correctness proof. It
 * is the decay signal M3's retention score reads.
 */
export async function verifyMemoryNote(options: SomaMemoryVerifyOptions): Promise<SomaMemoryVerifyResult> {
  assertNonEmpty(options.id, "id");
  const somaHome = createPaths(options).root();
  const now = options.now ?? new Date();
  const { path, type, note, raw } = await loadNoteById(somaHome, options.id);

  // Verifying a principal note refreshes its decay signal — a principal-note
  // mutation, so it needs the same escalation. (Verify has no trigger; a
  // principal note verified WITH authority is treated as a principal-correction
  // for the trust-rank check.)
  if (note.trust === "principal" && options.principalAuthority !== true) {
    throw new MemoryNoteError(
      `Verifying principal-trust note ${note.id} requires --principal-authority ` +
        `(refreshing its decay signal is a principal-note mutation).`,
      "principalAuthority",
    );
  }

  const verified: SomaMemoryNote = {
    ...note,
    last_verified: isoDate(now),
    resurface_count: note.resurface_count + 1,
  };
  await writeNoteFile(path, verified, "w");

  const event = await appendNoteMutationEvent(
    somaHome,
    now,
    options.substrate,
    {
      kind: "memory.verify",
      summary: `Verified memory note ${verified.id} (${type}); resurface_count ${verified.resurface_count}`,
      artifactPaths: [path],
      metadata: { id: verified.id, type, resurfaceCount: verified.resurface_count, ...principalAuthorityMeta(note.trust) },
    },
    () => restoreBytes(path, raw), // roll back: restore the pre-verify bytes
  );

  return { somaHome, path, note: verified, event };
}
