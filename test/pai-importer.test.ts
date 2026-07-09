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

  const telosFixtures = [
    { file: "MISSION.md", content: "# Mission\n\nBuild useful test systems without leaking publisher context.\n" },
    { file: "GOALS.md", content: ["# Goals", "", "- Keep imported goals fixture-local.", "- Preserve assistant portability."].join("\n") },
    { file: "STRATEGIES.md", content: ["# Strategies", "", "- Verify projections after import.", "- Keep source snapshots under Soma home."].join("\n") },
    {
      file: "BELIEFS.md",
      content: ["# Beliefs", "", "- Tests should describe the imported fixture.", "- Generated profile summaries must come from selected sources."].join("\n"),
    },
  ];

  for (const fixture of telosFixtures) {
    await writeFile(join(userRoot, "TELOS", fixture.file), fixture.content, "utf8");
  }
}

test("plans a PAI import without writing files", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    const plan = planPaiImport({ homeDir });

    expect(plan.sourceFiles).toContain(join(homeDir, ".claude/PAI/USER/PRINCIPAL_IDENTITY.md"));
    expect(plan.sourceChecks ?? []).toContainEqual({
      path: join(homeDir, ".claude/PAI/USER/PRINCIPAL_IDENTITY.md"),
      required: true,
      present: true,
    });
    expect(plan.targetFiles).toContain(join(homeDir, ".soma/profile/assistant.md"));
    await expect(stat(join(homeDir, ".soma"))).rejects.toThrow();
  });
});

test("imports PAI v4 identity filename variants", async () => {
  await withTempHome(async (homeDir) => {
    const userRoot = join(homeDir, ".claude/PAI/USER");
    await mkdir(join(userRoot, "TELOS"), { recursive: true });
    await writeFile(join(userRoot, "BASICINFO.md"), "Name: Andreas Example\n", "utf8");
    await writeFile(join(userRoot, "DAIDENTITY.md"), ["# DA Identity", "", "- **Name:** Ada", "- **Display Name:** Ada"].join("\n"), "utf8");
    for (const file of ["MISSION.md", "GOALS.md", "BELIEFS.md"]) {
      await writeFile(join(userRoot, "TELOS", file), `# ${file}\n\nFixture ${file}\n`, "utf8");
    }

    const plan = planPaiImport({ homeDir });
    expect(plan.sourceFiles).toContain(join(userRoot, "BASICINFO.md"));
    expect(plan.sourceFiles).toContain(join(userRoot, "DAIDENTITY.md"));
    expect(plan.sourceChecks ?? []).toContainEqual({
      path: join(userRoot, "TELOS", "STRATEGIES.md"),
      required: false,
      present: false,
    });

    const result = await importPaiIdentity({ homeDir });
    const principal = await readFile(join(homeDir, ".soma/profile/principal.md"), "utf8");
    const assistant = await readFile(join(homeDir, ".soma/profile/assistant.md"), "utf8");
    const telos = await readFile(join(homeDir, ".soma/profile/purpose.md"), "utf8");

    expect(result.files).toContain(join(homeDir, ".soma/profile/imports/claude/BASICINFO.md"));
    expect(result.files).toContain(join(homeDir, ".soma/profile/imports/claude/DAIDENTITY.md"));
    expect(result.files).not.toContain(join(homeDir, ".soma/profile/imports/claude/TELOS/STRATEGIES.md"));
    expect(principal).toContain("Name: Andreas Example");
    expect(principal).toContain("profile/imports/claude/BASICINFO.md");
    expect(assistant).toContain("Name: Ada");
    expect(telos).not.toContain("STRATEGIES.md");
  });
});

test("plans missing required PAI sources without writing files", async () => {
  await withTempHome(async (homeDir) => {
    const userRoot = join(homeDir, ".claude/PAI/USER");
    await mkdir(join(userRoot, "TELOS"), { recursive: true });

    const plan = planPaiImport({ homeDir });

    expect(plan.sourceChecks ?? []).toContainEqual({
      path: join(userRoot, "PRINCIPAL_IDENTITY.md"),
      required: true,
      present: false,
    });
    await expect(importPaiIdentity({ homeDir })).rejects.toThrow("Required PAI source file is missing:");
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
    expect(context.profile.purpose.mission).toBe("Build useful test systems without leaking publisher context.");
    expect(context.profile.purpose.goals).toContain("Keep imported goals fixture-local.");
    expect(context.profile.purpose.principles).toContain("Tests should describe the imported fixture.");
    expect(context.profile.purpose.commitments).toContain("Verify projections after import.");
    expect(principal).toContain("source: Claude PAI principal identity");
    expect(assistantSource).toContain("Ivy - Personal AI Assistant");
  });
});

test("PAI import and Claude Code projection do not contain publisher starter telos", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);

    await runSomaCli(["import", "pai", "--apply", "--home-dir", homeDir]);
    await runSomaCli(["install", "claude-code", "--apply", "--home-dir", homeDir]);

    const telos = await readFile(join(homeDir, ".soma/profile/purpose.md"), "utf8");
    const projectedTelos = await readFile(join(homeDir, ".claude/rules/soma/PURPOSE.md"), "utf8");
    const projectedContext = await readFile(join(homeDir, ".claude/rules/soma/CONTEXT.md"), "utf8");

    for (const content of [telos, projectedTelos, projectedContext]) {
      expect(content).toContain("Build useful test systems without leaking publisher context.");
      expect(content).not.toContain("[REDACTED_PUBLISHER_TELOS_MISSION]");
      expect(content).not.toContain("[REDACTED_PUBLISHER_TELOS_GOAL]");
      expect(content).not.toContain("[REDACTED_PUBLISHER_TELOS_GOAL]");
    }
  });
});

test("cli dry-runs and applies the PAI importer", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);

    const dryRun = await runSomaCli(["import", "pai", "--home-dir", homeDir]);
    expect(dryRun).toContain("Soma PAI import plan");
    expect(dryRun).toContain("[present] required");
    await expect(stat(join(homeDir, ".soma"))).rejects.toThrow();

    const applied = await runSomaCli(["import", "pai", "--apply", "--home-dir", homeDir]);
    expect(applied).toContain("Soma PAI import applied");
    await expect(readFile(join(homeDir, ".soma/profile/assistant.md"), "utf8")).resolves.toContain("Name: Ivy");
  });
});

// ---- soma#441 — profile/purpose.md is a reserved identity target ----

test("#441 re-import leaves a curated purpose.md byte-unchanged and reports it as skipped-reserved", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    await importPaiIdentity({ homeDir });

    const purposePath = join(homeDir, ".soma/profile/purpose.md");
    const curated = "# Purpose\n\nHand-curated mission that must survive re-import.\n";
    await writeFile(purposePath, curated, "utf8");

    const second = await importPaiIdentity({ homeDir });

    expect(await readFile(purposePath, "utf8")).toBe(curated);
    expect(second.skippedReserved ?? []).toContain(purposePath);
    expect(second.files).not.toContain(purposePath);
    // principal.md / assistant.md are deterministic distillations and
    // must still be (re)written on every run.
    expect(second.files).toContain(join(homeDir, ".soma/profile/principal.md"));
    expect(second.files).toContain(join(homeDir, ".soma/profile/assistant.md"));
  });
});

test("#441 overwriteReserved: true replaces an existing curated purpose.md", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    await importPaiIdentity({ homeDir });

    const purposePath = join(homeDir, ".soma/profile/purpose.md");
    await writeFile(purposePath, "# Purpose\n\nHand-curated, about to be overwritten.\n", "utf8");

    const second = await importPaiIdentity({ homeDir, overwriteReserved: true });

    expect(second.files).toContain(purposePath);
    expect(second.skippedReserved ?? []).not.toContain(purposePath);
    const rewritten = await readFile(purposePath, "utf8");
    expect(rewritten).not.toContain("Hand-curated, about to be overwritten.");
  });
});

test("#441 first run (no existing purpose.md) creates it and does not report it as skipped", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);

    const result = await importPaiIdentity({ homeDir });
    const purposePath = join(homeDir, ".soma/profile/purpose.md");

    expect(result.files).toContain(purposePath);
    expect(result.skippedReserved ?? []).toEqual([]);
    await expect(readFile(purposePath, "utf8")).resolves.toContain("Build useful test systems without leaking publisher context.");
  });
});

test("#441 cli `soma import pai --apply` reports skipped reserved purpose.md and accepts --overwrite-reserved", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    await runSomaCli(["import", "pai", "--apply", "--home-dir", homeDir]);

    const purposePath = join(homeDir, ".soma/profile/purpose.md");
    await writeFile(purposePath, "# Purpose\n\nHand-curated via CLI.\n", "utf8");

    const applied = await runSomaCli(["import", "pai", "--apply", "--home-dir", homeDir]);
    expect(applied).toContain("skipped reserved");
    expect(applied).toContain("profile/purpose.md");
    expect(applied).toContain("--overwrite-reserved");
    await expect(readFile(purposePath, "utf8")).resolves.toBe("# Purpose\n\nHand-curated via CLI.\n");

    const overwritten = await runSomaCli(["import", "pai", "--apply", "--home-dir", homeDir, "--overwrite-reserved"]);
    expect(overwritten).not.toContain("skipped reserved");
    await expect(readFile(purposePath, "utf8")).resolves.not.toContain("Hand-curated via CLI.");
  });
});
