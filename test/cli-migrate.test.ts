/**
 * #67 — `soma migrate pai` CLI orchestrator command tests.
 *
 * Validates dry-run, --apply, --status, and unknown-flag behavior
 * against a synthetic PAI fixture.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-cli-67-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writePaiFixture(homeDir: string, opts: { withAlgorithm?: boolean } = {}): Promise<void> {
  const userRoot = join(homeDir, ".claude/PAI/USER");
  await mkdir(join(userRoot, "TELOS"), { recursive: true });
  await writeFile(
    join(userRoot, "PRINCIPAL_IDENTITY.md"),
    "# Principal\n\n- **Name:** Test User\n- **Pronunciation:** Test\n- **Location:** Nowhere\n- **Timezone:** UTC\n- **Role:** Tester\n- **Focus:** Testing\n",
    "utf8",
  );
  await writeFile(
    join(userRoot, "DA_IDENTITY.md"),
    "# DA Identity\n\n- **Full Name:** Bot\n- **Name:** Bot\n- **Display Name:** Bot\n- **Color:** #000\n- **Voice ID:** v\n- **Role:** assistant\n- **Operating Environment:** test\n",
    "utf8",
  );
  for (const file of ["MISSION.md", "GOALS.md", "STRATEGIES.md", "BELIEFS.md"]) {
    await writeFile(join(userRoot, "TELOS", file), `# ${file}\n\nFixture\n`, "utf8");
  }
  if (opts.withAlgorithm) {
    const algoDir = join(homeDir, ".claude/PAI/Algorithm");
    await mkdir(algoDir, { recursive: true });
    await writeFile(join(algoDir, "v6.3.0.md"), "# Algorithm v6.3.0\n", "utf8");
  }
}

test("soma migrate pai (no flags) → dry-run plan", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir, { withAlgorithm: true });
    const output = await runSomaCli(["migrate", "pai", "--home-dir", homeDir]);
    expect(output).toContain("dry-run");
    expect(output).toContain("identity:");
    expect(output).toContain("algorithm:");
    expect(output).toContain(homeDir);
    // No write happened.
    await expect(stat(join(homeDir, ".soma/profile/imports/claude/MIGRATION.md"))).rejects.toThrow();
  });
});

test("soma migrate pai --apply writes manifest + identity files", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir, { withAlgorithm: true });
    const output = await runSomaCli(["migrate", "pai", "--apply", "--home-dir", homeDir]);
    expect(output).toContain("applied");
    expect(output).toContain("Total files written:");
    await stat(join(homeDir, ".soma/profile/imports/claude/MIGRATION.md"));
    await stat(join(homeDir, ".soma/profile/principal.md"));
  });
});

test("soma migrate pai --status (no prior run) reports absence", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    const output = await runSomaCli(["migrate", "pai", "--status", "--home-dir", homeDir]);
    expect(output).toContain("no migration manifest");
  });
});

test("soma migrate pai --status (after apply) prints manifest", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir, { withAlgorithm: true });
    await runSomaCli(["migrate", "pai", "--apply", "--home-dir", homeDir]);
    const status = await runSomaCli(["migrate", "pai", "--status", "--home-dir", homeDir]);
    expect(status).toContain("# PAI Migration");
    expect(status).toContain("identity:");
  });
});

test("soma migrate pai --help surfaces usage", async () => {
  const output = await runSomaCli(["migrate", "pai", "--help"]);
  expect(output).toContain("Usage: soma migrate pai");
});

test("soma migrate (no subcommand) errors with usage", async () => {
  await expect(runSomaCli(["migrate"])).rejects.toThrow();
});

test("soma migrate pai --unknown-flag errors", async () => {
  await withTempHome(async (homeDir) => {
    await expect(
      runSomaCli(["migrate", "pai", "--bogus", "--home-dir", homeDir]),
    ).rejects.toThrow("Unknown option");
  });
});

test("soma migrate pai --apply is idempotent (rerun produces no manifest content change)", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir, { withAlgorithm: true });
    await runSomaCli(["migrate", "pai", "--apply", "--home-dir", homeDir]);
    const before = await readFile(join(homeDir, ".soma/profile/imports/claude/MIGRATION.md"), "utf8");
    await runSomaCli(["migrate", "pai", "--apply", "--home-dir", homeDir]);
    const after = await readFile(join(homeDir, ".soma/profile/imports/claude/MIGRATION.md"), "utf8");
    expect(after).toBe(before);
  });
});

// ---- #90 CLI surface ----

async function writeMemoryFixture(homeDir: string): Promise<void> {
  const root = join(homeDir, ".claude/PAI/MEMORY");
  await mkdir(join(root, "LEARNING"), { recursive: true });
  await writeFile(join(root, "LEARNING/lesson.md"), "# Lesson\n", "utf8");
}

async function writePackFixture(packsDir: string, packName: string): Promise<void> {
  const packDir = join(packsDir, packName);
  await mkdir(join(packDir, "src"), { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    `---\nname: ${packName}\ndescription: tiny pack\n---\n\n# ${packName}\n\nFixture.\n`,
    "utf8",
  );
  await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
  await writeFile(
    join(packDir, "src/SKILL.md"),
    `---\nname: ${packName}\ndescription: tiny pack\n---\n\n# ${packName}\n\nFixture skill body.\n`,
    "utf8",
  );
}

async function writePaiSourceFixture(homeDir: string): Promise<string> {
  const sourceDir = join(homeDir, "PAI/Releases/v5.0.0/.claude/PAI");
  await mkdir(join(sourceDir, "DOCUMENTATION/Skills"), { recursive: true });
  await writeFile(
    join(sourceDir, "DOCUMENTATION/Skills/SkillSystem.md"),
    "# Skill System\n",
    "utf8",
  );
  return sourceDir;
}

test("soma migrate pai --pai-install <alias for --claude-home>", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    const output = await runSomaCli([
      "migrate",
      "pai",
      "--home-dir",
      homeDir,
      "--pai-install",
      join(homeDir, ".claude"),
    ]);
    expect(output).toContain("dry-run");
    expect(output).toContain(join(homeDir, ".claude"));
  });
});

test("soma migrate pai plan reports memory phase counts", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    await writeMemoryFixture(homeDir);
    const output = await runSomaCli(["migrate", "pai", "--home-dir", homeDir]);
    expect(output).toContain("memory:");
    expect(output).toMatch(/memory:\s+1 file/);
  });
});

test("soma migrate pai --skip-memory honored at the CLI level", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    await writeMemoryFixture(homeDir);
    const output = await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--skip-memory",
      "--home-dir",
      homeDir,
    ]);
    expect(output).toContain("memory:   skipped");
    await expect(stat(join(homeDir, ".soma/memory/LEARNING/lesson.md"))).rejects.toThrow();
  });
});

test("soma migrate pai --pai-packs-dir bulk-imports packs", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await writePackFixture(packsDir, "Gamma");
    await writePackFixture(packsDir, "Delta");
    const output = await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--pai-packs-dir",
      packsDir,
      "--home-dir",
      homeDir,
    ]);
    expect(output).toContain("packs:    2 pack(s)");
    await stat(join(homeDir, ".soma/skills/gamma/SKILL.md"));
    await stat(join(homeDir, ".soma/skills/delta/SKILL.md"));
  });
});

test("soma migrate pai --skip-skills suppresses bulk skill import", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await writePackFixture(packsDir, "Gamma");
    const output = await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--pai-packs-dir",
      packsDir,
      "--skip-skills",
      "--home-dir",
      homeDir,
    ]);
    expect(output).toContain("packs:    0 pack(s)");
    await expect(stat(join(homeDir, ".soma/skills/gamma"))).rejects.toThrow();
  });
});

test("soma migrate pai --pai-source-dir triggers docs phase", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    const sourceDir = await writePaiSourceFixture(homeDir);
    const output = await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--pai-source-dir",
      sourceDir,
      "--home-dir",
      homeDir,
    ]);
    expect(output).toContain("docs:");
    await stat(join(homeDir, ".soma/PAI/DOCUMENTATION/Skills/SkillSystem.md"));
  });
});

test("soma migrate pai --skip-docs honored even when --pai-source-dir is set", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    const sourceDir = await writePaiSourceFixture(homeDir);
    const output = await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--pai-source-dir",
      sourceDir,
      "--skip-docs",
      "--home-dir",
      homeDir,
    ]);
    expect(output).toContain("docs:     skipped");
    await expect(
      stat(join(homeDir, ".soma/PAI/DOCUMENTATION/Skills/SkillSystem.md")),
    ).rejects.toThrow();
  });
});

test("soma migrate pai --overwrite-reserved permits reserved-skill packs", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    // Pack whose name slugifies to a reserved canonical skill name.
    await writePackFixture(packsDir, "telos");
    await expect(
      runSomaCli([
        "migrate",
        "pai",
        "--apply",
        "--pai-packs-dir",
        packsDir,
        "--home-dir",
        homeDir,
      ]),
    ).rejects.toThrow(/reserved Soma skill 'telos'/);
    // With the override flag the same call succeeds.
    const output = await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--pai-packs-dir",
      packsDir,
      "--overwrite-reserved",
      "--home-dir",
      homeDir,
    ]);
    expect(output).toContain("packs:    1 pack(s)");
  });
});

test("soma migrate pai --status after full apply reports memory + docs lines", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    await writeMemoryFixture(homeDir);
    const sourceDir = await writePaiSourceFixture(homeDir);
    await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--pai-source-dir",
      sourceDir,
      "--home-dir",
      homeDir,
    ]);
    const status = await runSomaCli([
      "migrate",
      "pai",
      "--status",
      "--home-dir",
      homeDir,
    ]);
    expect(status).toContain("# PAI Migration");
    expect(status).toContain("memory:");
    expect(status).toContain("docs:");
    expect(status).toContain("identity:");
  });
});

test("soma migrate pai full-apply idempotent: rerun = same MIGRATION.md bytes", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    await writeMemoryFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await writePackFixture(packsDir, "Gamma");
    const sourceDir = await writePaiSourceFixture(homeDir);
    await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--pai-packs-dir",
      packsDir,
      "--pai-source-dir",
      sourceDir,
      "--home-dir",
      homeDir,
    ]);
    const before = await readFile(
      join(homeDir, ".soma/profile/imports/claude/MIGRATION.md"),
      "utf8",
    );
    await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--pai-packs-dir",
      packsDir,
      "--pai-source-dir",
      sourceDir,
      "--home-dir",
      homeDir,
    ]);
    const after = await readFile(
      join(homeDir, ".soma/profile/imports/claude/MIGRATION.md"),
      "utf8",
    );
    expect(after).toBe(before);
  });
});

test("soma migrate pai --pai-source-dir bogus dir refused loud at CLI", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    const bogus = join(homeDir, "not-pai");
    await mkdir(bogus, { recursive: true });
    await writeFile(join(bogus, "anything.md"), "x\n", "utf8");
    await expect(
      runSomaCli([
        "migrate",
        "pai",
        "--apply",
        "--pai-source-dir",
        bogus,
        "--home-dir",
        homeDir,
      ]),
    ).rejects.toThrow(/does not look like a PAI release tree/);
  });
});
