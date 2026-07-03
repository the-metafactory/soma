import { createHash } from "node:crypto";
import { mkdir, writeFile, unlink, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPaths } from "./paths";
import { appendSomaMemoryEvent } from "./memory";
import { serializeMemoryNote, parseMemoryNote, MemoryNoteError } from "./memory-note";
import { SOMA_MEMORY_ACTION_APPROVALS } from "./types";
import type {
  SomaMemoryActionOptions,
  SomaMemoryActionResult,
  SomaMemoryDigestOptions,
  SomaMemoryDigestResult,
  SomaMemoryEvent,
  SomaMemoryNote,
  SubstrateId,
} from "./types";

/**
 * Episodic capture (subsystem M5). Session digests + a first-class action log,
 * written as `episodic` notes under
 * `memory/episodic/{sessions,actions}/YYYY-MM/YYYYMMDD-<slug>.md`. Deterministic
 * (dates from an injected `now`, no LLM). Two capture paths:
 *
 * - **digest** — one 8–15-line "what happened / what changed / open loops" per
 *   session. The write is gated to one-per-session: a cross-date scan finds any
 *   existing digest for the session, and the actual write uses an O_EXCL create so
 *   two same-date writers can't both win — the loser observes EEXIST and records a
 *   `memory.digest.duplicate` event instead of erroring. HONEST LIMIT: soma has no
 *   cross-process lock, so a genuine concurrent race between two writers on
 *   DIFFERENT UTC dates (e.g. a multi-day session) could still produce two digests
 *   before either scan sees the other — reconciled by the M7 audit, not prevented
 *   here.
 * - **action** — a plannedAction → approval → outcome entry for the M6
 *   consolidator to mine. Actions are many-per-session, keyed by a caller slug; an
 *   id collision is refused via the same O_EXCL create (never overwrites a record).
 *
 * Episodic notes are `assistant` trust (the agent's own account of a session), so
 * they never enter the always-loaded INDEX by admission (M3) until consolidation
 * promotes a recurring pattern. Each write appends exactly one journal event; if
 * that append fails, the just-written file is removed — and if THAT removal also
 * fails, the inconsistency is surfaced (never silently swallowed). Not crash-atomic:
 * a hard kill between the file write and the event append can still orphan a file,
 * reconciled by the M7 audit.
 */

// Same slug grammar as the M0 note id / M1 write boundary.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Digest body bounds (plan §M5): a digest is 8–15 non-empty lines.
const DIGEST_MIN_LINES = 8;
const DIGEST_MAX_LINES = 15;

function assertNonEmpty(value: string | undefined, field: string): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new MemoryNoteError(`Soma memory episodic ${field} must not be empty.`, field);
  }
}

function assertSlug(slug: string, field: string): void {
  if (!SLUG.test(slug) || slug.length > 64) {
    throw new MemoryNoteError(`${field} "${slug}" is not a valid slug (lowercase [a-z0-9-], <=64 chars).`, field);
  }
}

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

/** YYYY-MM-DD (UTC) — the note schema's calendar-date grammar. */
function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** YYYYMMDD (UTC) — the id date prefix. */
function idDate(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

/** YYYY-MM (UTC) — the month directory. */
function monthDir(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/**
 * A collision-RESISTANT slug for a session. A human-readable prefix (normalized,
 * truncated) is combined with an 8-hex digest of the FULL session id, so two
 * distinct session ids can never map to the same slug (which would make one
 * session's digest no-op against the other's). If the id has no slug-able
 * characters, the hash alone identifies it.
 */
function sessionSlug(sessionId: string): string {
  const readable = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  return readable.length > 0 ? `${readable}-${hash}` : hash;
}

function episodicPath(somaHome: string, kind: "sessions" | "actions", now: Date, id: string): string {
  return createPaths(somaHome).resolve("memory", "episodic", kind, monthDir(now), `${id}.md`);
}

/**
 * Find an EXISTING session digest for `slug`, across ALL month directories — the
 * one-per-session scan must be date-INDEPENDENT (a multi-day session digested on a
 * later UTC date must still be recognized). A digest id is always `YYYYMMDD-<slug>`,
 * so a file matching `^\d{8}-<slug>\.md$` in any month dir is the session's digest.
 * Exact-match on the full id avoids a slug being a false suffix of another. The scan
 * cost grows with retained digests but is bounded by M6's 90-day archival; the
 * O_EXCL write below is the atomic gate, this is the cross-date fast-path.
 */
async function findExistingSessionDigestPath(somaHome: string, slug: string): Promise<string | undefined> {
  const base = createPaths(somaHome).resolve("memory", "episodic", "sessions");
  const idPattern = new RegExp(`^\\d{8}-${slug}\\.md$`); // slug is [a-z0-9-] only — no regex metachars
  let months: string[];
  try {
    months = await readdir(base);
  } catch {
    return undefined; // sessions dir absent → no digests yet
  }
  for (const month of months.sort()) {
    let entries: string[];
    try {
      entries = await readdir(join(base, month));
    } catch {
      continue;
    }
    const match = entries.sort().find((entry) => idPattern.test(entry));
    if (match) return join(base, month, match);
  }
  return undefined;
}

/** Build an episodic note (assistant trust, agent-authored account). */
function buildEpisodicNote(id: string, now: Date, body: string): SomaMemoryNote {
  const today = isoDate(now);
  return {
    id,
    type: "episodic",
    created: today,
    last_verified: today,
    valid_until: null,
    provenance: "conversation",
    trust: "assistant",
    source_of_truth: null,
    project: null,
    links: [],
    resurface_count: 0,
    body: body.trim(),
  };
}

interface EpisodicWrite {
  somaHome: string;
  path: string;
  note: SomaMemoryNote;
  substrate: SubstrateId | undefined;
  now: Date;
  event: { kind: string; summary: string; metadata: Record<string, unknown> };
}

/**
 * O_EXCL-create the note file (throws EEXIST if it already exists — the callers
 * turn that into duplicate/collision handling), then append its event. If the
 * event append fails, remove the just-written file; if that removal ALSO fails, the
 * inconsistency is surfaced rather than swallowed (mirrors M1's honest rollback).
 */
async function writeEpisodicNoteWithEvent(input: EpisodicWrite): Promise<SomaMemoryEvent> {
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, serializeMemoryNote(input.note), { encoding: "utf8", flag: "wx" });
  try {
    return await appendSomaMemoryEvent(input.somaHome, {
      timestamp: input.now.toISOString(),
      substrate: input.substrate ?? "custom",
      kind: input.event.kind,
      summary: input.event.summary,
      artifactPaths: [input.path],
      metadata: input.event.metadata,
    });
  } catch (appendError) {
    try {
      await unlink(input.path);
    } catch (unlinkError) {
      throw new Error(
        `Soma memory ${input.event.kind} event append failed AND the rollback unlink failed — ` +
          `orphaned file ${input.path}; reconcile manually.`,
        { cause: unlinkError },
      );
    }
    throw new Error(`Soma memory ${input.event.kind} event append failed; rolled back the file.`, { cause: appendError });
  }
}

/** Record a duplicate-digest no-op against an existing on-disk digest. */
async function recordDuplicateDigest(
  somaHome: string,
  existingPath: string,
  sessionId: string,
  substrate: SubstrateId | undefined,
  now: Date,
): Promise<SomaMemoryDigestResult> {
  const existingNote = parseMemoryNote(await readFile(existingPath, "utf8"));
  const event = await appendSomaMemoryEvent(somaHome, {
    timestamp: now.toISOString(),
    substrate: substrate ?? "custom",
    kind: "memory.digest.duplicate",
    summary: `Digest already exists for session ${sessionId} (${existingNote.id}); no-op.`,
    artifactPaths: [existingPath],
    metadata: { id: existingNote.id, sessionId },
  });
  return { somaHome, path: existingPath, created: false, note: existingNote, event };
}

/**
 * Write the one session digest (M5). One-per-session: a cross-date scan short-
 * circuits to a duplicate no-op, and the O_EXCL write makes the same-date path
 * atomic — a concurrent same-date writer that loses observes EEXIST and records a
 * duplicate event too. The body must be 8–15 non-empty lines.
 */
export async function writeSessionDigest(options: SomaMemoryDigestOptions): Promise<SomaMemoryDigestResult> {
  const somaHome = createPaths(options).root();
  const now = options.now ?? new Date();
  assertNonEmpty(options.sessionId, "sessionId");
  assertNonEmpty(options.body, "body");

  const lines = options.body.trim().split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < DIGEST_MIN_LINES || lines.length > DIGEST_MAX_LINES) {
    throw new MemoryNoteError(
      `a session digest must be ${DIGEST_MIN_LINES}–${DIGEST_MAX_LINES} non-empty lines (got ${lines.length}).`,
      "body",
    );
  }

  const slug = sessionSlug(options.sessionId);
  const id = `${idDate(now)}-${slug}`;
  assertSlug(id, "digest id");

  // Cross-date fast-path: an existing digest for this session (any month) no-ops.
  const existingPath = await findExistingSessionDigestPath(somaHome, slug);
  if (existingPath !== undefined) {
    return recordDuplicateDigest(somaHome, existingPath, options.sessionId, options.substrate, now);
  }

  const path = episodicPath(somaHome, "sessions", now, id);
  const note = buildEpisodicNote(id, now, options.body);
  try {
    const event = await writeEpisodicNoteWithEvent({
      somaHome,
      path,
      note,
      substrate: options.substrate,
      now,
      event: {
        kind: "memory.digest",
        summary: `Session digest ${id} for session ${options.sessionId} (${lines.length} lines).`,
        metadata: { id, sessionId: options.sessionId, lines: lines.length },
      },
    });
    return { somaHome, path, created: true, note, event };
  } catch (error) {
    // A concurrent same-date writer created the file first (O_EXCL) — treat as duplicate.
    if (isEexist(error)) {
      return recordDuplicateDigest(somaHome, path, options.sessionId, options.substrate, now);
    }
    throw error;
  }
}

/**
 * Log one action (M5): plannedAction → approval → outcome, as an episodic note
 * under `actions/`. Keyed by a caller slug (`YYYYMMDD-<slug>`); an id collision is
 * refused via the O_EXCL create (never overwrites an existing action record). The
 * session id is recorded in the body (NOT `project`, which is reserved for actual
 * project scope).
 */
export async function writeMemoryAction(options: SomaMemoryActionOptions): Promise<SomaMemoryActionResult> {
  const somaHome = createPaths(options).root();
  const now = options.now ?? new Date();
  assertNonEmpty(options.slug, "slug");
  assertSlug(options.slug, "slug");
  assertNonEmpty(options.plannedAction, "plannedAction");
  if (!(SOMA_MEMORY_ACTION_APPROVALS as readonly string[]).includes(options.approval)) {
    throw new MemoryNoteError(`approval must be one of ${SOMA_MEMORY_ACTION_APPROVALS.join(", ")}.`, "approval");
  }

  const id = `${idDate(now)}-${options.slug}`;
  assertSlug(id, "action id");
  const path = episodicPath(somaHome, "actions", now, id);

  // The action's structured record — one field per line so the consolidator can
  // parse it mechanically. Session id lives here, not in `project`.
  const bodyLines = [
    `**Planned action:** ${options.plannedAction.trim()}`,
    `**Approval:** ${options.approval}`,
    `**Outcome:** ${options.outcome && options.outcome.trim().length > 0 ? options.outcome.trim() : "(not yet recorded)"}`,
  ];
  if (options.sessionId && options.sessionId.trim().length > 0) {
    bodyLines.push(`**Session:** ${options.sessionId.trim()}`);
  }
  const note = buildEpisodicNote(id, now, bodyLines.join("\n"));

  try {
    const event = await writeEpisodicNoteWithEvent({
      somaHome,
      path,
      note,
      substrate: options.substrate,
      now,
      event: {
        kind: "memory.action",
        summary: `Action ${id} (${options.approval}): ${options.plannedAction.trim().slice(0, 80)}`,
        metadata: { id, sessionId: options.sessionId ?? null, approval: options.approval },
      },
    });
    return { somaHome, path, note, event };
  } catch (error) {
    if (isEexist(error)) {
      throw new MemoryNoteError(`Soma memory action id already exists: ${id}`, "slug");
    }
    throw error;
  }
}
