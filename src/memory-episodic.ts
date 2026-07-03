import { mkdir, writeFile, unlink, access } from "node:fs/promises";
import { dirname } from "node:path";
import { createPaths } from "./paths";
import { appendSomaMemoryEvent } from "./memory";
import { serializeMemoryNote, MemoryNoteError } from "./memory-note";
import { SOMA_MEMORY_ACTION_APPROVALS } from "./types";
import type {
  SomaMemoryActionOptions,
  SomaMemoryActionResult,
  SomaMemoryDigestOptions,
  SomaMemoryDigestResult,
  SomaMemoryNote,
} from "./types";

/**
 * Episodic capture (subsystem M5). Session digests + a first-class action log,
 * written as `episodic` notes under
 * `memory/episodic/{sessions,actions}/YYYY-MM/YYYYMMDD-<slug>.md`. Deterministic
 * (dates from an injected `now`, no LLM). Two capture paths:
 *
 * - **digest** — one 8–15-line "what happened / what changed / open loops" per
 *   session. The write is GATED to exactly one per session: a second `digest` for
 *   the same session no-ops and records a `memory.digest.duplicate` event, so the
 *   design's one-digest-per-session invariant holds even if the CLI and a hook both
 *   fire (the exactly-one write gate).
 * - **action** — an intent → approval → outcome entry for the M6 consolidator to
 *   mine. Actions are many-per-session, keyed by a caller-supplied slug; an id
 *   collision is refused (never silently overwrite an existing action record).
 *
 * Episodic notes are `assistant` trust (the agent's own account of a session), so
 * they never enter the always-loaded INDEX by admission (M3) until consolidation
 * promotes a recurring pattern. Each write appends exactly one journal event, with
 * the same write-then-event-with-rollback discipline as M1: if the event append
 * fails, the just-written file is removed so no episodic file is orphaned.
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
 * Turn an opaque session id into a bounded kebab slug so it is filesystem-safe and
 * a valid note id fragment. Lowercase, non-alphanumerics → single dashes, trimmed,
 * capped. A session id that reduces to nothing (all punctuation) is rejected —
 * better to fail loud than write an ambiguous `YYYYMMDD-.md`.
 */
function sessionSlug(sessionId: string): string {
  const slug = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (slug.length === 0) {
    throw new MemoryNoteError(`session id "${sessionId}" has no slug-able characters.`, "sessionId");
  }
  return slug;
}

function episodicPath(somaHome: string, kind: "sessions" | "actions", now: Date, id: string): string {
  return createPaths(somaHome).resolve("memory", "episodic", kind, monthDir(now), `${id}.md`);
}

async function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

/** Build an episodic note (assistant trust, agent-authored account). */
function buildEpisodicNote(id: string, now: Date, body: string, project: string | null): SomaMemoryNote {
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
    project,
    links: [],
    resurface_count: 0,
    body: body.trim(),
  };
}

/**
 * Write a note file (fail if it already exists) then append its event; if the
 * event append fails, remove the just-written file so no episodic file is orphaned
 * from its journal entry. Mirrors M1's write-then-event-with-rollback (not
 * crash-atomic — a hard kill between the two can still orphan a file, reconciled by
 * the M7 audit).
 */
async function writeEpisodicNoteWithEvent(
  somaHome: string,
  path: string,
  note: SomaMemoryNote,
  substrate: SomaMemoryDigestOptions["substrate"],
  eventFields: { kind: string; summary: string; metadata: Record<string, unknown> },
  now: Date,
): Promise<SomaMemoryDigestResult["event"]> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeMemoryNote(note), { encoding: "utf8", flag: "wx" });
  try {
    return await appendSomaMemoryEvent(somaHome, {
      timestamp: now.toISOString(),
      substrate: substrate ?? "custom",
      kind: eventFields.kind,
      summary: eventFields.summary,
      artifactPaths: [path],
      metadata: eventFields.metadata,
    });
  } catch (appendError) {
    await unlink(path).catch(() => undefined);
    throw new Error(`Soma memory ${eventFields.kind} event append failed; rolled back the file.`, { cause: appendError });
  }
}

/**
 * Write the one session digest (M5). Gated to exactly one per session: if a digest
 * for `sessionId` already exists (same id, `YYYYMMDD-<sessionSlug>`), this no-ops,
 * records a `memory.digest.duplicate` event, and returns `created: false` with the
 * existing note re-read from disk NOT re-parsed here (the caller only needs the
 * decision + path). The body must be 8–15 non-empty lines.
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

  const id = `${idDate(now)}-${sessionSlug(options.sessionId)}`;
  assertSlug(id, "digest id");
  const path = episodicPath(somaHome, "sessions", now, id);
  const note = buildEpisodicNote(id, now, options.body, null);

  // One-per-session gate: an existing digest for this session is NOT overwritten.
  if (await pathExists(path)) {
    const event = await appendSomaMemoryEvent(somaHome, {
      timestamp: now.toISOString(),
      substrate: options.substrate ?? "custom",
      kind: "memory.digest.duplicate",
      summary: `Digest already exists for session ${options.sessionId} (${id}); no-op.`,
      artifactPaths: [path],
      metadata: { id, sessionId: options.sessionId },
    });
    return { somaHome, path, created: false, note, event };
  }

  const event = await writeEpisodicNoteWithEvent(
    somaHome,
    path,
    note,
    options.substrate,
    {
      kind: "memory.digest",
      summary: `Session digest ${id} for session ${options.sessionId} (${lines.length} lines).`,
      metadata: { id, sessionId: options.sessionId, lines: lines.length },
    },
    now,
  );
  return { somaHome, path, created: true, note, event };
}

/**
 * Log one action (M5): intent → approval → outcome, as an episodic note under
 * `actions/`. Keyed by a caller slug (`YYYYMMDD-<slug>`); an id collision is
 * refused rather than overwriting an existing action record.
 */
export async function writeAction(options: SomaMemoryActionOptions): Promise<SomaMemoryActionResult> {
  const somaHome = createPaths(options).root();
  const now = options.now ?? new Date();
  assertNonEmpty(options.slug, "slug");
  assertSlug(options.slug, "slug");
  assertNonEmpty(options.intent, "intent");
  if (!(SOMA_MEMORY_ACTION_APPROVALS as readonly string[]).includes(options.approval)) {
    throw new MemoryNoteError(`approval must be one of ${SOMA_MEMORY_ACTION_APPROVALS.join(", ")}.`, "approval");
  }

  const id = `${idDate(now)}-${options.slug}`;
  assertSlug(id, "action id");
  const path = episodicPath(somaHome, "actions", now, id);
  if (await pathExists(path)) {
    throw new MemoryNoteError(`Soma memory action id already exists: ${id}`, "slug");
  }

  // The action's structured record — intent/approval/outcome, one per line so the
  // consolidator can parse it mechanically.
  const body = [
    `**Intent:** ${options.intent.trim()}`,
    `**Approval:** ${options.approval}`,
    `**Outcome:** ${options.outcome && options.outcome.trim().length > 0 ? options.outcome.trim() : "(not yet recorded)"}`,
  ].join("\n");
  const note = buildEpisodicNote(id, now, body, options.sessionId ?? null);

  const event = await writeEpisodicNoteWithEvent(
    somaHome,
    path,
    note,
    options.substrate,
    {
      kind: "memory.action",
      summary: `Action ${id} (${options.approval}): ${options.intent.trim().slice(0, 80)}`,
      metadata: { id, sessionId: options.sessionId ?? null, approval: options.approval },
    },
    now,
  );
  return { somaHome, path, note, event };
}
