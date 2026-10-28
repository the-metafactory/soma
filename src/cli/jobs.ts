import { randomUUID } from "node:crypto";
import { defaultSomaHome } from "../core/index";
import { readJobsInventory, type JobsInventory, type JobRow } from "../jobs/index";
import type { RunLedgerDeps } from "../flows/index";

export const JOBS_COMMAND_HELP = {
  usage: "Usage: soma jobs [--json] [--emit] (read-only inventory; --emit reports assessed jobs to the run ledger; SOMA_PRINCIPAL required)",
};

export interface JobsCliDeps extends RunLedgerDeps {
  inventory?: () => Promise<JobsInventory>;
  now?: () => Date;
  somaHome?: string;
  stderr?: (line: string) => void;
}

function renderRows(rows: JobRow[]): string {
  if (rows.length === 0) return "No scheduled jobs found.";
  return ["STATUS\tLABEL\tLAST EXIT\tPERIOD (min)\tLAST RUN / ACTIVITY\tREASON", ...rows.map((row) =>
    [row.status, row.label, row.lastExit ?? "?", row.periodMinutes ?? "?", row.lastRun ?? "?", row.reason].join("\t"))].join("\n");
}

export async function runJobsCli(args: string[], deps: JobsCliDeps = {}): Promise<string> {
  if (args.some((arg) => arg !== "--json" && arg !== "--emit")) throw new Error(JOBS_COMMAND_HELP.usage);
  const now = deps.now?.() ?? new Date();
  const inventory = await (deps.inventory?.() ?? readJobsInventory({ now }));
  const stderr = deps.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  for (const gap of inventory.gaps) stderr(`soma jobs: inventory gap: ${gap}`);
  if (args.includes("--emit")) {
    const env = deps.env ?? process.env;
    if (!env.SOMA_PRINCIPAL) stderr("soma jobs: SOMA_PRINCIPAL unset; nothing published");
    else {
      const { publishRunFinished } = await import("../flows/index");
      const seen = new Set<string>();
      for (const row of inventory.rows) {
        if (row.status === "unknown" || seen.has(row.label)) continue;
        seen.add(row.label);
        const result = await publishRunFinished({
          kind: "job", ref: `job:${row.label}`, runId: randomUUID(),
          outcome: row.status === "ok" ? "succeeded" : "failed",
          startedAt: now.toISOString(), endedAt: now.toISOString(),
          serves: {},
        }, { somaHome: deps.somaHome ?? defaultSomaHome(), substrate: "custom", env, publish: deps.publishRunFinished });
        stderr(`soma jobs: job:${row.label}: ${result}`);
      }
    }
  }
  return args.includes("--json") ? JSON.stringify(inventory.rows, null, 2) : renderRows(inventory.rows);
}
