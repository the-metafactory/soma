import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectRuntimeArtifact, readRuntimeArtifactState, rollbackRuntimeArtifact, stageRuntimeArtifact } from "../src/runtime-artifact";
import { runRuntimeCli } from "../src/cli/runtime";

const roots: string[] = [];
async function makeWritable(path: string): Promise<void> {
  await chmod(path, 0o755).catch(() => undefined);
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await makeWritable(child);
    else await chmod(child, 0o644).catch(() => undefined);
  }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(async root => { await makeWritable(root); await rm(root, { recursive: true, force: true }); })); });
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
  const staged = await stageRuntimeArtifact({ somaHome: home, substrate: "codex", sourceRoot: source });
  expect(await readFile(join(staged.path, "src", "cli.ts"), "utf8")).toContain("cli = true");
  expect((await readRuntimeArtifactState(home, "codex"))?.active).toBe(staged.hash);
  expect(await readFile(join(home, "runtime/codex/current/src/cli.ts"), "utf8")).toContain("cli = true");
});
test("retains and explicitly rolls back the selected substrate predecessor", async () => {
  const { source, home } = await fixture();
  const first = await stageRuntimeArtifact({ somaHome: home, substrate: "codex", sourceRoot: source });
  await writeFile(join(source, "src", "cli.ts"), "export const cli = false;\n");
  const second = await stageRuntimeArtifact({ somaHome: home, substrate: "codex", sourceRoot: source });
  expect(second.previous).toBe(first.hash);
  expect((await rollbackRuntimeArtifact(home, "codex")).active).toBe(first.hash);
  expect(await runRuntimeCli({ command: "runtime", action: "rollback", substrate: "codex", somaHome: home })).toContain(second.hash);
});
test("keeps guarded substrate activations independent", async () => {
  const { source, home } = await fixture();
  const codex = await stageRuntimeArtifact({ somaHome: home, substrate: "codex", sourceRoot: source });
  await writeFile(join(source, "src", "cli.ts"), "export const cli = false;\n");
  const claude = await stageRuntimeArtifact({ somaHome: home, substrate: "claude-code", sourceRoot: source });
  expect(await readFile(join(home, "runtime/codex/current/src/cli.ts"), "utf8")).toContain("cli = true");
  expect(await readFile(join(home, "runtime/claude-code/current/src/cli.ts"), "utf8")).toContain("cli = false");
  expect((await readRuntimeArtifactState(home, "codex"))?.active).toBe(codex.hash);
  expect((await readRuntimeArtifactState(home, "claude-code"))?.active).toBe(claude.hash);
  await expect(rollbackRuntimeArtifact(home, "claude-code")).rejects.toThrow("No previous runtime artifact");
  expect((await readRuntimeArtifactState(home, "codex"))?.active).toBe(codex.hash);
});
test("reports missing and unloadable active artifacts", async () => {
  const { source, home } = await fixture();
  expect((await inspectRuntimeArtifact(home, "codex")).status).toBe("missing-state");
  const staged = await stageRuntimeArtifact({ somaHome: home, substrate: "codex", sourceRoot: source });
  await makeWritable(staged.path);
  await writeFile(join(staged.path, "src", "cli.ts"), "this is not valid TypeScript");
  expect((await inspectRuntimeArtifact(home, "codex")).status).toBe("unloadable");
});
test("detects and replaces valid-TypeScript artifact tampering", async () => {
  const { source, home } = await fixture();
  const staged = await stageRuntimeArtifact({ somaHome: home, substrate: "codex", sourceRoot: source });
  await makeWritable(staged.path);
  await writeFile(join(staged.path, "src", "cli.ts"), "export const cli = false;\n");
  expect((await inspectRuntimeArtifact(home, "codex")).status).toBe("unloadable");
  const restored = await stageRuntimeArtifact({ somaHome: home, substrate: "codex", sourceRoot: source });
  expect(restored.hash).toBe(staged.hash);
  expect(await readFile(join(restored.path, "src", "cli.ts"), "utf8")).toContain("cli = true");
  expect((await inspectRuntimeArtifact(home, "codex")).status).toBe("ready");
});
test("replaces an incomplete existing target on reinstall", async () => {
  const { source, home } = await fixture();
  const staged = await stageRuntimeArtifact({ somaHome: home, substrate: "codex", sourceRoot: source });
  await makeWritable(staged.path);
  await rm(join(staged.path, "package.json"));
  const restored = await stageRuntimeArtifact({ somaHome: home, substrate: "codex", sourceRoot: source });
  expect(restored.hash).toBe(staged.hash);
  expect(await readFile(join(restored.path, "package.json"), "utf8")).toBe("{}\n");
  expect((await inspectRuntimeArtifact(home, "codex")).status).toBe("ready");
});
test("seals artifact directories and payload files read-only", async () => {
  const { source, home } = await fixture();
  await mkdir(join(source, "src", "nested"), { recursive: true });
  await writeFile(join(source, "src", "nested", "extra.ts"), "export const nested = true;\n");
  const staged = await stageRuntimeArtifact({ somaHome: home, substrate: "codex", sourceRoot: source });
  for (const path of [staged.path, join(staged.path, "src"), join(staged.path, "src", "nested"), join(staged.path, "src", "cli.ts"), join(staged.path, "package.json")]) {
    expect((await stat(path)).mode & 0o222).toBe(0);
  }
  expect((await inspectRuntimeArtifact(home, "codex")).status).toBe("ready");
});
test("refuses rollback to a corrupted predecessor and preserves the current pointer", async () => {
  const { source, home } = await fixture();
  const first = await stageRuntimeArtifact({ somaHome: home, substrate: "codex", sourceRoot: source });
  await writeFile(join(source, "src", "cli.ts"), "export const cli = false;\n");
  const second = await stageRuntimeArtifact({ somaHome: home, substrate: "codex", sourceRoot: source });
  await makeWritable(join(home, "runtime", "artifacts", first.hash));
  await writeFile(join(home, "runtime", "artifacts", first.hash, "src", "cli.ts"), "export const cli = 'tampered';\n");
  const before = await readRuntimeArtifactState(home, "codex");
  const current = await readFile(join(home, "runtime/codex/current/src/cli.ts"), "utf8");
  await expect(rollbackRuntimeArtifact(home, "codex")).rejects.toThrow("integrity or load validation");
  expect(await readRuntimeArtifactState(home, "codex")).toEqual(before);
  expect((await readRuntimeArtifactState(home, "codex"))?.active).toBe(second.hash);
  expect(await readFile(join(home, "runtime/codex/current/src/cli.ts"), "utf8")).toBe(current);
});
