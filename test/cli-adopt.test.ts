/**
 * #68 — `soma adopt claude` CLI orchestrator command tests.
 *
 * Validates dry-run, --apply, --uninstall, --help, and unknown-flag
 * behavior against a temp home.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-cli-68-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("soma adopt claude (no flags) → dry-run plan", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli(["adopt", "claude", "--home-dir", homeDir]);
    expect(output).toContain("Soma install plan");
    expect(output).toContain("substrate: claude-code");
    expect(output).toContain("rules/soma/");
    // No writes happened.
    await expect(stat(join(homeDir, ".claude/rules/soma"))).rejects.toThrow();
  });
});

test("soma adopt claude --apply writes rules/soma/ skeleton + ISA skill", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli(["adopt", "claude", "--apply", "--home-dir", homeDir]);
    expect(output).toContain("Soma install applied");
    expect(output).toContain("substrate: claude-code");
    await stat(join(homeDir, ".claude/rules/soma/README.md"));
    await stat(join(homeDir, ".claude/rules/soma/CONTEXT.md"));
    await stat(join(homeDir, ".claude/skills/ISA/SKILL.md"));
  });
});

test("soma adopt claude --apply is idempotent (rerun byte-stable)", async () => {
  await withTempHome(async (homeDir) => {
    await runSomaCli(["adopt", "claude", "--apply", "--home-dir", homeDir]);
    const before = await readFile(join(homeDir, ".claude/rules/soma/CONTEXT.md"), "utf8");
    await runSomaCli(["adopt", "claude", "--apply", "--home-dir", homeDir]);
    const after = await readFile(join(homeDir, ".claude/rules/soma/CONTEXT.md"), "utf8");
    expect(after).toBe(before);
  });
});

test("soma adopt claude --uninstall removes rules/soma + skills/ISA", async () => {
  await withTempHome(async (homeDir) => {
    await runSomaCli(["adopt", "claude", "--apply", "--home-dir", homeDir]);
    const output = await runSomaCli(["adopt", "claude", "--uninstall", "--home-dir", homeDir]);
    expect(output).toContain("Removed:");
    await expect(stat(join(homeDir, ".claude/rules/soma"))).rejects.toThrow();
    await expect(stat(join(homeDir, ".claude/skills/ISA"))).rejects.toThrow();
  });
});

test("soma adopt claude --uninstall (no install) reports nothing-to-remove", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli(["adopt", "claude", "--uninstall", "--home-dir", homeDir]);
    expect(output).toContain("Nothing to remove");
  });
});

test("soma adopt claude --help surfaces usage", async () => {
  const output = await runSomaCli(["adopt", "claude", "--help"]);
  expect(output).toContain("Usage: soma adopt claude");
});

test("soma adopt (no substrate) errors with usage", async () => {
  await expect(runSomaCli(["adopt"])).rejects.toThrow();
});

test("soma adopt claude --bogus errors", async () => {
  await expect(runSomaCli(["adopt", "claude", "--bogus"])).rejects.toThrow("Unknown option");
});
