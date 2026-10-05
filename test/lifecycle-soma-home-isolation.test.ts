import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { expect, test } from "bun:test";
import { bootstrapSomaHome, serializeMemoryNote, type SomaMemoryNote } from "../src/index";
import { resolveLifecycleHomeDir, SCRATCH_SUBSTRATE_HOME_DIRNAME } from "../src/lifecycle";
import { memoryNotePath, type WritableType } from "../src/memory-write";

// node #614: `--soma-home <scratch>` reads as "this invocation is sandboxed", but
// substrate homes used to resolve against `os.homedir()` regardless, so a
// scratch lifecycle run overwrote the operator's live projection. These tests run
// the real CLI in a subprocess with HOME pointed at a fake home, so the "real
// home" is observable without touching the operator's.

const repoRoot = resolve(import.meta.dir, "..");

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "soma-lifecycle-isolation-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => !entry.isDirectory()).map((entry) => join(entry.parentPath, entry.name));
}

// A non-empty memory index is what makes session-start project a substrate
// file at all — with an empty one the reproject no-ops and isolation is untested.
async function seedScratchSomaHome(somaHome: string): Promise<void> {
  await bootstrapSomaHome({ somaHome });
  const n: SomaMemoryNote = {
    id: "isolation-fact",
    type: "semantic",
    created: "2026-07-01",
    last_verified: "2026-07-01",
    valid_until: null,
    provenance: "conversation",
    trust: "principal",
    source_of_truth: null,
    project: null,
    links: [],
    resurface_count: 0,
    body: "the gateway retries thrice",
  };
  const path = memoryNotePath(somaHome, n.type as WritableType, n.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeMemoryNote(n), "utf8");
}

function runLifecycle(fakeHome: string, args: string[]): void {
  // Bun's own transpiler cache lives under HOME; it is not Soma's write, so keep
  // it out of the fake home rather than filter it from the assertions.
  const env: Record<string, string | undefined> = { ...process.env, HOME: fakeHome, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  delete env.SOMA_HOME;
  const result = spawnSync(process.execPath, ["src/cli.ts", "lifecycle", "session-start", "--substrate", "claude-code", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`soma lifecycle exited ${result.status}: ${result.stderr}`);
}

test("lifecycle session-start with a scratch --soma-home writes nothing outside it", async () => {
  await withTempRoot(async (root) => {
    const fakeHome = join(root, "home");
    const scratch = join(root, "scratch-soma");
    await mkdir(fakeHome, { recursive: true });
    await seedScratchSomaHome(scratch);

    runLifecycle(fakeHome, ["--soma-home", scratch]);

    expect(await listFiles(fakeHome)).toEqual([]);
    for (const file of await listFiles(root)) {
      expect(relative(scratch, file).startsWith("..")).toBe(false);
    }
    // The projection still happened — just inside the scratch tree.
    const projected = join(scratch, SCRATCH_SUBSTRATE_HOME_DIRNAME, ".claude", "rules", "soma", "MEMORY.md");
    expect((await stat(projected)).isFile()).toBe(true);
  });
}, 120_000);

test("lifecycle with the default soma home still projects into the real substrate home (live hook contract)", async () => {
  await withTempRoot(async (root) => {
    const fakeHome = join(root, "home");
    const somaHome = join(fakeHome, ".soma");
    await seedScratchSomaHome(somaHome);

    // Every substrate hook passes `--soma-home ~/.soma` without `--home-dir`.
    runLifecycle(fakeHome, ["--soma-home", somaHome]);

    const projected = join(fakeHome, ".claude", "rules", "soma", "MEMORY.md");
    expect((await stat(projected)).isFile()).toBe(true);
    await expect(stat(join(somaHome, SCRATCH_SUBSTRATE_HOME_DIRNAME))).rejects.toThrow();
  });
}, 120_000);

test("an explicit --home-dir wins over the derived scratch substrate home", async () => {
  await withTempRoot(async (root) => {
    const fakeHome = join(root, "home");
    const target = join(root, "target-home");
    const scratch = join(root, "scratch-soma");
    await mkdir(fakeHome, { recursive: true });
    await seedScratchSomaHome(scratch);

    runLifecycle(fakeHome, ["--soma-home", scratch, "--home-dir", target]);

    expect(await listFiles(fakeHome)).toEqual([]);
    const projected = join(target, ".claude", "rules", "soma", "MEMORY.md");
    expect((await stat(projected)).isFile()).toBe(true);
  });
}, 120_000);

test("resolveLifecycleHomeDir derives only for a non-default soma home without a home dir", () => {
  expect(resolveLifecycleHomeDir({})).toBeUndefined();
  expect(resolveLifecycleHomeDir({ somaHome: join(homedir(), ".soma") })).toBeUndefined();
  expect(resolveLifecycleHomeDir({ homeDir: "/x" })).toBe("/x");
  expect(resolveLifecycleHomeDir({ somaHome: "/scratch/soma", homeDir: "/x" })).toBe("/x");
  expect(resolveLifecycleHomeDir({ somaHome: "/scratch/soma" })).toBe(join("/scratch/soma", SCRATCH_SUBSTRATE_HOME_DIRNAME));
});
