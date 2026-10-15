#!/usr/bin/env bun
/**
 * Lint suppressions may only shrink.
 *
 * ESLint bulk suppressions grandfather lint errors that predate a rule, and
 * ESLint itself fails when a suppressed error goes away without the file being
 * pruned. Nothing in ESLint stops the other direction: `--suppress-rule`
 * silences a new violation as easily as an old one, and so does an inline
 * `eslint-disable` comment. This check counts both, per file and rule, and
 * fails when a count grew against the Git base:
 *
 * - `eslint-suppressions.json` entries, every rule;
 * - inline `eslint-disable`, `-line` and `-next-line` directives in `src/` that
 *   name a ratcheted rule (`RATCHETED_RULES`), counted as `inline:<rule>`;
 * - bare inline directives in `src/`, which disable every rule, counted as
 *   `inline:all-rules`.
 *
 * Fixing a catch in one file does not pay for a new suppression in another. A
 * file Git sees as renamed since the base keeps its base count, so a pure move
 * passes. A new exception is the principal's call: this check fails until the
 * principal accepts it.
 *
 * The base comes from `SOMA_BOUNDARIES_BASE_REF` (set by CI), then the merge
 * base with origin/main, as in `check-boundaries.ts`.
 *
 * Usage: bun scripts/check-suppressions.ts [root]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { readJsonAtBase, repositoryBaseRevision } from "./git-base";

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

/** Rules whose inline disables are ratcheted like their bulk suppressions. */
export const RATCHETED_RULES = ["soma/no-discarded-error"] as const;

const DIRECTIVE = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?(?![\w-])([^\n]*)/g;

/** Inline directives in one file's text, as suppression entries (`inline:<rule>`, `inline:all-rules`). */
export function inlineDirectiveCounts(text: string): Record<string, { count: number }> {
  const counts: Record<string, { count: number }> = {};
  const bump = (key: string) => {
    counts[key] = { count: (key in counts ? counts[key].count : 0) + 1 };
  };
  for (const match of text.matchAll(DIRECTIVE)) {
    const rules = match[1].split(/--|\*\//)[0].split(",").map((rule) => rule.trim()).filter((rule) => rule !== "");
    if (rules.length === 0) bump("inline:all-rules");
    for (const rule of RATCHETED_RULES) if (rules.includes(rule)) bump(`inline:${rule}`);
  }
  return counts;
}

function addInline(target: Suppressions, file: string, text: string): void {
  const counts = inlineDirectiveCounts(text);
  if (Object.keys(counts).length > 0) target[file] = { ...(target[file] ?? {}), ...counts };
}

/** Inline directives in `src/` at HEAD (the working tree). */
async function currentInline(root: string, into: Suppressions): Promise<void> {
  for await (const file of new Glob("src/**/*.{ts,mjs}").scan({ cwd: root })) addInline(into, file, readFileSync(join(root, file), "utf8"));
}

/** Inline directives in `src/` at the Git base: only lines that mention eslint-disable are read. */
function baseInline(root: string, into: Suppressions): void {
  const base = repositoryBaseRevision(root);
  let output = "";
  try {
    output = execFileSync("git", ["grep", "-n", "-e", "eslint-disable", base, "--", "src"], { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if (!(error instanceof Error && "status" in error && error.status === 1)) throw error;
  }
  const byFile = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const rest = line.slice(base.length + 1);
    const match = /^([^:]+\.(?:ts|mjs)):\d+:(.*)$/.exec(rest);
    if (match) byFile.set(match[1], [...(byFile.get(match[1]) ?? []), match[2]]);
  }
  for (const [file, lines] of byFile) addInline(into, file, lines.join("\n"));
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? ".");
  const path = join(root, SUPPRESSIONS_PATH);
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Suppressions) : {};
  // First landing: the base has no suppressions file, so the file is admitted as it is.
  const base = structuredClone((readJsonAtBase(root, SUPPRESSIONS_PATH) as Suppressions | null) ?? current);
  await currentInline(root, current);
  baseInline(root, base);
  const grown = grownSuppressions(current, base, renamesSinceBase(root));
  for (const { file, rule, base: before, current: after } of grown) {
    console.error(`${file}: ${rule} has ${String(after)} suppressed, ${String(before)} at the base. Fix the violation instead of suppressing it; a new exception is the principal's call. See AGENTS.md "Enforced rules".`);
  }
  if (grown.length > 0) process.exit(1);
  console.log("suppressions: no file's suppressed or inline-disabled count grew");
}
