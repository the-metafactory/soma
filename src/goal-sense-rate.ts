import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { rateParams, type RateParams } from "./goal-kinds/rate";
import { workdayWindowStart } from "./workdays";
import type { GoalSenseValue } from "./goal-sense";
import {
  publishRunFinished,
  type RunFinishedPublisher,
  type RunFinishedResult,
  type RunLedgerEnv,
} from "./run-ledger";

export type RateSensorOptions = Omit<RateParams, "route" | "timezone"> & Partial<Pick<RateParams, "route" | "timezone">>;

export interface RateSensorDeps {
  somaHome: string;
  env?: RunLedgerEnv;
  publish?: RunFinishedPublisher;
  now?: () => Date;
  runId?: () => string;
  stdout?: (line: string) => void;
}

export interface RateSensorResult {
  /** 0 measured, 1 journal unreadable, 2 refused before opening the journal. */
  exitCode: 0 | 1 | 2;
  value?: GoalSenseValue;
  count?: number;
  ledger?: RunFinishedResult;
  error?: string;
}

/** Read Ranger's journal without importing its store, migrating or creating it. */
function countClosedEscalations(journalPath: string, route: RateParams["route"], start: Date, end: Date): number {
  const journal = new Database(journalPath, { readonly: true, create: false, strict: true });
  try {
    const rows = journal.query<{ closed_at: string }, [string]>(
      "SELECT closed_at FROM escalations WHERE status = 'closed' AND route = ? AND closed_at IS NOT NULL",
    ).iterate(route);
    let count = 0;
    for (const row of rows) {
      // Compare instants, not ISO strings: offsets need not match UTC spelling.
      const closedAt = Date.parse(row.closed_at);
      if (!Number.isFinite(closedAt)) throw new Error("escalation closed_at is not an ISO instant");
      if (closedAt >= start.getTime() && closedAt <= end.getTime()) count++;
    }
    return count;
  } finally {
    journal.close();
  }
}

/** Closed events against min; unavailable evidence fails without a goal state. */
export async function runRateSensor(
  options: RateSensorOptions,
  journalPath: string,
  deps: RateSensorDeps,
): Promise<RateSensorResult> {
  const parsed = rateParams.safeParse(options);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] ?? "params"))];
    return { exitCode: 2, error: `soma goal sense rate: invalid ${fields.join(", ")}; journal not read` };
  }
  const p = parsed.data;
  const now = deps.now ?? (() => new Date());
  const instant = now();
  const startedAt = instant.toISOString();
  let measured: { count: number; value: GoalSenseValue } | undefined;
  let error: string | undefined;
  try {
    const start = workdayWindowStart(p.window_workdays, p.timezone, instant);
    const count = countClosedEscalations(journalPath, p.route, start, instant);
    measured = { count, value: count >= p.min ? "on-track" : "off-track" };
  } catch (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    error = `soma goal sense rate: journal read failed: ${reason.replaceAll(journalPath, "<journal>")}`;
  }
  const ledger = await publishRunFinished({
    kind: "job",
    ref: `goal-sense/${p.goal}`,
    runId: deps.runId?.() ?? randomUUID(),
    outcome: measured === undefined ? "failed" : "succeeded",
    startedAt,
    endedAt: now().toISOString(),
    serves: { goal: p.goal },
    ...(measured === undefined ? {} : { state: { subject: p.goal, value: measured.value } }),
  }, { somaHome: deps.somaHome, substrate: "custom", env: deps.env, publish: deps.publish });

  if (measured === undefined) return { exitCode: 1, ledger, error };
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  stdout(`${p.goal}: ${measured.value} (${measured.count} closed ${p.route} escalations, min ${p.min} in ${p.window_workdays} workdays (${p.timezone}); run ledger: ${ledger})`);
  return { exitCode: 0, ...measured, ledger };
}
