/**
 * #67 — `soma migrate pai` CLI orchestrator command tests.
 *
 * Validates dry-run, --apply, --status, and unknown-flag behavior
 * against a synthetic PAI fixture.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";
import {
  withTempHome as withSharedTempHome,
  writePaiIdentityFixture as writePaiFixture,
} from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-cli-67-");

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

// Shared fixture builders (Sage r1 #95 Maintainability nit:
// deduplicate the pack/source/memory builders across migration test
// files).
import {
  writePaiMemoryFixture as writeMemoryFixture,
  writePaiPackFixture as writePackFixture,
  writePaiReleaseFixture as writePaiSourceFixture,
} from "./fixtures/pai-migration-fixtures";

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
    // Shared fixture plants 2 files (LEARNING/lesson.md + WORK/.../notes.md).
    expect(output).toMatch(/memory:\s+2 file/);
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

test("soma migrate pai --overwrite-reserved permits reserved-skill packs (#97 contract)", async () => {
  // #97 — without the override flag, reserved-skill packs are
  // recorded as `refused-reserved` per-pack outcomes (zero-exit).
  // The override flag lets the same pack land. The CLI no longer
  // throws on reserved-name collision.
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    // Pack whose name slugifies to a reserved canonical skill name.
    await writePackFixture(packsDir, "telos");
    const refusedOut = await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--pai-packs-dir",
      packsDir,
      "--home-dir",
      homeDir,
    ]);
    expect(refusedOut).toContain("telos: refused-reserved");
    expect(refusedOut).toContain("packs:    0 pack(s)");
    // With the override flag the same call lands the pack.
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
    expect(output).toContain("telos: imported");
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
