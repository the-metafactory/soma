import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createPaths } from "./paths";
import { collectDurableNotes } from "./memory-write";
import type { SomaMemoryIndexResult, SomaMemoryNote, SomaMemoryNoteType, SomaMemoryTrust } from "./types";

/**
 * Memory index renderer (subsystem M3). Plan v2 §M3 — the always-loaded, tiny
 * pointer artifact (`memory/INDEX.md`) that makes session N+1 better-informed
 * than N. Rebuilt deterministically from note frontmatter (never on the request
 * path; no LLM), and projected verbatim to the substrate by M4.
 *
 * Two orthogonal decisions per note:
 *
 * 1. **Admission (earned inclusion).** A note earns a line only if it is active
 *    (`valid_until === null`), NOT quarantined, and clears the ladder: resurfaced-
 *    and-verified ≥2×, OR principal-marked (trust `principal`), OR still in the
 *    <7-day creation grace window. Quarantined notes never appear (design §15 L3).
 *
 * 2. **Retention score (eviction order).** `trust_weight × type_weight ×
 *    freshness`, where freshness is recall's decay curve applied to frontmatter:
 *    `resurface_count × 0.5^(daysSince(last_verified)/halflife)` with a future-
 *    timestamp clamp (adapted from recall's freshness-score concept — see
 *    Plans/2026-07-02-recall-adoption-analysis.md; this amends v1's linear recency
 *    term). When the ≤200-line / ≤25KB budget is hit, the LOWEST score sheds
 *    first. Quarantined weight is 0, so even if some future path admitted one it
 *    would sink to the bottom — defense in depth behind the admission filter.
 *
 * Determinism: every date derives from an injected `now`; ties break on a fixed
 * key (score → trust → last_verified → id), so the same tree + same `now` render
 * byte-identical output (golden-file tested).
 */

// Recency half-life for the freshness term, in days. A note verified within a
// half-life keeps most of its resurface weight; the weight halves each half-life
// it goes un-reverified. Named + tunable; 90d pairs with the design's "unverified
// >180d → eviction" review rule (two half-lives ≈ a quarter of the original heat).
const DEFAULT_HALFLIFE_DAYS = 90;

// Admission-ladder thresholds (design §15 L3).
const RESURFACE_ADMIT = 2; // resurfaced-and-verified ≥2×
const GRACE_DAYS = 7; // creation recency grace

// Governed weights (design §15). Quarantined is 0 on BOTH the admission filter
// and the score, so it can never occupy an index line.
const TRUST_WEIGHT: Record<SomaMemoryTrust, number> = { principal: 3, assistant: 1, quarantined: 0 };
const TYPE_WEIGHT: Record<SomaMemoryNoteType, number> = { procedural: 3, semantic: 2, episodic: 1 };

// Budget (design §15 / plan §M3). 25KB matches the Claude auto-dream ceiling.
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;

// Sections render in this fixed order (highest type_weight first). Episodic has
// no durable dir yet (M5); it joins here when it lands, hence the full type list.
const SECTION_ORDER: SomaMemoryNoteType[] = ["procedural", "semantic", "episodic"];
const SECTION_TITLE: Record<SomaMemoryNoteType, string> = {
  procedural: "Procedural",
  semantic: "Semantic",
  episodic: "Episodic",
};

const MS_PER_DAY = 86_400_000;
const DESCRIPTOR_MAX = 80;

/** UTC-midnight ms for a `YYYY-MM-DD` date; the note schema guarantees the shape. */
function dateMs(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days between `isoDate` and `now`, clamped at 0 for a future date. */
function ageDays(isoDate: string, now: Date): number {
  const delta = now.getTime() - dateMs(isoDate);
  return delta <= 0 ? 0 : Math.floor(delta / MS_PER_DAY);
}

/**
 * Freshness term — recall's decay curve on frontmatter. Never-resurfaced notes
 * (`resurface_count === 0`) score 0 on this term; a future `last_verified`
 * (clock skew) clamps to no decay rather than rewarding futureness.
 */
function freshness(note: SomaMemoryNote, now: Date, halflifeDays: number): number {
  const count = note.resurface_count > 0 ? note.resurface_count : 0;
  if (count === 0) return 0;
  const dt = now.getTime() - dateMs(note.last_verified);
  if (dt <= 0) return count; // future/equal timestamp → no decay
  const days = dt / MS_PER_DAY;
  const hl = halflifeDays > 0 ? halflifeDays : DEFAULT_HALFLIFE_DAYS;
  return count * Math.pow(0.5, days / hl);
}

/** `trust_weight × type_weight × freshness` — the deterministic eviction score. */
export function retentionScore(note: SomaMemoryNote, now: Date, halflifeDays = DEFAULT_HALFLIFE_DAYS): number {
  return TRUST_WEIGHT[note.trust] * TYPE_WEIGHT[note.type] * freshness(note, now, halflifeDays);
}

/**
 * The earned-inclusion admission ladder. Active + non-quarantined AND (resurfaced
 * ≥2× OR principal-marked OR within the creation grace window). Superseded and
 * quarantined notes never earn a line.
 */
function isAdmitted(note: SomaMemoryNote, now: Date): boolean {
  if (note.trust === "quarantined") return false;
  if (note.valid_until !== null) return false;
  return (
    note.resurface_count >= RESURFACE_ADMIT ||
    note.trust === "principal" ||
    ageDays(note.created, now) < GRACE_DAYS
  );
}

/** Collapse to a single sanitized line and truncate — index descriptors are one line. */
function oneLine(text: string, max: number): string {
  const collapsed = text
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ") // control chars (incl. newlines/tabs) → space
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** The one-line pointer descriptor: the recall-trigger hook, else the first body line. */
function descriptorFor(note: SomaMemoryNote): string {
  const source = note.hook && note.hook.trim().length > 0 ? note.hook : note.body;
  return oneLine(source, DESCRIPTOR_MAX);
}

interface ScoredLine {
  type: SomaMemoryNoteType;
  score: number;
  note: SomaMemoryNote;
  text: string; // the fully-rendered `- …` pointer line
}

/** Deterministic ordering: score desc → trust desc → last_verified desc → id asc. */
function compareScored(a: ScoredLine, b: ScoredLine): number {
  return (
    b.score - a.score ||
    TRUST_WEIGHT[b.note.trust] - TRUST_WEIGHT[a.note.trust] ||
    dateMs(b.note.last_verified) - dateMs(a.note.last_verified) ||
    a.note.id.localeCompare(b.note.id)
  );
}

function pointerLine(note: SomaMemoryNote, now: Date): string {
  // "verified Nd ago" is computed HERE, at rebuild time, from the injected now —
  // never a wall clock at projection time (M4 invariant AC-4).
  return `- ${note.id} — ${descriptorFor(note)} · ${note.trust}, verified ${ageDays(note.last_verified, now)}d ago`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export interface RenderedIndex {
  content: string;
  admitted: number;
  rendered: number;
  shed: number;
  excluded: number;
}

/**
 * Render INDEX.md from a note set. Pure + deterministic given `notes` and `now`.
 * Budget enforcement: every non-empty section is guaranteed its single
 * highest-scored line (min-1-per-section), then the remaining line/byte budget is
 * filled in global score order; whatever doesn't fit is shed (lowest score first)
 * and reported in the footer — never silently dropped.
 */
export function renderMemoryIndex(
  notes: SomaMemoryNote[],
  now: Date,
  halflifeDays = DEFAULT_HALFLIFE_DAYS,
): RenderedIndex {
  const admittedNotes = notes.filter((note) => isAdmitted(note, now));
  const excluded = notes.length - admittedNotes.length;

  const scored: ScoredLine[] = admittedNotes.map((note) => ({
    type: note.type,
    score: retentionScore(note, now, halflifeDays),
    note,
    text: pointerLine(note, now),
  }));

  // Section buckets in fixed order, each internally score-sorted.
  const bySection = new Map<SomaMemoryNoteType, ScoredLine[]>();
  for (const type of SECTION_ORDER) bySection.set(type, []);
  for (const line of scored) bySection.get(line.type)!.push(line);
  for (const lines of bySection.values()) lines.sort(compareScored);

  const header = "# Soma Memory Index";
  // Running byte budget starts with the header; each selected line and section
  // header is charged as it is admitted so the final string is within budget.
  let usedBytes = byteLength(`${header}\n`);
  let usedLines = 0;
  const selected = new Set<ScoredLine>();

  // Charge a candidate against the line/byte budget; on the first time a section
  // contributes, also charge its "\n## Title\n" header. Returns false if it won't fit.
  const chargedSectionHeader = new Set<SomaMemoryNoteType>();
  function tryAdmit(line: ScoredLine): boolean {
    if (usedLines >= MAX_INDEX_LINES) return false;
    let cost = byteLength(`${line.text}\n`);
    if (!chargedSectionHeader.has(line.type)) {
      cost += byteLength(`\n## ${SECTION_TITLE[line.type]}\n`);
    }
    if (usedBytes + cost > MAX_INDEX_BYTES) return false;
    usedBytes += cost;
    usedLines += 1;
    chargedSectionHeader.add(line.type);
    selected.add(line);
    return true;
  }

  // Pass 1 — min-1-per-section: the top-scored line of each non-empty section.
  for (const type of SECTION_ORDER) {
    const top = bySection.get(type)!.at(0);
    if (top) tryAdmit(top);
  }
  // Pass 2 — fill remaining budget in global score order (lowest sheds first).
  for (const line of [...scored].sort(compareScored)) {
    if (!selected.has(line)) tryAdmit(line);
  }

  const rendered = selected.size;
  const shed = scored.length - rendered;

  // Assemble in fixed section order, only sections that have a selected line.
  const parts: string[] = [header];
  if (rendered === 0) {
    parts.push("", "_No notes have earned an index line yet._");
  } else {
    for (const type of SECTION_ORDER) {
      const lines = bySection.get(type)!.filter((line) => selected.has(line));
      if (lines.length === 0) continue;
      parts.push("", `## ${SECTION_TITLE[type]}`);
      for (const line of lines) parts.push(line.text);
    }
  }
  if (shed > 0) {
    parts.push("", `_${shed} more note(s) earned a line but were shed to fit the index budget._`);
  }

  return {
    content: `${parts.join("\n")}\n`,
    admitted: scored.length,
    rendered,
    shed,
    excluded,
  };
}

/** On-disk path of the rendered index. */
export function memoryIndexPath(somaHome: string): string {
  return createPaths(somaHome).resolve("memory", "INDEX.md");
}

/**
 * Collect every durable note (semantic + procedural) for indexing, plus the
 * unreadable-file blind spot. Episodic notes join here when M5 lands their dir.
 */
export async function collectAllNotes(somaHome: string): Promise<{ notes: SomaMemoryNote[]; unreadable: string[] }> {
  const { notes, unreadable } = await collectDurableNotes(somaHome);
  return { notes: notes.map((scanned) => scanned.note), unreadable };
}

export interface SomaMemoryIndexOptions {
  homeDir?: string;
  somaHome?: string;
  /** Injected clock for deterministic ages/freshness. Defaults to now. */
  now?: Date;
  halflifeDays?: number;
}

/**
 * Rebuild `memory/INDEX.md` from the current note corpus and write it. Returns the
 * counts (admitted / rendered / shed / excluded) plus the unreadable blind spot.
 * Deterministic given the tree and `now`.
 */
export async function rebuildMemoryIndex(options: SomaMemoryIndexOptions = {}): Promise<SomaMemoryIndexResult> {
  const somaHome = createPaths(options).root();
  const now = options.now ?? new Date();
  const { notes, unreadable } = await collectAllNotes(somaHome);
  const { content, admitted, rendered, shed, excluded } = renderMemoryIndex(notes, now, options.halflifeDays);

  const path = memoryIndexPath(somaHome);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");

  return { somaHome, path, content, admitted, rendered, shed, excluded, unreadable };
}
