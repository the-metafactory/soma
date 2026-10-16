import type { SubstrateId } from "../types";
import type { SomaMemoryEvent } from "../events/index";


export interface SomaMemorySearchOptions {
  homeDir?: string;
  somaHome?: string;
  query: string;
  limit?: number;
  /**
   * Include `memory/STATE` — the event log, work indices and import manifests.
   * Off by default: that tree is operational bookkeeping, not memory content,
   * and it is large enough to exhaust any limit on a common term. Search also
   * appends its own `memory.recall` event there, so including it lets a search
   * match the record of previous searches.
   */
  includeState?: boolean;
  /** Injected clock for the `memory.recall` event's timestamp. Defaults to now. */
  now?: Date;
  /** Substrate tag for the `memory.recall` event this call appends. Defaults to `"custom"`. */
  substrate?: SubstrateId;
}

/**
 * What kind of file a match came from. Ranking is by class first and term score
 * second, so a curated note always outranks the raw archive it was distilled
 * from — the archive shares its vocabulary and vastly outnumbers it.
 */
export type SomaMemorySearchSourceClass = "note" | "archive" | "state";

export interface SomaMemorySearchMatch {
  path: string;
  line: number;
  score: number;
  snippet: string;
  /** Which corpus this line came from. Drives ranking; see the type. */
  sourceClass: SomaMemorySearchSourceClass;
}

export interface SomaMemorySearchResult {
  query: string;
  somaHome: string;
  matches: SomaMemorySearchMatch[];
}

// ── Memory subsystem (Track B, M0) ──────────────────────────────────────────
// File-native memory note schema. Contract fixed in the memory-subsystem plan
// v2 §2 (do not redesign). One note = one markdown file: strict frontmatter +
// markdown body. Parser/serializer live in src/memory/memory-note.ts and obey the
// round-trip law parse(serialize(n)) == n for any note serialize accepts whose
// body is already trimmed (serialize trims the body — the one lossy
// normalization; see serializeMemoryNote for the exact contract).
// Single source of truth for the note enums: the validator arrays in
// memory-note.ts import these, and the union types derive from them, so the
// literals live in exactly one place.
export const SOMA_MEMORY_NOTE_TYPES = ["semantic", "episodic", "procedural"] as const;
export type SomaMemoryNoteType = (typeof SOMA_MEMORY_NOTE_TYPES)[number];
// Trust tier = who vouched for a memory. "assistant" (not "agent") per
// CONTEXT.md, which reserves `agent` for substrate concepts and forbids it as a
// Soma core noun; the plan's `agent` tier is renamed here at first codification.
export const SOMA_MEMORY_TRUSTS = ["principal", "assistant", "quarantined"] as const;
export type SomaMemoryTrust = (typeof SOMA_MEMORY_TRUSTS)[number];

export interface SomaMemoryNote {
  id: string;                 // kebab slug; storage layer (M1) binds it to the filename stem
  type: SomaMemoryNoteType;
  created: string;            // YYYY-MM-DD
  last_verified: string;      // YYYY-MM-DD
  valid_until: string | null; // YYYY-MM-DD when superseded/expired, else null
  provenance: string;         // "conversation" | "consolidation" | "import" | "tool:<name>"
  trust: SomaMemoryTrust;     // who vouched: principal | assistant | quarantined.
                              // "assistant" not "agent" — CONTEXT.md reserves `agent` for substrate concepts.
  source_of_truth: string | null; // path/URL to verify against, or null
  project: string | null;     // scope key, e.g. "soma", or null
  links: string[];            // ids of related notes (may be empty)
  resurface_count: number;    // integer >= 0
  hook?: string;              // optional: recall-trigger phrase
  review?: string;            // optional: review directive
  body: string;               // markdown after the closing ---
}

// Memory subsystem M1 (write + verify). Plan v2 §M1 (do not redesign the
// governance model): trust is NOT selectable via a `--trust` flag — it is DERIVED
// from the write trigger, and elevating above `quarantined` needs a deliberate
// authority signal. Honest scope: the ENFORCED boundary is the CLI surface (no
// public self-assert path), not the SDK — an in-process caller can still set the
// `principalAuthority`/`consolidationAuthority` booleans, as soma has no
// cryptographic capability primitive (CONTEXT.md reserves bare `agent`; use
// `assistant`/substrate). THREE of
// design §7's five triggers reach the `write` path (principal-correction, import,
// consolidation); the other two — session-end and consequential-action — are
// M5's episodic `digest`/`action`, NOT `write`. M1 owns the durable, dedup-gated
// types (semantic + procedural).

/**
 * The governed write trigger (design §7). Trust is a pure function of this value
 * (see {@link SOMA_MEMORY_TRIGGER_TRUST}); there is no `--trust` flag. Only these
 * three reach the `write` path in M1:
 * - `principal-correction` — the principal said "remember"/"no, always X". The
 *   ONLY path to `principal` trust, and the documented principal-authority gate.
 * - `import` — migration / external doc. Untrusted source → `quarantined` (MINJA
 *   defense: tool/web content never lands trusted).
 * - `consolidation` — the M6 consolidator promoting/merging → `assistant`.
 * (`session-end` and `consequential-action` are the other two design-§7 triggers;
 * they belong to M5's episodic path, not `write`.)
 */
export const SOMA_MEMORY_WRITE_TRIGGERS = ["principal-correction", "import", "consolidation"] as const;
export type SomaMemoryWriteTrigger = (typeof SOMA_MEMORY_WRITE_TRIGGERS)[number];

/** Trust derived from trigger — the whole M1 governance model in one table. */
export const SOMA_MEMORY_TRIGGER_TRUST: Record<SomaMemoryWriteTrigger, SomaMemoryTrust> = {
  "principal-correction": "principal",
  import: "quarantined",
  consolidation: "assistant",
};

/** Create (dedup-gated), merge (delta-edit target), or supersede (close old + create new). */
export type SomaMemoryWriteMode = "create" | "merge" | "supersede";

/** A near-duplicate surfaced by the recall-first refusal gate (Jaccard ≥ 0.6 or exact-body hash). */
export interface SomaMemoryDuplicateCandidate {
  id: string;
  type: SomaMemoryNoteType;
  path: string;
  /** 1.0 for an exact normalized-body hash match, else the Jaccard token-set score. */
  score: number;
  exact: boolean;
}

export interface SomaMemoryWriteOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  /** Injected clock for deterministic `created`/`last_verified`. Defaults to now. */
  now?: Date;

  mode: SomaMemoryWriteMode;
  trigger: SomaMemoryWriteTrigger;
  /**
   * The deliberate-escalation gate for `principal` trust. `principal-correction`
   * mints a `principal` note only when this is set — otherwise it is REFUSED, so
   * an automated/agent invocation can never mint principal trust incidentally
   * from the trigger alone. This is a sudo-style deliberate + logged escalation,
   * NOT cryptographic principal authentication (soma has no such primitive — a
   * recorded limitation). The CLI sets it from an explicit `--principal-authority`
   * flag; it is intentionally NOT an env var (ambient authority is the footgun
   * this gate exists to close). Ignored for import/consolidation triggers.
   */
  principalAuthority?: boolean;
  /**
   * The consolidation counterpart of {@link principalAuthority}: `consolidation`
   * mints `assistant` trust, so it too requires an explicit signal. Like
   * `principalAuthority`, this is a sudo-style deliberate flag, NOT a
   * cryptographically enforced capability — at the SDK layer an in-process caller
   * (intended: the M6 consolidator) sets it, exactly as they would set
   * `principalAuthority`; soma has no capability primitive to make it
   * unforgeable. What IS enforced is the surface: it is intentionally NOT exposed
   * as a public CLI flag and `--trigger consolidation` is refused on the CLI, so
   * the public command-line cannot mint assistant trust. Ignored for
   * principal/import triggers.
   */
  consolidationAuthority?: boolean;

  /** create/supersede: the new note's id. merge: unused (target is `--merge <id>`). */
  id?: string;
  type?: SomaMemoryNoteType;
  body: string;
  project?: string | null;
  sourceOfTruth?: string | null;
  links?: string[];
  hook?: string;
  review?: string;
  /**
   * Only meaningful for `import` (`import` or `tool:<name>`); forced to
   * `conversation` for principal-correction and `consolidation` otherwise.
   */
  provenance?: string;

  /** merge: id of the note to delta-edit. supersede: id of the note to close. */
  targetId?: string;
  /** create only: bypass the recall-first refusal gate. */
  force?: boolean;
  /**
   * #428 — create only: when the recall-first refusal gate finds a near-dup
   * (exact-hash or Jaccard ≥ 0.6), delta-merge this write's body into the
   * BEST-scoring candidate (the existing `merge` mode) instead of refusing —
   * an opt-in resolution, not a silent auto-merge. Governance is UNCHANGED: the
   * redirect only picks the target automatically, `mergeNote`'s own
   * trust-rank + tier-authority checks still apply exactly as for an explicit
   * `--merge <id>`. Mutually exclusive with `force` (which skips the scan
   * entirely, so there is nothing for `upsert` to react to). Ignored when no
   * candidate is found — the write proceeds as a normal create.
   */
  upsert?: boolean;
}

export interface SomaMemoryWriteResult {
  somaHome: string;
  mode: SomaMemoryWriteMode;
  path: string;
  note: SomaMemoryNote;
  /** supersede only: the id of the note that was closed (valid_until set). Undefined for create/merge. */
  supersededId?: string;
  event: SomaMemoryEvent;
}

export interface SomaMemoryVerifyOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  now?: Date;
  id: string;
  /**
   * Verifying mutates a note's decay signals (`last_verified`, `resurface_count`),
   * so verifying a non-quarantined note needs that tier's authority — otherwise a
   * tool caller could keep a trusted note artificially fresh in the index.
   * `principal` notes need this; ignored for quarantined notes.
   */
  principalAuthority?: boolean;
  /** As above, for `assistant`-trust notes. Ignored for principal/quarantined notes. */
  consolidationAuthority?: boolean;
}

export interface SomaMemoryVerifyResult {
  somaHome: string;
  path: string;
  note: SomaMemoryNote;
  event: SomaMemoryEvent;
}

/**
 * #427 — the low-friction "this recalled note helped" signal. Distinct from
 * `verify`: `verify` is the caller ASSERTING a fact still holds (authority-gated,
 * requires `--principal-authority`/`consolidationAuthority` per tier); `resurface`
 * is the caller observing that a recall was USEFUL, which is a weaker, cheaper
 * claim — so it needs no per-call authority flag at all. It performs the identical
 * frontmatter bump (`last_verified` = today, `resurface_count += 1`) through the
 * same governance + atomicity path, but with its OWN trust-scoping instead of
 * verify's: `assistant` notes are bumped freely (the resurface act IS the
 * authority — the whole point is a path reachable from the public CLI, unlike
 * `consolidationAuthority`), `principal` notes are a no-op (already
 * unconditionally admitted, see `memory-index.ts`'s `isAdmitted`), and
 * `quarantined` notes are refused outright (never admitted; resurfacing one would
 * only mislead the retention score). This DOES introduce a narrow new governed
 * authority — the resurface act self-authorizes an assistant-tier `resurface_count`
 * bump that is reachable from the public CLI (justified above: it moves only a
 * decay signal, never body content or trust tier, so "the `used` call fired" is
 * sufficient authority for it). It adds no new note-CONTENT authority, and no
 * change to the admission threshold or retention formula.
 */
export interface SomaMemoryResurfaceOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  now?: Date;
  id: string;
}

export interface SomaMemoryResurfaceResult {
  somaHome: string;
  path: string;
  note: SomaMemoryNote;
  /**
   * `false` for the principal-trust no-op (already admitted — nothing written,
   * `event` is `undefined`). `true` for the assistant-trust bump (`event` is set).
   * Quarantined never reaches a result — `resurfaceMemoryNote` throws instead.
   */
  mutated: boolean;
  event?: SomaMemoryEvent;
}

// Memory subsystem M8 (backfill). Bulk-import a principal's existing free-form
// markdown memory into schema-valid, governed notes through the M1 write path.
// Deterministic, no LLM: bodies are imported verbatim (no wrapper/preamble),
// `created` comes from the source mtime, and every note lands at `quarantined` trust via the `import`
// trigger (MINJA defense — bulk-imported content is never trusted incidentally;
// the principal re-authors it later at higher trust via principal-correction/
// supersede — verify alone does not elevate a quarantined note). The top-level
// category dir is mapped to a note type by {@link SOMA_MEMORY_BACKFILL_TYPE_MAP}; `--type`
// forces a single type for all files. Idempotent via a SHA manifest at
// `memory/STATE/imports/backfill/.manifest.json`.

/** The durable, backfillable note types (episodic is written via digest/action, not backfill). */
export type WritableNoteType = Exclude<SomaMemoryNoteType, "episodic">;

/**
 * Top-level source category dir → note type. Categories not listed here fall
 * back to `semantic`. The map affects TYPE only — trust is always `quarantined`
 * (derived from the `import` trigger), never selectable here.
 */
export const SOMA_MEMORY_BACKFILL_TYPE_MAP: Record<string, WritableNoteType> = {
  LEARNING: "procedural",
  KNOWLEDGE: "semantic",
};

export interface SomaMemoryBackfillOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  /** Injected clock for deterministic manifest `importedAt`. Defaults to now. */
  now?: Date;
  /** Source root walked recursively. Defaults to `<somaHome>/memory`. */
  from?: string;
  /** Force ALL notes to this type, overriding the category map. */
  type?: WritableNoteType;
  /** Sets each note's `project` field. Defaults to null. */
  project?: string | null;
  /** Plan only — print the intended imports and touch nothing (no manifest write). */
  dryRun?: boolean;
}

export type SomaMemoryBackfillEntryStatus =
  | "written"
  | "skipped-manifest"
  | "skipped-duplicate"
  | "error";

/** One planned/attempted source-file → note import. */
export interface SomaMemoryBackfillEntry {
  /** POSIX relative path under the source root. */
  relativePath: string;
  /** Absolute source path (also recorded as the note's `source_of_truth`). */
  source: string;
  noteId: string;
  type: WritableNoteType;
  /** `created`/`last_verified` date derived from the source mtime (YYYY-MM-DD, UTC). */
  created: string;
  /** Target note path (written, or would-be for a dry-run). */
  target: string;
  /** Populated after a real run; absent for a dry-run plan entry. */
  status?: SomaMemoryBackfillEntryStatus;
  /** Present for `skipped-duplicate` / `error`: the reason. */
  detail?: string;
}

export interface SomaMemoryBackfillResult {
  somaHome: string;
  from: string;
  dryRun: boolean;
  writtenCount: number;
  skippedManifestCount: number;
  skippedDuplicateCount: number;
  errorCount: number;
  manifestPath: string;
  entries: SomaMemoryBackfillEntry[];
}

export interface SomaMemoryBackfillManifestEntry {
  relativePath: string;
  noteId: string;
  type: WritableNoteType;
  sha256: string;
  mtimeMs: number;
}

export interface SomaMemoryBackfillManifest {
  schema: "soma.memory-backfill.v1";
  somaHome: string;
  from: string;
  importedAt: string;
  files: SomaMemoryBackfillManifestEntry[];
}

// Memory subsystem M5 (episodic capture). Plan v2 §M5: session digests + a
// first-class action log, stored as `episodic` notes under
// `memory/episodic/{sessions,actions}/YYYY-MM/YYYYMMDD-<slug>.md`. Deterministic,
// no LLM. The digest write is gated to one-per-session — atomic (O_EXCL) within a
// UTC date, and a cross-date scan catches later re-digests — but it is best-effort,
// NOT an absolute guarantee: with no cross-process lock, a genuine concurrent race
// across different UTC dates can still produce two digests (reconciled by the M7
// audit). A second same-session call no-ops with an event. Action entries record plannedAction →
// approval → outcome for the consolidator (M6) to mine. Episodic notes are written
// at `assistant` trust (the assistant's own account); whether they reach the
// always-loaded INDEX is decided by M3's admission ladder, where an unresurfaced
// assistant note is not admitted until consolidation promotes it.

/** Approval state of a logged action (plannedAction → approval → outcome). */
export const SOMA_MEMORY_ACTION_APPROVALS = ["proposed", "approved", "rejected", "auto"] as const;
export type SomaMemoryActionApproval = (typeof SOMA_MEMORY_ACTION_APPROVALS)[number];

export interface SomaMemoryDigestOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  /** Injected clock for deterministic `created`/id date. Defaults to now. */
  now?: Date;
  /** The session this digest summarizes — the one-per-session gate key. */
  sessionId: string;
  /** The digest text: 8–15 non-empty lines of what happened / changed / open loops. */
  body: string;
  /**
   * Optional lifecycle-event label (e.g. `session-end`) recorded into the note's M0
   * `hook:` frontmatter field, marking the digest as lifecycle-triggered. Its ABSENCE
   * means only "not lifecycle-triggered" — it does NOT by itself prove assistant
   * authorship; `provenance` is the independent source signal (e.g. a `tool:<name>`
   * digest is machine-authored with no lifecycleEvent). Read both. The VALUE is an
   * opaque adapter-supplied string carrying lifecycle-event (not substrate-hook)
   * semantics, so core stays substrate-neutral without being semantics-free.
   */
  lifecycleEvent?: string;
  /**
   * Optional provenance override (`conversation` | `consolidation` | `import` |
   * `tool:<name>`). Defaults to `conversation`. A machine-extracted fallback passes a
   * `tool:<name>` value so recall surfaces that the body was not assistant-authored.
   * Rejected if outside this grammar.
   */
  provenance?: string;
}

// The Claude Code SessionEnd transcript-fallback types (ClaudeSessionDigestOptions/
// Result) are adapter-owned — see src/adapters/claude-code/session-digest.ts. Core
// stays substrate-neutral: it exposes only `writeSessionDigest` (ready body + hook
// marker) and `hasSessionDigest`; the Claude JSONL format never enters core.

export interface SomaMemoryDigestResult {
  somaHome: string;
  path: string;
  /** False when a digest already existed for the session (the write no-op'd). */
  created: boolean;
  note: SomaMemoryNote;
  event: SomaMemoryEvent;
}

export interface SomaMemoryActionOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  now?: Date;
  /** kebab slug for the action's id (`YYYYMMDD-<slug>`). */
  slug: string;
  /** The session this action belongs to (recorded in the note body for consolidation scope). */
  sessionId?: string;
  /**
   * What the assistant planned to do. Named `plannedAction` (not `intent`) because
   * CONTEXT.md reserves `intent` for the principal's checkable directional anchor
   * sourced from Purpose — a different concept from the assistant's logged action.
   */
  plannedAction: string;
  /** Approval state at record time. */
  approval: SomaMemoryActionApproval;
  /** What actually happened (may be recorded later; empty = not-yet-known). */
  outcome?: string;
}

export interface SomaMemoryActionResult {
  somaHome: string;
  path: string;
  note: SomaMemoryNote;
  event: SomaMemoryEvent;
}

// Memory subsystem M6 (deterministic consolidation). The full contract — ops,
// ordering, dry-run parity semantics, archive layout, idempotency — lives with the
// implementation in `src/memory/memory-consolidate.ts` (single source of truth). In brief:
// a no-LLM maintenance pass; `--dry-run` reports the same file OPERATIONS the real
// run applies (operation-level parity, not a byte-level diff).
export interface SomaMemoryConsolidateOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  /** Injected clock for deterministic age math. Defaults to now. */
  now?: Date;
  /** Plan only — print the ops without touching the filesystem. */
  dryRun?: boolean;
  /**
   * Explicit override for the destructive state GC. Deleting `current-work-*.json`
   * is a destructive mutation of protected state, so per CONTEXT.md it needs a
   * deliberate flag — without this, the pass plans/deletes no state files.
   */
  gcState?: boolean;
}

/** One planned file move (episodic prune → archive), preserving relative path. */
export interface SomaMemoryArchivePlan {
  from: string;
  to: string;
  reason: string;
}

/**
 * A pair of notes with high LEXICAL similarity (Jaccard token overlap), surfaced
 * for principal review — a CANDIDATE duplicate/contradiction, not a proven semantic
 * one. `score` is the token-overlap ratio. This report itself is always read-only
 * (unchanged by #428); the ELIGIBLE-for-auto-merge subset of it is a separate field,
 * {@link SomaMemoryAutoMergePlan}.
 */
export interface SomaMemorySimilarPair {
  a: string;
  b: string;
  score: number;
}

/**
 * #428 — a near-dup pair from {@link SomaMemorySimilarPair} that M6 consolidation
 * is eligible to auto-merge: BOTH notes are `assistant` trust (never `principal` —
 * those stay a read-only `similarPairs` entry only; never `quarantined` — unvetted
 * content is never auto-consolidated either). `keepId` absorbs `dropId`'s body via
 * the SAME delta-append shape the M1 `merge` mode uses; `dropId` is then CLOSED
 * (`valid_until` set, cross-linked) — invalidated, never deleted, and never
 * re-minted under a new id (this is NOT `supersede`). `score` is the pair's
 * Jaccard score at plan time.
 */
export interface SomaMemoryAutoMergePlan {
  keepId: string;
  dropId: string;
  score: number;
}

export interface SomaMemoryConsolidateResult {
  somaHome: string;
  dryRun: boolean;
  // NOTE: on a dry-run these are the PLANNED operations (nothing was applied); on a
  // real run they are what was applied. Each field's verb is mode-neutral for that
  // reason.
  /** Aged episodic notes to move under `memory/archive/` (planned on dry-run, moved on a real run). */
  archived: SomaMemoryArchivePlan[];
  /** Monthly digest files whose archived-notes months are affected (regenerated on a real run). */
  digestsWritten: string[];
  /** Semantic notes to mark `review: stale` (planned on dry-run, marked on a real run). */
  markedStale: string[];
  /** `current-work-*.json` files older than 7d to GC — only under `--gc-state`; this pass's only deletion. */
  stateGced: string[];
  /** High-lexical-similarity note pairs listed for review (candidate duplicates/contradictions). Read-only; never mutates anything itself. */
  similarPairs: SomaMemorySimilarPair[];
  /**
   * #428 — assistant-trust near-dup pairs auto-merged (planned on dry-run, applied
   * on a real run): `keepId` absorbed `dropId`'s body and `dropId` was closed.
   * Principal-trust pairs NEVER appear here — see {@link SomaMemoryAutoMergePlan}.
   */
  autoMerged: SomaMemoryAutoMergePlan[];
  /**
   * Note files surfaced for the audit and NOT acted on — either an I/O/parse failure
   * (couldn't be read/parsed) OR a safety refusal (unsafe id, malformed calendar date,
   * or a mis-placed episodic note whose directory month ≠ its created month). Never
   * silently skipped; the two classes are not distinguished in this field.
   */
  unreadable: string[];
  /**
   * True iff the pass has (or, on dry-run, would have) any file mutation — i.e. any
   * of archived / markedStale / stateGced / autoMerged is non-empty. The single
   * source of truth for whether the INDEX is rebuilt and a `memory.consolidate`
   * event is emitted; the similar-pairs report is read-only and does NOT set this.
   */
  mutated: boolean;
  /**
   * The INDEX.md path. Always reported, but the index is REBUILT only when the pass
   * mutated something (any of archived / markedStale / stateGced non-empty) — a
   * no-op run leaves it untouched. This is the path, not proof a rebuild happened.
   */
  indexPath: string;
}

// Memory subsystem M7 (audit). Plan v2 §M7: a DETERMINISTIC health check over the
// on-disk memory tree — no LLM, no sentiment, only filesystem ground-truth probes.
// Read-only: it mutates nothing and appends no event. The CLI exits NON-ZERO when
// `healthy` is false — any health-gating probe failing: an abnormal note root
// (root-integrity), a schema-invalid note, or a stale INDEX — so it can gate CI /
// a pre-consolidation check.
export interface SomaMemoryAuditOptions {
  homeDir?: string;
  somaHome?: string;
}

/** The fixed set of audit probes (stable public names; `auditMemory` is exported). */
export type SomaMemoryAuditProbeName =
  | "root-integrity"
  | "schema"
  | "index-freshness"
  | "digest-coverage"
  | "orphaned-archive"
  | "event-ratio"
  | "retrieval-quality";

/**
 * One deterministic probe's outcome. `gatesHealth` is machine-readable: when it is
 * true, `ok: false` forces `result.healthy` false. Three probes gate:
 * `root-integrity`, `schema`, and `index-freshness`. Informational probes
 * (`digest-coverage`, `orphaned-archive`, `event-ratio`, `retrieval-quality`) have
 * `gatesHealth: false` and always report `ok: true`.
 */
export interface SomaMemoryAuditProbe {
  name: SomaMemoryAuditProbeName;
  ok: boolean;
  gatesHealth: boolean;
  detail: string;
}

/**
 * #425 — the first retrieval-quality signal, computed PURELY from the journal
 * (no new state files, no gating): the AUTOMEM-inspired "does recall actually
 * help" proxy. Every rate here is over PARSEABLE journal events — a malformed
 * JSONL line is skipped and counted in `skippedEventLines`, so a reader can see
 * the metric is not necessarily over the complete journal. `verifyFollowsRecallRate`'s
 * denominator is recalls WITH results (`recallsWithResults`), not every recall —
 * an empty recall structurally can never be followed by a verify of a returned
 * note, so folding it into this rate would just re-encode `emptyRecallRate` a
 * second time. `verifyWindowEvents` is the number of SUBSEQUENT parseable journal
 * events (any kind) searched, chronologically after a recall, for a
 * `memory.verify` OR (#427) `memory.resurface` of one of its returned ids — a
 * fixed default (see `memory-audit.ts`), not yet configurable; a future slice
 * may gate on this metric, this one only measures it.
 */
export interface SomaMemoryRetrievalQuality {
  /** Total `memory.recall` events in the journal. */
  recallVolume: number;
  /** Fraction of recalls returning 0 note ids (AUTOMEM's "empty-search rate"). 0 when recallVolume is 0. */
  emptyRecallRate: number;
  /** Fraction of non-empty recalls followed by a `memory.verify` OR (#427) `memory.resurface` of a returned id within the window. 0 when recallsWithResults is 0. */
  verifyFollowsRecallRate: number;
  /** Denominator for verifyFollowsRecallRate: recalls that returned ≥1 note id. */
  recallsWithResults: number;
  /** The subsequent-event window used to correlate a recall with a later verify. */
  verifyWindowEvents: number;
  /** Non-empty journal lines that failed to parse (skipped, not counted in any rate) — surfaces that the metric is over PARSEABLE events, not the whole journal. */
  skippedEventLines: number;
}

export interface SomaMemoryAuditResult {
  somaHome: string;
  /** false ⇒ the CLI exits non-zero. Gated by ALL three: real note roots (root-integrity),
   *  no schema-invalid notes, AND a fresh INDEX. */
  healthy: boolean;
  /** Valid-note counts by type across the whole tree (durable + episodic + archive). */
  notesByType: { semantic: number; procedural: number; episodic: number };
  /** Note files that exist but fail to parse (schema-invalid) — a health failure. */
  invalidNotes: string[];
  /** INDEX freshness: stale when a durable note is newer than INDEX.md, or INDEX is absent while durable notes exist. */
  index: { path: string; stale: boolean; reason: string };
  /** Episodic coverage counts — session/action notes vs monthly digest files present. */
  digests: { sessionNotes: number; actionNotes: number; digestFiles: number };
  /** Archived episodic notes whose id is absent from their month's digest (informational drift signal). */
  orphanedArchive: string[];
  /** Event-stream vs corpus size — a coarse write-amplification signal (informational). */
  events: { lines: number; notes: number };
  /** #425 retrieval-quality signal computed from the journal (informational, never gates `healthy`). */
  retrieval: SomaMemoryRetrievalQuality;
  /**
   * Every probe run, in report order. THREE gate `healthy` (`root-integrity`,
   * `schema`, `index-freshness`); the other four (`digest-coverage`,
   * `orphaned-archive`, `event-ratio`, `retrieval-quality`) are informational drift
   * signals whose `ok` is always true. Read `probe.gatesHealth` rather than
   * hardcoding this list.
   */
  probes: SomaMemoryAuditProbe[];
}

// Memory subsystem M2 (recall). Plan v2 §M2: note-aware retrieval over the
// durable corpus (semantic + procedural) — term scoring, whole-file retrieval
// (limit 3), 1-hop link expansion, superseded-exclusion via `valid_until`, and a
// read-time verification banner whose age derives from an injected `now`. Recall
// mutates NO note (verifying is a separate, authority-gated act) — that purity
// invariant is unchanged. #425 adds exactly one observability side effect: every
// call appends a `memory.recall` journal event (query terms, returned note ids,
// result count, unresolved-link count) so retrieval can finally be measured; see
// `memory-recall.ts`'s module docstring for the full contract. The legacy
// line-grep `searchSomaMemory` (which walks the pre-note memory tree
// WORK/KNOWLEDGE/…) also appends a `memory.recall` event now, tagged
// `via: "search"` — but only when the query has searchable terms.
export interface SomaMemoryRecallOptions {
  homeDir?: string;
  somaHome?: string;
  query: string;
  /** Cap on primary (term-matched) notes returned; 1-hop link pulls are additional. Default 3. */
  limit?: number;
  /** Injected clock for deterministic banner ages AND the recall event's timestamp. Defaults to now. */
  now?: Date;
  /** Substrate tag for the `memory.recall` event this call appends. Defaults to `"custom"`. */
  substrate?: SubstrateId;
}

/** One retrieved note with its verification banner (M2). */
export interface SomaMemoryRecalledNote {
  id: string;
  type: SomaMemoryNoteType;
  path: string;
  /** Distinct query terms matched in the note; 0 for a note pulled only via a 1-hop link. */
  score: number;
  /** `match` = surfaced by term score; `link` = pulled in as 1-hop context from a match. */
  via: "match" | "link";
  /** For `via: "link"`, the id of the matched note that linked here; null for matches. */
  linkedFrom: string | null;
  /** Whole days since `last_verified`, clamped at 0 for a future date (derived from injected `now`). */
  ageDays: number;
  /** True iff `trust === "quarantined"` — the note carries an untrusted-content warning. */
  quarantined: boolean;
  /** The one-line verification banner (age · trust · provenance · verify-against). */
  banner: string;
  /** Whole-file: the complete parsed note (body included). */
  note: SomaMemoryNote;
}

export interface SomaMemoryRecallResult {
  query: string;
  somaHome: string;
  /** The 3+char query terms actually scored (deduped, lowercased). */
  terms: string[];
  /** Primary matches first (score desc), then their 1-hop link pulls. */
  matches: SomaMemoryRecalledNote[];
  /** 1-hop link ids that resolved to no active note (missing or superseded) — surfaced, not hidden. */
  unresolvedLinks: string[];
  /** Corpus files that exist but could not be read/parsed — recall's blind spot, never silent. */
  unreadable: string[];
}

// Memory subsystem M3 (index renderer). The result of rebuilding the tiny,
// always-loaded INDEX (`memory/INDEX.md`, ≤200 pointer lines / ≤25KB): its path,
// rendered content, admit/render/shed/excluded counts, and the unreadable blind
// spot. Admission, scoring, and budget POLICY live with the renderer in
// `src/memory/memory-index.ts` (the single source of truth). M4 projects the file through
// substrate adapters into each substrate's native always-loaded surface.
export interface SomaMemoryIndexResult {
  somaHome: string;
  /** On-disk path of the rendered index (`memory/INDEX.md`). */
  path: string;
  /** The rendered INDEX.md content (also what M4 projects verbatim). */
  content: string;
  /** Notes that earned admission (before the budget was applied). */
  admitted: number;
  /** Index lines actually rendered after the budget. */
  rendered: number;
  /** admitted − rendered: lines shed to stay within the line/byte budget. */
  shed: number;
  /** Notes present but NOT admitted (quarantined, superseded, or not yet earned). */
  excluded: number;
  /** Corpus files that exist but could not be read/parsed — surfaced, never silent. */
  unreadable: string[];
}
