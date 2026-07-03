import { createPaths } from "./paths";
import { collectDurableNotes } from "./memory-write";
import type { ScannedNote } from "./memory-write";
import type {
  SomaMemoryNote,
  SomaMemoryRecallOptions,
  SomaMemoryRecalledNote,
  SomaMemoryRecallResult,
} from "./types";

/**
 * Memory recall (subsystem M2). Plan v2 §M2 — the read side that closes the loop
 * M1's verify feeds. Note-aware retrieval over the durable corpus
 * (`memory/semantic/` + `memory/procedural/`), reusing M1's `collectDurableNotes`
 * corpus reader:
 *
 * - **Term scoring** — the query is split into 3+char tokens; a note scores by the
 *   number of DISTINCT query terms present in its searchable surface (body + id +
 *   hook + project + source_of_truth). Ties break on total term frequency, then
 *   recency (`last_verified`), then id, so output is fully deterministic.
 * - **Whole-file retrieval** — a match returns the complete parsed note, not a
 *   line snippet (design §: summaries are the cognition unit, not atomic facts).
 * - **limit 3** — the primary term-matched set is capped (default 3); 1-hop link
 *   pulls are additional context beyond that cap.
 * - **1-hop links** — each primary match's `links` are followed exactly one hop;
 *   a linked note that is active and not already a match is appended as context.
 * - **Superseded excluded** — only ACTIVE notes (`valid_until === null`) are
 *   eligible, as matches AND as link targets. A superseded (or missing) link
 *   target is surfaced in `unresolvedLinks`, never silently dropped.
 * - **Verification banner** — every returned note carries a one-line banner whose
 *   age derives from the injected `now`; quarantined notes carry an explicit
 *   untrusted-content warning.
 *
 * Read-only: recall appends NO event and mutates nothing. Bumping a note's
 * `last_verified`/`resurface_count` is the separate, authority-gated `verify` act
 * (M1) — recall deliberately does not confer freshness by being read (that would
 * let a mere read keep a note artificially alive in the M3 index).
 */

const MS_PER_DAY = 86_400_000;
const DEFAULT_LIMIT = 3;

/**
 * Split a query into distinct 3+char search terms. Mirrors the legacy search
 * tokenizer (`memory.ts`) and the write-path dedup floor (`memory-write.ts`) so
 * recall, dedup, and search all agree on what counts as a term.
 */
function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9À-ɏ]+/i)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3),
    ),
  );
}

/**
 * The lowercased text a note is scored against. The id is de-slugged (dashes →
 * spaces) so a hyphenated id matches its constituent query words. `hook` (the
 * recall-trigger phrase) and `project`/`source_of_truth` are high-signal recall
 * surfaces and count toward matching.
 */
function searchableText(note: SomaMemoryNote): string {
  return [
    note.body,
    note.id.replace(/-/g, " "),
    note.hook ?? "",
    note.project ?? "",
    note.source_of_truth ?? "",
  ]
    .join("\n")
    .toLowerCase();
}

/** Non-overlapping occurrence count of `needle` in `haystack` (both lowercased). */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

interface NoteScore {
  /** Distinct query terms present in the note. */
  matched: number;
  /** Total term occurrences across the searchable text — the frequency tiebreak. */
  freq: number;
}

function scoreNote(note: SomaMemoryNote, terms: string[]): NoteScore {
  const text = searchableText(note);
  let matched = 0;
  let freq = 0;
  for (const term of terms) {
    const occurrences = countOccurrences(text, term);
    if (occurrences > 0) {
      matched += 1;
      freq += occurrences;
    }
  }
  return { matched, freq };
}

/** UTC midnight ms for a `YYYY-MM-DD` date; the note schema guarantees the shape. */
function dateMs(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days since `last_verified`, clamped at 0 for a future date. Derived from injected `now`. */
function ageDaysSince(lastVerified: string, now: Date): number {
  const delta = now.getTime() - dateMs(lastVerified);
  return delta <= 0 ? 0 : Math.floor(delta / MS_PER_DAY);
}

/**
 * The read-time verification banner. Age derives from the injected `now`;
 * quarantined notes lead with an explicit untrusted-content warning so a reader
 * never mistakes imported/tool content for vouched fact.
 */
function verificationBanner(note: SomaMemoryNote, ageDays: number): string {
  const target = note.source_of_truth ?? "no recorded source";
  const base = `${ageDays}d old · ${note.trust} · ${note.provenance} · verify against ${target}`;
  return note.trust === "quarantined" ? `⚠ QUARANTINED (untrusted) · ${base}` : `⚠ ${base}`;
}

function toRecalledNote(
  scanned: ScannedNote,
  score: number,
  via: "match" | "link",
  linkedFrom: string | null,
  now: Date,
): SomaMemoryRecalledNote {
  const { note, path } = scanned;
  const ageDays = ageDaysSince(note.last_verified, now);
  return {
    id: note.id,
    type: note.type,
    path,
    score,
    via,
    linkedFrom,
    ageDays,
    quarantined: note.trust === "quarantined",
    banner: verificationBanner(note, ageDays),
    note,
  };
}

/**
 * Recall active durable notes for `query`. See the module docstring for the full
 * contract (term scoring, whole-file, limit 3, 1-hop links, superseded-exclusion,
 * verification banner). Deterministic and side-effect-free.
 */
export async function recallMemory(options: SomaMemoryRecallOptions): Promise<SomaMemoryRecallResult> {
  const somaHome = createPaths(options).root();
  const now = options.now ?? new Date();
  const limit = options.limit ?? DEFAULT_LIMIT;
  const terms = queryTerms(options.query);

  const { notes, unreadable } = await collectDurableNotes(somaHome);
  // Only ACTIVE notes are eligible — as matches and as link targets. A superseded
  // note is a closed replacement, not a recall result.
  const active = notes.filter((scanned) => scanned.note.valid_until === null);

  if (terms.length === 0) {
    return { query: options.query, somaHome, terms, matches: [], unresolvedLinks: [], unreadable };
  }

  // Score, keep only notes matching at least one term, and rank deterministically:
  // distinct terms desc → frequency desc → recency (last_verified) desc → id asc.
  const scored = active
    .map((scanned) => ({ scanned, ...scoreNote(scanned.note, terms) }))
    .filter((entry) => entry.matched > 0)
    .sort(
      (a, b) =>
        b.matched - a.matched ||
        b.freq - a.freq ||
        dateMs(b.scanned.note.last_verified) - dateMs(a.scanned.note.last_verified) ||
        a.scanned.note.id.localeCompare(b.scanned.note.id),
    );

  const primary = scored.slice(0, limit);
  const primaryIds = new Set(primary.map((entry) => entry.scanned.note.id));

  const matches: SomaMemoryRecalledNote[] = primary.map((entry) =>
    toRecalledNote(entry.scanned, entry.matched, "match", null, now),
  );

  // 1-hop link expansion: follow each match's `links` exactly one hop. A target is
  // included once (first linker wins), only if it is an active note that is not
  // already a primary match. Missing or superseded targets surface as unresolved.
  const activeById = new Map(active.map((scanned) => [scanned.note.id, scanned] as const));
  const seenLinks = new Set<string>();
  const unresolvedLinks: string[] = [];
  for (const entry of primary) {
    for (const linkId of entry.scanned.note.links) {
      if (primaryIds.has(linkId) || seenLinks.has(linkId)) continue;
      const target = activeById.get(linkId);
      if (target === undefined) {
        // Not active (missing OR superseded) — record once, in link-encounter order.
        if (!unresolvedLinks.includes(linkId)) unresolvedLinks.push(linkId);
        continue;
      }
      seenLinks.add(linkId);
      matches.push(toRecalledNote(target, 0, "link", entry.scanned.note.id, now));
    }
  }

  return { query: options.query, somaHome, terms, matches, unresolvedLinks, unreadable };
}
