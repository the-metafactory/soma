#!/usr/bin/env bun
/**
 * eslint-suppressions.json may only shrink.
 *
 * ESLint bulk suppressions grandfather lint errors that predate a rule, and
 * ESLint itself fails when a suppressed error goes away without the file being
 * pruned. Nothing in ESLint stops the other direction: `--suppress-rule`
 * silences a new violation as easily as an old one. This check compares each
 * file's suppressed count per rule with the Git base and fails when one grew,
 * so fixing a catch in one file does not pay for suppressing a new one in
 * another. A file Git sees as renamed since the base keeps its base count, so
 * a pure move passes; content moved into a file Git does not pair as a rename
 * fails and needs a fix or the principal's approval.
 *
 * The base comes from `SOMA_BOUNDARIES_BASE_REF` (set by CI), then the merge
 * base with origin/main, as in `check-boundaries.ts`.
 *
 * Usage: bun scripts/check-suppressions.ts [root]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonAtBase, repositoryBaseRevision } from "./check-boundaries";

export const SUPPRESSIONS_PATH = "eslint-suppressions.json";

export type Suppressions = Record<string, Record<string, { count: number }>>;

export interface GrownSuppression {
  file: string;
  rule: string;
  base: number;
  current: number;
}

/** Suppressed counts whose file/rule entry is higher than at the base, base paths carried through renames. */
export function grownSuppressions(current: Suppressions, base: Suppressions, renames: ReadonlyMap<string, string> = new Map()): GrownSuppression[] {
  const before = new Map<string, number>();
  for (const [file, rules] of Object.entries(base)) {
    const path = renames.get(file) ?? file;
    for (const [rule, { count }] of Object.entries(rules)) before.set(`${path}\0${rule}`, (before.get(`${path}\0${rule}`) ?? 0) + count);
  }
  const grown: GrownSuppression[] = [];
  for (const [file, rules] of Object.entries(current)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      const baseCount = before.get(`${file}\0${rule}`) ?? 0;
      if (count > baseCount) grown.push({ file, rule, base: baseCount, current: count });
    }
  }
  return grown;
}

/** Renamed paths between the base and HEAD, old → new. */
function renamesSinceBase(root: string): Map<string, string> {
  const output = execFileSync("git", ["diff", "-M", "--name-status", "--diff-filter=R", repositoryBaseRevision(root), "HEAD"], { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const renames = new Map<string, string>();
  for (const line of output.split("\n")) {
    const [status, from, to] = line.split("\t");
    if (status.startsWith("R") && from && to) renames.set(from, to);
  }
  return renames;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? ".");
  const path = join(root, SUPPRESSIONS_PATH);
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Suppressions) : {};
  const base = readJsonAtBase(root, SUPPRESSIONS_PATH) as Suppressions | null;
  if (base === null) {
    console.log(`suppressions: no ${SUPPRESSIONS_PATH} at the base; first landing`);
    process.exit(0);
  }
  const grown = grownSuppressions(current, base, renamesSinceBase(root));
  for (const { file, rule, base: before, current: after } of grown) {
    console.error(`${file}: ${rule} has ${String(after)} suppressed, ${String(before)} at the base. Fix the new violation instead of suppressing it; see AGENTS.md "Enforced rules".`);
  }
  if (grown.length > 0) process.exit(1);
  console.log("suppressions: no file's suppressed count grew");
}
