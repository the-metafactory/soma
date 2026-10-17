/**
 * The stub runtime fixture (node #914). Tests that install a substrate but
 * assert nothing about the staged runtime pass `runtimeSourceRoot:
 * STUB_RUNTIME_SOURCE`, so each install stages two files instead of the real
 * ~2,300-file tree. These rows prove the stub is a runtime staging accepts
 * and loads, and that the seam moves the runtime source only: bundled skills
 * still come from the real repo.
 */
import { expect, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSomaCli } from "../src/cli";
import { installSomaForCodex } from "../src/index";
import { inspectRuntimeArtifact, stageRuntimeArtifact } from "../src/substrates/runtime-artifact";
import { STUB_RUNTIME, STUB_RUNTIME_SOURCE } from "./fixtures/stub-runtime";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "soma-stub-runtime-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("the stub runtime stages, passes the load check and inspects as ready", async () => {
  await withHome(async (home) => {
    const somaHome = join(home, ".soma");
    const staged = await stageRuntimeArtifact({ somaHome, target: "codex", sourceRoot: STUB_RUNTIME_SOURCE });
    expect(JSON.parse(await readFile(join(staged.path, "package.json"), "utf8")).name).toBe("soma-stub-runtime");
    expect((await readdir(join(staged.path, "src"))).sort()).toEqual(["cli.ts"]);
    // load: true re-runs the load check against the sealed artifact.
    expect((await inspectRuntimeArtifact(somaHome, "codex", { load: true })).status).toBe("ready");
  });
});

test("runtimeSourceRoot moves the staged runtime only; bundled skills still come from the real repo", async () => {
  await withHome(async (homeDir) => {
    const result = await installSomaForCodex({ homeDir, runtimeSourceRoot: STUB_RUNTIME_SOURCE });
    expect(result.runtimeArtifact).toBeDefined();
    const artifactManifest = JSON.parse(await readFile(join(result.runtimeArtifact!.path, "package.json"), "utf8"));
    expect(artifactManifest.name).toBe("soma-stub-runtime");
    // The CLI runtime target is staged from the same stub source.
    const cliManifest = JSON.parse(await readFile(join(homeDir, ".soma", "runtime", "cli", "current", "package.json"), "utf8"));
    expect(cliManifest.name).toBe("soma-stub-runtime");
    // Bundled skills are read from the real repo, not the stub (which has no src/skills).
    const homeSkills = await readdir(join(homeDir, ".soma", "skills"));
    expect(homeSkills).toContain("the-algorithm");
    expect(homeSkills).toContain("VSA");
  });
});

test("an in-process CLI install takes the runtime source as an internal seam, not from argv", async () => {
  await withHome(async (homeDir) => {
    await runSomaCli(["install", "codex", "--apply", "--home-dir", homeDir], STUB_RUNTIME);
    const manifest = JSON.parse(await readFile(join(homeDir, ".soma", "runtime", "codex", "current", "package.json"), "utf8"));
    expect(manifest.name).toBe("soma-stub-runtime");
    expect(await readdir(join(homeDir, ".soma", "skills"))).toContain("the-algorithm");
    // No flag spells the seam: argv cannot redirect the runtime source.
    await expect(runSomaCli(["install", "codex", "--apply", "--home-dir", homeDir, "--runtime-source-root", STUB_RUNTIME_SOURCE])).rejects.toThrow("Unknown option: --runtime-source-root");
  });
});
