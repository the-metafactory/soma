/**
 * Orienteer node #793 — PAI migration and import were removed from soma
 * (pin soma ≤ 0.25 for them). `soma migrate pai` and every `soma import`
 * source must fail like any other unknown command, and no help or usage
 * text may still advertise them.
 */
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";

const REPO_ROOT = join(import.meta.dir, "..");

test("soma migrate (no subcommand) errors with usage", async () => {
  await expect(runSomaCli(["migrate"])).rejects.toThrow("Usage: soma migrate claude-skills");
});

test("soma migrate pai is rejected with the migrate usage, which no longer names it", async () => {
  const error = await runSomaCli(["migrate", "pai", "--apply"]).then(
    () => null,
    (caught: unknown) => caught as Error,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error?.message).toContain("Usage: soma migrate claude-skills");
  expect(error?.message).not.toContain("migrate pai");
});

for (const source of ["pai", "algorithm", "pai-pack", "pai-docs"]) {
  test(`soma import ${source} is an unknown command`, async () => {
    await expect(runSomaCli(["import", source, "--dry-run"])).rejects.toThrow("Unknown command: import");
  });
}

test("soma import --help is an unknown command", async () => {
  await expect(runSomaCli(["import", "--help"])).rejects.toThrow("Unknown command: import");
});

test("no help or usage text mentions the removed commands", async () => {
  const texts = [
    await runSomaCli([]),
    await runSomaCli(["--help"]),
    await runSomaCli(["migrate", "--help"]),
    await runSomaCli(["migrate", "claude-skills", "--help"]),
  ];
  for (const text of texts) {
    expect(text).not.toMatch(/soma import\b/);
    expect(text).not.toContain("migrate pai");
  }
});

test("the real CLI exits non-zero on the removed commands", () => {
  for (const args of [["migrate", "pai"], ["import", "pai"], ["import", "algorithm"]]) {
    const result = Bun.spawnSync([process.execPath, join(REPO_ROOT, "src", "cli.ts"), ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
  }
});
