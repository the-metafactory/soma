#!/usr/bin/env bun
/**
 * Literal-set check: one list, one owner.
 *
 * Reviews kept flagging the same shape: a string-literal union and an
 * `as const` array (or two unions, or two arrays) spelling the same members
 * by hand, which then drift (GoalStatus vs GOAL_STATUSES, #856; the forge list
 * in #695; the substrate set re-typed per command). This check parses
 * `src/**\/*.ts` and fails when a change adds a hand-written list that carries
 * the same set of three or more string literals as another.
 *
 * Counted lists:
 * - a union type whose members are all string literals (also inside
 *   `Extract<…>` and other type arguments), except property selections in
 *   `Pick` / `Omit` / `T[…]`;
 * - an array literal of string literals under `as const`, or passed to
 *   `new Set(…)`.
 *
 * Copies that predate the check live in `scripts/literal-sets/baseline.json`,
 * which may only shrink: a new copy fails, a removed copy fails until the
 * baseline is rewritten (`--write-baseline`), and an entry raised against the
 * Git base fails. The base comes from `SOMA_BOUNDARIES_BASE_REF` (set by CI),
 * then the merge base with origin/main, as in `check-boundaries.ts`.
 *
 * Fix: keep one `as const` array and derive the rest —
 * `type X = (typeof XS)[number]`, `Extract<X, …>` of a derived union, or
 * `XS.filter(…)`. A derived type is not a literal list, so it is not counted.
 *
 * A deliberate coincidence (two unrelated concepts that share members) may
 * stay: put `// literal-set-allow: <reason>` on the line above one of the two
 * lists.
 *
 * Usage: bun scripts/check-literal-sets.ts [root] [--write-baseline]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Glob } from "bun";
import ts from "typescript";
import { repositoryBaseRevision } from "./check-boundaries";

export interface LiteralList {
  file: string;
  line: number;
  kind: "union" | "array";
  members: string[];
}

const ALLOW_MARKER = "literal-set-allow:";
export const BASELINE_PATH = "scripts/literal-sets/baseline.json";
/**
 * Two-member pairs (`"pass" | "fail"`, `"file" | "dir"`) recur in unrelated
 * code by coincidence; failing on them would teach agents to paste the allow
 * marker. Three or more shared members is a copy.
 */
const MIN_MEMBERS = 3;

function stringMembersOfUnion(node: ts.UnionTypeNode): string[] | null {
  const members: string[] = [];
  for (const type of node.types) {
    if (!ts.isLiteralTypeNode(type) || !ts.isStringLiteral(type.literal)) return null;
    members.push(type.literal.text);
  }
  return members;
}

function stringMembersOfArray(node: ts.ArrayLiteralExpression): string[] | null {
  const members: string[] = [];
  for (const element of node.elements) {
    if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) return null;
    members.push(element.text);
  }
  return members;
}

/** `Pick<T, "a" | "b">` and `T["a" | "b"]` select properties; they are not value lists. */
function selectsProperties(node: ts.UnionTypeNode): boolean {
  const parent = node.parent;
  if (ts.isIndexedAccessTypeNode(parent)) return parent.indexType === node;
  if (!ts.isTypeReferenceNode(parent)) return false;
  const name = parent.typeName.getText();
  return (name === "Pick" || name === "Omit") && parent.typeArguments?.[1] === node;
}

function isConstAssertion(node: ts.Node): boolean {
  return ts.isAsExpression(node) && ts.isTypeReferenceNode(node.type) && node.type.typeName.getText() === "const";
}

function isCountedArray(node: ts.ArrayLiteralExpression): boolean {
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isSatisfiesExpression(parent)) parent = parent.parent;
  if (isConstAssertion(parent)) return true;
  return ts.isNewExpression(parent) && parent.expression.getText() === "Set" && parent.arguments?.[0] === node;
}

function allowed(source: ts.SourceFile, node: ts.Node): boolean {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  const lines = source.text.split("\n");
  // The marker may sit on the list's own line or on any of the three lines above it
  // (a declaration often starts a line or two before its literal).
  for (let index = Math.max(0, line - 3); index <= line; index += 1) {
    if (lines[index]?.includes(ALLOW_MARKER)) return true;
  }
  return false;
}

export function collectLiteralLists(file: string, text: string): LiteralList[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lists: LiteralList[] = [];
  const visit = (node: ts.Node): void => {
    let members: string[] | null = null;
    let kind: LiteralList["kind"] = "union";
    if (ts.isUnionTypeNode(node) && !ts.isUnionTypeNode(node.parent) && !selectsProperties(node)) {
      members = stringMembersOfUnion(node);
    } else if (ts.isArrayLiteralExpression(node) && isCountedArray(node)) {
      members = stringMembersOfArray(node);
      kind = "array";
    }
    if (members && new Set(members).size >= MIN_MEMBERS && !allowed(source, node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      lists.push({ file, line: line + 1, kind, members: [...new Set(members)].sort() });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lists;
}

export function findDuplicateSets(lists: LiteralList[]): LiteralList[][] {
  const bySet = new Map<string, LiteralList[]>();
  for (const list of lists) {
    const key = JSON.stringify(list.members);
    bySet.set(key, [...(bySet.get(key) ?? []), list]);
  }
  return [...bySet.values()].filter((group) => group.length > 1);
}

export async function checkLiteralSets(root: string): Promise<LiteralList[][]> {
  const lists: LiteralList[] = [];
  for await (const path of new Glob("src/**/*.ts").scan({ cwd: root })) {
    const absolute = resolve(root, path);
    lists.push(...collectLiteralLists(relative(root, absolute), readFileSync(absolute, "utf8")));
  }
  return findDuplicateSets(lists);
}

/** Known copies: member set (joined by `|`) → how many hand-written lists carry it. */
export type LiteralSetBaseline = Record<string, number>;

export function baselineOf(duplicates: LiteralList[][]): LiteralSetBaseline {
  const entries = duplicates.map((group) => [group[0]?.members.join("|") ?? "", group.length] as const);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

export interface LiteralSetFindings {
  /** A set with more copies than the baseline allows. */
  added: LiteralList[][];
  /** A baseline entry whose copies were removed; the baseline must shrink with them. */
  stale: string[];
  /** A baseline entry raised above the base revision's. */
  raised: string[];
}

export function compareWithBaseline(duplicates: LiteralList[][], baseline: LiteralSetBaseline, base: LiteralSetBaseline | null): LiteralSetFindings {
  const current = baselineOf(duplicates);
  const added = duplicates.filter((group) => group.length > (baseline[group[0]?.members.join("|") ?? ""] ?? 0));
  const stale = Object.keys(baseline).filter((key) => (current[key] ?? 0) < (baseline[key] ?? 0));
  const raised = base === null ? [] : Object.keys(baseline).filter((key) => (baseline[key] ?? 0) > (base[key] ?? 0));
  return { added, stale, raised };
}

function readBaseline(root: string): LiteralSetBaseline {
  const path = join(root, BASELINE_PATH);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LiteralSetBaseline) : {};
}

/** The baseline at the Git base, or null on first landing (no baseline there yet). */
function readBaseBaseline(root: string): LiteralSetBaseline | null {
  try {
    const text = execFileSync("git", ["show", `${repositoryBaseRevision(root)}:${BASELINE_PATH}`], { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return JSON.parse(text) as LiteralSetBaseline;
  } catch (error) {
    if (error instanceof Error && /does not exist|exists on disk, but not in/.test(error.message)) return null;
    throw error;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = resolve(args.find((arg) => !arg.startsWith("--")) ?? ".");
  const duplicates = await checkLiteralSets(root);
  if (args.includes("--write-baseline")) {
    mkdirSync(dirname(join(root, BASELINE_PATH)), { recursive: true });
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baselineOf(duplicates), null, 2)}\n`);
    console.log(`literal sets: wrote ${BASELINE_PATH} (${String(duplicates.length)} known copies)`);
    process.exit(0);
  }
  const { added, stale, raised } = compareWithBaseline(duplicates, readBaseline(root), readBaseBaseline(root));
  for (const group of added) {
    console.error(`new copy of literal set {${group[0]?.members.join(", ") ?? ""}}:`);
    for (const list of group) console.error(`  ${list.file}:${String(list.line)} (${list.kind})`);
  }
  if (added.length > 0) {
    console.error(
      `\nA hand-written list repeats one that already exists. Keep one \`as const\` array and derive the others:\n` +
        "  type X = (typeof XS)[number];   Extract<X, ...> of that type;   XS.filter(...)\n" +
        `A deliberate coincidence takes \`// ${ALLOW_MARKER} <reason>\` above one list. See AGENTS.md "Enforced rules".`,
    );
  }
  for (const key of stale) console.error(`stale baseline entry {${key}}: copies were removed; run \`bun scripts/check-literal-sets.ts --write-baseline\` to shrink ${BASELINE_PATH}`);
  for (const key of raised) console.error(`baseline entry {${key}} grew against the base revision; ${BASELINE_PATH} may only shrink`);
  if (added.length + stale.length + raised.length > 0) process.exit(1);
  console.log(`literal sets: no new copies (${String(duplicates.length)} known, baselined)`);
}
