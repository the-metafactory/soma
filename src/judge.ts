import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
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
 * Best-effort append. A failed write is swallowed and reported as `false`, so it
 * never changes the judgment it records. A write that stalls does delay the
 * caller until it completes; callers on a deadline (the mode hook's subprocess
 * timeout) fail open past it, exactly as for any other classifier failure.
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

export interface JudgmentFilter {
  caller?: string;
  /** ISO date or timestamp; records before it are skipped. */
  since?: string;
}

function matchesFilter(record: JudgmentRecord, filter: JudgmentFilter): boolean {
  if (filter.caller && record.caller !== filter.caller) return false;
  if (filter.since && record.ts < filter.since) return false;
  return true;
}

/**
 * Stream the ledger, keeping only records that pass `filter`, so a narrow query
 * holds only its own records in memory. A ledger that does not exist yet reads
 * as empty; any other read failure is an error, never "no judgments".
 */
export async function readJudgments(somaHome: string, filter: JudgmentFilter = {}): Promise<{ records: JudgmentRecord[]; malformed: number }> {
  const records: JudgmentRecord[] = [];
  let malformed = 0;
  const stream = createReadStream(judgeLedgerPath(somaHome), { encoding: "utf8" });
  const opened = new Promise<boolean>((resolve, reject) => {
    stream.once("open", () => resolve(true));
    stream.once("error", (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? resolve(false) : reject(error)));
  });
  if (!(await opened)) return { records, malformed };

  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isJudgmentRecord(parsed)) malformed += 1;
      else if (matchesFilter(parsed, filter)) records.push(parsed);
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
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
