import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { createPaths } from "./paths";

/** Shared judgment storage; caller policy and measurement belong to src/router/judge.ts. */
export interface JudgmentRecord {
  v: 1;
  id?: string;
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
 * Best-effort append. A failed write is swallowed and reported as `false`, so it
 * never changes the judgment it records. A write that stalls does delay the
 * caller until it completes; callers on a deadline (the mode hooks' timeouts)
 * fail open past it, exactly as for any other classifier failure.
 */
export async function recordJudgment(somaHome: string, record: JudgmentRecord): Promise<boolean> {
  try {
    const path = judgeLedgerPath(somaHome);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ ...record, id: record.id ?? randomUUID() })}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * A record counts only when every field the statistics read is well-formed.
 * Anything less is reported as malformed rather than skewing decision shares.
 */
function isJudgmentRecord(value: unknown): value is JudgmentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.v === 1
    && (record.id === undefined || (typeof record.id === "string" && record.id.trim().length > 0))
    && typeof record.ts === "string"
    && typeof record.caller === "string"
    && typeof record.inputSha256 === "string"
    && typeof record.backend === "string"
    && typeof record.backendVersion === "string"
    && typeof record.latencyMs === "number"
    && isStringRecord(record.decision)
    && Object.keys(record.decision).length > 0;
}

export interface JudgmentFilter {
  caller?: string;
  /** ISO date or timestamp; records before it are skipped. */
  since?: string;
}

export function matchesFilter(record: JudgmentRecord, filter: JudgmentFilter): boolean {
  if (filter.caller && record.caller !== filter.caller) return false;
  if (filter.since && record.ts < filter.since) return false;
  return true;
}

/**
 * Stream the ledger, keeping only records that pass `filter`, so a narrow query
 * holds only its own records in memory. A ledger that does not exist yet reads
 * as empty; any other read failure is an error, never "no judgments".
 */
export async function readJudgments(somaHome: string, filter: JudgmentFilter = {}): Promise<{ records: (JudgmentRecord & { id: string })[]; malformed: number }> {
  const records: (JudgmentRecord & { id: string })[] = [];
  let malformed = 0;
  const stream = createReadStream(judgeLedgerPath(somaHome), { encoding: "utf8" });
  const opened = new Promise<boolean>((resolve, reject) => {
    stream.once("open", () => {
      resolve(true);
    });
    stream.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
  if (!(await opened)) return { records, malformed };

  let lineNumber = 0;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isJudgmentRecord(parsed)) malformed += 1;
      else if (matchesFilter(parsed, filter)) records.push({
        ...parsed,
        id: parsed.id ?? `legacy-${hashJudgmentInput(`${lineNumber}:${line}`)}`,
      });
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

