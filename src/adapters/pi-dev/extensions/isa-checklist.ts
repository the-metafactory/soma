/**
 * Pure-logic renderer for the "ISA criteria" widget content lines.
 *
 * The Algorithm's per-ISA criteria are projected as a live checklist:
 *
 *   [x] ISC-1: criterion title
 *   [ ] ISC-2: criterion title
 *   [-] ISC-3: criterion title — dropped
 *
 * Glyph mapping:
 *   passed   → [x]   (criterion verified)
 *   dropped  → [-]   (deliberately removed)
 *   pending  → [ ]   (everything else: unverified, in-progress, etc.)
 *
 * Status strings mirror `IdealStateCriterion.status` in `src/types.ts`.
 * This module deliberately accepts any string status and falls through
 * to "pending" for unrecognized values rather than crashing the widget.
 *
 * No widget primitives are imported here — `renderIsaChecklistLines`
 * returns `string[]` so the soma-algorithm pi.dev extension can hand it
 * straight to `ctx.ui.setWidget(key, lines)`.
 */

export interface IsaChecklistCriterion {
  /** Stable identifier like "ISC-1". Rendered verbatim. */
  readonly id: string;
  /** One-line title. Rendered verbatim, truncated by display layer if needed. */
  readonly title: string;
  /** Status string. "passed" / "dropped" map to glyphs; anything else → pending. */
  readonly status: string;
}

export interface IsaChecklistOptions {
  /**
   * Header line(s) prepended to the checklist. Empty array → no header.
   * Defaults to `["## ISA Criteria"]`.
   */
  readonly header?: readonly string[];
  /**
   * Line rendered when there are zero criteria. Defaults to
   * `"(no criteria yet)"`.
   */
  readonly emptyLine?: string;
}

const DEFAULT_HEADER = ["## ISA Criteria"] as const;
const DEFAULT_EMPTY = "(no criteria yet)";

function glyphFor(status: string): string {
  switch (status) {
    case "passed":
      return "[x]";
    case "dropped":
      return "[-]";
    default:
      return "[ ]";
  }
}

/**
 * Render the criteria checklist as widget lines. Pure and total: never
 * throws, returns at least one line (the header or the empty line).
 *
 * Callers feed the result directly into `ctx.ui.setWidget(key, lines)`.
 */
export function renderIsaChecklistLines(
  criteria: readonly IsaChecklistCriterion[],
  options: IsaChecklistOptions = {},
): string[] {
  const header = options.header ?? DEFAULT_HEADER;
  const emptyLine = options.emptyLine ?? DEFAULT_EMPTY;
  const lines: string[] = [...header];

  if (criteria.length === 0) {
    lines.push(emptyLine);
    return lines;
  }

  for (const criterion of criteria) {
    lines.push(`${glyphFor(criterion.status)} ${criterion.id}: ${criterion.title}`);
  }

  return lines;
}

/**
 * Quick-summary counts. Useful for the footer status line:
 *
 *   `Phase 5/7 — EXECUTE | ISA: 3/7 verified`
 */
export interface IsaChecklistSummary {
  readonly total: number;
  readonly passed: number;
  readonly dropped: number;
  readonly pending: number;
}

export function summarizeIsaChecklist(criteria: readonly IsaChecklistCriterion[]): IsaChecklistSummary {
  let passed = 0;
  let dropped = 0;

  for (const c of criteria) {
    if (c.status === "passed") passed += 1;
    else if (c.status === "dropped") dropped += 1;
  }

  return {
    total: criteria.length,
    passed,
    dropped,
    pending: criteria.length - passed - dropped,
  };
}
