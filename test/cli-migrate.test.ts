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
