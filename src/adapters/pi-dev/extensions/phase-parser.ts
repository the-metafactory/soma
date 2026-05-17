/**
 * Algorithm phase marker parser (pure logic).
 *
 * Identifies the canonical phase headers Soma's Algorithm emits as part of
 * model output:
 *
 *   ━━━ 👁️ OBSERVE ━━━ 1/7
 *   ━━━ 🧠 THINK ━━━ 2/7
 *   ━━━ 📋 PLAN ━━━ 3/7
 *   ━━━ 🛠️ BUILD ━━━ 4/7
 *   ━━━ ⚡ EXECUTE ━━━ 5/7
 *   ━━━ ✅ VERIFY ━━━ 6/7
 *   ━━━ 📚 LEARN ━━━ 7/7
 *   ━━━ 📃 SUMMARY ━━━ 7/7
 *
 * Lives in the pi-dev adapter tree because it backs the soma-algorithm
 * pi.dev extension (#43). The parser itself is substrate-agnostic and
 * fully unit-testable — it operates on streamed model text.
 *
 * Tolerant by design: models drift, line wrapping happens, leading/trailing
 * whitespace happens. The regex is anchored to the heavy-line glyph and
 * the n/m suffix so spurious text never matches. Lines that don't match
 * are skipped silently — the parser is a filter, not a validator.
 */

/**
 * Phase identifiers — lowercase per the existing `AlgorithmPhase` type
 * in `src/types.ts`. Distinct from `complete`/`abandoned` lifecycle
 * states; those have no marker in model output.
 */
export type AlgorithmPhaseKey =
  | "observe"
  | "think"
  | "plan"
  | "build"
  | "execute"
  | "verify"
  | "learn"
  | "summary";

export interface AlgorithmPhaseDescriptor {
  readonly key: AlgorithmPhaseKey;
  readonly name: string; // uppercase label as it appears in the marker
  readonly emoji: string; // emoji glyph as it appears in the marker
  readonly position: number; // 1..7 — phase ordinal as authored
  readonly total: number; // 7 — total phases
}

/**
 * Canonical phase table. SUMMARY shares position 7 with LEARN — that
 * matches the canonical example in `src/adapters/codex/adapter.ts:166`
 * and is intentional: SUMMARY is the close-out of LEARN, not a 9th
 * phase. Widget keys still use distinct slugs.
 */
export const ALGORITHM_PHASES: readonly AlgorithmPhaseDescriptor[] = [
  { key: "observe", name: "OBSERVE", emoji: "👁️", position: 1, total: 7 },
  { key: "think", name: "THINK", emoji: "🧠", position: 2, total: 7 },
  { key: "plan", name: "PLAN", emoji: "📋", position: 3, total: 7 },
  { key: "build", name: "BUILD", emoji: "🛠️", position: 4, total: 7 },
  { key: "execute", name: "EXECUTE", emoji: "⚡", position: 5, total: 7 },
  { key: "verify", name: "VERIFY", emoji: "✅", position: 6, total: 7 },
  { key: "learn", name: "LEARN", emoji: "📚", position: 7, total: 7 },
  { key: "summary", name: "SUMMARY", emoji: "📃", position: 7, total: 7 },
] as const;

export interface PhaseMarker {
  readonly phase: AlgorithmPhaseKey;
  readonly position: number;
  readonly total: number;
  /** Zero-based line index within the input text where the marker matched. */
  readonly lineIndex: number;
  /** The raw matched line (trimmed of trailing whitespace, untouched leading). */
  readonly rawLine: string;
}

/**
 * Matches `━━━ <emoji> <NAME> ━━━ <n>/<m>` as a complete line. We require:
 *   - line anchors (^ ... $) so body prose containing a marker-shaped
 *     substring (e.g. quoting another transcript) never produces a
 *     false phase transition (Sage R4 CodeQuality suggestion)
 *   - leading/trailing optional whitespace tolerance — copy/paste from
 *     terminals sometimes adds it
 *   - heavy-line opener and closer (3+ heavy glyphs each side)
 *   - uppercase NAME (A-Z and underscore) so "Plan ahead" never matches
 *   - the digits suffix
 *
 * The emoji portion is non-greedy (`.+?`) because emoji are variable-width
 * grapheme clusters — encoding any specific set would be brittle.
 */
const MARKER_REGEX = /^\s*━{3,}\s+(.+?)\s+([A-Z][A-Z_]+)\s+━{3,}\s+(\d+)\s*\/\s*(\d+)\s*$/u;

/**
 * Build a lookup from uppercase phase name to descriptor. SUMMARY and
 * LEARN are distinct keys (both at position 7) so the lookup is
 * unambiguous on the name axis. A Map (not a Record) so unknown keys
 * return undefined rather than a never-narrowed value — the parser
 * gracefully skips unknown uppercase tokens.
 */
const PHASES_BY_NAME: ReadonlyMap<string, AlgorithmPhaseDescriptor> = new Map(
  ALGORITHM_PHASES.map((descriptor) => [descriptor.name, descriptor] as const),
);

/**
 * Parse all phase markers in the given streamed text. Returns markers in
 * the order they appear, including duplicates if a phase is announced
 * more than once (uncommon but legal — a long run may re-emit a phase
 * header after a tool call interlude).
 *
 * Pure: same input → same output, no side effects.
 */
export function parseAlgorithmPhaseMarkers(text: string): PhaseMarker[] {
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  const markers: PhaseMarker[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex].replace(/\s+$/u, "");
    const match = MARKER_REGEX.exec(rawLine);
    if (!match) continue;

    const name = match[2];
    const descriptor = PHASES_BY_NAME.get(name);
    if (!descriptor) continue; // unknown uppercase token — ignore, don't throw

    const position = Number.parseInt(match[3], 10);
    const total = Number.parseInt(match[4], 10);
    if (!Number.isFinite(position) || !Number.isFinite(total)) continue;

    markers.push({
      phase: descriptor.key,
      position,
      total,
      lineIndex,
      rawLine,
    });
  }

  return markers;
}

// NOTE: A `latestAlgorithmPhaseMarker(text) → PhaseMarker | undefined`
// convenience was previously exported here. Dropped because the
// pi.dev extension derives currentPhase directly from per-line
// ingest, and no other caller exists (Sage R5 maintainability
// suggestion). Add it back when a production caller materializes.
