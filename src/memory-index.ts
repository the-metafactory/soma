import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createPaths } from "./paths";
import { isEnoent } from "./fs-utils";
import { collectDurableNotes, listDurableNotePaths } from "./memory-write";
import { noteDateMs, ageDays, sanitizeNoteText } from "./memory-corpus";
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
 *    (`valid_until === null`), NOT quarantined, and either is principal-marked
 *    (trust `principal`) OR has been resurfaced-and-verified ≥2×. Non-principal
 *    notes get NO pure recency grace — admitting unverified imported/tool-derived
 *    text into always-loaded memory would be a prompt-injection path. Quarantined
 *    notes never appear (design §15 L3, tightened per sage M3 r3).
 *
 * 2. **Retention score (eviction order).** `trust_weight × type_weight ×
 *    freshness`, where freshness is recall's decay curve applied to frontmatter:
 *    `resurface_count × 0.5^(daysSince(last_verified)/halflife)` with a future-
 *    timestamp clamp (adapted from recall's freshness-score concept — see
 *    Plans/2026-07-02-recall-adoption-analysis.md; this amends v1's linear recency
 *    term). When the ≤200-pointer-line / ≤25KB budget is hit the LOWEST score sheds first,
 *    except that each non-empty section is first offered its single best line
 *    (min-1-per-section), subject to the hard ceiling. The real quarantined guard is
 *    the admission FILTER (a quarantined note never reaches scoring); the 0 weight
 *    is a secondary backstop, not a guarantee-by-sinking (min-1-per-section means a
 *    lone section member is offered regardless of score).
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

// Admission-ladder threshold (design §15 L3): non-principal notes earn an
// always-loaded line only after this many verified resurfacings.
const RESURFACE_ADMIT = 2;

// Governed weights (design §15). What actually keeps a quarantined note off the
// index is the admission FILTER (isAdmitted rejects it before scoring); its 0
// trust weight is a secondary backstop, not the guarantee — min-1-per-section can
// offer a section's lone member regardless of score.
const TRUST_WEIGHT: Record<SomaMemoryTrust, number> = { principal: 3, assistant: 1, quarantined: 0 };
const TYPE_WEIGHT: Record<SomaMemoryNoteType, number> = { procedural: 3, semantic: 2, episodic: 1 };

// Budget (design §15 / plan §M3). 25KB matches the Claude auto-dream ceiling and
// is the HARD ceiling on the whole file. MAX_INDEX_POINTER_LINES caps the number
// of note POINTER lines specifically — the title, per-section headings, blank
// separators, and the optional shed footer are a small fixed overhead on top
// (≤ ~7 lines given ≤3 sections), so the physical file is ≤ pointer-cap + overhead.
const MAX_INDEX_POINTER_LINES = 200;
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

/**
 * Freshness term — recall's decay curve on frontmatter. Never-resurfaced notes
 * (`resurface_count === 0`) score 0 on this term; a future `last_verified`
 * (clock skew) clamps to no decay rather than rewarding futureness.
 */
function freshness(note: SomaMemoryNote, now: Date, halflifeDays: number): number {
  const count = note.resurface_count > 0 ? note.resurface_count : 0;
  if (count === 0) return 0;
  const dt = now.getTime() - noteDateMs(note.last_verified);
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
 * The earned-inclusion admission ladder. Active + non-quarantined, then:
 * - PRINCIPAL notes (same-turn corrections, trusted by construction) earn a line
 *   immediately — this subsumes the creation-grace window for them.
 * - NON-principal notes (assistant/consolidation, whose text can derive from
 *   imported or tool content) earn an always-loaded line ONLY by verified
 *   resurfacing (≥2×). A pure recency grace for them is deliberately NOT granted:
 *   admitting unverified non-principal text into projected memory would be a
 *   prompt-injection path (sage M3 r3). Verified usage is the trust signal.
 * Superseded and quarantined notes never earn a line.
 */
function isAdmitted(note: SomaMemoryNote): boolean {
  if (note.trust === "quarantined") return false;
  if (note.valid_until !== null) return false;
  if (note.trust === "principal") return true;
  return note.resurface_count >= RESURFACE_ADMIT;
}

/**
 * Collapse to a single sanitized line and truncate — index descriptors are one
 * line. Sanitization (#410) is the SAME strong stripper that guards recall's
 * terminal output (whole-sequence removal of ESC-introduced AND 8-bit C1
 * CSI/OSC escapes, not just a blanked introducer byte) — the always-loaded
 * INDEX is the highest-stakes surface for note-authored text and must never be
 * the weakest-guarded one.
 */
function oneLine(text: string, max: number): string {
  const collapsed = sanitizeNoteText(text, { oneLine: true });
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
  /**
   * The rendered `- …` pointer line, materialized during an admission ATTEMPT. A
   * note shed by the line ceiling is never rendered (the attempt returns before
   * rendering); one shed by the byte ceiling is rendered once (its size is needed
   * to decide it doesn't fit) but then dropped.
   */
  text?: string;
}

/** Deterministic ordering: score desc → trust desc → last_verified desc → id asc. */
function compareScored(a: ScoredLine, b: ScoredLine): number {
  return (
    b.score - a.score ||
    TRUST_WEIGHT[b.note.trust] - TRUST_WEIGHT[a.note.trust] ||
    noteDateMs(b.note.last_verified) - noteDateMs(a.note.last_verified) ||
    a.note.id.localeCompare(b.note.id)
  );
}

function pointerLine(note: SomaMemoryNote, now: Date): string {
  // "verified Nd ago" is computed HERE, at rebuild time, from the injected now —
  // never a wall clock at projection time (M4 invariant AC-4). Both id and
  // descriptor go through oneLine, which enforces the one-line pointer invariant
  // and strips terminal escapes/control chars — NOT a semantic prompt-injection
  // defense: the descriptor deliberately projects note-authored hook/body text
  // (that IS the index). What keeps untrusted CONTENT out is the admission
  // ladder upstream (quarantined excluded, non-principal admitted only after
  // verified resurfacing); sanitization only keeps admitted text from spoofing
  // the terminal it's rendered to. trust is an enum and the age a number, so
  // both are safe as-is.
  const id = oneLine(note.id, DESCRIPTOR_MAX);
  return `- ${id} — ${descriptorFor(note)} · ${note.trust}, verified ${ageDays(note.last_verified, now)}d ago`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The footer noting how many earned lines were shed to fit the budget. */
function shedFooter(count: number): string {
  return `_${count} more note(s) earned a line but were shed to fit the index budget._`;
}

export interface RenderedIndex {
  content: string;
  admitted: number;
  rendered: number;
  shed: number;
  excluded: number;
}

const INDEX_HEADER = "# Soma Memory Index";

/**
 * The budgeted two-pass selection. Materializes pointer text on each admission
 * attempt (a line shed by the line ceiling is never rendered; one shed by the byte
 * ceiling is rendered once to measure it), and returns the admitted set.
 *
 * Budget policy (honest ordering): each non-empty section is OFFERED its top-scored
 * line first (min-1-per-section), then the remaining line/byte budget is filled in
 * global retention-score order. So the effective eviction rule is "lowest score
 * sheds first, EXCEPT a section's single best line is offered ahead of the global
 * fill". Both passes are subject to the hard ceiling: if even the top line does not
 * fit the byte budget it is shed too (the ceiling always wins). Mutates `scored`
 * (sorts it in place for pass 2) and the section buckets' order — both are the
 * caller's throwaway working state.
 */
function selectIndexLines(
  scored: ScoredLine[],
  bySection: Map<SomaMemoryNoteType, ScoredLine[]>,
  now: Date,
  byteCeiling: number,
): Set<ScoredLine> {
  // usedBytes over-estimates the assembled bytes (header + a trailing doc newline;
  // each section charged its full "\n\n## Title\n" prefix, each line its "…\n"), so
  // header + sections ≤ byteCeiling and footer ≤ footerReserve ⇒ total ≤ MAX.
  let usedBytes = byteLength(INDEX_HEADER) + 1;
  let usedLines = 0;
  const selected = new Set<ScoredLine>();
  const chargedSectionHeader = new Set<SomaMemoryNoteType>();

  function tryAdmit(line: ScoredLine): void {
    if (usedLines >= MAX_INDEX_POINTER_LINES) return;
    const text = line.text ?? pointerLine(line.note, now); // needed to measure the line
    line.text = text;
    let cost = byteLength(`${text}\n`);
    if (!chargedSectionHeader.has(line.type)) {
      cost += byteLength(`\n\n## ${SECTION_TITLE[line.type]}\n`);
    }
    if (usedBytes + cost > byteCeiling) return;
    usedBytes += cost;
    usedLines += 1;
    chargedSectionHeader.add(line.type);
    selected.add(line);
  }

  // Pass 1 — min-1-per-section: OFFER the top-scored line of each non-empty section
  // (subject to the hard ceiling — an oversized top line is still shed).
  for (const type of SECTION_ORDER) {
    const top = bySection.get(type)!.at(0);
    if (top) tryAdmit(top);
  }
  // Pass 2 — fill remaining budget in global score order (lowest sheds first).
  scored.sort(compareScored);
  for (const line of scored) {
    if (!selected.has(line)) tryAdmit(line);
  }
  return selected;
}

/**
 * Render INDEX.md from a note set. Pure + deterministic given `notes`, `now`, AND
 * `halflifeDays` (the half-life shifts scoring and therefore selection, so two
 * renders with different half-lives are NOT comparable).
 * Orchestrates: admit → score → bucket → budgeted select ({@link selectIndexLines})
 * → assemble markdown. Shed notes are counted and reported in a footer — never
 * silently dropped.
 */
export function renderMemoryIndex(
  notes: SomaMemoryNote[],
  now: Date,
  halflifeDays = DEFAULT_HALFLIFE_DAYS,
): RenderedIndex {
  const admittedNotes = notes.filter((note) => isAdmitted(note));
  const excluded = notes.length - admittedNotes.length;

  const scored: ScoredLine[] = admittedNotes.map((note) => ({
    type: note.type,
    score: retentionScore(note, now, halflifeDays),
    note,
  }));

  // Section buckets in fixed order, each internally score-sorted.
  const bySection = new Map<SomaMemoryNoteType, ScoredLine[]>();
  for (const type of SECTION_ORDER) bySection.set(type, []);
  for (const line of scored) bySection.get(line.type)!.push(line);
  for (const lines of bySection.values()) lines.sort(compareScored);

  // Reserve room for the shed footer up front so the final content — footer
  // included — can never exceed MAX_INDEX_BYTES. Reserve the worst case (all
  // admitted notes shed → largest count) whether or not a footer ends up rendered;
  // an unused reserve just leaves the index below its ceiling (a ceiling, not a floor).
  // Includes the document's trailing newline (content is always `${join}\n`), so a
  // budget-filling render + footer still can't push one byte past the ceiling.
  const footerReserve = byteLength(`\n\n${shedFooter(scored.length)}\n`);
  const byteCeiling = MAX_INDEX_BYTES - footerReserve;

  const selected = selectIndexLines(scored, bySection, now, byteCeiling);
  const rendered = selected.size;
  const shed = scored.length - rendered;

  // Assemble in fixed section order, only sections that have a selected line.
  // Byte-budget reasoning covers BOTH branches: the empty branch is a fixed
  // constant (header + one short placeholder ≪ MAX_INDEX_BYTES), and the rendered
  // branch is bounded by selectIndexLines (sections ≤ byteCeiling) plus the
  // pre-reserved footer — so the returned content is ≤ MAX_INDEX_BYTES either way.
  const parts: string[] = [INDEX_HEADER];
  if (rendered === 0) {
    // Distinguish "nothing earned a line" from "notes earned lines but all were
    // shed" — the placeholder must not claim the corpus is empty of earned memory.
    parts.push(
      "",
      shed === 0
        ? "_No notes have earned an index line yet._"
        : `_${shed} note(s) earned a line but none fit the index budget._`,
    );
  } else {
    for (const type of SECTION_ORDER) {
      const lines = bySection.get(type)!.filter((line) => selected.has(line));
      if (lines.length === 0) continue;
      parts.push("", `## ${SECTION_TITLE[type]}`);
      for (const line of lines) parts.push(line.text!);
    }
    // The shed footer belongs to a non-empty render; the rendered===0 branch above
    // already states the shed situation in its placeholder.
    if (shed > 0) parts.push("", shedFooter(shed));
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

/** Env kill-switches (M4, adapted from recall's tiered disable pattern — pattern only, no code). */
function memoryProjectionDisabled(): boolean {
  // SOMA_MEMORY_DISABLE turns off ALL memory behavior; SOMA_MEMORY_DISABLE_PROJECT
  // turns off only the substrate projection (recall/reindex still work).
  return process.env.SOMA_MEMORY_DISABLE === "1" || process.env.SOMA_MEMORY_DISABLE_PROJECT === "1";
}

/**
 * Read the rendered `memory/INDEX.md` for substrate projection (M4). Returns the
 * verbatim stored bytes so the projected memory file has NO wall clock — ages were
 * baked at index rebuild time (AC-4). The projection reads, it does NOT rebuild:
 * rebuilding here would stamp install-time ages into the output.
 *
 * Returns `undefined` (project no memory file) when memory/projection is disabled,
 * the index is absent (ENOENT — the normal pre-first-reindex case, silent), or it
 * is empty/whitespace. Any OTHER read failure (permissions, a directory at the
 * path, I/O) is ALSO soft-failed to `undefined` — the projection must never block
 * an install — but it is WARNED to stderr rather than hidden, so a genuine
 * misconfiguration is not silently mistaken for "no memory".
 */
export async function loadMemoryIndexForProjection(
  options: { homeDir?: string; somaHome?: string } = {},
): Promise<string | undefined> {
  if (memoryProjectionDisabled()) return undefined;
  const somaHome = createPaths(options).root();
  const path = memoryIndexPath(somaHome);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      // Unexpected read failure: degrade (don't block install) but surface it.
      console.warn(
        `soma: could not read the memory index at ${path} for projection — skipping the memory file. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return undefined;
  }
  return content.trim().length > 0 ? content : undefined;
}

/**
 * Collect every durable note (semantic + procedural) for indexing, plus the
 * unreadable-file blind spot. Episodic notes join here when M5 lands their dir.
 */
async function collectAllNotes(somaHome: string): Promise<{ notes: SomaMemoryNote[]; unreadable: string[] }> {
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

export interface ReindexMemoryIfStaleResult {
  rebuilt: boolean;
  reason: "disabled" | "up-to-date" | "rebuilt" | "missing-index";
}

/**
 * SessionStart's "smart" reindex gate (M8). Rebuilds `memory/INDEX.md` ONLY when
 * it is actually stale — missing, or some durable note file has been modified
 * (created/edited/verified) more recently than the index was last rebuilt.
 *
 * This is the invariant an idle session must preserve: `renderMemoryIndex`'s
 * "verified Nd ago" ages are baked in at rebuild time from an injected `now`
 * (AC-4) — rebuilding on every session start, even with nothing changed, would
 * silently re-stamp those ages from wall-clock drift alone and churn the
 * generated file (and, if `~/.soma` is snapshotted, its history) for zero
 * informational gain. Comparing mtimes keeps a truly idle session a no-op.
 *
 * Note mtimes come from the SAME symlink-guarded seam the index itself renders
 * from, via the parse-free {@link listDurableNotePaths} (no readFile/parse — an
 * idle check must not scan the whole corpus) — a note this function can't see
 * can't make it stale, and vice versa.
 */
export async function reindexMemoryIfStale(options: SomaMemoryIndexOptions = {}): Promise<ReindexMemoryIfStaleResult> {
  if (memoryProjectionDisabled()) return { rebuilt: false, reason: "disabled" };

  const somaHome = createPaths(options).root();
  const indexPath = memoryIndexPath(somaHome);

  let indexMtimeMs: number | undefined;
  try {
    indexMtimeMs = (await stat(indexPath)).mtimeMs;
  } catch (error) {
    if (!isEnoent(error)) throw error;
    indexMtimeMs = undefined;
  }

  if (indexMtimeMs === undefined) {
    await rebuildMemoryIndex(options);
    return { rebuilt: true, reason: "missing-index" };
  }

  // Freshness only needs mtimes, so enumerate note paths WITHOUT reading/parsing
  // them (parse-free walk) — an idle session start must not pay the O(notes)
  // readFile+parse of a full corpus scan.
  const notePaths = await listDurableNotePaths(somaHome);
  const noteMtimes = await Promise.all(
    notePaths.map(async (path) => {
      try {
        return (await stat(path)).mtimeMs;
      } catch {
        // Vanished between the walk and this stat (TOCTOU) — it can no longer
        // contribute a staleness signal (rebuildMemoryIndex's own scan will
        // simply not see it either).
        return undefined;
      }
    }),
  );
  const newestNoteMtimeMs = noteMtimes.reduce<number>(
    (max, mtimeMs) => (mtimeMs !== undefined && mtimeMs > max ? mtimeMs : max),
    -Infinity,
  );

  if (newestNoteMtimeMs > indexMtimeMs) {
    await rebuildMemoryIndex(options);
    return { rebuilt: true, reason: "rebuilt" };
  }
  return { rebuilt: false, reason: "up-to-date" };
}
