/**
 * Pure-logic renderers for the per-phase widget lines + auxiliary widget
 * helpers used by the soma-algorithm pi.dev extension (#43).
 *
 * Each helper takes plain data and returns `string[]` — ready to hand to
 * `ctx.ui.setWidget(key, lines)`. No pi.dev runtime imports; these
 * functions are unit-testable in isolation.
 *
 * Key conventions:
 *
 *   Widget key  =  `soma-${runId}-phase-${position}-${slug}`
 *   Status key  =  `soma`  (single status slot per session — pi.dev convention)
 *
 * The runId scoping addresses open-question #2 in the issue: concurrent
 * Algorithm runs each get a distinct set of widget keys, so a long-running
 * background run does not clobber a freshly started one.
 */

import {
  ALGORITHM_PHASES,
  type AlgorithmPhaseKey,
  type PhaseMarker,
} from "./phase-parser";

/**
 * Slug used in widget keys — lowercase phase key. Stable across versions;
 * downstream tools may parse widget keys.
 */
function slugFor(phase: AlgorithmPhaseKey): string {
  return phase;
}

export interface PhaseWidgetKeyInput {
  readonly runId: string;
  readonly phase: AlgorithmPhaseKey;
  readonly position: number;
}

/**
 * Compute the widget key for a single phase widget.
 *
 * Always namespaced by `runId` so concurrent runs in the same pi.dev
 * session don't collide.
 */
export function phaseWidgetKey({ runId, phase, position }: PhaseWidgetKeyInput): string {
  return `soma-${runId}-phase-${position}-${slugFor(phase)}`;
}

/** Auxiliary widget keys — single per-run instance each. */
export function isaCriteriaWidgetKey(runId: string): string {
  return `soma-${runId}-isa-criteria`;
}

// NOTE: A capabilitiesWidgetKey helper was previously reserved here for
// the capabilities widget. It was dropped because nothing renders the
// widget in this PR (Sage R3 maintainability suggestion). Add it back
// when the capabilities widget actually lands, alongside its renderer.

/** The footer status key. Pi.dev's status is a single slot; we own `soma`. */
export const SOMA_STATUS_KEY = "soma" as const;

export interface PhaseWidgetContentInput {
  readonly marker: PhaseMarker;
  /**
   * Lines emitted by the model under this phase header, up to the next
   * marker (or end of stream). Already split on newlines; leading/trailing
   * blank lines stripped by the caller.
   */
  readonly body: readonly string[];
  /**
   * Whether this is the currently-active phase. Used for visual hints
   * (e.g. trailing "▸ active" marker line). Rendering is otherwise
   * identical.
   */
  readonly active: boolean;
}

/**
 * Look up the canonical display strings for a phase key. Shared
 * between widget header and footer status renderers so phase-label
 * changes need only one edit (Sage R6 maintainability suggestion).
 * Falls through to the uppercased key + bullet glyph for unknown
 * phases — tolerant by design.
 */
function phaseDisplay(phase: AlgorithmPhaseKey): { name: string; emoji: string } {
  const descriptor = ALGORITHM_PHASES.find((d) => d.key === phase);
  return {
    name: descriptor?.name ?? phase.toUpperCase(),
    emoji: descriptor?.emoji ?? "•",
  };
}

/**
 * Render the content lines for a single phase widget.
 *
 * Output shape:
 *
 *   <emoji> PHASE <n>/<m>
 *   <body line 1>
 *   <body line 2>
 *   ...
 *   ▸ active        (only when active === true)
 *
 * Always returns at least one line (the header).
 */
export function renderPhaseWidgetLines(input: PhaseWidgetContentInput): string[] {
  const { name, emoji } = phaseDisplay(input.marker.phase);
  const lines: string[] = [`${emoji} ${name} ${input.marker.position}/${input.marker.total}`];

  for (const line of input.body) lines.push(line);

  if (input.active) lines.push("▸ active");

  return lines;
}

export interface PhaseStatusInput {
  readonly marker: PhaseMarker;
  readonly suffix?: string; // optional appendage like "ISA 3/7"
}

/**
 * Footer status line: `Phase N/7 — EXECUTE` (AC-6). With optional
 * suffix: `Phase 5/7 — EXECUTE | ISA 3/7`.
 */
export function renderPhaseStatusText(input: PhaseStatusInput): string {
  const { name } = phaseDisplay(input.marker.phase);
  const base = `Phase ${input.marker.position}/${input.marker.total} — ${name}`;

  return input.suffix ? `${base} | ${input.suffix}` : base;
}

/**
 * Render the "all seven phases at a glance" overview widget. Used for
 * the soma-${runId}-overview widget — single per-run dashboard line set
 * showing which phases have fired vs. are pending.
 */
export interface OverviewInput {
  readonly seenPhases: ReadonlySet<AlgorithmPhaseKey>;
  readonly currentPhase?: AlgorithmPhaseKey;
}

export function renderPhaseOverviewLines(input: OverviewInput): string[] {
  const lines: string[] = ["## Algorithm Phases"];

  for (const descriptor of ALGORITHM_PHASES) {
    const seen = input.seenPhases.has(descriptor.key);
    const active = input.currentPhase === descriptor.key;
    const glyph = active ? "▸" : seen ? "✓" : "·";

    lines.push(`${glyph} ${descriptor.emoji} ${descriptor.name} ${descriptor.position}/${descriptor.total}`);
  }

  return lines;
}
