/**
 * Shared corpus operations (#410). Compare / date / sanitize decisions over the
 * note corpus were previously re-decided per call site — `jaccard` duplicated in
 * memory-write.ts + memory-consolidate.ts (with the `0.6` threshold as a second,
 * separately-duplicated literal); `dateMs`/`ageDays` triplicated in memory-index.ts,
 * memory-recall.ts, and memory-consolidate.ts (each with its own future-timestamp
 * nuance); and note-text sanitization split across three strippers of differing
 * strength (`cli/memory.ts`'s full ANSI/OSC strip, wired only into recall;
 * memory-index.ts's weaker `oneLine`, guarding the ALWAYS-LOADED INDEX;
 * episodic-digest.ts's third strip for the digest pointer). Named here so a new
 * output surface can't silently reinvent (or skip) a defense, and so the two
 * near-duplicate paths can't silently disagree on the threshold.
 */

const MS_PER_DAY = 86_400_000;

// --- near-duplicate scoring ---------------------------------------------------

/** Jaccard similarity of two token sets — |intersection| / |union|; 0 when both are empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * The near-duplicate floor shared by the M1 write-path refusal gate
 * (`findDuplicateCandidates` in memory-write.ts) and the M6 consolidation
 * near-duplicate report (`planSimilarPairs` in memory-consolidate.ts) — one
 * number, so the two paths can never silently disagree on what counts as
 * "near-duplicate".
 */
export const NEAR_DUPLICATE_JACCARD_THRESHOLD = 0.6;

// --- note dates ----------------------------------------------------------------

/** UTC-midnight ms for a `YYYY-MM-DD` date; the note schema guarantees the shape. */
export function noteDateMs(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Whole days between a `YYYY-MM-DD` date and `now`, clamped at 0 for a future
 * date — a clock-skewed or future-dated note must never read as having a
 * negative age.
 */
export function ageDays(isoDate: string, now: Date): number {
  const delta = now.getTime() - noteDateMs(isoDate);
  return delta <= 0 ? 0 : Math.floor(delta / MS_PER_DAY);
}

// --- note-text sanitization (SECURITY-CRITICAL) --------------------------------

const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // OSC … terminated by BEL or ST
const CSI_SEQUENCE = /\x1b[@-_][0-?]*[ -/]*[@-~]/g; // CSI and other two-byte ESC sequences
// 8-bit C1 forms: a single introducer byte (0x9b CSI / 0x9d OSC) with no
// leading ESC. Strip the WHOLE sequence, not just the introducer — otherwise
// the C0/C1 byte strip below removes 0x9b but leaves its parameters ("31m") as
// literal text, understating the removal.
const C1_CSI_SEQUENCE = /\x9b[0-?]*[ -/]*[@-~]/g; // C1 CSI (0x9b … final)
const C1_OSC_SEQUENCE = /\x9d[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g; // C1 OSC … terminated by BEL, ST, or C1 ST
const STRAY_ESC = /\x1b./g; // any stray ESC + following byte
const C0_C1_KEEP_TAB_NL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g; // C0/C1 controls except \t (\x09) and \n (\x0a)

/**
 * Strip terminal control sequences from note-authored text before it reaches
 * ANY output surface. Memory notes can hold imported/quarantined tool/web
 * content, and a malicious note body or `source_of_truth` could otherwise
 * smuggle ANSI CSI/OSC escapes that spoof output, rewrite earlier lines, or
 * poke the terminal's title/clipboard state — on recall, on the always-loaded
 * INDEX, or in a regenerated episodic digest. Removes:
 *   - ESC-introduced sequences (CSI `ESC [ … final`, OSC `ESC ] … BEL|ST`, and
 *     any other `ESC <byte>` form),
 *   - the 8-bit C1 equivalents as WHOLE sequences (C1 CSI `0x9b … final`, C1
 *     OSC `0x9d … BEL|ST`), not just their introducer byte, and
 *   - remaining C0/C1 control chars, keeping tab and newline UNLESS `oneLine`.
 * Deliberately conservative: it discards control bytes rather than escaping
 * them, since every surface this guards renders human-facing text, not a
 * round-trippable channel.
 *
 * `oneLine: true` additionally collapses all whitespace (including the
 * tab/newline otherwise preserved) into single spaces and trims — the shape a
 * one-line pointer descriptor (the INDEX line, the episodic digest pointer)
 * needs. Default `false` preserves layout, matching recall's multi-line
 * banner + body rendering.
 */
export function sanitizeNoteText(text: string, options: { oneLine?: boolean } = {}): string {
  const stripped = text
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(C1_OSC_SEQUENCE, "")
    .replace(C1_CSI_SEQUENCE, "")
    .replace(STRAY_ESC, "")
    .replace(C0_C1_KEEP_TAB_NL, "");
  return options.oneLine ? stripped.replace(/\s+/g, " ").trim() : stripped;
}
