import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ALGORITHM_CLASSIFIER_CONTRACT } from "./algorithm-classifier";
import { createPaths } from "./paths";

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
];

export interface JudgmentRecord {
  v: 1;
  ts: string;
  caller: string;
  substrate?: string;
  session?: string;
  inputSha256: string;
  backend: string;
  backendVersion: string;
  decision: Record<string, string>;
  source?: string;
  latencyMs: number;
}

export function judgeLedgerPath(somaHome: string): string {
  return createPaths(somaHome).state("judgments", "ledger.jsonl");
}

export function hashJudgmentInput(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Identity of the regex classifier a record was produced by. A change to any
 * pattern changes the version, so a measurement never silently carries over to
 * a different classifier.
 */
export function regexClassifierVersion(): string {
  return hashJudgmentInput(JSON.stringify(ALGORITHM_CLASSIFIER_CONTRACT)).slice(0, 12);
}

/**
 * Best-effort append. A ledger failure must never change or block the judgment
 * it records, so every error is swallowed and reported as `false`.
 */
export async function recordJudgment(somaHome: string, record: JudgmentRecord): Promise<boolean> {
  try {
    const path = judgeLedgerPath(somaHome);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function isJudgmentRecord(value: unknown): value is JudgmentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.v === 1
    && typeof record.ts === "string"
    && typeof record.caller === "string"
    && typeof record.decision === "object"
    && record.decision !== null;
}

export async function readJudgments(somaHome: string): Promise<{ records: JudgmentRecord[]; malformed: number }> {
  let raw: string;
  try {
    raw = await readFile(judgeLedgerPath(somaHome), "utf8");
  } catch {
    return { records: [], malformed: 0 };
  }

  const records: JudgmentRecord[] = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isJudgmentRecord(parsed)) records.push(parsed);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
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

export function summarizeJudgments(records: JudgmentRecord[], options: { since?: string; caller?: string } = {}): JudgeCallerStats[] {
  const byCaller = new Map<string, JudgmentRecord[]>();
  for (const record of records) {
    if (options.caller && record.caller !== options.caller) continue;
    if (options.since && record.ts < options.since) continue;
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
        medianLatencyMs: latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : null,
      };
    });
}
