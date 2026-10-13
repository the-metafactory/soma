import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GOAL_STATUSES } from "./goal-records";
import type { GoalRecord } from "./types";

export const GOAL_ID_PATTERN = /^G\d+$/;

/** Advisory reference checks need only IDs and status, never private goal wording. */
export interface ServesOptions {
  somaHome?: string;
  goalStatus?: (id: string) => GoalRecord["status"] | undefined;
  warn?: (message: string) => void;
}

/** A synchronous status probe keeps the VSA parser's existing synchronous API. */
export function readGoalStatus(id: string, somaHome = process.env.SOMA_HOME ?? join(homedir(), ".soma")): GoalRecord["status"] | undefined {
  if (!GOAL_ID_PATTERN.test(id)) return undefined;
  const content = readFileSync(join(somaHome, "profile", "goals", `${id}.md`), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if (frontmatter === undefined) return undefined;
  const raw: unknown = Bun.YAML.parse(frontmatter);
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  return record.id === id && (GOAL_STATUSES as readonly unknown[]).includes(record.status)
    ? record.status as GoalRecord["status"] : undefined;
}

/** D10: goal state warns once, never gates the work or publishes goal wording. */
export function warnServes(id: string, options: ServesOptions = {}): void {
  const warn = options.warn ?? ((message: string) => { console.warn(message); });
  if (!GOAL_ID_PATTERN.test(id)) {
    warn(`soma: serves ${id}: malformed goal id; expected G<n>`);
    return;
  }
  let status: GoalRecord["status"] | undefined;
  try {
    status = options.goalStatus ? options.goalStatus(id) : readGoalStatus(id, options.somaHome);
  } catch {
    // Missing, unreadable or malformed records are advisory too. Do not echo
    // parser errors: they can contain private bytes from the goal file.
    status = undefined;
  }
  if (status === "active") return;
  warn(status === undefined
    ? `soma: serves ${id}: unknown goal id (no readable goal record)`
    : `soma: serves ${id}: goal is ${status}, not active`);
}
