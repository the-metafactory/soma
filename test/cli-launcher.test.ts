import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { stageRuntimeArtifact } from "../src/runtime-artifact";

const launcher = new URL("../src/cli-launcher.ts", import.meta.url).pathname;

test("Arc launcher executes the active CLI snapshot and fails closed without one", async () => {
  const home = await mkdtemp(join(tmpdir(), "soma-cli-launcher-"));
  try {
    const env = { ...process.env, SOMA_HOME: home };
    const missing = spawnSync(process.execPath, [launcher, "graph", "node", "1"], { env, encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("CLI runtime is missing-state");

    const source = join(home, "source");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "package.json"), "{}\n");
    await writeFile(join(source, "src", "cli.ts"), "console.log('FROZEN CLI');\n");
    const staged = await stageRuntimeArtifact({ somaHome: home, substrate: "cli", sourceRoot: source });
    const active = spawnSync(process.execPath, [launcher, "--version"], { env, encoding: "utf8" });
    expect(active.status).toBe(0);
    expect(active.stdout).toContain("FROZEN CLI");

    await chmod(join(staged.path, "src", "cli.ts"), 0o644);
    await writeFile(join(staged.path, "src", "cli.ts"), "console.log('TAMPERED CLI');\n");
    const tampered = spawnSync(process.execPath, [launcher, "graph", "node", "1"], { env, encoding: "utf8" });
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain("CLI runtime is unloadable");
    expect(tampered.stdout).not.toContain("TAMPERED CLI");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
