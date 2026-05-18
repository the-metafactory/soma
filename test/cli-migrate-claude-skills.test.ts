/**
 * #115 — `soma migrate claude-skills` CLI surface tests.
 *
 * Validates dry-run / --apply / --status / --include-claude-specific
 * and unknown-flag behavior against a synthetic flat skills tree.
 *
 * Mirrors `cli-migrate.test.ts` (the PAI path) so the two surfaces
 * stay in formatter parity — same totals line, same per-row shape,
 * same --status empty-state hint.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";
import { withTempHome as withSharedTempHome } from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-cli-115-");

async function writeFixture(home: string): Promise<string> {
  const fromDir = join(home, "skills");
  await mkdir(join(fromDir, "Portable"), { recursive: true });
  await writeFile(
    join(fromDir, "Portable", "SKILL.md"),
    "# Portable\n\nclean.\n",
    "utf8",
  );
  await mkdir(join(fromDir, "NeedsAdapt"), { recursive: true });
  await writeFile(
    join(fromDir, "NeedsAdapt", "SKILL.md"),
    "# NeedsAdapt\n\nsee ~/.claude/PAI/DOCUMENTATION/X.md\n",
    "utf8",
  );
  await mkdir(join(fromDir, "ClaudeSpecific"), { recursive: true });
  await writeFile(
    join(fromDir, "ClaudeSpecific", "SKILL.md"),
    "# ClaudeSpecific\n\nStop: cleanup hook\n",
    "utf8",
  );
  return fromDir;
}

test("soma migrate claude-skills --from <dir> → plan", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      join(home, "soma"),
    ]);
    expect(output).toContain("plan (dry-run");
    expect(output).toContain("portable [portable] → imported");
    expect(output).toContain("needs-adapt [needs-adapt] → imported");
    expect(output).toContain("claude-specific [claude-specific] → skipped-claude-specific");
    expect(output).toContain("Totals: 2 imported, 0 skipped-idempotent, 1 skipped-claude-specific");
    // No writes — soma home shouldn't have a manifest yet.
    await expect(
      stat(join(home, "soma/imports/claude-skills/.manifest.json")),
    ).rejects.toThrow();
  });
});

test("soma migrate claude-skills --apply writes manifest + report + payloads", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
    ]);
    expect(output).toContain("applied");
    expect(output).toContain("Totals: 2 written, 0 skipped-idempotent, 1 skipped-claude-specific");
    await stat(join(somaHome, "imports/claude-skills/.manifest.json"));
    await stat(join(somaHome, "imports/claude-skills/.portability-report.md"));
    await stat(join(somaHome, "skills/portable/SKILL.md"));
    await stat(join(somaHome, "skills/needs-adapt/SKILL.md"));
    // claude-specific must NOT have landed.
    await expect(
      stat(join(somaHome, "skills/claude-specific/SKILL.md")),
    ).rejects.toThrow();
  });
});

test("soma migrate claude-skills --apply --include-claude-specific lands the skipped set", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
      "--include-claude-specific",
    ]);
    expect(output).toContain("Totals: 3 written, 0 skipped-idempotent, 0 skipped-claude-specific");
    await stat(join(somaHome, "skills/claude-specific/SKILL.md"));
    // Report carries the override.
    const report = await readFile(
      join(somaHome, "imports/claude-skills/.portability-report.md"),
      "utf8",
    );
    expect(report).toContain("Include claude-specific: yes");
  });
});

test("soma migrate claude-skills --status (no prior apply) reports absence", async () => {
  await withTempHome(async (home) => {
    const output = await runSomaCli([
      "migrate",
      "claude-skills",
      "--status",
      "--soma-home",
      join(home, "soma"),
    ]);
    expect(output).toContain("no migration manifest found");
  });
});

test("soma migrate claude-skills --status (after apply) prints summary", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
    ]);
    const status = await runSomaCli([
      "migrate",
      "claude-skills",
      "--status",
      "--soma-home",
      somaHome,
    ]);
    expect(status).toContain("soma migrate claude-skills — status");
    expect(status).toContain("portable [portable]");
    expect(status).toContain("needs-adapt [needs-adapt]");
  });
});

test("soma migrate claude-skills --help surfaces usage", async () => {
  const output = await runSomaCli(["migrate", "claude-skills", "--help"]);
  expect(output).toContain("Usage: soma migrate claude-skills");
});

test("soma migrate claude-skills --apply --unknown-flag errors", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    await expect(
      runSomaCli([
        "migrate",
        "claude-skills",
        "--from",
        fromDir,
        "--apply",
        "--bogus",
        "--soma-home",
        join(home, "soma"),
      ]),
    ).rejects.toThrow("Unknown option");
  });
});

test("soma migrate claude-skills (no --from on plan) errors with usage", async () => {
  await expect(runSomaCli(["migrate", "claude-skills"])).rejects.toThrow();
});

test("soma migrate claude-skills --apply is idempotent", async () => {
  await withTempHome(async (home) => {
    const fromDir = await writeFixture(home);
    const somaHome = join(home, "soma");
    const first = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
    ]);
    expect(first).toContain("Totals: 2 written, 0 skipped-idempotent");
    const second = await runSomaCli([
      "migrate",
      "claude-skills",
      "--from",
      fromDir,
      "--soma-home",
      somaHome,
      "--apply",
    ]);
    expect(second).toContain("Totals: 0 written, 2 skipped-idempotent");
  });
});
