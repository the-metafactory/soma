import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { createPaths } from "./paths";
import { listMemoryNotes } from "./memory-fs";
import { runBoundedConcurrent } from "./internal-concurrency";
import { appendSomaMemoryEvent } from "./memory";
import { parseMemoryNote, serializeMemoryNote, MemoryNoteError, isValidNoteId, NOTE_ID_MAX_LEN } from "./memory-note";
import { memoryTermSet } from "./memory-terms";
import { jaccard, NEAR_DUPLICATE_JACCARD_THRESHOLD } from "./memory-corpus";
import { SOMA_MEMORY_NOTE_TYPES, SOMA_MEMORY_TRIGGER_TRUST } from "./types";
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
 * - **Trust is derived from the trigger**, never a caller flag. Any tier above
 *   `quarantined` needs that tier's explicit authority signal to be minted (or an
 *   existing note of that tier to be mutated): `principal-correction` →
 *   `principal` (needs `principalAuthority`); `consolidation` → `assistant`
 *   (needs `consolidationAuthority`); `import` → `quarantined`, free (MINJA
 *   defense). Two honest limits: (1) the signals are sudo-style deliberate
 *   booleans, NOT cryptographic capabilities — the ENFORCED surface is the CLI
 *   (no `--*-authority` self-assert path for consolidation; `--trigger
 *   consolidation` refused), while an in-process SDK caller can set the boolean,
 *   as soma has no capability primitive. (2) Authorization is CHECKED and its
 *   audit-meta RESOLVED together, by one call to `resolveMutationGovernance` —
 *   the single gate every mutation path (create/merge/supersede/verify) goes
 *   through — and that audit-meta is only RECORDED in the mutation's event on
 *   success: the audit trail exists only if the mutation reaches event append.
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
 * - One mutating call → one events journal line, through one shared primitive
 *   (`writeNotesAtomically`): every staged file write (one for create/merge/
 *   verify, two for supersede — mint the replacement, close the old note) and
 *   the event append succeed together or are rolled back together (created
 *   files unlinked, edited files restored to prior bytes), so a mid-write
 *   failure and an append failure both surface the SAME error shape and never
 *   commit a *completed* note without its event. A FIRST write that is a create
 *   (`wx`) propagates its failure directly rather than rolling back: on EEXIST
 *   the target is untouched and on a pre-write serialization error nothing
 *   reached disk, so in those (common) cases nothing is committed. A rarer
 *   mid-write failure (ENOSPC/EIO after the exclusive create) can leave an
 *   unreferenced partial fragment with no event — the SAME orphan class as the
 *   crash gap below, reconciled by the M7 audit, not a valid note. This is
 *   NOT crash-atomic — a process kill
 *   in the window between a file write and the append can still orphan a file
 *   from its event (a documented gap reconciled by the M7 audit; soma has no
 *   WAL/2PC primitive).
 *
 * Deterministic: dates come from an injected `now` (UTC), no LLM calls, writes
 * stay within the Soma memory tree under `memory/semantic/` + `memory/procedural/`.
 */

// The recall-first refusal fires at/above this Jaccard token-set overlap — the
// same shared floor (#410) the M6 consolidation near-dup report scores against
// (memory-consolidate.ts's `planSimilarPairs`). Re-exported under this file's
// established name: internal soma modules and tests import it from here (see
// index.ts's public-surface note), not from memory-corpus.ts directly.
export { NEAR_DUPLICATE_JACCARD_THRESHOLD as MEMORY_DEDUP_JACCARD_THRESHOLD };

// The durable, dedup-gated corpus. Episodic notes live elsewhere (M5) and are
// not written through this path.
export type WritableType = Exclude<SomaMemoryNoteType, "episodic">;

// One source of truth for the writable-type enumeration — every helper that
// walks both durable dirs reuses this instead of re-casting Object.keys. Exported
// so the CLI validates `--type` against the same list the writer routes on.
// Derived from the canonical note-type array (types.ts) rather than a private
// dir-name map — the on-disk dir for each type now comes from the SomaPaths
// seam (`paths.semantic()` / `paths.procedural()`, see `typeDir` below).
export const WRITABLE_NOTE_TYPES = SOMA_MEMORY_NOTE_TYPES.filter(
  (type): type is WritableType => type !== "episodic",
);
const WRITABLE_TYPES = WRITABLE_NOTE_TYPES;

/** True iff `value` is a note type the write path accepts (semantic|procedural). */
export function isWritableNoteType(value: string): value is WritableType {
  return (WRITABLE_NOTE_TYPES as readonly string[]).includes(value);
}

// Trust ordering for the mutation gate: content may never be injected into a
// note of HIGHER trust than the mutation's own trigger carries.
const TRUST_RANK: Record<SomaMemoryTrust, number> = { quarantined: 0, assistant: 1, principal: 2 };

function assertNonEmpty(value: string | undefined, field: string): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new MemoryNoteError(`Soma memory write ${field} must not be empty.`, field);
  }
}

// Same slug grammar the M0 parser enforces on `id` (memory-note.ts's
// NOTE_ID_PATTERN). Validated HERE at the write boundary — before the id is
// ever joined into a filesystem path — so a traversal id (`../../evil`) is
// refused up front rather than incidentally by serialize's round-trip
// re-parse. Defense in depth: memoryNotePath must never receive an
// unvalidated id.
function assertNoteId(id: string): void {
  if (!isValidNoteId(id)) {
    throw new MemoryNoteError(`id "${id}" is not a valid slug (lowercase [a-z0-9-], <=${NOTE_ID_MAX_LEN} chars).`, "id");
  }
}

/**
 * Roll back a mutation whose write OR event-append just failed, and shape the
 * resulting error IDENTICALLY either way — one atomicity contract, one error
 * shape, for every mutation path (create/merge/supersede/verify), instead of a
 * mid-write failure and a post-write event-append rejection each growing their
 * own divergent undo + error shape. `rollback` restores disk to its
 * pre-mutation state and MUST throw if it cannot — a swallowed rollback
 * failure would report "rolled back" while leaving the note mutated.
 *
 * NOTE (honest limitation): this guards against a write/append *rejection*,
 * not a process crash/kill mid-operation. A hard crash there can still leave a
 * file without its event; the journal is best-effort append-only and that gap
 * is reconciled by a later audit (M7), not prevented here. Soma has no
 * write-ahead-log / 2-phase-commit primitive.
 */
async function rollbackAndThrow(kind: string, operation: string, cause: unknown, rollback: () => Promise<void>): Promise<never> {
  try {
    await rollback();
  } catch (rollbackError) {
    throw new Error(
      `Soma memory ${kind} ${operation} failed AND the rollback failed — memory may be inconsistent; reconcile manually.`,
      { cause: rollbackError },
    );
  }
  throw new Error(`Soma memory ${kind} ${operation} failed; rolled back the file mutation.`, { cause });
}

/** Append the mutation's event; on a rejection, roll the file mutation back via `rollbackAndThrow`. */
async function appendMutationEvent(
  somaHome: string,
  input: Parameters<typeof appendSomaMemoryEvent>[1],
  rollback: () => Promise<void>,
): ReturnType<typeof appendSomaMemoryEvent> {
  return appendSomaMemoryEvent(somaHome, input).catch((appendError: unknown) =>
    rollbackAndThrow(input.kind, "event append", appendError, rollback),
  );
}

/**
 * One staged file write for {@link writeNotesAtomically}: what to write, and
 * how to undo it. For an overwrite (`"w"`) the type requires `priorRaw`, but the
 * temporal contract is the CALLER's to honour and cannot be type-enforced: it
 * must be the target's current bytes read BEFORE the write runs, since undoing
 * the write means restoring exactly those bytes. (The production callers —
 * merge/supersede/verify — read the note file for other reasons first and pass
 * that same content.) A create (`"wx"`) needs no prior bytes: undoing it is a
 * plain unlink.
 * Exported for the atomicity-shape acceptance test (a mid-write failure and a
 * post-write event-append failure must produce the SAME error shape) — not
 * public index API; create/merge/supersede/verify remain the only production
 * callers.
 */
export type AtomicNoteWrite =
  | { path: string; flag: "wx"; note: SomaMemoryNote }
  | { path: string; flag: "w"; note: SomaMemoryNote; priorRaw: string };

async function undoAtomicWrite(somaHome: string, write: AtomicNoteWrite): Promise<void> {
  // Discriminated union: a "w" undo always has the captured prior bytes, so the
  // rollback restores real content — never an empty-string fallback that would
  // truncate the note.
  if (write.flag === "w") await restoreBytes(somaHome, write.path, write.priorRaw);
  else await unlink(write.path);
}

/**
 * Stage every file write in `writes`, then append the mutation's event, as ONE
 * atomic unit — the single contract create/merge/supersede/verify all resolve
 * through, so a mid-write failure and a post-write event-append rejection
 * produce the IDENTICAL error shape (`rollbackAndThrow`) instead of each
 * mutation path hand-rolling its own undo and its own error shape.
 *
 * Writes run in order. A failed write rolls back every write up to and
 * INCLUDING it, latest-first — `writes[i]`'s own undo runs too, because an
 * overwrite (`"w"`) may have already truncated its target before failing, so
 * restoring its prior bytes is still required even though that specific write
 * "failed". The ONE exception is a first CREATE (`i === 0`, `"wx"`): it
 * propagates directly, since an EEXIST failure left the target untouched (and
 * unlinking it would clobber a pre-existing file) and a partial create has no
 * prior state to restore. (`supersedeNote`'s
 * two writes — mint the replacement, then close the old note — roll back in
 * exactly this order: restore the old note FIRST, the trusted state most
 * worth restoring, then drop the new one SECOND.) If every write succeeds, the
 * event is appended with a rollback that undoes every staged write,
 * latest-first — the same primitive whether one write (create/merge/verify)
 * or two (supersede) were staged.
 */
export async function writeNotesAtomically(
  somaHome: string,
  now: Date,
  substrate: SomaMemoryWriteOptions["substrate"],
  kind: string,
  writes: AtomicNoteWrite[],
  fields: { summary: string; artifactPaths: string[]; metadata: Record<string, unknown> },
): ReturnType<typeof appendSomaMemoryEvent> {
  const undoThrough = async (last: number): Promise<void> => {
    for (let j = last; j >= 0; j -= 1) await undoAtomicWrite(somaHome, writes[j]);
  };
  for (let i = 0; i < writes.length; i += 1) {
    try {
      await writeNoteFile(somaHome, writes[i].path, writes[i].note, writes[i].flag);
    } catch (writeError) {
      // A first CREATE (`"wx"`) propagates directly: an EEXIST failure left the
      // target untouched (must NOT unlink a pre-existing file) and a partial
      // create has no prior bytes to restore. A first OVERWRITE (`"w"`) may
      // have truncated its target before failing, so its prior bytes still need
      // restoring — roll back through i even at i === 0.
      if (i === 0 && writes[i].flag === "wx") throw writeError;
      return rollbackAndThrow(kind, "write", writeError, () => undoThrough(i));
    }
  }
  return appendMutationEvent(
    somaHome,
    { timestamp: now.toISOString(), substrate: substrate ?? "custom", kind, ...fields },
    () => undoThrough(writes.length - 1),
  );
}

/** YYYY-MM-DD in UTC — matches the note schema's calendar-date grammar. */
function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Directory holding notes of a writable type. */
function typeDir(somaHome: string, type: WritableType): string {
  const paths = createPaths(somaHome);
  return type === "semantic" ? paths.semantic() : paths.procedural();
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

// Hash + token set both start from ONE lowercased pass over the body — the
// lower-aware variants (`*FromLower`) let the scan loop lowercase each note once
// and derive both from it, instead of two `.toLowerCase()` passes per note.
function hashFromLower(lower: string): string {
  return createHash("sha256").update(lower.replace(/\s+/g, " ").trim()).digest("hex");
}

/** Token set for Jaccard near-match — the shared memory tokenizer (memory-terms.ts),
 *  same 3+char floor as recall and search. Takes ALREADY-lowercased input so the
 *  scan lowercases each note once and feeds both hash and tokens. */
const tokensFromLower = memoryTermSet;

function bodyHash(body: string): string {
  return hashFromLower(body.toLowerCase());
}

function bodyTokens(body: string): Set<string> {
  return tokensFromLower(body.toLowerCase());
}

export interface ScannedNote {
  path: string;
  type: WritableType;
  note: SomaMemoryNote;
}

interface LoadedNote extends ScannedNote {
  /** The exact on-disk bytes — used to restore the file on event-append rollback. */
  raw: string;
}

// The authority signals a caller can hold. Both write and verify options carry
// these fields; the tier gate reads only this narrow shape. Exported (not
// public index API — same "module-private, test-imported" pattern as
// `findDuplicateCandidates`/`memoryNotePath` below) so the governance test can
// call `resolveMutationGovernance` directly.
export interface AuthoritySignals {
  principalAuthority?: boolean;
  consolidationAuthority?: boolean;
}

/**
 * A trust tier above `quarantined` is never conferred by choosing a trigger
 * alone — it requires that tier's explicit, logged authority signal. `principal`
 * needs `--principal-authority`; `assistant` (the consolidation tier) needs
 * `--consolidation-authority`; `quarantined` is free. `context` names the act
 * (mint / mutate) for the error.
 */
function assertTierAuthority(tier: SomaMemoryTrust, auth: AuthoritySignals, context: string): void {
  if (tier === "principal" && auth.principalAuthority !== true) {
    throw new MemoryNoteError(`${context} requires --principal-authority (a deliberate, logged escalation).`, "principalAuthority");
  }
  if (tier === "assistant" && auth.consolidationAuthority !== true) {
    throw new MemoryNoteError(
      `${context} requires consolidation authority — an internal (M6) SDK capability set via ` +
        `SomaMemoryWriteOptions.consolidationAuthority, NOT a public CLI flag and not selectable ` +
        `by choosing --trigger consolidation.`,
      "consolidationAuthority",
    );
  }
}

/** Minting a note: the trigger's derived tier needs that tier's authority. Returns the tier. */
function assertMintAuthority(trigger: SomaMemoryWriteTrigger, auth: AuthoritySignals): SomaMemoryTrust {
  const tier = SOMA_MEMORY_TRIGGER_TRUST[trigger];
  assertTierAuthority(tier, auth, `${trigger} mints ${tier} trust and`);
  return tier;
}

/**
 * Guard every mutation of an EXISTING note (merge body, supersede-close). Two
 * rules, both anti-injection:
 *   1. The mutation's trigger-trust must be ≥ the target's trust — a tool/import
 *      caller (quarantined) can never inject content into an assistant/principal
 *      note ("import is always quarantined" would otherwise be a lie for merges).
 *   2. Mutating a non-quarantined note needs the TARGET tier's authority — the
 *      same signal that minted it.
 */
function assertMayMutate(target: SomaMemoryNote, trigger: SomaMemoryWriteTrigger, auth: AuthoritySignals): void {
  const incoming = SOMA_MEMORY_TRIGGER_TRUST[trigger];
  if (TRUST_RANK[incoming] < TRUST_RANK[target.trust]) {
    throw new MemoryNoteError(
      `Cannot mutate ${target.trust}-trust note ${target.id} with ${incoming}-trust content ` +
        `(trigger ${trigger}) — a mutation may not inject lower-trust content.`,
      "trigger",
    );
  }
  assertTierAuthority(target.trust, auth, `Mutating ${target.trust}-trust note ${target.id}`);
}

/**
 * Event metadata recording the authority escalation, so an audit can prove from
 * the journal alone that a non-quarantined mutation was authorized.
 */
function authorityMeta(trust: SomaMemoryTrust): Record<string, unknown> {
  if (trust === "principal") return { principalAuthority: true };
  if (trust === "assistant") return { consolidationAuthority: true };
  return {};
}

/**
 * The single entry for M1 mutation governance: `(trigger, target, auth) →
 * { trust, provenance, eventMeta } | refusal`. Every mutation path
 * (create/merge/supersede/verify) resolves its authority through this one
 * function, so the tier-authority check and the audit-meta describing it can
 * never be paired by hand at the call site (and drift) — the `trust` a call
 * approves is exactly the `trust` `eventMeta` documents, because both come out
 * of the same call. The six formerly-scattered predicates (`TRUST_RANK`,
 * `assertTierAuthority`, `assertMintAuthority`, `assertMayMutate`,
 * `authorityMeta`, `resolveProvenance`) are this function's internal
 * implementation; no call site outside it names them directly.
 *
 * Dispatches on `target`/`trigger` into the three shapes M1 actually has:
 * - **MINT** (`target: null`) — a NEW note at the trigger-derived tier
 *   (`createNote`; `supersedeNote`'s replacement). Needs that tier's own
 *   authority, and resolves/validates `provenance` for the trigger.
 * - **MUTATE** (`target` set, `trigger` given) — editing an EXISTING note
 *   with new incoming content (`mergeNote`'s body edit; `supersedeNote`'s
 *   close-old). The trigger's tier must be allowed to inject into the
 *   target's tier (the rank check), and the authority required is the
 *   TARGET's tier — closing a principal note always needs
 *   `principalAuthority`, whatever tier minted the replacement.
 * - **VERIFY** (`target` set, `trigger` omitted) — refreshing an existing
 *   note's decay signal with no incoming content to rank, so only the
 *   target's own tier authority applies (`verifyMemoryNote`, whose options
 *   carry no `trigger` at all).
 *
 * `supersedeNote` governs TWO notes — mint the replacement, mutate the old —
 * which can sit at different tiers requiring different signals, so it is the
 * one path that calls this twice. The invariant this function preserves is
 * per-call (a resolved `trust` and its `eventMeta` can never desync), not
 * "at most one call per mutation path".
 */
export interface MutationGovernance {
  trust: SomaMemoryTrust;
  /** Only set by a MINT resolution; `undefined` for MUTATE/VERIFY. */
  provenance?: string;
  eventMeta: Record<string, unknown>;
}

// Exported for the M1 acceptance test (a mint refusal and its audit-meta must
// come from the same call) — not public index API; the four mutation paths
// below remain the only production callers.
export function resolveMutationGovernance(
  trigger: SomaMemoryWriteTrigger | undefined,
  target: SomaMemoryNote | null,
  auth: AuthoritySignals,
  provenanceOverride?: string,
): MutationGovernance {
  if (target === null) {
    // MINT — a trigger is required here; only the mint call sites pass `target: null`.
    if (trigger === undefined) {
      throw new Error("resolveMutationGovernance: a MINT resolution (target: null) requires a trigger.");
    }
    const tier = assertMintAuthority(trigger, auth);
    return { trust: tier, provenance: resolveProvenance(trigger, provenanceOverride), eventMeta: authorityMeta(tier) };
  }
  if (trigger !== undefined) {
    // MUTATE — incoming content is being injected into an existing note.
    assertMayMutate(target, trigger, auth);
    return { trust: target.trust, eventMeta: authorityMeta(target.trust) };
  }
  // VERIFY — no incoming content, so no rank check; only the target's own tier authority.
  assertTierAuthority(target.trust, auth, `Verifying ${target.trust}-trust note ${target.id}`);
  return { trust: target.trust, eventMeta: authorityMeta(target.trust) };
}

// Bounded read concurrency for the dedup scan — parallel enough to not serialize
// on every note, capped so a large corpus can't spike FDs on the write path.
const DEDUP_SCAN_CONCURRENCY = 16;

// Internal: `collectDurableNotes` exposes it only as an inferred return type;
// no external caller names it, so it stays module-private (ScannedNote IS
// imported by memory-recall, so that one is exported).
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
 *
 * Enumeration goes through the shared `listMemoryNotes` seam (#408) —
 * previously this walk had NO symlink guard at all (a planted
 * `semantic/evil.md` → outside-the-tree symlink would be readdir'd and read
 * like any other note), the one caller among the four re-derivations of this
 * walk with no hardening whatsoever. `onSymlink: "skip"` matches the sibling
 * durable-corpus scan `consolidateMemory` already uses for episodic notes —
 * a symlinked note is now silently invisible to the dedup gate, the index,
 * and recall (this function's three callers), never followed. The seam also
 * re-`lstat`s each leaf before returning it (closing the enumeration-side
 * swap window); the read below adds `O_NOFOLLOW` so even a leaf swapped for a
 * symlink AFTER the seam returns cannot be followed — it reads as unreadable
 * (ELOOP → surfaced), never through the link to an outside target.
 */
export async function collectDurableNotes(somaHome: string): Promise<CorpusScan> {
  // Enumerate all note files across both durable dirs, then read them with a
  // bounded concurrency window (shared helper) rather than one unbounded
  // Promise.all over the whole tree.
  const targets: { path: string; type: WritableType }[] = [];
  const unreadableDirs: string[] = [];
  for (const type of WRITABLE_TYPES) {
    const dir = typeDir(somaHome, type);
    let files: string[];
    try {
      files = await listMemoryNotes(dir, { onSymlink: "skip" });
    } catch {
      // A missing dir is genuinely empty (listMemoryNotes already returns []
      // for that, never throwing) — anything that DOES throw here (a real
      // readdir failure, or a mid-walk directory-swap TOCTOU) is an unscanned
      // blind spot and must be surfaced, not treated as empty.
      unreadableDirs.push(dir);
      continue;
    }
    for (const path of files) targets.push({ path, type });
  }

  const scanned = await runBoundedConcurrent(
    targets,
    async ({ path, type }): Promise<ScannedNote | { unreadable: string }> => {
      // O_NOFOLLOW: a leaf swapped for a symlink after the seam's re-lstat but
      // before this read fails the open (ELOOP) rather than following the link
      // out of the memory tree — the read-time half of the leaf-TOCTOU guard.
      const content = await readFile(path, { encoding: "utf8", flag: FS.O_RDONLY | FS.O_NOFOLLOW }).catch(() => undefined);
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
    const lower = note.body.toLowerCase(); // one pass, feeds both hash and tokens
    const exact = hashFromLower(lower) === hash;
    const score = exact ? 1 : jaccard(tokens, tokensFromLower(lower));
    if (exact || score >= NEAR_DUPLICATE_JACCARD_THRESHOLD) {
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
 *
 * Only meaningful for a MINT (a brand-new note names its own provenance);
 * `resolveMutationGovernance` is this function's only caller.
 */
function resolveProvenance(trigger: SomaMemoryWriteTrigger, provenanceOverride: string | undefined): string {
  switch (trigger) {
    case "principal-correction":
      if (provenanceOverride !== undefined && provenanceOverride !== "conversation") {
        throw new MemoryNoteError(
          `principal-correction writes are provenance "conversation"; refusing "${provenanceOverride}" ` +
            `(tool/import content cannot ride in under principal trust).`,
          "provenance",
        );
      }
      return "conversation";
    case "consolidation":
      if (provenanceOverride !== undefined && provenanceOverride !== "consolidation") {
        throw new MemoryNoteError(`consolidation writes are provenance "consolidation".`, "provenance");
      }
      return "consolidation";
    case "import": {
      const provenance = provenanceOverride ?? "import";
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

/**
 * Containment: after the parent dir exists, resolve its realpath (following ANY
 * symlinked component — not just the final note path) and require it to stay
 * under the real memory root. This closes the parent-symlink escape: a planted
 * `memory/semantic` → /elsewhere symlink can no longer redirect a write out of
 * the tree. lstat on the final path (loadNoteById) guards the leaf; this guards
 * the directory chain.
 */
async function assertWriteContained(somaHome: string, path: string): Promise<void> {
  const realRoot = await realpath(createPaths(somaHome).memory());
  const realParent = await realpath(dirname(path));
  const rel = relative(realRoot, realParent);
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new MemoryNoteError(`Refusing write: ${path} resolves outside the memory tree (a symlinked path component).`, "id");
  }
}

/**
 * Overwrite an EXISTING note's bytes with O_NOFOLLOW, closing the leaf-symlink
 * TOCTOU: after the containment check, an attacker could swap the leaf for a
 * symlink before the write. `wx` (create) is immune — O_CREAT|O_EXCL refuses a
 * pre-existing symlink — but an overwrite ("w") would follow one, so open the
 * leaf with O_NOFOLLOW and let `open` fail (ELOOP) rather than escape.
 */
async function overwriteNoFollow(path: string, content: string): Promise<void> {
  const fh = await open(path, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW, 0o644);
  try {
    await fh.writeFile(content, "utf8");
  } finally {
    await fh.close();
  }
}

async function writeNoteFile(somaHome: string, path: string, note: SomaMemoryNote, flag: "wx" | "w"): Promise<void> {
  const content = serializeMemoryNote(note); // enforces the round-trip law before any byte hits disk
  await mkdir(dirname(path), { recursive: true });
  await assertWriteContained(somaHome, path); // parent-dir symlink guard
  try {
    if (flag === "w") await overwriteNoFollow(path, content); // leaf-symlink guard
    else await writeFile(path, content, { encoding: "utf8", flag });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EEXIST") {
      throw new MemoryNoteError(`Soma memory note already exists: ${path}`, "id");
    }
    if (code === "ELOOP") {
      throw new MemoryNoteError(`Refusing write: ${path} is a symlink (O_NOFOLLOW).`, "id");
    }
    throw error;
  }
}

/**
 * Restore raw bytes to `path` on a rollback, recreating the parent dir first —
 * a normal write always recreates parents (writeNoteFile), so the restore path
 * must too, or an externally-removed directory would defeat the rollback. Uses
 * the same O_NOFOLLOW overwrite as an edit so a rollback can't be redirected.
 */
async function restoreBytes(somaHome: string, path: string, raw: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await assertWriteContained(somaHome, path);
  await overwriteNoFollow(path, raw);
}

/**
 * Load one note by id by probing its two possible paths directly
 * (`semantic/<id>.md`, `procedural/<id>.md`) — O(1) I/O, not an O(corpus) scan.
 * Create/supersede run a preflight id-uniqueness check across types, so in the
 * single-process CLI at most one path resolves; if both exist (e.g. a race
 * between two concurrent writers, which the preflight is not atomic against, or
 * a hand-placed file), semantic wins deterministically.
 */
async function loadNoteById(somaHome: string, id: string): Promise<LoadedNote> {
  assertNoteId(id); // a lookup id is also a path segment — never probe an unsafe one
  for (const type of WRITABLE_TYPES) {
    const path = memoryNotePath(somaHome, type, id);
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      // Only a genuinely-absent file (ENOENT) is "not here, try the next type".
      // Any OTHER stat failure must NOT masquerade as absence — that would break
      // the global-id guarantee (fall through to a same-id note of the other
      // type, or wrongly report not-found on an existing-but-unreadable note).
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") continue;
      throw new MemoryNoteError(`Soma memory note ${id} exists at ${path} but is unstattable: ${String(error)}`, "id");
    }
    // Containment: a note path that is a symlink would let a subsequent "w"
    // overwrite (merge/verify/supersede-close) escape the memory tree. Refuse it.
    if (stats.isSymbolicLink()) {
      throw new MemoryNoteError(`Soma memory note ${id} at ${path} is a symlink; refusing to follow it out of the memory tree.`, "id");
    }
    const raw = await readFile(path, "utf8");
    const note = parseMemoryNote(raw);
    // Bind the id==filename-stem (and type==dir) invariant the M0 parser
    // documents but cannot enforce (a content parser has no path). Without this,
    // `semantic/foo.md` containing `id: bar` would let verify/merge target a
    // different logical note than the caller named.
    if (note.id !== id || note.type !== type) {
      throw new MemoryNoteError(
        `Soma memory note at ${path} has mismatched frontmatter (id/type "${note.id}"/"${note.type}" ` +
          `≠ path "${id}"/"${type}"); refusing to mutate a mis-filed note.`,
        "id",
      );
    }
    return { path, type, note, raw };
  }
  throw new MemoryNoteError(`Soma memory note not found: ${id}`, "id");
}

/**
 * True iff a note FILE with this id already exists under either durable type.
 * A pure presence check (`lstat`), NOT a parse — a malformed or symlinked
 * `semantic/<id>.md` must still block a colliding `procedural/<id>.md`, so id
 * uniqueness holds even over a hand-corrupted corpus. Only ENOENT counts as
 * absent; any other stat failure is surfaced (an unreadable path must not be
 * mistaken for a free id).
 */
async function noteIdExists(somaHome: string, id: string): Promise<boolean> {
  assertNoteId(id);
  for (const type of WRITABLE_TYPES) {
    try {
      await lstat(memoryNotePath(somaHome, type, id));
      return true;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") continue;
      throw new MemoryNoteError(`Soma memory id ${id} path is unstattable: ${String(error)}`, "id");
    }
  }
  return false;
}

// --- create / merge / supersede ----------------------------------------------

interface NewNote {
  note: SomaMemoryNote;
  /** The MINT resolution that authorized and derived this note's trust/provenance. */
  governance: MutationGovernance;
}

function buildNewNote(options: SomaMemoryWriteOptions, now: Date): NewNote {
  assertNonEmpty(options.id, "id");
  assertNoteId(options.id);
  if (options.type === undefined || options.type === "episodic") {
    throw new MemoryNoteError(`type must be "semantic" or "procedural" (episodic writes go through digest/action, M5).`, "type");
  }
  assertNonEmpty(options.body, "body");

  // Minting a tier above quarantined needs that tier's authority — no caller can
  // mint principal/assistant trust by choosing a trigger alone; import defaults safe.
  const governance = resolveMutationGovernance(options.trigger, null, options, options.provenance);
  if (governance.provenance === undefined) {
    // Unreachable in practice — a MINT resolution (target: null) always sets
    // provenance. Guarded rather than asserted so a future regression in
    // resolveMutationGovernance surfaces here instead of writing a note with a
    // missing provenance.
    throw new Error(`resolveMutationGovernance did not resolve a provenance for trigger "${options.trigger}".`);
  }

  const today = isoDate(now);
  const note: SomaMemoryNote = {
    id: options.id,
    type: options.type,
    created: today,
    last_verified: today,
    valid_until: null,
    provenance: governance.provenance,
    trust: governance.trust,
    source_of_truth: options.sourceOfTruth ?? null,
    project: options.project ?? null,
    links: options.links ?? [],
    resurface_count: 0,
    body: options.body,
  };
  if (options.hook !== undefined) note.hook = options.hook;
  if (options.review !== undefined) note.review = options.review;
  return { note, governance };
}

async function createNote(somaHome: string, options: SomaMemoryWriteOptions, now: Date): Promise<SomaMemoryWriteResult> {
  const { note, governance } = buildNewNote(options, now);

  // Cheap path-existence PREFLIGHT — reject an id collision before paying for
  // the whole-corpus dedup scan, and reject `procedural/foo` when `semantic/foo`
  // exists so id-based lookups stay unambiguous. This is a preflight, not a lock:
  // it is best-effort against two concurrent writers racing the same id into
  // different types (the CLI is single-process; `wx` below still guards the
  // same-path case atomically).
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
  const event = await writeNotesAtomically(somaHome, now, options.substrate, "memory.write.create", [{ path, flag: "wx", note }], {
    summary: `Created memory note ${note.id} (${note.type}, trust ${note.trust})`,
    artifactPaths: [path],
    metadata: {
      id: note.id,
      type: note.type,
      trust: note.trust,
      trigger: options.trigger,
      ...governance.eventMeta, // audit the escalation when non-quarantined — from the SAME governance call that authorized the mint
      // Record the dedup gate's blind spot so "dedup-gated" is never a silent
      // overstatement when part of the corpus was unreadable.
      ...(unreadable.length > 0 ? { dedupUnreadable: unreadable.length } : {}),
    },
  });

  return { somaHome, mode: "create", path, note, event };
}

async function mergeNote(somaHome: string, options: SomaMemoryWriteOptions, now: Date): Promise<SomaMemoryWriteResult> {
  assertNonEmpty(options.targetId, "targetId");
  assertNonEmpty(options.body, "body");
  // merge edits an existing note IN PLACE, preserving its provenance — so a
  // provenance flag would be silently ignored. Refuse it rather than pretend
  // (this is also what makes "tool/import content is refused" honest for merge:
  // you cannot attach a tool provenance to a merge at all).
  if (options.provenance !== undefined) {
    throw new MemoryNoteError(`--provenance is not valid with --merge; merge preserves the target note's provenance.`, "provenance");
  }
  const { path, type, note, raw } = await loadNoteById(somaHome, options.targetId);
  if (note.valid_until !== null) {
    throw new MemoryNoteError(`Cannot merge into superseded note ${note.id} (valid_until set).`, "targetId");
  }
  const governance = resolveMutationGovernance(options.trigger, note, options);

  const today = isoDate(now);
  const merged: SomaMemoryNote = {
    ...note,
    last_verified: today,
    body: `${note.body}\n\n**Update (${today}):** ${options.body.trim()}`,
  };
  const event = await writeNotesAtomically(somaHome, now, options.substrate, "memory.write.merge", [{ path, flag: "w", note: merged, priorRaw: raw }], {
    summary: `Merged update into memory note ${merged.id} (${type})`,
    artifactPaths: [path],
    // Log the escalation so an audit can prove a principal-note mutation was authorized
    // — from the SAME governance call that authorized the mutation.
    metadata: { id: merged.id, type, trust: merged.trust, trigger: options.trigger, ...governance.eventMeta },
  });

  return { somaHome, mode: "merge", path, note: merged, event };
}

async function supersedeNote(somaHome: string, options: SomaMemoryWriteOptions, now: Date): Promise<SomaMemoryWriteResult> {
  assertNonEmpty(options.targetId, "targetId");
  const { note: newNote, governance: mintGovernance } = buildNewNote(options, now);
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
  // Closing an existing note is a SEPARATE governance resolution from minting
  // the replacement above (same trust gate as merge — can't close a
  // higher-trust note with lower-trust content; principal needs the
  // escalation). The two notes can sit at different tiers, each requiring its
  // own authority signal, which is why supersede is the one path that resolves
  // governance twice.
  const closeGovernance = resolveMutationGovernance(options.trigger, old.note, options);

  // New note points back at what it replaces; the closed note points forward.
  if (!newNote.links.includes(old.note.id)) newNote.links = [...newNote.links, old.note.id];
  const closed: SomaMemoryNote = {
    ...old.note,
    valid_until: isoDate(now),
    links: old.note.links.includes(newNote.id) ? old.note.links : [...old.note.links, newNote.id],
  };

  const newPath = memoryNotePath(somaHome, newNote.type as WritableType, newNote.id);
  // Two staged writes — mint the replacement, then close the old note — resolved
  // through the SAME atomicity primitive as the single-write paths above. A
  // failure closing the old note (index 1) rolls back BOTH: `writeNotesAtomically`
  // undoes latest-first (restore the old note's bytes first — the trusted state
  // most worth restoring — then drop the new one), sharing one error shape with
  // every other mutation path instead of a bespoke two-file undo here.
  const event = await writeNotesAtomically(
    somaHome,
    now,
    options.substrate,
    "memory.write.supersede",
    [
      { path: newPath, flag: "wx", note: newNote },
      { path: old.path, flag: "w", note: closed, priorRaw: old.raw },
    ],
    {
      summary: `Note ${newNote.id} supersedes ${closed.id} (closed ${closed.valid_until})`,
      artifactPaths: [newPath, old.path],
      // Supersede validates TWO authorities — minting the new note (its tier) and
      // closing the old one (its tier). Log BOTH, each straight from the
      // governance call that authorized it, so the journal can prove every
      // required signal was present (e.g. principal replacement of an assistant
      // note carries both principalAuthority and consolidationAuthority).
      metadata: {
        id: newNote.id,
        supersededId: closed.id,
        trigger: options.trigger,
        ...mintGovernance.eventMeta,
        ...closeGovernance.eventMeta,
      },
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

  // A superseded note is closed — reinforcing its freshness signal is meaningless
  // (and would resurrect it in retention scoring). Refuse.
  if (note.valid_until !== null) {
    throw new MemoryNoteError(`Cannot verify superseded note ${note.id} (valid_until set ${note.valid_until}).`, "id");
  }

  // Verifying refreshes a note's decay signal — a mutation — so a non-quarantined
  // note needs its tier's authority (principal→--principal-authority,
  // assistant→internal consolidator authority). No `trigger` here (verify carries
  // none) — that's what selects the VERIFY shape inside resolveMutationGovernance.
  const governance = resolveMutationGovernance(undefined, note, options);

  const verified: SomaMemoryNote = {
    ...note,
    last_verified: isoDate(now),
    resurface_count: note.resurface_count + 1,
  };
  const event = await writeNotesAtomically(somaHome, now, options.substrate, "memory.verify", [{ path, flag: "w", note: verified, priorRaw: raw }], {
    summary: `Verified memory note ${verified.id} (${type}); resurface_count ${verified.resurface_count}`,
    artifactPaths: [path],
    metadata: { id: verified.id, type, resurfaceCount: verified.resurface_count, ...governance.eventMeta },
  });

  return { somaHome, path, note: verified, event };
}
