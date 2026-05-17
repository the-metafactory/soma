/**
 * #28 minimal-scope orchestrator tests.
 *
 * Validates `planPaiMigration` + `migratePai` end-to-end against a
 * synthetic PAI fixture covering identity + algorithm + zero-pack.
 * Per-category importer tests (skills/agents/commands/auto-memory)
 * land with their respective importers in incremental PRs.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { migratePai, planPaiMigration } from "../src/index";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-28-"));
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
    await writeFile(
      join(algoDir, "v6.3.0.md"),
      "# Algorithm v6.3.0\n\nThe doctrine.\n",
      "utf8",
    );
  }
}

test("planPaiMigration returns subplans + manifest path without writing", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir, { withAlgorithm: true });
    const plan = await planPaiMigration({ homeDir });
    expect(plan.apply).toBe(false);
    expect(plan.claudeHome).toBe(join(homeDir, ".claude"));
    expect(plan.somaHome).toBe(join(homeDir, ".soma"));
    expect(plan.identity.sourceFiles.length).toBeGreaterThan(0);
    expect(plan.algorithm).not.toBeNull();
    expect(plan.algorithm!.sourceFiles.length).toBeGreaterThan(0);
    expect(plan.packs).toEqual([]);
    expect(plan.manifestPath).toBe(join(homeDir, ".soma/profile/imports/claude/MIGRATION.md"));
    // Plan must not write — manifest path doesn't exist yet.
    await expect(stat(plan.manifestPath)).rejects.toThrow();
  });
});

test("planPaiMigration handles missing algorithm dir gracefully", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir, { withAlgorithm: false });
    const plan = await planPaiMigration({ homeDir });
    expect(plan.algorithm).toBeNull();
  });
});

test("migratePai executes identity + algorithm + writes MIGRATION.md", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir, { withAlgorithm: true });
    const result = await migratePai({ homeDir });
    expect(result.identity.files.length).toBeGreaterThan(0);
    expect(result.algorithm).not.toBeNull();
    expect(result.algorithm!.files.length).toBeGreaterThan(0);
    expect(result.packs).toEqual([]);
    const manifest = await readFile(result.manifestPath, "utf8");
    expect(manifest).toContain("# PAI Migration");
    expect(manifest).toContain("identity:");
    expect(manifest).toContain("algorithm:");
    expect(manifest).toContain(homeDir);
  });
});

test("migratePai is idempotent at the file level (rerun = no file content change)", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir, { withAlgorithm: true });
    const first = await migratePai({ homeDir });
    const beforePrincipal = await readFile(join(homeDir, ".soma/profile/principal.md"), "utf8");
    const beforeManifest = await readFile(first.manifestPath, "utf8");
    await migratePai({ homeDir });
    const afterPrincipal = await readFile(join(homeDir, ".soma/profile/principal.md"), "utf8");
    const afterManifest = await readFile(first.manifestPath, "utf8");
    expect(afterPrincipal).toBe(beforePrincipal);
    // Sage r1: manifest must also be stable across reruns.
    expect(afterManifest).toBe(beforeManifest);
  });
});

test("migratePai omits algorithm when PAI install has no Algorithm dir", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir, { withAlgorithm: false });
    const result = await migratePai({ homeDir });
    expect(result.algorithm).toBeNull();
    const manifest = await readFile(result.manifestPath, "utf8");
    expect(manifest).toContain("algorithm: not present");
  });
});

test("migratePai surfaces EACCES on Algorithm dir instead of silently dropping (sage r3)", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir, { withAlgorithm: true });
    const algoDir = join(homeDir, ".claude/PAI/Algorithm");
    const { chmod } = await import("node:fs/promises");
    // Make Algorithm's parent unreadable so stat on Algorithm
    // itself fails with EACCES, not ENOENT.
    const paiDir = join(homeDir, ".claude/PAI");
    await chmod(paiDir, 0o000);
    try {
      await expect(migratePai({ homeDir })).rejects.toThrow();
    } finally {
      await chmod(paiDir, 0o700);
      await chmod(algoDir, 0o700).catch(() => undefined);
    }
  });
});

test("migratePai surfaces EACCES on packs dir instead of silently skipping (sage r2)", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    // Create an unreadable packs dir.
    const packsRoot = join(homeDir, ".claude/PAI/Packs");
    await mkdir(packsRoot, { recursive: true });
    const { chmod } = await import("node:fs/promises");
    await chmod(packsRoot, 0o000);
    try {
      await expect(migratePai({ homeDir })).rejects.toThrow();
    } finally {
      await chmod(packsRoot, 0o700);
    }
  });
});

test("migratePai writes manifest with claude/MIGRATION.md path", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiFixture(homeDir);
    const result = await migratePai({ homeDir });
    expect(result.manifestPath).toBe(join(homeDir, ".soma/profile/imports/claude/MIGRATION.md"));
    await stat(result.manifestPath); // throws if missing
    expect(result.filesWritten).toContain(result.manifestPath);
  });
});
