import { createHash } from "node:crypto";
import { mkdir, writeFile, unlink, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPaths } from "./paths";
import { isEnoent } from "./fs-utils";
import { appendSomaMemoryEvent } from "./memory";
import { serializeMemoryNote, parseMemoryNote, MemoryNoteError } from "./memory-note";
import { SOMA_MEMORY_ACTION_APPROVALS } from "./types";
import type {
  SomaMemoryActionOptions,
  SomaMemoryActionResult,
  SomaMemoryDigestFromTranscriptOptions,
  SomaMemoryDigestFromTranscriptResult,
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
 * Episodic notes are written at `assistant` trust (the assistant's own account of
 * a session). Whether they reach the always-loaded INDEX is decided by M3's
 * admission ladder, NOT here — under that rule an unresurfaced assistant note is
 * not admitted, so digests stay out of the projected index until consolidation
 * promotes a recurring pattern; that enforcement (and its tests) live in
 * `memory-index.ts`, this module only sets the trust. Each write appends exactly
 * one journal event; if
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

function assertSlug(slug: string, field: string, maxLen = 64): void {
  if (!SLUG.test(slug) || slug.length > maxLen) {
    throw new MemoryNoteError(`${field} "${slug}" is not a valid slug (lowercase [a-z0-9-], <=${maxLen} chars).`, field);
  }
}

// The `YYYYMMDD-` date prefix (9 chars) eats into the 64-char id budget, so a
// caller-supplied action slug is capped so `${date}-${slug}` stays a valid id —
// caught at the `slug` field (clear error) rather than surfacing later as a
// confusing `action id` failure.
const MAX_ID_SLUG = 64 - "YYYYMMDD-".length;

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
 * distinct session ids are overwhelmingly unlikely to map to the same slug — an
 * 8-hex (32-bit) digest is collision-resistant, not collision-proof, but it closes
 * the systematic truncation collisions (distinct ids sharing a 32-char prefix) that
 * a plain truncated slug would alias into one digest. If the id has no slug-able
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
 * is an unbounded directory walk today; M6 (episodic archival, not yet implemented)
 * is expected to bound it by pruning old digests. The O_EXCL write below is the
 * atomic gate — this is only the cross-date fast-path.
 */
async function findExistingSessionDigestPath(somaHome: string, slug: string): Promise<string | undefined> {
  const base = createPaths(somaHome).resolve("memory", "episodic", "sessions");
  const idPattern = new RegExp(`^\\d{8}-${slug}\\.md$`); // slug is [a-z0-9-] only — no regex metachars
  let months: string[];
  try {
    months = await readdir(base);
  } catch (error) {
    if (isEnoent(error)) return undefined; // sessions dir absent → genuinely no digests yet
    // Any OTHER failure (permissions, ENOTDIR, I/O) must NOT fail open — a scan we
    // can't complete can't prove "no existing digest", and swallowing it would let
    // a duplicate slip past the one-per-session gate.
    throw new Error(`Soma memory: could not scan session digests at ${base} — dedup cannot proceed.`, { cause: error });
  }
  for (const month of months.sort()) {
    const monthDirPath = join(base, month);
    let entries: string[];
    try {
      entries = await readdir(monthDirPath);
    } catch (error) {
      if (isEnoent(error)) continue; // a month dir vanished mid-scan — nothing there
      throw new Error(`Soma memory: could not scan session digests in ${monthDirPath} — dedup cannot proceed.`, { cause: error });
    }
    const match = entries.sort().find((entry) => idPattern.test(entry));
    if (match) return join(monthDirPath, match);
  }
  return undefined;
}

/** Build an episodic note (assistant trust, assistant-authored account). */
function buildEpisodicNote(id: string, now: Date, body: string, hook?: string): SomaMemoryNote {
  const today = isoDate(now);
  const note: SomaMemoryNote = {
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
  if (hook !== undefined && hook.trim().length > 0) note.hook = hook.trim();
  return note;
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

/**
 * Read + parse the existing digest, retrying briefly. The cross-date SCAN path
 * hits a fully-written file (first attempt succeeds), but the EEXIST path can race
 * a concurrent winner whose O_EXCL-created file is not yet fully written — a bounded
 * retry rides out that in-flight window rather than throwing a confusing parse error.
 */
async function readNoteWithRetry(path: string, attempts = 5): Promise<SomaMemoryNote> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return parseMemoryNote(await readFile(path, "utf8"));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5)); // let the winner finish its write
    }
  }
  throw new Error(`Soma memory: existing digest at ${path} could not be read/parsed after ${attempts} attempts.`, { cause: lastError });
}

/** Record a duplicate-digest no-op against an existing on-disk digest. */
async function recordDuplicateDigest(
  somaHome: string,
  existingPath: string,
  sessionId: string,
  substrate: SubstrateId | undefined,
  now: Date,
): Promise<SomaMemoryDigestResult> {
  const existingNote = await readNoteWithRetry(existingPath);
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
  const note = buildEpisodicNote(id, now, options.body, options.hook);
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

// --- SessionEnd deterministic fallback (M5b) ---------------------------------

// A deterministic fallback needs enough genuine prompts to make a useful 8–15-line
// digest — below this it skips (the assistant self-authors small sessions instead).
const FALLBACK_MIN_PROMPTS = 6;
const FALLBACK_MAX_PROMPT_LINES = 13; // + 2 structural (header + tools) = 15 max
const PROMPT_LINE_MAX_CHARS = 120;

/** Wrapper/noise prefixes that mark a "user" line as NOT a genuine principal prompt. */
const PROMPT_NOISE_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<local-command-",
  "<system-reminder>",
  "caveat:",
  "<user-prompt-submit-hook>",
];

/** Collapse control chars + whitespace and truncate — one clean digest pointer line. */
function cleanLine(text: string): string {
  const collapsed = text.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > PROMPT_LINE_MAX_CHARS ? `${collapsed.slice(0, PROMPT_LINE_MAX_CHARS - 1)}…` : collapsed;
}

/** The text of a transcript message's `content` (string, or joined `text` parts). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type?: unknown; text?: unknown } => part !== null && typeof part === "object")
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join(" ");
  }
  return "";
}

/**
 * Deterministically extract an 8–15-line digest body from a Claude Code transcript
 * (JSONL). No LLM: it lists the genuine principal prompts (noise/tool/command lines
 * filtered, sidechain/sub-agent lines skipped) plus a header and a tool-use rollup.
 * Returns `undefined` when the session has too few real prompts to summarize.
 */
export function extractDigestBodyFromTranscript(transcript: string): string | undefined {
  const prompts: string[] = [];
  const toolCounts = new Map<string, number>();
  let assistantTurns = 0;

  for (const raw of transcript.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a non-JSON line — skip, never fail the whole extraction
    }
    if (entry.isSidechain === true || entry.isMeta === true) continue; // sub-agent / meta noise
    const message = entry.message as { role?: unknown; content?: unknown } | undefined;
    if (entry.type === "user" && message?.role === "user") {
      // A real prompt is string content; a tool_result array is not principal text.
      if (typeof message.content !== "string" && !isTextOnlyContent(message.content)) continue;
      const text = cleanLine(messageText(message.content));
      if (text.length === 0) continue;
      const lower = text.toLowerCase();
      if (PROMPT_NOISE_PREFIXES.some((p) => lower.startsWith(p))) continue;
      prompts.push(text);
    } else if (entry.type === "assistant" && message?.role === "assistant") {
      assistantTurns += 1;
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part && typeof part === "object" && (part as { type?: unknown }).type === "tool_use") {
            const name = (part as { name?: unknown }).name;
            if (typeof name === "string") toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
          }
        }
      }
    }
  }

  if (prompts.length < FALLBACK_MIN_PROMPTS) return undefined;

  // Sample head + tail when there are many prompts, so the digest captures the arc.
  const shown = samplePrompts(prompts, FALLBACK_MAX_PROMPT_LINES);
  const totalTools = [...toolCounts.values()].reduce((sum, n) => sum + n, 0);
  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name, n]) => `${name}×${n}`)
    .join(", ");

  const lines = [
    `- session: ${prompts.length} principal prompts, ${assistantTurns} assistant turns, ${totalTools} tool calls`,
    ...shown.map((p) => `- ${p}`),
    `- tools: ${topTools.length > 0 ? topTools : "none"}`,
  ];
  return lines.join("\n");
}

/** True only for array content that is purely text parts (never a tool_result). */
function isTextOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((part) => part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text");
}

/** Head+tail sample to `max` lines, inserting an elision marker when trimmed. */
function samplePrompts(prompts: string[], max: number): string[] {
  if (prompts.length <= max) return prompts;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return [...prompts.slice(0, head), `… (${prompts.length - head - tail} more prompts) …`, ...prompts.slice(prompts.length - tail)];
}

/**
 * SessionEnd fallback (M5b): write a deterministic digest from a transcript. Suppresses
 * sub-agent sessions (ADR 0014) unless `forcePrimary`; no-ops when an assistant digest
 * already exists (the one-per-session gate); skips when the transcript is too thin.
 * NEVER throws for an absent/unreadable transcript — the hook must not block a session.
 */
export async function writeSessionDigestFromTranscript(
  options: SomaMemoryDigestFromTranscriptOptions,
): Promise<SomaMemoryDigestFromTranscriptResult> {
  const isSubagent = options.forceSubagent === true || (options.forcePrimary !== true && hasAgentMarker(options));
  if (isSubagent && options.forcePrimary !== true) {
    return { outcome: "suppressed", reason: "sub-agent session (ADR 0014) — no fallback digest written" };
  }

  const transcript = await readFile(options.transcriptPath, "utf8").catch(() => undefined);
  if (transcript === undefined) {
    return { outcome: "skipped", reason: `transcript not readable at ${options.transcriptPath}` };
  }
  const body = extractDigestBodyFromTranscript(transcript);
  if (body === undefined) {
    return { outcome: "skipped", reason: "transcript has too few principal prompts for a fallback digest" };
  }

  const digest = await writeSessionDigest({
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    substrate: options.substrate,
    now: options.now,
    sessionId: options.sessionId,
    body,
    hook: "session-end",
  });
  return {
    outcome: digest.created ? "written" : "duplicate",
    digest,
    reason: digest.created
      ? "wrote a deterministic session-end fallback digest"
      : "a digest already exists for this session — no-op",
  };
}

/** A sub-agent invocation carries a non-empty agent id or type in the hook payload. */
function hasAgentMarker(options: SomaMemoryDigestFromTranscriptOptions): boolean {
  return (options.agentId ?? "").trim().length > 0 || (options.agentType ?? "").trim().length > 0;
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
  assertSlug(options.slug, "slug", MAX_ID_SLUG);
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
