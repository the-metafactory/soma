import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import ts from "typescript";
import { projectPiDevHome } from "../../src/substrates/adapters/pi-dev/adapter";
import { portableProjectionInput } from "../fixtures";

/**
 * Drift guard for the pi.dev extension import graph (soma#531 follow-up).
 *
 * The generated `~/.pi/agent/extensions/*.ts` modules import this repo's `src/`
 * through `file://` URLs, and pi loads them with **jiti** — not bun. jiti (like
 * node) honours only `type: "json"` import attributes and silently STRIPS the
 * rest. So a bun-only `import x from "./y.mjs" with { type: "text" }` anywhere
 * in the reachable graph does not fail at the import: the target is evaluated as
 * a real ES module. That is exactly how `soma install claude-code`'s hook-asset
 * inlining broke every pi session with
 *
 *     Failed to load extension: __SOMA_CLAUDE_HOOK_EVENT_HANDLERS__ is not defined
 *
 * (`hook-runner.mjs` evaluated as a module, hitting its unreplaced projection
 * placeholder). Nothing in the graph pointed at claude-code deliberately — a
 * `checkSomaPolicy` call reached `install-spec-registry`, which eagerly imports
 * every adapter's installer.
 *
 * The fix was `src/policy/private-roots.ts` + `src/policy/projection-private-roots.ts`;
 * this test is what stops the graph from re-acquiring the syntax by accident.
 */

const REPO_ROOT = resolve(import.meta.dir, "../..");

/**
 * An import statement carrying any attribute other than `type: "json"` — json is
 * the one form both bun and jiti/node implement. Covers the legacy `assert`
 * spelling too. Applied to comment-stripped source, because the modules that
 * document this hazard quote the syntax in prose.
 */
const NON_PORTABLE_IMPORT_ATTRIBUTE =
  /\bimport\b[^;]*?\b(?:with|assert)\s*\{\s*type\s*:\s*["'](?!json["'])([^"']+)["']/gu;


/**
 * Good enough for the attribute scan: block + line comments, no string
 * awareness. `//` preceded by `:` is left alone so the generated extensions'
 * `file://` specifiers survive.
 */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/(^|[^:])\/\/[^\n]*/gmu, "$1");
}

/** Extension-less TS imports are the house style, so resolution has to guess. */
const RESOLUTION_SUFFIXES = ["", ".ts", ".mts", ".mjs", ".js", "/index.ts", "/index.mjs", "/index.js"];

function resolveModule(specifier: string, importerPath: string): string | undefined {
  const base = specifier.startsWith("file://")
    ? fileURLToPath(specifier)
    : specifier.startsWith(".")
      ? resolve(dirname(importerPath), specifier)
      : undefined;
  if (base === undefined) return undefined; // bare specifier: node:*, npm dep — not ours to walk
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    // `""` is tried first for specifiers that already carry an extension, but it
    // also matches a same-named DIRECTORY (`./tools` next to `tools/`) — hence
    // the isFile check rather than a bare existsSync.
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function matchAll(source: string, pattern: RegExp): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  const scanner = new RegExp(pattern.source, pattern.flags);
  let match = scanner.exec(source);
  while (match !== null) {
    matches.push(match);
    match = scanner.exec(source);
  }
  return matches;
}

interface GraphWalk {
  visited: Set<string>;
  /** Offending file -> the import chain that reached it, from the seed root. */
  offenders: Map<string, { attribute: string; chain: string[] }>;
}

/** Pi erases type-only imports; they belong to the static boundary closure, not this runtime graph. */
function moduleSpecifiers(source: string, { includeTypeOnly = false } = {}): string[] {
  const parsed = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, false);
  return parsed.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    if (includeTypeOnly) return [statement.moduleSpecifier.text];
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) return [];
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings) && !statement.importClause?.name &&
          bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)) return [];
    } else {
      if (statement.isTypeOnly) return [];
      if (statement.exportClause && ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.length > 0 && statement.exportClause.elements.every((element) => element.isTypeOnly)) return [];
    }
    return [statement.moduleSpecifier.text];
  });
}

function walkImportGraph(seeds: { label: string; source: string; importerPath: string }[]): GraphWalk {
  const visited = new Set<string>();
  const offenders = new Map<string, { attribute: string; chain: string[] }>();
  const queue: { path: string; source: string; chain: string[] }[] = [];

  for (const seed of seeds) {
    for (const specifier of moduleSpecifiers(seed.source)) {
      const resolved = resolveModule(specifier, seed.importerPath);
      if (resolved !== undefined && !visited.has(resolved)) {
        visited.add(resolved);
        queue.push({ path: resolved, source: readFileSync(resolved, "utf8"), chain: [seed.label] });
      }
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const chain = [...current.chain, relative(REPO_ROOT, current.path)];

    const attribute = matchAll(stripComments(current.source), NON_PORTABLE_IMPORT_ATTRIBUTE)[0]?.[1];
    if (attribute !== undefined) offenders.set(relative(REPO_ROOT, current.path), { attribute, chain });

    for (const specifier of moduleSpecifiers(current.source)) {
      const resolved = resolveModule(specifier, current.path);
      if (resolved === undefined || visited.has(resolved)) continue;
      visited.add(resolved);
      queue.push({ path: resolved, source: readFileSync(resolved, "utf8"), chain });
    }
  }

  return { visited, offenders };
}

function generatedExtensionSeeds(): { label: string; source: string; importerPath: string }[] {
  const bundle = projectPiDevHome(portableProjectionInput, "/tmp/soma-home-import-graph");
  const extensions = bundle.files.filter((file) => /^agent\/extensions\/.+\.ts$/u.test(file.path));
  // The generated modules address the repo by absolute `file://` URL, so the
  // importer path is irrelevant for them — but keep it honest anyway.
  return extensions.map((file) => ({ label: file.path, source: file.content, importerPath: REPO_ROOT }));
}

test("relocated pi.dev projections have resolvable local imports and CLI entrypoints", () => {
  const seeds = generatedExtensionSeeds();
  let localImports = 0;
  let cliEntrypoints = 0;
  for (const seed of seeds) {
    expect(seed.source).not.toContain("src/adapters/");
    for (const specifier of moduleSpecifiers(seed.source, { includeTypeOnly: true })) {
      if (!specifier.startsWith("file://")) continue;
      localImports++;
      expect(isFile(fileURLToPath(specifier))).toBe(true);
    }
    for (const match of seed.source.matchAll(/const SOMA_CLI_ENTRYPOINT = "([^"]+)"/gu)) {
      cliEntrypoints++;
      expect(match[1]).toBe(resolve(REPO_ROOT, "src/cli.ts"));
      expect(isFile(match[1])).toBe(true);
    }
  }
  expect(localImports).toBeGreaterThanOrEqual(8);
  expect(cliEntrypoints).toBeGreaterThan(0);
});

test("the runtime graph erases type-only imports while retaining value imports", () => {
  const target = `file://${REPO_ROOT}/src/substrates/adapters/claude-code/hooks.ts`;
  expect(walkImportGraph([{ label: "type-only", source: `import type { Unused } from "${target}";`, importerPath: REPO_ROOT }]).visited.size).toBe(0);
  expect(walkImportGraph([{ label: "value", source: `import "${target}";`, importerPath: REPO_ROOT }]).offenders.size).toBeGreaterThan(0);
});

test("the generated pi.dev extensions reach at least one real Soma module", () => {
  const seeds = generatedExtensionSeeds();
  expect(seeds.length).toBeGreaterThan(0);

  const { visited } = walkImportGraph(seeds);

  // Vacuity guard: a walk that resolves nothing would pass the real assertion
  // below for the wrong reason.
  expect(visited.size).toBeGreaterThan(10);
  expect([...visited].map((path) => relative(REPO_ROOT, path))).toContain("src/policy/policy-audit.ts");
});

test("no module reachable from a generated pi.dev extension uses a bun-only import attribute", () => {
  const { offenders } = walkImportGraph(generatedExtensionSeeds());

  const report = [...offenders.entries()].map(
    ([path, { attribute, chain }]) => `${path} uses \`type: "${attribute}"\` — reached via ${chain.join(" -> ")}`,
  );

  expect(report).toEqual([]);
});

test("the detector still fires on the import that actually broke pi", () => {
  // Negative control. `install-spec-registry` eagerly imports every adapter's
  // installer, which is how a policy check used to reach the claude-code hook
  // assets. Seeding the walk there must still produce a finding — otherwise the
  // assertion above would be passing because the detector went blind, not
  // because the graph is clean.
  const seed = {
    label: "<synthetic>",
    source: `import "file://${REPO_ROOT}/src/substrates/install-spec-registry.ts";`,
    importerPath: REPO_ROOT,
  };

  const { offenders } = walkImportGraph([seed]);

  expect([...offenders.keys()]).toContain("src/substrates/adapters/claude-code/hooks.ts");
  expect(offenders.get("src/substrates/adapters/claude-code/hooks.ts")?.attribute).toBe("text");
});

test("the claude-code hook assets stay OUT of the pi.dev extension graph", () => {
  // The specific regression: hook-runner.mjs must never be evaluated by jiti.
  const reachable = [...walkImportGraph(generatedExtensionSeeds()).visited].map((path) => relative(REPO_ROOT, path));

  expect(reachable).not.toContain("src/substrates/adapters/claude-code/hooks.ts");
  expect(reachable).not.toContain("src/substrates/adapters/claude-code/hook-runner.mjs");
});

test("generated pi.dev policy extensions reach defining modules without the policy barrel", () => {
  const reachable = [...walkImportGraph(generatedExtensionSeeds()).visited].map((path) => relative(REPO_ROOT, path));

  expect(reachable).toContain("src/policy/policy-path-guard.ts");
  expect(reachable).toContain("src/policy/policy-targets.ts");
  expect(reachable).not.toContain("src/policy/index.ts");
  expect(reachable).not.toContain("src/index.ts");
});
