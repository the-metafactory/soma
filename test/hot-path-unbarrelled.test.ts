import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

// Node #794: the hook hot path (`soma policy inspect|guard`, `soma algorithm
// classify`) must not reach the src/index.ts barrel, which closes over ~200
// modules Bun cannot tree-shake. The closure counts value AND type-only imports
// and follows re-exports, so a type import through the barrel fails here too.

const repoRoot = resolve(import.meta.dir, "..");
const barrel = join(repoRoot, "src/index.ts");
const HOT_PATH_MODULES = ["src/cli/policy.ts", "src/cli/algorithm.ts"];

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  const stem = base.replace(/\.(js|mjs|ts)$/, "");
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, join(base, "index.ts")]) {
    if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

// Breadth-first import closure; returns each reached file mapped to the file
// that first imported it, so a failure can print the chain.
function importClosure(entry: string): Map<string, string | undefined> {
  const parentOf = new Map<string, string | undefined>([[entry, undefined]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName } of importedFiles) {
      const target = resolveRelative(file, fileName);
      if (target === undefined || parentOf.has(target)) continue;
      parentOf.set(target, file);
      queue.push(target);
    }
  }
  return parentOf;
}

function chainTo(parentOf: Map<string, string | undefined>, file: string): string {
  const chain: string[] = [];
  for (let at: string | undefined = file; at !== undefined; at = parentOf.get(at)) {
    chain.unshift(relative(repoRoot, at));
  }
  return chain.join(" -> ");
}

describe("hot-path CLI modules stay off the src/index.ts barrel", () => {
  for (const modulePath of HOT_PATH_MODULES) {
    test(modulePath, () => {
      const closure = importClosure(join(repoRoot, modulePath));
      const reachesBarrel = closure.has(barrel)
        ? `${modulePath} reaches src/index.ts: ${chainTo(closure, barrel)}`
        : undefined;
      expect(reachesBarrel).toBeUndefined();
    });
  }

  test("the closure walker sees a type-only import of the barrel", () => {
    const { importedFiles } = ts.preProcessFile('import type { SomaHome } from "../index";', true, true);
    expect(importedFiles.map((ref) => ref.fileName)).toEqual(["../index"]);
  });
});
