#!/usr/bin/env bun
/**
 * eslint-suppressions.json may only shrink.
 *
 * ESLint bulk suppressions grandfather lint errors that predate a rule, and
 * ESLint itself fails when a suppressed error goes away without the file being
 * pruned. Nothing in ESLint stops the other direction: `--suppress-rule`
 * silences a new violation as easily as an old one. This check compares each
 * rule's total suppressed count with the Git base and fails when it grew.
 * Totals per rule, not per file, so a pure move keeps passing.
 *
 * The base comes from `SOMA_BOUNDARIES_BASE_REF` (set by CI), then the merge
 * base with origin/main, as in `check-boundaries.ts`.
 *
 * Usage: bun scripts/check-suppressions.ts [root]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repositoryBaseRevision } from "./check-boundaries";

export const SUPPRESSIONS_PATH = "eslint-suppressions.json";

export type Suppressions = Record<string, Record<string, { count: number }>>;

export function ruleTotals(suppressions: Suppressions): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const rules of Object.values(suppressions)) {
    for (const [rule, { count }] of Object.entries(rules)) totals[rule] = (totals[rule] ?? 0) + count;
  }
  return totals;
}

/** Rules whose suppressed total is higher than at the base. */
export function grownRules(current: Suppressions, base: Suppressions): { rule: string; base: number; current: number }[] {
  const before = ruleTotals(base);
  return Object.entries(ruleTotals(current))
    .filter(([rule, count]) => count > (before[rule] ?? 0))
    .map(([rule, count]) => ({ rule, base: before[rule] ?? 0, current: count }));
}

function readBase(root: string): Suppressions | null {
  try {
    const text = execFileSync("git", ["show", `${repositoryBaseRevision(root)}:${SUPPRESSIONS_PATH}`], { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return JSON.parse(text) as Suppressions;
  } catch (error) {
    if (error instanceof Error && /does not exist|exists on disk, but not in/.test(error.message)) return null;
    throw error;
  }
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? ".");
  const path = join(root, SUPPRESSIONS_PATH);
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Suppressions) : {};
  const base = readBase(root);
  if (base === null) {
    console.log(`suppressions: no ${SUPPRESSIONS_PATH} at the base; first landing`);
    process.exit(0);
  }
  const grown = grownRules(current, base);
  for (const { rule, base: before, current: after } of grown) {
    console.error(`${rule}: ${String(after)} suppressed, ${String(before)} at the base. Fix the new violation instead of suppressing it; see AGENTS.md "Enforced rules".`);
  }
  if (grown.length > 0) process.exit(1);
  console.log("suppressions: no rule's suppressed total grew");
}
