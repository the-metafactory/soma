import { ALGORITHM_CLASSIFIER_CONTRACT } from "../algorithm/algorithm-classifier";
import { hashJudgmentInput, matchesFilter, type JudgmentRecord, type JudgmentFilter } from "../core/index";

/**
 * `soma judge` — the judgment ledger and caller registry.
 *
 * Every piece of code that makes a fuzzy call (which mode a prompt needs, later:
 * is this a correction, is this memory relevant) is a registered *caller*. Each
 * call writes one ledger line, so agreement with what actually happened can be
 * measured before any caller is trusted to act. A caller starts in `shadow`
 * and only moves to `enforce` with a recorded measurement.
 *
 * The ledger stores a hash of the input, never the input itself.
 *
 * Design: Plans/2026-09-28-front-door-router-design.md (step 0, Q3).
 */

export type JudgeCallerState = "shadow" | "enforce";

export interface JudgeCallerMeasurement {
  agreement: number;
  date: string;
  backend: string;
  backendVersion: string;
}

export interface JudgeCaller {
  id: string;
  description: string;
  state: JudgeCallerState;
  measuredOn: JudgeCallerMeasurement | null;
}

export const JUDGE_REGISTRY: readonly JudgeCaller[] = [
  {
    id: "mode-router",
    description: "Picks mode (minimal/native/algorithm) and effort for each prompt.",
    state: "shadow",
    measuredOn: null,
  },
  {
    id: "errata-triage",
    description: "Promotes or drops interactive feedback rejecting delivered outputs.",
    state: "shadow",
    measuredOn: null,
  },
];

/**
 * Identity of the regex classifier's pattern set a record was produced by. It
 * hashes ALGORITHM_CLASSIFIER_CONTRACT only, so any pattern change changes the
 * version. Changes to the code around the patterns (normalisation, precedence,
 * the unmatched fallback) do not; a measurement that must span such a change
 * has to be re-taken, not trusted by version alone.
 */
export function regexClassifierVersion(): string {
  return hashJudgmentInput(JSON.stringify(ALGORITHM_CLASSIFIER_CONTRACT)).slice(0, 12);
}


function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export interface JudgeCallerStats {
  caller: string;
  state: JudgeCallerState | "unregistered";
  total: number;
  /** decision key → value → count, e.g. mode → native → 12. */
  decisions: Record<string, Record<string, number>>;
  /** YYYY-MM-DD → count. */
  days: Record<string, number>;
  medianLatencyMs: number | null;
}

export function summarizeJudgments(records: JudgmentRecord[], filter: JudgmentFilter = {}): JudgeCallerStats[] {
  const byCaller = new Map<string, JudgmentRecord[]>();
  for (const record of records) {
    if (!matchesFilter(record, filter)) continue;
    const list = byCaller.get(record.caller) ?? [];
    list.push(record);
    byCaller.set(record.caller, list);
  }

  return [...byCaller.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([caller, list]) => {
      const decisions: Record<string, Record<string, number>> = {};
      const days: Record<string, number> = {};
      for (const record of list) {
        for (const [key, value] of Object.entries(record.decision)) {
          decisions[key] ??= {};
          decisions[key][value] = (decisions[key][value] ?? 0) + 1;
        }
        const day = record.ts.slice(0, 10);
        days[day] = (days[day] ?? 0) + 1;
      }
      const latencies = list.map((record) => record.latencyMs).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
      return {
        caller,
        state: JUDGE_REGISTRY.find((entry) => entry.id === caller)?.state ?? "unregistered",
        total: list.length,
        decisions,
        days,
        medianLatencyMs: median(latencies),
      };
    });
}
