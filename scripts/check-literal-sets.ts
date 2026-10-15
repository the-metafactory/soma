#!/usr/bin/env bun
/**
 * Literal-set check: one list, one owner.
 *
 * Reviews kept flagging the same shape: a string-literal union and an
 * `as const` array (or two unions, or two arrays) spelling the same members
 * by hand, which then drift (GoalStatus vs GOAL_STATUSES, #856; the forge list
 * in #695; the substrate set re-typed per command). This check parses
 * `src/**\/*.ts` and fails when a change adds a hand-written list of three or
 * more string literals that carries the same set as another list, or the same
 * set with one member added or dropped (a copy that has started to drift).
 * A copy that drifted further, or one with a renamed member, is not caught.
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
 * stay: put `// literal-set-allow: <reason>` in the comment directly above the
 * declaration that holds one of the lists, or on the list's own line.
 *
 * Usage: bun scripts/check-literal-sets.ts [root] [--write-baseline]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Glob } from "bun";
import ts from "typescript";
import { readJsonAtBase } from "./git-base";

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

/** The statement or member a list belongs to: its comments are the ones that annotate the list. */
function owningDeclaration(node: ts.Node): ts.Node {
  let current = node;
  while (
    !ts.isSourceFile(current.parent) &&
    !ts.isBlock(current.parent) &&
    !ts.isModuleBlock(current.parent) &&
    !ts.isClassLike(current.parent) &&
    !ts.isInterfaceDeclaration(current.parent) &&
    !ts.isTypeLiteralNode(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

/** The marker sits on the list's own line or in the comments directly before its declaration. */
function allowed(source: ts.SourceFile, node: ts.Node): boolean {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  if (source.text.split("\n")[line]?.includes(ALLOW_MARKER)) return true;
  const comments = ts.getLeadingCommentRanges(source.text, owningDeclaration(node).getFullStart()) ?? [];
  return comments.some((range) => source.text.slice(range.pos, range.end).includes(ALLOW_MARKER));
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

/** Lists that copy each other: the same members, or one member added or dropped. */
export interface CopyGroup {
  /** `a|b|c` for an exact copy; `a|b|c ~ a|b|c|d` for a near copy. */
  key: string;
  lists: LiteralList[];
}

/**
 * Exact copies share a member set. A near copy is one member short of another
 * list (the pre-dsh `"codex" | … | "grok"` beside the six shipped substrates):
 * drift is what makes copies stop matching, so an exact-only check would miss
 * the copies that already went wrong.
 */
export function findCopies(lists: LiteralList[]): CopyGroup[] {
  const bySet = new Map<string, LiteralList[]>();
  for (const list of lists) {
    const key = list.members.join("|");
    bySet.set(key, [...(bySet.get(key) ?? []), list]);
  }
  const groups: CopyGroup[] = [...bySet].filter(([, group]) => group.length > 1).map(([key, group]) => ({ key, lists: group }));
  const sets = [...bySet].map(([key, group]) => ({ key, group, members: new Set(group[0]?.members ?? []) }));
  for (const small of sets) {
    for (const large of sets) {
      if (large.members.size !== small.members.size + 1) continue;
      if (![...small.members].every((member) => large.members.has(member))) continue;
      groups.push({ key: `${small.key} ~ ${large.key}`, lists: [...small.group, ...large.group] });
    }
  }
  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

export async function checkLiteralSets(root: string): Promise<CopyGroup[]> {
  const lists: LiteralList[] = [];
  for await (const path of new Glob("src/**/*.ts").scan({ cwd: root })) {
    const absolute = resolve(root, path);
    lists.push(...collectLiteralLists(relative(root, absolute), readFileSync(absolute, "utf8")));
  }
  return findCopies(lists);
}

/** Known copies: group key → how many hand-written lists it holds. */
export type LiteralSetBaseline = Record<string, number>;

export function baselineOf(copies: CopyGroup[]): LiteralSetBaseline {
  return Object.fromEntries(copies.map((group) => [group.key, group.lists.length] as const));
}

export interface LiteralSetFindings {
  /** A group with more lists than the baseline allows. */
  added: CopyGroup[];
  /** A baseline entry whose copies were removed; the baseline must shrink with them. */
  stale: string[];
  /** A baseline entry raised above the base revision's. */
  raised: string[];
}

export function compareWithBaseline(copies: CopyGroup[], baseline: LiteralSetBaseline, base: LiteralSetBaseline | null): LiteralSetFindings {
  const current = baselineOf(copies);
  const added = copies.filter((group) => group.lists.length > (baseline[group.key] ?? 0));
  const stale = Object.keys(baseline).filter((key) => (current[key] ?? 0) < (baseline[key] ?? 0));
  const raised = base === null ? [] : Object.keys(baseline).filter((key) => (baseline[key] ?? 0) > (base[key] ?? 0));
  return { added, stale, raised };
}

function readBaseline(root: string): LiteralSetBaseline {
  const path = join(root, BASELINE_PATH);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LiteralSetBaseline) : {};
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = resolve(args.find((arg) => !arg.startsWith("--")) ?? ".");
  const copies = await checkLiteralSets(root);
  if (args.includes("--write-baseline")) {
    mkdirSync(dirname(join(root, BASELINE_PATH)), { recursive: true });
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baselineOf(copies), null, 2)}\n`);
    console.log(`literal sets: wrote ${BASELINE_PATH} (${String(copies.length)} known copies)`);
    process.exit(0);
  }
  const { added, stale, raised } = compareWithBaseline(copies, readBaseline(root), readJsonAtBase(root, BASELINE_PATH) as LiteralSetBaseline | null);
  for (const group of added) {
    console.error(`new copy of literal set {${group.key}}:`);
    for (const list of group.lists) console.error(`  ${list.file}:${String(list.line)} (${list.kind})`);
  }
  if (added.length > 0) {
    console.error(
      `\nA hand-written list repeats, or is one member off, a list that already exists. Keep one \`as const\` array and derive the others:\n` +
        "  type X = (typeof XS)[number];   Extract<X, ...> of that type;   XS.filter(...)\n" +
        `A deliberate coincidence takes \`// ${ALLOW_MARKER} <reason>\` above one list. See AGENTS.md "Enforced rules".`,
    );
  }
  for (const key of stale) console.error(`stale baseline entry {${key}}: copies were removed; run \`bun scripts/check-literal-sets.ts --write-baseline\` to shrink ${BASELINE_PATH}`);
  for (const key of raised) console.error(`baseline entry {${key}} grew against the base revision; ${BASELINE_PATH} may only shrink`);
  if (added.length + stale.length + raised.length > 0) process.exit(1);
  console.log(`literal sets: no new copies (${String(copies.length)} known, baselined)`);
}
