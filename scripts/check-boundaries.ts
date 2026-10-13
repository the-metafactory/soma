#!/usr/bin/env bun
/**
 * Component boundary check (node #795).
 *
 * Builds the import graph of `src/**\/*.{ts,mjs}` (plus `test/<component>/`)
 * with the TypeScript compiler API and enforces `src/components.ts`:
 *
 * - membership: every `src` file belongs to exactly one component;
 * - direction: a cross-component edge needs the target in `mayImport`;
 * - public entries: into a component that declares them, only those;
 * - units: no edge between two units of one component;
 * - tests: `test/<c>/` may import its own component freely, only public
 *   entries of components that declare them, and never `src/index.ts`.
 *
 * Static imports, `export … from`, literal dynamic `import("…")` and
 * type-only imports all count as edges.
 *
 * Known violations live in `scripts/boundaries/violations.json` and may only
 * shrink: an unlisted violation fails as new, a listed pair that is no longer a
 * violation fails as stale. `scripts/boundaries/closure-baseline.json` caps each
 * component's import-closure size (lines of every reachable `src` file);
 * `--update-baseline` rewrites it so growth becomes a reviewed diff.
 *
 * Usage: bun scripts/check-boundaries.ts [--update-baseline]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import ts from "typescript";
import { components, type ComponentManifest, type ComponentSpec } from "../src/components";

export const VIOLATIONS_PATH = "scripts/boundaries/violations.json";
export const BASELINE_PATH = "scripts/boundaries/closure-baseline.json";

export type EdgeKind = "import" | "type-import" | "re-export" | "dynamic-import";
export type ViolationRule = "direction" | "public-entry" | "unit" | "test-index" | "test-public-entry";

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface Violation {
  key: string;
  from: string;
  to: string;
  fromComponent: string;
  toComponent: string;
  rule: ViolationRule;
  message: string;
}

export interface ClosureDelta {
  component: string;
  baseline: number | undefined;
  actual: number;
}

export interface BoundaryReport {
  ok: boolean;
  errors: string[];
  notes: string[];
  files: string[];
  edges: Edge[];
  unmatched: string[];
  ambiguous: { file: string; components: string[] }[];
  violations: Violation[];
  newViolations: Violation[];
  staleEntries: string[];
  closures: Record<string, number>;
  closureGrowth: ClosureDelta[];
  closureShrink: ClosureDelta[];
  baselineUpdated: boolean;
}

export interface CheckOptions {
  root: string;
  manifest?: ComponentManifest;
  updateBaseline?: boolean;
}

const SOURCE_EXTENSIONS = [".ts", ".mjs"];

function stemOf(file: string): string {
  return file.replace(/(\.d\.ts|\.ts|\.mjs)$/, "");
}

function isSourceFile(name: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function walk(root: string, dir: string, out: string[]): void {
  const abs = join(root, dir);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(root, rel, out);
    else if (entry.isFile() && isSourceFile(entry.name)) out.push(rel);
  }
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

interface CompiledRules {
  matches(stem: string): boolean;
}

function compileRules(include: readonly string[], exclude: readonly string[] = []): CompiledRules {
  const inc = include.map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  return { matches: (stem) => inc.some((re) => re.test(stem)) && !exc.some((re) => re.test(stem)) };
}

function literalText(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

/** Every module specifier the file names, with how it is imported. */
export function collectSpecifiers(fileName: string, text: string): { specifier: string; kind: EdgeKind }[] {
  const kind = fileName.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  const found: { specifier: string; kind: EdgeKind }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier !== undefined) {
        found.push({ specifier, kind: node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ? "type-import" : "import" });
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier !== undefined) found.push({ specifier, kind: node.isTypeOnly ? "type-import" : "re-export" });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literalText(node.moduleReference.expression);
      if (specifier !== undefined) found.push({ specifier, kind: node.isTypeOnly ? "type-import" : "import" });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = literalText(node.arguments[0]);
      if (specifier !== undefined) found.push({ specifier, kind: "dynamic-import" });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = literalText(node.argument.literal);
      if (specifier !== undefined) found.push({ specifier, kind: "type-import" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Resolves a relative specifier to a known `src` file, or undefined. */
function resolveSpecifier(from: string, specifier: string, srcFiles: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = [base, `${base}.ts`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.mjs`];
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`);
  return candidates.find((candidate) => srcFiles.has(candidate));
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return text.endsWith("\n") ? lines : lines + 1;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readViolationList(root: string, errors: string[]): string[] {
  const path = join(root, VIOLATIONS_PATH);
  if (!existsSync(path)) return [];
  const value = readJson(path);
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
    errors.push(`${VIOLATIONS_PATH} must be a JSON array of "<from> -> <to>" strings`);
    return [];
  }
  const sorted = [...new Set(value)].sort();
  if (sorted.length !== value.length || sorted.some((entry, i) => entry !== value[i])) {
    errors.push(`${VIOLATIONS_PATH} must be sorted and free of duplicates`);
  }
  return value;
}

function readBaseline(root: string, errors: string[]): Partial<Record<string, number>> {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return {};
  const value = readJson(path);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.values(value).every((size) => typeof size === "number")
  ) {
    errors.push(`${BASELINE_PATH} must be a JSON object mapping component names to line counts`);
    return {};
  }
  return value;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function checkBoundaries(options: CheckOptions): BoundaryReport {
  const root = resolve(options.root);
  const manifest: ComponentManifest = options.manifest ?? components;
  const names = Object.keys(manifest);
  const errors: string[] = [];
  const notes: string[] = [];

  // Membership.
  const rules = new Map(names.map((name) => [name, compileRules(manifest[name].files, manifest[name].exclude)]));
  const unitRules = new Map<string, [string, CompiledRules][]>(
    names.map((name) => [
      name,
      Object.entries(manifest[name].units ?? {}).map(([unit, spec]): [string, CompiledRules] => [
        unit,
        compileRules(spec.files),
      ]),
    ]),
  );
  const srcList: string[] = [];
  walk(root, "src", srcList);
  srcList.sort();
  const srcFiles = new Set(srcList);
  const owner = new Map<string, string>();
  const unmatched: string[] = [];
  const ambiguous: { file: string; components: string[] }[] = [];
  for (const file of srcList) {
    const stem = stemOf(file);
    const matched = names.filter((name) => rules.get(name)?.matches(stem));
    if (matched.length === 1) owner.set(file, matched[0]);
    else if (matched.length === 0) {
      unmatched.push(file);
      errors.push(`${file} belongs to no component in src/components.ts`);
    } else {
      ambiguous.push({ file, components: matched });
      errors.push(`${file} belongs to more than one component: ${matched.join(", ")}`);
    }
  }
  const unitOf = (file: string): string | undefined => {
    const component = owner.get(file);
    if (component === undefined) return undefined;
    const stem = stemOf(file);
    return unitRules.get(component)?.find(([, unit]) => unit.matches(stem))?.[0];
  };

  // Test files under test/<component>/.
  const testList: string[] = [];
  for (const name of names) {
    const dir = join(root, "test", name);
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(root, `test/${name}`, testList);
  }
  testList.sort();

  // Graph.
  const edges: Edge[] = [];
  const adjacency = new Map<string, Set<string>>();
  const lineCount = new Map<string, number>();
  for (const file of [...srcList, ...testList]) {
    const text = readFileSync(join(root, file), "utf8");
    if (srcFiles.has(file)) lineCount.set(file, countLines(text));
    const seen = new Set<string>();
    for (const { specifier, kind } of collectSpecifiers(file, text)) {
      const to = resolveSpecifier(file, specifier, srcFiles);
      if (to === undefined || to === file || seen.has(to)) continue;
      seen.add(to);
      edges.push({ from: file, to, kind });
      if (srcFiles.has(file)) {
        let targets = adjacency.get(file);
        if (!targets) adjacency.set(file, (targets = new Set()));
        targets.add(to);
      }
    }
  }

  // Rules.
  const isPublic = (spec: ComponentSpec, file: string): boolean =>
    spec.publicEntries === undefined || spec.publicEntries.some((entry) => entry === file || entry === stemOf(file));
  const violations: Violation[] = [];
  const flag = (edge: Edge, fromComponent: string, toComponent: string, rule: ViolationRule, why: string): void => {
    const key = `${edge.from} -> ${edge.to}`;
    violations.push({
      key,
      from: edge.from,
      to: edge.to,
      fromComponent,
      toComponent,
      rule,
      message: `${edge.from} [${fromComponent}] -> ${edge.to} [${toComponent}] (${edge.kind}): ${why}`,
    });
  };
  for (const edge of edges) {
    const toComponent = owner.get(edge.to);
    if (toComponent === undefined) continue;
    const toSpec = manifest[toComponent];
    if (!srcFiles.has(edge.from)) {
      // Test file: test/<component>/...
      const fromComponent = edge.from.split("/")[1];
      if (stemOf(edge.to) === "src/index") {
        flag(edge, `test/${fromComponent}`, toComponent, "test-index", "tests may never import src/index.ts");
      } else if (toComponent !== fromComponent && !isPublic(toSpec, edge.to)) {
        flag(edge, `test/${fromComponent}`, toComponent, "test-public-entry", `not a public entry of ${toComponent}`);
      }
      continue;
    }
    const fromComponent = owner.get(edge.from);
    if (fromComponent === undefined) continue;
    if (fromComponent === toComponent) {
      const fromUnit = unitOf(edge.from);
      const toUnit = unitOf(edge.to);
      if (fromUnit !== undefined && toUnit !== undefined && fromUnit !== toUnit) {
        flag(
          edge,
          `${fromComponent}/${fromUnit}`,
          `${toComponent}/${toUnit}`,
          "unit",
          `unit ${fromUnit} may not import unit ${toUnit}`,
        );
      }
    } else if (!manifest[fromComponent].mayImport.includes(toComponent)) {
      flag(edge, fromComponent, toComponent, "direction", `${fromComponent} may not import ${toComponent}`);
    } else if (!isPublic(toSpec, edge.to)) {
      flag(edge, fromComponent, toComponent, "public-entry", `not a public entry of ${toComponent}`);
    }
  }
  violations.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // Shrink-only known violations.
  const known = readViolationList(root, errors);
  const knownSet = new Set(known);
  const actualKeys = new Set(violations.map((violation) => violation.key));
  const newViolations = violations.filter((violation) => !knownSet.has(violation.key));
  const staleEntries = known.filter((key) => !actualKeys.has(key));
  for (const violation of newViolations) errors.push(`new boundary violation: ${violation.message}`);
  for (const key of staleEntries) {
    errors.push(`stale entry in ${VIOLATIONS_PATH}: "${key}" is no longer a violation; remove it`);
  }

  // Closure baseline.
  const closures: Record<string, number> = {};
  for (const name of names) {
    const visited = new Set<string>();
    const queue = srcList.filter((file) => owner.get(file) === name);
    for (const file of queue) visited.add(file);
    while (queue.length > 0) {
      const next = queue.pop();
      if (next === undefined) break;
      for (const target of adjacency.get(next) ?? []) {
        if (!visited.has(target)) {
          visited.add(target);
          queue.push(target);
        }
      }
    }
    let lines = 0;
    for (const file of visited) lines += lineCount.get(file) ?? 0;
    closures[name] = lines;
  }
  const closureGrowth: ClosureDelta[] = [];
  const closureShrink: ClosureDelta[] = [];
  let baselineUpdated = false;
  if (options.updateBaseline) {
    writeJson(join(root, BASELINE_PATH), closures);
    baselineUpdated = true;
    notes.push(`wrote ${BASELINE_PATH}`);
  } else {
    const baseline = readBaseline(root, errors);
    for (const name of names) {
      const actual = closures[name];
      const limit = baseline[name];
      if (limit === undefined || actual > limit) {
        closureGrowth.push({ component: name, baseline: limit, actual });
        errors.push(
          limit === undefined
            ? `closure of ${name} has no baseline (${actual} lines); run with --update-baseline`
            : `closure of ${name} grew: ${limit} -> ${actual} lines (+${actual - limit}); run with --update-baseline if intended`,
        );
      } else if (actual < limit) {
        closureShrink.push({ component: name, baseline: limit, actual });
        notes.push(`closure of ${name} shrank: ${limit} -> ${actual} lines (-${limit - actual})`);
      }
    }
    for (const name of Object.keys(baseline)) {
      if (!(name in manifest)) errors.push(`stale entry in ${BASELINE_PATH}: ${name} is not a component`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    notes,
    files: srcList,
    edges,
    unmatched,
    ambiguous,
    violations,
    newViolations,
    staleEntries,
    closures,
    closureGrowth,
    closureShrink,
    baselineUpdated,
  };
}

export function formatReport(report: BoundaryReport): string {
  const lines = [
    `boundaries: ${report.files.length} src files, ${report.edges.length} edges, ` +
      `${report.violations.length} violations (${report.newViolations.length} new)`,
    ...report.notes.map((note) => `  note: ${note}`),
    ...report.errors.map((error) => `  error: ${error}`),
    report.ok ? "boundaries: ok" : `boundaries: FAILED (${report.errors.length} errors)`,
  ];
  return lines.join("\n");
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const report = checkBoundaries({ root, updateBaseline: process.argv.includes("--update-baseline") });
  const output = formatReport(report);
  if (report.ok) console.log(output);
  else console.error(output);
  process.exit(report.ok ? 0 : 1);
}
