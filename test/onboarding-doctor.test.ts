import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { planSomaInit, diagnoseSomaDoctor } from "../src/onboarding";
import { runSomaCli } from "../src/cli";
import { withTempHome as withSharedTempHome } from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-onboarding-");

async function writeMinimalPaiInstall(homeDir: string): Promise<void> {
  await mkdir(join(homeDir, ".claude/PAI/USER"), { recursive: true });
  await mkdir(join(homeDir, ".claude/PAI/Algorithm"), { recursive: true });
  await mkdir(join(homeDir, ".claude/skills/Portable"), { recursive: true });
  await mkdir(join(homeDir, ".config/pai/CORE_USER"), { recursive: true });
  await mkdir(join(homeDir, ".claude/PAI/USER/TELOS"), { recursive: true });
  await writeFile(join(homeDir, ".claude/PAI/USER/PRINCIPAL_IDENTITY.md"), "Name: Principal\n", "utf8");
  await writeFile(join(homeDir, ".claude/PAI/USER/DA_IDENTITY.md"), "Name: Soma\n", "utf8");
  await writeFile(join(homeDir, ".claude/PAI/USER/TELOS/MISSION.md"), "Mission: Keep context portable.\n", "utf8");
  await writeFile(join(homeDir, ".claude/PAI/USER/TELOS/GOALS.md"), "- Migrate safely.\n", "utf8");
  await writeFile(join(homeDir, ".claude/PAI/USER/TELOS/BELIEFS.md"), "- Portability matters.\n", "utf8");
  await writeFile(join(homeDir, ".claude/PAI/Algorithm/v6.3.0.md"), "# Algorithm\n", "utf8");
  await writeFile(
    join(homeDir, ".claude/skills/Portable/SKILL.md"),
    "---\nname: Portable\ndescription: Portable test skill\n---\n# Portable\n",
    "utf8",
  );
  await writeFile(join(homeDir, ".config/pai/CORE_USER/profile.md"), "core user\n", "utf8");
}

test("planSomaInit orders PAI migrant commands as dry-run copy-paste steps", async () => {
  await withTempHome(async (homeDir) => {
    await writeMinimalPaiInstall(homeDir);

    const plan = await planSomaInit({ homeDir });

    expect(plan.mode).toBe("dry-run");
    expect(plan.detected.paiInstall).toBe(join(homeDir, ".claude"));
    expect(plan.detected.claudeSkillsDir).toBe(join(homeDir, ".claude/skills"));
    expect(plan.detected.coreUserDir).toBe(join(homeDir, ".config/pai/CORE_USER"));
    expect(plan.soma.starterProfile).toBe(false);
    expect(plan.steps.map((step) => step.id)).toEqual([
      "migrate-claude-skills",
      "migrate-pai",
      "install-codex",
    ]);
    expect(plan.steps.map((step) => step.command)).toEqual([
      `soma migrate claude-skills --from ${join(homeDir, ".claude/skills")} --dry-run --home-dir ${homeDir} --soma-home ${join(homeDir, ".soma")}`,
      `soma migrate pai --pai-install ${join(homeDir, ".claude")} --dry-run --home-dir ${homeDir} --soma-home ${join(homeDir, ".soma")}`,
      `soma install codex --dry-run --home-dir ${homeDir} --soma-home ${join(homeDir, ".soma")}`,
    ]);
  });
});

test("planSomaInit shell-quotes paths in copy-paste commands", async () => {
  await withTempHome(async (root) => {
    const homeDir = join(root, "home with spaces");
    await writeMinimalPaiInstall(homeDir);

    const plan = await planSomaInit({
      homeDir,
      somaHome: join(homeDir, "soma home"),
    });

    expect(plan.steps[0]?.command).toContain(`--from '${join(homeDir, ".claude/skills")}'`);
    expect(plan.steps[0]?.command).toContain(`--home-dir '${homeDir}'`);
    expect(plan.steps[0]?.command).toContain(`--soma-home '${join(homeDir, "soma home")}'`);
  });
});

test("soma init --yes applies detected migration phases", async () => {
  await withTempHome(async (homeDir) => {
    await writeMinimalPaiInstall(homeDir);

    const output = await runSomaCli(["init", "--yes", "--home-dir", homeDir]);

    expect(output).toContain("soma init — applied");
    expect(output).toContain("migrate-claude-skills: applied");
    expect(output).toContain("migrate-pai: applied");
    expect(output).toContain("install-codex: applied");
    await expect(stat(join(homeDir, ".soma/imports/claude-skills/.manifest.json"))).resolves.toBeTruthy();
    await expect(stat(join(homeDir, ".soma/profile/imports/claude/MIGRATION.md"))).resolves.toBeTruthy();
    await expect(stat(join(homeDir, ".codex/rules/soma.rules"))).resolves.toBeTruthy();
  });
});

test("soma doctor reports missing migrations and projection drift actions", async () => {
  await withTempHome(async (homeDir) => {
    await writeMinimalPaiInstall(homeDir);
    await mkdir(join(homeDir, ".soma/profile"), { recursive: true });
    await mkdir(join(homeDir, ".codex/rules"), { recursive: true });
    await writeFile(join(homeDir, ".codex/rules/soma.rules"), "old projection\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(join(homeDir, ".soma/profile/principal.md"), "# Principal\n\n## Profile\n\n- status: starter-profile\n", "utf8");

    const diagnosis = await diagnoseSomaDoctor({ homeDir });
    const output = await runSomaCli(["doctor", "--home-dir", homeDir]);

    expect(diagnosis.status).toBe("drift");
    expect(diagnosis.findings.map((finding) => finding.id)).toEqual([
      "starter-profile",
      "claude-skills-not-migrated",
      "pai-not-migrated",
      "codex-projection-stale",
    ]);
    expect(output).toContain("soma doctor — drift detected");
    expect(output).toContain("soma migrate claude-skills --from");
    expect(output).toContain("soma migrate pai --pai-install");
    expect(output).toContain(`--home-dir ${homeDir}`);
    expect(output).toContain(`--soma-home ${join(homeDir, ".soma")}`);
    expect(output).toContain("soma reproject codex");
  });
});

test("soma doctor reports a missing Codex projection as drift", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".soma/profile"), { recursive: true });
    await writeFile(join(homeDir, ".soma/profile/principal.md"), "# Principal\n\nName: Principal\n", "utf8");

    const diagnosis = await diagnoseSomaDoctor({ homeDir });

    expect(diagnosis.findings).toContainEqual({
      id: "codex-projection-stale",
      severity: "warning",
      message: "Codex projection is missing.",
      action: "soma reproject codex",
    });
  });
});

test("soma doctor surfaces broken Soma profile paths", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".soma"), { recursive: true });
    await writeFile(join(homeDir, ".soma/profile"), "not a directory\n", "utf8");

    await expect(diagnoseSomaDoctor({ homeDir })).rejects.toThrow();
  });
});

test("soma init surfaces broken Soma skills paths", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".soma"), { recursive: true });
    await writeFile(join(homeDir, ".soma/skills"), "not a directory\n", "utf8");

    await expect(planSomaInit({ homeDir })).rejects.toThrow();
  });
});

test("soma init --yes fails when Claude skills migration has refused errors", async () => {
  await withTempHome(async (homeDir) => {
    await writeMinimalPaiInstall(homeDir);
    await mkdir(join(homeDir, ".claude/skills/EmbeddedGit/.git"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude/skills/EmbeddedGit/SKILL.md"),
      "---\nname: EmbeddedGit\ndescription: Bad skill\n---\n# EmbeddedGit\n",
      "utf8",
    );
    await writeFile(join(homeDir, ".claude/skills/EmbeddedGit/.git/config"), "[core]\n", "utf8");

    await expect(runSomaCli(["init", "--yes", "--home-dir", homeDir])).rejects.toThrow(
      "soma init migrate-claude-skills failed",
    );
  });
});

test("soma doctor reports ok after init applies the detected plan", async () => {
  await withTempHome(async (homeDir) => {
    await writeMinimalPaiInstall(homeDir);

    await runSomaCli(["init", "--yes", "--home-dir", homeDir]);
    const output = await runSomaCli(["doctor", "--home-dir", homeDir]);

    expect(output).toContain("soma doctor — ok");
    expect(output).not.toContain("soma migrate claude-skills --from");
    const migration = await readFile(join(homeDir, ".soma/profile/imports/claude/MIGRATION.md"), "utf8");
    expect(migration).toContain("Last migrated at:");
  });
});
