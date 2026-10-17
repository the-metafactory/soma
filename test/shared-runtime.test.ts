/**
 * The shared staged runtime fixture (node #929): real-runtime installs into
 * fresh homes reuse one staged artifact per process, other sources keep a
 * private store, and a tampered shared payload is re-staged, never reused.
 */
import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeArtifactActivePath } from "../src/substrates/runtime-artifact";
import { installSomaForCodex } from "./fixtures/shared-runtime";
import { STUB_RUNTIME_SOURCE } from "./fixtures/stub-runtime";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "soma-shared-runtime-test-"));
  homes.push(home);
  return home;
}

const storeOf = (homeDir: string): string => join(homeDir, ".soma", "runtime", "artifacts");

test("real-runtime installs into fresh homes activate one shared staged artifact", async () => {
  const first = await freshHome();
  const second = await freshHome();
  await installSomaForCodex({ homeDir: first });
  const staged = await stat(await realpath(runtimeArtifactActivePath(join(first, ".soma"), "codex")));
  await installSomaForCodex({ homeDir: second });
  // Re-staging renames a fresh copy into place; the same inode means the second install reused it.
  expect((await stat(await realpath(runtimeArtifactActivePath(join(second, ".soma"), "codex")))).ino).toBe(staged.ino);

  expect((await lstat(storeOf(first))).isSymbolicLink()).toBe(true);
  expect(await readlink(storeOf(first))).toBe(await readlink(storeOf(second)));
  const active = await realpath(runtimeArtifactActivePath(join(first, ".soma"), "codex"));
  expect(await realpath(runtimeArtifactActivePath(join(second, ".soma"), "codex"))).toBe(active);
  // Each home keeps its own activation pointer and state.
  expect((await lstat(join(first, ".soma", "runtime", "codex", "current"))).isSymbolicLink()).toBe(true);
  expect((await lstat(join(second, ".soma", "runtime", "codex", "active.json"))).isFile()).toBe(true);
}, 120_000);

test("an install from another runtime source keeps a private store", async () => {
  const home = await freshHome();
  await installSomaForCodex({ homeDir: home, runtimeSourceRoot: STUB_RUNTIME_SOURCE });

  const store = await lstat(storeOf(home));
  expect(store.isSymbolicLink()).toBe(false);
  expect(store.isDirectory()).toBe(true);
}, 120_000);

test("a tampered shared payload is re-staged by the next install, not reused", async () => {
  const first = await freshHome();
  await installSomaForCodex({ homeDir: first });
  const entry = join(runtimeArtifactActivePath(join(first, ".soma"), "codex"), "src", "cli.ts");
  const original = await readFile(entry, "utf8");
  await chmod(entry, 0o644);
  await writeFile(entry, "export const tampered = true;\n");

  const second = await freshHome();
  await installSomaForCodex({ homeDir: second });
  expect(await readFile(join(runtimeArtifactActivePath(join(second, ".soma"), "codex"), "src", "cli.ts"), "utf8")).toBe(original);
}, 180_000);
