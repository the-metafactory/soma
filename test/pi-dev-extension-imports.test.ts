import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectPiDevHome } from "../src/substrates/index";
import { portableProjectionInput } from "./fixtures";

// pi loads its extensions under Node, not Bun: a `bun:` module anywhere in the
// static import graph of a projected extension fails the whole pi session.
const transpiler = new Bun.Transpiler({ loader: "ts" });

function resolveModule(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith("file://") ? fileURLToPath(specifier) : resolve(dirname(from), specifier);
  return [base, `${base}.ts`, resolve(base, "index.ts")].find((candidate) => existsSync(candidate) && candidate.endsWith(".ts"));
}

function bunImports(entries: readonly { from: string; source: string }[]): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const { from, source } = queue.shift() ?? { from: "", source: "" };
    for (const { path, kind } of transpiler.scanImports(source)) {
      if (kind === "dynamic-import") continue;
      if (path === "bun" || path.startsWith("bun:")) found.push(`${from} -> ${path}`);
      if (!path.startsWith(".") && !path.startsWith("file://")) continue;
      const target = resolveModule(from, path);
      if (target === undefined || seen.has(target)) continue;
      seen.add(target);
      queue.push({ from: target, source: readFileSync(target, "utf8") });
    }
  }
  return found;
}

test("projected pi extensions import no Bun-only module, so pi can load them under Node", () => {
  const projection = projectPiDevHome(portableProjectionInput, "/tmp/soma-home", "/tmp/home");
  const extensions = projection.files.filter((file) => file.path.startsWith("agent/extensions/") && file.path.endsWith(".ts"));
  expect(extensions.length).toBeGreaterThan(0);
  expect(bunImports(extensions.map((file) => ({ from: file.path, source: file.content })))).toEqual([]);
});
