import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";
import { bootstrapSomaHome, importAlgorithm, loadSomaHome, planAlgorithmImport } from "../src/index";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-algorithm-import-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writeAlgorithmFixture(homeDir: string): Promise<string> {
  const algorithmDir = join(homeDir, ".claude/PAI/Algorithm");

  await mkdir(algorithmDir, { recursive: true });
  await writeFile(join(algorithmDir, "v6.3.0.md"), "# Algorithm v6.3.0\n\nDoctrine.\n", "utf8");

  return algorithmDir;
}

test("plans an Algorithm import without writing files", async () => {
  await withTempHome(async (homeDir) => {
    const algorithmDir = await writeAlgorithmFixture(homeDir);
    const plan = planAlgorithmImport({ homeDir });

    expect(plan.apply).toBe(false);
    expect(plan.paiAlgorithmDir).toBe(algorithmDir);
    expect(plan.targetFiles).toContain(join(homeDir, ".soma/skills/the-algorithm/SKILL.md"));
    await expect(stat(join(homeDir, ".soma"))).rejects.toThrow();
  });
});

test("imports Algorithm doctrine as a portable Soma skill", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await writeAlgorithmFixture(homeDir);
    const result = await importAlgorithm({ homeDir });

    expect(result.files).toContain(join(homeDir, ".soma/skills/the-algorithm/SKILL.md"));
    await expect(readFile(join(homeDir, ".soma/skills/the-algorithm/SKILL.md"), "utf8")).resolves.toContain(
      'description: "Use when work should run through the PAI Algorithm:',
    );
    await expect(readFile(join(homeDir, ".soma/skills/the-algorithm/Workflows/RunAlgorithm.md"), "utf8")).resolves.toContain(
      "Create a harness run",
    );

    const context = await loadSomaHome(join(homeDir, ".soma"));
    expect(context.profile.skills.some((skill) => skill.name === "the-algorithm")).toBe(true);
  });
});

test("cli dry-runs and applies the Algorithm importer", async () => {
  await withTempHome(async (homeDir) => {
    await writeAlgorithmFixture(homeDir);
    const dryRun = await runSomaCli(["import", "algorithm", "--home-dir", homeDir]);

    expect(dryRun).toContain("Soma Algorithm import plan");
    expect(dryRun).toContain(join(homeDir, ".soma/skills/the-algorithm/SKILL.md"));

    const output = await runSomaCli(["import", "algorithm", "--apply", "--home-dir", homeDir]);

    expect(output).toContain("Soma Algorithm import applied");
    await expect(readFile(join(homeDir, ".soma/skills/the-algorithm/references/algorithm-v6.3.0.md"), "utf8")).resolves.toContain(
      "Doctrine.",
    );
  });
});
