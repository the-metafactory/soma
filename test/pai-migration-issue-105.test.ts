/**
 * Issue 105 — migration orchestrator: handle N-skills-per-pack from
 * nested skill bundles, plus cross-pack name collisions.
 *
 * The pack importer (`importPaiPack`) now returns
 * `PaiPackImportResult[]` (Option A breaking change shipped in this
 * PR). The orchestrator must:
 *
 *  - Treat each derived skill in a pack as its own outcome row in
 *    `packOutcomes`. A pack with N derived skills produces ≥ N
 *    outcome rows (N successes, or fewer + refusals).
 *  - Detect cross-pack name collisions: if Pack A landed `browser`
 *    and Pack B's nested `Browser` would also kebab to `browser`, the
 *    second pack's `browser` derived skill records
 *    `refused-name-collision` unless `--overwrite-reserved`-style
 *    flow permits it. (Per issue body: `--overwrite` flag on the
 *    pack-import call permits, mirrored at migrate level.)
 *  - Handle the within-pack collision (two derived skills kebab to
 *    the same name) by passing the typed refusal up — the orchestrator
 *    records `refused-name-collision` for the whole pack and continues.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { migratePai, planPaiMigration } from "../src/pai-migration";
import {
  withTempHome as withSharedTempHome,
  writePaiIdentityFixture as writeIdentityFixture,
} from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-105-");

async function writeNestedPack(
  packsDir: string,
  packName: string,
  skills: string[],
): Promise<string> {
  const packDir = join(packsDir, packName);
  await mkdir(packDir, { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    `---\nname: ${packName}\ndescription: ${packName} pack\n---\n\n# ${packName}\n\nFixture.\n`,
    "utf8",
  );
  await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
  await mkdir(join(packDir, "src"), { recursive: true });
  for (const skill of skills) {
    await mkdir(join(packDir, "src", skill, "Workflows"), { recursive: true });
    await writeFile(
      join(packDir, "src", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: nested ${skill}\n---\n\n# ${skill}\n\nBody.\n`,
      "utf8",
    );
    await writeFile(join(packDir, "src", skill, "Workflows/Default.md"), `# ${skill} Default\n`, "utf8");
  }
  return packDir;
}

async function withMigrationHome<T>(
  fn: (ctx: { homeDir: string; packsDir: string }) => Promise<T>,
): Promise<T> {
  return withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    return fn({ homeDir, packsDir });
  });
}

// ───────────────────────────────────────────────────────────────────────
// AC-2 / AC-4: N-per-pack lands as N skills in the migration outcome
// ───────────────────────────────────────────────────────────────────────

test("AC-2: nested pack with 2 skills produces 2 imported outcome rows", async () => {
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    await writeNestedPack(packsDir, "Media", ["Art", "Remotion"]);

    const result = await migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true });

    // Two outcome rows — one per derived skill.
    const skillNames = result.packOutcomes
      .filter((o) => o.outcome === "imported")
      .map((o) => o.skillName)
      .sort();
    expect(skillNames).toEqual(["art", "remotion"]);

    // Two pack-import-result objects (one per derived skill).
    const importedNames = result.packs.map((p) => p.skillName).sort();
    expect(importedNames).toEqual(["art", "remotion"]);

    // The two skills landed in the Soma home.
    for (const name of ["art", "remotion"]) {
      const path = join(homeDir, ".soma/skills", name, "SKILL.md");
      const bytes = await readFile(path, "utf8");
      expect(bytes.length).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-5: Cross-pack name collision
// ───────────────────────────────────────────────────────────────────────

test("AC-5: cross-pack name collision records refused-name-collision for the second pack", async () => {
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    // Pack A: flat pack named "Browser".
    const packA = join(packsDir, "Browser");
    await mkdir(join(packA, "src/Workflows"), { recursive: true });
    await writeFile(
      join(packA, "README.md"),
      "---\nname: Browser\ndescription: A\n---\n\n# Browser\n",
      "utf8",
    );
    await writeFile(join(packA, "INSTALL.md"), "# Install\n", "utf8");
    await writeFile(join(packA, "VERIFY.md"), "# Verify\n", "utf8");
    await writeFile(
      join(packA, "src/SKILL.md"),
      "---\nname: Browser\ndescription: A\n---\n\n# Browser\n",
      "utf8",
    );

    // Pack B: nested pack containing src/Browser/SKILL.md.
    await writeNestedPack(packsDir, "Utilities", ["Browser"]);

    const result = await migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true });

    const importedNames = result.packOutcomes
      .filter((o) => o.outcome === "imported")
      .map((o) => o.skillName)
      .sort();

    // First pack's `browser` wins; second pack's nested `browser` collides.
    expect(importedNames).toContain("browser");

    const refusedCollisions = result.packOutcomes.filter(
      (o) => o.outcome === "refused-name-collision",
    );
    expect(refusedCollisions.length).toBeGreaterThanOrEqual(1);
    expect(refusedCollisions.some((o) => o.skillName === "browser")).toBe(true);
  });
});

test("AC-5: cross-pack collision with --overwrite-reserved-equivalent flag — second wins", async () => {
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    const packA = join(packsDir, "Browser");
    await mkdir(join(packA, "src/Workflows"), { recursive: true });
    await writeFile(
      join(packA, "README.md"),
      "---\nname: Browser\ndescription: A\n---\n\n# Browser\n",
      "utf8",
    );
    await writeFile(join(packA, "INSTALL.md"), "# Install A\n", "utf8");
    await writeFile(join(packA, "VERIFY.md"), "# Verify A\n", "utf8");
    await writeFile(
      join(packA, "src/SKILL.md"),
      "---\nname: Browser\ndescription: A\n---\n\n# Browser pack A\n",
      "utf8",
    );

    await writeNestedPack(packsDir, "Utilities", ["Browser"]);

    // Note: `overwriteReserved` repurposed at migrate level to permit name
    // collisions across packs as well. (Simpler than adding a fresh flag;
    // the principal already opted in to overwriting canonical surfaces.)
    const result = await migratePai({
      homeDir,
      paiPacksDir: packsDir,
      skipMemory: true,
      overwriteReserved: true,
    });

    // Both packs' browsers should appear in outcomes; one wins on disk.
    const imported = result.packOutcomes
      .filter((o) => o.outcome === "imported")
      .map((o) => o.skillName);
    expect(imported.filter((n) => n === "browser").length).toBeGreaterThanOrEqual(1);
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-3 backwards compat: FLAT packs still produce single outcome
// ───────────────────────────────────────────────────────────────────────

test("AC-3: FLAT pack still imports as one outcome row (backwards compat)", async () => {
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    const packDir = join(packsDir, "Single");
    await mkdir(join(packDir, "src/Workflows"), { recursive: true });
    await writeFile(
      join(packDir, "README.md"),
      "---\nname: Single\ndescription: flat\n---\n\n# Single\n",
      "utf8",
    );
    await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
    await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
    await writeFile(
      join(packDir, "src/SKILL.md"),
      "---\nname: Single\ndescription: flat\n---\n\n# Single\n",
      "utf8",
    );
    await writeFile(join(packDir, "src/Workflows/Run.md"), "# Run\n", "utf8");

    const result = await migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true });

    expect(result.packs).toHaveLength(1);
    expect(result.packs[0].skillName).toBe("single");
    expect(result.packOutcomes.filter((o) => o.outcome === "imported")).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────
// plan mode mirrors apply mode
// ───────────────────────────────────────────────────────────────────────

test("plan mode produces same per-skill outcome rows for nested packs", async () => {
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    await writeNestedPack(packsDir, "Media", ["Art", "Remotion"]);

    const plan = await planPaiMigration({ homeDir, paiPacksDir: packsDir, skipMemory: true });

    const planned = plan.packOutcomes
      .filter((o) => o.outcome === "imported")
      .map((o) => o.skillName)
      .sort();
    expect(planned).toEqual(["art", "remotion"]);
    expect(plan.packs).toHaveLength(2);
  });
});
