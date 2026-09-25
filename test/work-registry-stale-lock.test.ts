import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import { bootstrapSomaHome, somaWorkRegistryPaths, upsertSomaWorkRegistryEntry } from "../src/index";

const execFileAsync = promisify(execFile);

async function withTempHome<T>(fn: (homeDir: string, somaHome: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-stale-lock-"));
  const somaHome = join(homeDir, ".soma");
  try {
    await bootstrapSomaHome({ homeDir, somaHome });
    return await fn(homeDir, somaHome);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("ownerless work-registry lock older than the timeout is reclaimed", async () => {
  await withTempHome(async (_homeDir, somaHome) => {
    const lockPath = `${somaWorkRegistryPaths({ somaHome }).work}.lock`;
    await mkdir(lockPath);
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);

    await upsertSomaWorkRegistryEntry({
      somaHome,
      sessionId: "reclaimed",
      substrate: "codex",
      workRegistryLockTimeoutMs: 1_000,
    });

    const registry = JSON.parse(await readFile(somaWorkRegistryPaths({ somaHome }).work, "utf8"));
    expect(Object.values(registry.sessions)).toEqual([
      expect.objectContaining({ sessionUUID: "reclaimed" }),
    ]);
  });
});

test("lifecycle session-start honors the CLI lock timeout when another process holds the lock", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const lockPath = `${somaWorkRegistryPaths({ somaHome }).work}.lock`;
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, hostname: hostname() })}\n`);

    const started = Date.now();
    await execFileAsync(process.execPath, [
      join(import.meta.dir, "../src/cli.ts"), "lifecycle", "session-start",
      "--home-dir", homeDir, "--soma-home", somaHome,
      "--substrate", "codex", "--session-id", "contended",
      "--work-registry-lock-timeout-ms", "1000",
    ], { timeout: 6_000 });
    expect(Date.now() - started).toBeLessThan(6_000);

    const events = (await readFile(join(somaHome, "memory/STATE/events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { kind: string });
    expect(events.some((event) => event.kind === "lifecycle.session_start.registry-write-failed")).toBe(true);
    expect(events.some((event) => event.kind === "lifecycle.session_start")).toBe(true);
  });
}, 10_000);
