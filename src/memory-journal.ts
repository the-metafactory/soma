import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { somaMemoryEventsPath } from "./memory";
import type { SomaMemoryEvent, SomaMemoryRetrievalQuality } from "./types";

/**
 * The NEUTRAL journal read-model. A single place that reads the append-only
 * `memory.recall`/`memory.verify`/(#427)`memory.resurface` JSONL journal and
 * derives retrieval signals from it — imported by BOTH the M7 audit
 * (`memory-audit.ts`, the read-only health check) AND M6 consolidation
 * (`memory-consolidate.ts`, deterministic maintenance). Neither of those two
 * distinct paths (docs/architecture.md) may depend on the other's internals, so
 * the shared journal-fold logic lives here, not inside the audit module.
 *
 * Two read-models, one streaming shape:
 * - {@link streamJournalStats} — the #425 corpus-wide retrieval-quality metric
 *   (recall volume, empty-recall rate, verify-follows-recall rate) plus the
 *   coarse event-line count; consumed by the audit's retrieval-quality +
 *   event-ratio probes.
 * - {@link computeNoteRetrievalCounts} — the #428 PER-NOTE recall/verify tally;
 *   consumed by M6 consolidation's auto-merge to prefer collapsing low-value
 *   churn over actively-useful notes.
 *
 * Both stream the journal line-by-line through an O_NOFOLLOW-opened FileHandle
 * (a symlinked events file fails the open with ELOOP and is treated as an empty
 * journal — the same forgiving stance the audit takes everywhere), so memory
 * stays O(window + counters), never O(journal).
 */

// Read WITHOUT following a final-component symlink — a symlinked events file fails
// the open (ELOOP) and reads as an empty journal, never through the link to an
// outside target. Exported so the audit reuses the SAME flag for its note/digest
// reads instead of re-deriving it.
export const NOFOLLOW_READ = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

// --- #425 retrieval-quality fold ----------------------------------------------

/**
 * The subsequent-event window the retrieval-quality metric searches, chronologically
 * after a `memory.recall` event, for a `memory.verify` OR (#427) `memory.resurface`
 * of one of its returned ids. No existing audit window applies here (the consolidate TTLs are day-based
 * staleness thresholds for a different concern), so this is a fresh, documented
 * default rather than a reused constant — events, not days, keep the correlation
 * deterministic and independent of clock/timezone handling. The window is counted
 * in PARSEABLE journal events (a malformed line is skipped, does not consume a
 * window slot). Not yet configurable; a future slice may need to tune it once real
 * recall volume exists.
 */
const RECALL_VERIFY_WINDOW_EVENTS = 50;

/** The `noteIds` a `memory.recall` event recorded (its returned note ids — both
 *  term matches and 1-hop link pulls), or `[]` if absent/malformed. */
function recallEventNoteIds(event: SomaMemoryEvent): string[] {
  const raw = event.metadata?.noteIds;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/**
 * #427 — the second event kind that satisfies a pending recall, alongside
 * `memory.verify`: `memory.resurface` (`memory-write.ts`'s `resurfaceMemoryNote`,
 * the low-friction "this recalled note helped" signal). Both record the bumped
 * note id the same way (`metadata.id`) and both count toward
 * `verifyFollowsRecallRate` as "the recall got reinforced" — but they assert
 * different things: `memory.resurface` asserts observed USEFULNESS, while
 * `memory.verify` asserts a fact was RE-CONFIRMED (which can happen independently
 * of a note actually being useful). The rate conflates the two deliberately as a
 * reinforcement proxy, not as a pure usefulness measure; the metric name stays
 * `verifyFollowsRecallRate` (not renamed) since it is still measuring "did a
 * recall get reinforced", just via either turning force.
 */
const VERIFY_LIKE_EVENT_KINDS = new Set(["memory.verify", "memory.resurface"]);

/** The note id a `memory.verify`/`memory.resurface` event bumped
 *  (`memory-write.ts`'s verify/resurface paths both record it as
 *  `metadata.id`), or `undefined` if the event is neither kind, or the id is
 *  absent/malformed. */
function verifyEventNoteId(event: SomaMemoryEvent): string | undefined {
  if (!VERIFY_LIKE_EVENT_KINDS.has(event.kind)) return undefined;
  const raw = event.metadata?.id;
  return typeof raw === "string" ? raw : undefined;
}

/**
 * The bounded, incremental retrieval-quality accumulator. Only the running counters
 * plus a window of PENDING recalls (each a non-empty recall still inside its
 * lookahead window) are resident — never the whole journal. A pending recall retires
 * as soon as a matching `memory.verify` is seen (counted as followed) OR after
 * `RECALL_VERIFY_WINDOW_EVENTS` subsequent parseable events elapse (unfollowed), so
 * `pending.length ≤ RECALL_VERIFY_WINDOW_EVENTS` at all times.
 */
interface RetrievalAccumulator {
  recallVolume: number;
  emptyRecalls: number;
  recallsWithResults: number;
  verifiedFollows: number;
  pending: { noteIds: Set<string>; remaining: number }[];
}

function newRetrievalAccumulator(): RetrievalAccumulator {
  return { recallVolume: 0, emptyRecalls: 0, recallsWithResults: 0, verifiedFollows: 0, pending: [] };
}

/**
 * Fold one PARSEABLE event into the accumulator, preserving the exact
 * array-based semantics of the prior implementation: the current event is a
 * SUBSEQUENT event for every earlier pending recall (so it decrements each window
 * and may satisfy one via a matching verify OR #427 resurface), and only AFTER
 * that does the event — if it is itself a recall — become pending (a recall
 * never verifies/resurfaces itself).
 */
function foldRetrievalEvent(acc: RetrievalAccumulator, event: SomaMemoryEvent): void {
  if (acc.pending.length > 0) {
    const verifiedId = verifyEventNoteId(event);
    const stillPending: RetrievalAccumulator["pending"][number][] = [];
    for (const p of acc.pending) {
      p.remaining -= 1;
      if (verifiedId !== undefined && p.noteIds.has(verifiedId)) {
        acc.verifiedFollows += 1; // satisfied → retire, counted as followed
      } else if (p.remaining > 0) {
        stillPending.push(p); // window not yet exhausted → keep watching
      }
      // else: window exhausted unsatisfied → retire, uncounted
    }
    acc.pending = stillPending;
  }

  if (event.kind === "memory.recall") {
    acc.recallVolume += 1;
    const noteIds = recallEventNoteIds(event);
    if (noteIds.length === 0) {
      acc.emptyRecalls += 1;
    } else {
      acc.recallsWithResults += 1;
      acc.pending.push({ noteIds: new Set(noteIds), remaining: RECALL_VERIFY_WINDOW_EVENTS });
    }
  }
}

function finalizeRetrieval(acc: RetrievalAccumulator, skippedEventLines: number): SomaMemoryRetrievalQuality {
  return {
    recallVolume: acc.recallVolume,
    emptyRecallRate: acc.recallVolume === 0 ? 0 : acc.emptyRecalls / acc.recallVolume,
    verifyFollowsRecallRate: acc.recallsWithResults === 0 ? 0 : acc.verifiedFollows / acc.recallsWithResults,
    recallsWithResults: acc.recallsWithResults,
    verifyWindowEvents: RECALL_VERIFY_WINDOW_EVENTS,
    skippedEventLines,
  };
}

/**
 * Parse one non-empty journal line into a well-formed {@link SomaMemoryEvent}, or
 * `undefined` when it is not JSON or lacks a string `kind`/`timestamp`. The single
 * definition of "a malformed journal line" — both read-models below skip the same
 * shape identically.
 */
function parseEventLine(line: string): SomaMemoryEvent | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<SomaMemoryEvent>;
    if (typeof parsed.kind === "string" && typeof parsed.timestamp === "string") return parsed as SomaMemoryEvent;
  } catch {
    // fall through → malformed
  }
  return undefined;
}

/**
 * ONE streaming pass over the JSONL journal — read line by line via an
 * O_NOFOLLOW-opened FileHandle (a symlinked events file fails the open with ELOOP
 * and is treated as an empty journal, same forgiving stance as the rest of the
 * audit), so audit memory stays O(window + counters), not O(journal). Feeds BOTH:
 * `eventLines` (non-empty lines — the coarse event-ratio count, malformed lines
 * INCLUDED, matching the old byte-scan) and the incremental retrieval accumulator
 * (PARSEABLE events only; a malformed line is skipped and counted). A malformed
 * line is a non-empty line that is not JSON, or lacks a string `kind`/`timestamp`.
 */
export async function streamJournalStats(eventsPath: string): Promise<{ eventLines: number; retrieval: SomaMemoryRetrievalQuality }> {
  let eventLines = 0;
  let skippedEventLines = 0;
  const acc = newRetrievalAccumulator();

  const handle = await open(eventsPath, NOFOLLOW_READ).catch(() => undefined);
  if (handle === undefined) {
    // absent, symlinked (ELOOP), or otherwise unopenable → empty journal
    return { eventLines: 0, retrieval: finalizeRetrieval(acc, 0) };
  }
  try {
    const lines = createInterface({ input: handle.createReadStream({ encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      eventLines += 1; // event-ratio counts every non-empty line, parseable or not
      const event = parseEventLine(line);
      if (event === undefined) {
        skippedEventLines += 1;
        continue; // malformed → does not consume a retrieval window slot
      }
      foldRetrievalEvent(acc, event);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  return { eventLines, retrieval: finalizeRetrieval(acc, skippedEventLines) };
}

// --- #428 per-note retrieval counts (M6 auto-merge gating) --------------------

/**
 * Per-note counterpart of the #425 corpus-wide retrieval-quality signal: how
 * many times THIS id was returned by a `memory.recall` event, and how many
 * times it was reinforced by a `memory.verify`/(#427) `memory.resurface` event.
 * Used by M6's #428 auto-merge to PREFER collapsing low-value churn (rarely
 * recalled, never reinforced) over actively-useful notes when two near-dup
 * pairs compete for the same note. This is a documented HEURISTIC — a combined
 * count, no recency/decay weighting — rather than a true per-PAIR "was this
 * recall useful" correlation: that would need the same recall→verify window
 * correlation `foldRetrievalEvent` already does at the CORPUS level, and
 * re-deriving it per-note here would be premature tuning before real recall
 * volume exists (the #425 retrieval-quality probe documents the same
 * young-corpus caveat). Malformed journal lines are silently skipped (not
 * surfaced) — this is an internal gating signal, not a health probe.
 */
export interface SomaMemoryNoteRetrievalCount {
  /** Times this note id appeared in a `memory.recall` event's returned ids. */
  recalled: number;
  /** Times this note id was bumped by `memory.verify` or `memory.resurface`. */
  verified: number;
}

/** Stream the journal once, counting per-note recall/verify occurrences (#428). */
export async function computeNoteRetrievalCounts(somaHome: string): Promise<Map<string, SomaMemoryNoteRetrievalCount>> {
  const counts = new Map<string, SomaMemoryNoteRetrievalCount>();
  const bump = (id: string, field: keyof SomaMemoryNoteRetrievalCount): void => {
    const existing = counts.get(id) ?? { recalled: 0, verified: 0 };
    existing[field] += 1;
    counts.set(id, existing);
  };

  const handle = await open(somaMemoryEventsPath(somaHome), NOFOLLOW_READ).catch(() => undefined);
  if (handle === undefined) return counts; // absent/symlinked journal → no signal, same forgiving stance as the audit
  try {
    const lines = createInterface({ input: handle.createReadStream({ encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      const event = parseEventLine(line); // malformed line → skipped, same shape as the retrieval-quality probe
      if (event === undefined) continue;
      if (event.kind === "memory.recall") {
        for (const id of recallEventNoteIds(event)) bump(id, "recalled");
        continue;
      }
      const verifiedId = verifyEventNoteId(event);
      if (verifiedId !== undefined) bump(verifiedId, "verified");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return counts;
}
