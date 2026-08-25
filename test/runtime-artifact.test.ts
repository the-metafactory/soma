import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectRuntimeArtifact, readRuntimeArtifactState, rollbackRuntimeArtifact, stageRuntimeArtifact } from "../src/runtime-artifact";
import { runSomaCli } from "../src/cli";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<{ root: string; source: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "soma-runtime-artifact-")); roots.push(root);
  const source = join(root, "source"); const home = join(root, "home");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "cli.ts"), "export const cli = true;\n");
  await writeFile(join(source, "package.json"), "{}\n");
  return { root, source, home };
}
test("stages an immutable source-complete artifact and atomically activates it", async () => {
  const { source, home } = await fixture();
  const staged = await stageRuntimeArtifact({ somaHome: home, sourceRoot: source });
  expect(await readFile(join(staged.path, "src", "cli.ts"), "utf8")).toContain("cli = true");
  expect((await readRuntimeArtifactState(home))?.active).toBe(staged.hash);
  expect(await readFile(join(home, "runtime/current/src/cli.ts"), "utf8")).toContain("cli = true");
});
test("retains and explicitly rolls back to the predecessor", async () => {
  const { source, home } = await fixture();
  const first = await stageRuntimeArtifact({ somaHome: home, sourceRoot: source });
  await writeFile(join(source, "src", "cli.ts"), "export const cli = false;\n");
  const second = await stageRuntimeArtifact({ somaHome: home, sourceRoot: source });
  expect(second.previous).toBe(first.hash);
  expect((await rollbackRuntimeArtifact(home)).active).toBe(first.hash);
  expect(await runSomaCli(["runtime", "rollback", "--soma-home", home])).toContain(second.hash);
});

test("reports missing and unloadable active artifacts", async () => {
  const { source, home } = await fixture();
  expect((await inspectRuntimeArtifact(home)).status).toBe("missing-state");
  const staged = await stageRuntimeArtifact({ somaHome: home, sourceRoot: source });
  await writeFile(join(staged.path, "src", "cli.ts"), "this is not valid TypeScript");
  expect((await inspectRuntimeArtifact(home)).status).toBe("unloadable");
});

test("detects and replaces valid-TypeScript artifact tampering", async () => {
  const { source, home } = await fixture();
  const staged = await stageRuntimeArtifact({ somaHome: home, sourceRoot: source });
  await writeFile(join(staged.path, "src", "cli.ts"), "export const cli = false;\n");
  expect((await inspectRuntimeArtifact(home)).status).toBe("unloadable");

  const restored = await stageRuntimeArtifact({ somaHome: home, sourceRoot: source });
  expect(restored.hash).toBe(staged.hash);
  expect(await readFile(join(restored.path, "src", "cli.ts"), "utf8")).toContain("cli = true");
  expect((await inspectRuntimeArtifact(home)).status).toBe("ready");
});
