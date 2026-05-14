import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { importPaiIdentity, loadSomaHome, planPaiImport } from "../src/index";
import { runSomaCli } from "../src/cli";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-pai-import-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writePaiFixture(homeDir: string): Promise<void> {
  const userRoot = join(homeDir, ".claude/PAI/USER");
  await mkdir(join(userRoot, "TELOS"), { recursive: true });

  await writeFile(
    join(userRoot, "PRINCIPAL_IDENTITY.md"),
    [
      "# Principal Identity",
      "",
      "- **Name:** Jens-Christian Fischer",
      "- **Pronunciation:** Yens-Christian",
      "- **Location:** Zurich",
      "- **Timezone:** Europe/Zurich",
      "- **Role:** Security Professional",
      "- **Focus:** AI infrastructure",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(userRoot, "DA_IDENTITY.md"),
    [
      "# DA Identity",
      "",
      "- **Full Name:** Ivy - Personal AI Assistant",
      "- **Name:** Ivy",
      "- **Display Name:** Ivy",
      "- **Color:** #3B82F6",
      "- **Voice ID:** voice-123",
      "- **Role:** Jens-Christian's AI assistant",
      "- **Operating Environment:** Claude Code",
    ].join("\n"),
    "utf8",
  );

  for (const file of ["MISSION.md", "GOALS.md", "STRATEGIES.md", "BELIEFS.md"]) {
    await writeFile(join(userRoot, "TELOS", file), `# ${file}\n\nFixture ${file}\n`, "utf8");
  }
}

test("plans a PAI import without writing files", async () => {
  await withTempHome(async (homeDir) => {
    const plan = planPaiImport({ homeDir });

    expect(plan.sourceFiles).toContain(join(homeDir, ".claude/PAI/USER/PRINCIPAL_IDENTITY.md"));
    expect(plan.targetFiles).toContain(join(homeDir, ".soma/profile/assistant.md"));
    await expect(stat(join(homeDir, ".soma"))).rejects.toThrow();
  });
});

test("imports PAI principal, Ivy identity, and telos into Soma", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);

    const result = await importPaiIdentity({ homeDir });
    const context = await loadSomaHome(result.somaHome);
    const principal = await readFile(join(homeDir, ".soma/profile/principal.md"), "utf8");
    const assistantSource = await readFile(join(homeDir, ".soma/profile/imports/claude/DA_IDENTITY.md"), "utf8");

    expect(context.profile.principal.name).toBe("Jens-Christian Fischer");
    expect(context.profile.principal.preferredName).toBe("Jens-Christian");
    expect(context.profile.assistant.name).toBe("Ivy");
    expect(context.profile.assistant.traits?.voice_id).toBe("voice-123");
    expect(context.profile.telos.goals).toContain("KAI/PAI weiterentwickeln: Context-Portabilität, Presence Layer und proaktive Intelligenz.");
    expect(principal).toContain("source: Claude PAI principal identity");
    expect(assistantSource).toContain("Ivy - Personal AI Assistant");
  });
});

test("cli dry-runs and applies the PAI importer", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);

    const dryRun = await runSomaCli(["import", "pai", "--home-dir", homeDir]);
    expect(dryRun).toContain("Soma PAI import plan");
    await expect(stat(join(homeDir, ".soma"))).rejects.toThrow();

    const applied = await runSomaCli(["import", "pai", "--apply", "--home-dir", homeDir]);
    expect(applied).toContain("Soma PAI import applied");
    await expect(readFile(join(homeDir, ".soma/profile/assistant.md"), "utf8")).resolves.toContain("Name: Ivy");
  });
});
