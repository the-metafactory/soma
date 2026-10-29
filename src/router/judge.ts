import { ALGORITHM_CLASSIFIER_CONTRACT } from "../algorithm/algorithm-classifier";
import { appendJudgmentLabel, hashJudgmentInput, matchesFilter, readJudgments, type JudgmentRecord, type JudgmentFilter, type PrincipalJudgmentLabel } from "../core/index";

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
  principalLabels: number;
  labelSource: "principal" | "model";
  date: string;
  backend: string;
  backendVersion: string;
}

export interface JudgeCaller {
  id: string;
  description: string;
  state: JudgeCallerState;
  measuredOn: JudgeCallerMeasurement | null;
  minLabels?: number;
  enforceBar?: number;
}

export const DEFAULT_JUDGE_THRESHOLDS = { minLabels: 20, enforceBar: 0.9 } as const;

export const JUDGE_REGISTRY: readonly JudgeCaller[] = [
  {
    ...DEFAULT_JUDGE_THRESHOLDS,
    id: "mode-router",
    description: "Picks mode (minimal/native/algorithm) and effort for each prompt.",
    state: "shadow",
    measuredOn: null,
  },
  {
    ...DEFAULT_JUDGE_THRESHOLDS,
    id: "errata-triage",
    description: "Promotes or drops interactive feedback rejecting delivered outputs.",
    state: "shadow",
    measuredOn: null,
  },
];

export function assertJudgeRegistry(registry: readonly JudgeCaller[] = JUDGE_REGISTRY): void {
  for (const caller of registry) {
    const minLabels = caller.minLabels ?? DEFAULT_JUDGE_THRESHOLDS.minLabels;
    const enforceBar = caller.enforceBar ?? DEFAULT_JUDGE_THRESHOLDS.enforceBar;
    if (!Number.isSafeInteger(minLabels) || minLabels < 1 || !Number.isFinite(enforceBar) || enforceBar <= 0 || enforceBar > 1) {
      throw new Error(`Judge ${caller.id}: invalid minLabels or enforceBar`);
    }
    if (caller.state !== "enforce") continue;
    const measurement = caller.measuredOn;
    if (measurement?.labelSource !== "principal"
      || !Number.isSafeInteger(measurement.principalLabels) || measurement.principalLabels < minLabels
      || !Number.isFinite(measurement.agreement) || measurement.agreement < enforceBar || measurement.agreement > 1) {
      throw new Error(`Judge ${caller.id}: enforce requires measuredOn with at least ${minLabels} principal labels and agreement >= ${enforceBar}`);
    }
  }
}

export async function labelJudgment(options: {
  somaHome: string;
  judgmentId: string;
  verdict: PrincipalJudgmentLabel["verdict"];
  env?: Pick<NodeJS.ProcessEnv, "SOMA_PRINCIPAL">;
}): Promise<PrincipalJudgmentLabel> {
  const principal = (options.env ?? process.env).SOMA_PRINCIPAL?.trim();
  if (!principal) throw new Error("SOMA_PRINCIPAL is required to label a judgment");
  const { records } = await readJudgments(options.somaHome);
  const matches = records.filter((record) => record.id === options.judgmentId);
  if (matches.length !== 1) throw new Error(`${matches.length === 0 ? "Unknown" : "Ambiguous"} judgment id: ${options.judgmentId}`);
  const label: PrincipalJudgmentLabel = {
    v: 1,
    judgmentId: options.judgmentId,
    ts: new Date().toISOString(),
    source: "principal",
    principal,
    verdict: options.verdict,
  };
  await appendJudgmentLabel(options.somaHome, label);
  return label;
}

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
  labeled: number;
  right: number;
  wrong: number;
  agreement: number | null;
}

export function summarizeJudgments(records: JudgmentRecord[], filter: JudgmentFilter = {}, labels: PrincipalJudgmentLabel[] = []): JudgeCallerStats[] {
  const latestLabels = new Map<string, PrincipalJudgmentLabel>();
  for (const label of labels) {
    latestLabels.set(label.judgmentId, label);
  }
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
      const labeled = new Map<string, PrincipalJudgmentLabel>();
      for (const record of list) {
        const label = record.id === undefined ? undefined : latestLabels.get(record.id);
        if (label) labeled.set(label.judgmentId, label);
      }
      const right = [...labeled.values()].filter((label) => label.verdict === "right").length;
      return {
        caller,
        state: JUDGE_REGISTRY.find((entry) => entry.id === caller)?.state ?? "unregistered",
        total: list.length,
        decisions,
        days,
        medianLatencyMs: median(latencies),
        labeled: labeled.size,
        right,
        wrong: labeled.size - right,
        agreement: labeled.size === 0 ? null : right / labeled.size,
      };
    });
}
