import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

const launcher = new URL("../src/cli-launcher.ts", import.meta.url).pathname;

test("Arc launcher executes the active CLI snapshot and fails closed without one", async () => {
  const home = await mkdtemp(join(tmpdir(), "soma-cli-launcher-"));
  try {
    const env = { ...process.env, SOMA_HOME: home };
    const missing = spawnSync(process.execPath, [launcher, "graph", "node", "1"], { env, encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("CLI runtime is missing");

    const entryDir = join(home, "runtime", "cli", "current", "src");
    await mkdir(entryDir, { recursive: true });
    await writeFile(join(entryDir, "cli.ts"), "console.log('FROZEN CLI');\n");
    const active = spawnSync(process.execPath, [launcher, "--version"], { env, encoding: "utf8" });
    expect(active.status).toBe(0);
    expect(active.stdout).toContain("FROZEN CLI");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
