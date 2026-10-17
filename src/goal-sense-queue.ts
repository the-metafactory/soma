import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { queueParams, type QueueParams } from "./goal-kinds/queue";
import type { GoalSenseValue } from "./goal-sense";
import {
  publishRunFinished,
  type RunFinishedPublisher,
  type RunFinishedResult,
  type RunLedgerEnv,
} from "./run-ledger";

export type QueueSensorOptions = Omit<QueueParams, "route"> & { route?: QueueParams["route"] };

export interface QueueSensorDeps {
  somaHome: string;
  env?: RunLedgerEnv;
  publish?: RunFinishedPublisher;
  now?: () => Date;
  runId?: () => string;
  stdout?: (line: string) => void;
}

export interface QueueSensorResult {
  /** 0 measured, 1 journal unreadable, 2 refused before opening the journal. */
  exitCode: 0 | 1 | 2;
  value?: GoalSenseValue;
  count?: number;
  ledger?: RunFinishedResult;
  error?: string;
}

/** Read Ranger's journal without importing its store, migrating or creating it. */
function countOpenEscalations(journalPath: string, route: QueueParams["route"]): number {
  const journal = new Database(journalPath, { readonly: true, create: false, strict: true });
  try {
    const row = journal.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM escalations WHERE status = 'open' AND route = ?",
    ).get(route);
    if (row === null) throw new Error("escalation count was not returned");
    return row.count;
  } finally {
    journal.close();
  }
}

/** A queue level against max; unavailable evidence fails without a goal state. */
export async function runQueueSensor(
  options: QueueSensorOptions,
  journalPath: string,
  deps: QueueSensorDeps,
): Promise<QueueSensorResult> {
  const parsed = queueParams.safeParse(options);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] ?? "params"))];
    return { exitCode: 2, error: `soma goal sense queue: invalid ${fields.join(", ")}; journal not read` };
  }
  const p = parsed.data;
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  let measured: { count: number; value: GoalSenseValue } | undefined;
  let error: string | undefined;
  try {
    const count = countOpenEscalations(journalPath, p.route);
    measured = { count, value: count <= p.max ? "on-track" : "off-track" };
  } catch (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    error = `soma goal sense queue: journal read failed: ${reason.replaceAll(journalPath, "<journal>")}`;
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
  stdout(`${p.goal}: ${measured.value} (${measured.count} open ${p.route} escalations, max ${p.max}; run ledger: ${ledger})`);
  return { exitCode: 0, ...measured, ledger };
}
