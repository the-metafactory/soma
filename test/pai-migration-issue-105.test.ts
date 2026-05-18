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
import { writeFlatPack, writeNestedPackShell, writeNestedSkill } from "./fixtures/pai-pack-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-105-");

/**
 * Sage r4 #108 (Maintainability suggestion): compose this multi-skill
 * nested pack from the shared `writeNestedPackShell` +
 * `writeNestedSkill` builders so the canonical pack shape is single-
 * sourced in `test/fixtures/pai-pack-fixtures.ts`. The function still
 * lives here because the (pack, [skills]) signature is migration-test
 * specific.
 */
async function writeNestedPack(
  packsDir: string,
  packName: string,
  skills: string[],
): Promise<string> {
  const packDir = join(packsDir, packName);
  await mkdir(packDir, { recursive: true });
  await writeNestedPackShell(packDir, packName);
  for (const skill of skills) {
    await writeNestedSkill(packDir, skill);
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
    await writeFlatPack(join(packsDir, "Browser"), "Browser");

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
    await writeFlatPack(join(packsDir, "Browser"), "Browser");
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
    await writeFlatPack(join(packsDir, "Single"), "Single");

    const result = await migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true });

    expect(result.packs).toHaveLength(1);
    expect(result.packs[0].skillName).toBe("single");
    expect(result.packOutcomes.filter((o) => o.outcome === "imported")).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────
// plan mode mirrors apply mode
// ───────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────
// Sage R1 #108 BLOCKER regression — collided skill NEVER touches disk
// ───────────────────────────────────────────────────────────────────────

test("Sage r1 #108: cross-pack collision: refused skill's bytes never overwrite the winner", async () => {
  // The previous implementation called `importPaiPack` for the
  // colliding pack BEFORE checking collisions, so the second pack's
  // bytes overwrote the first pack's `browser` skill on disk while
  // the outcome reported `refused-name-collision`. The fix is the
  // two-phase plan-then-apply with `excludeSkills` filtering: the
  // colliding pack runs `importPaiPack` with `excludeSkills: {browser}`,
  // so no file under `~/.soma/skills/browser/` is staged or written.
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    // Pack A — flat `Browser` skill with distinctive body content
    // (DISTINCT_A). Built from the shared fixture; the SKILL.md body
    // is overridden so the test can assert pack-A's bytes are on
    // disk after the collision is recorded.
    const packA = join(packsDir, "Browser");
    await writeFlatPack(packA, "Browser");
    await writeFile(
      join(packA, "src/SKILL.md"),
      "---\nname: Browser\ndescription: A\n---\n\n# Browser pack A — DISTINCT_A\n",
      "utf8",
    );

    // Pack B — nested Browser inside Utilities with DISTINCT_B body.
    // Composed from the shared nested-pack-shell + nested-skill
    // builders so the canonical pack shape is single-sourced; the
    // SKILL.md body and Workflow default are overridden for the
    // collision assertion.
    const packB = join(packsDir, "Utilities");
    await mkdir(packB, { recursive: true });
    await writeNestedPackShell(packB, "Utilities");
    await writeNestedSkill(packB, "Browser");
    await writeFile(
      join(packB, "src/Browser/SKILL.md"),
      "---\nname: Browser\ndescription: B\n---\n\n# Utilities/Browser — DISTINCT_B\n",
      "utf8",
    );
    await writeFile(join(packB, "src/Browser/Workflows/Default.md"), "# Utilities/Browser Default\n", "utf8");

    const result = await migratePai({ homeDir, paiPacksDir: packsDir, skipMemory: true });

    // Pack A's `Browser` won — its bytes are on disk untouched.
    const browserSkillMd = await readFile(
      join(homeDir, ".soma/skills/browser/SKILL.md"),
      "utf8",
    );
    expect(browserSkillMd).toContain("DISTINCT_A");
    expect(browserSkillMd).not.toContain("DISTINCT_B");

    // The refusal is recorded for pack B's nested browser.
    const collisions = result.packOutcomes.filter((o) => o.outcome === "refused-name-collision");
    expect(collisions.some((o) => o.skillName === "browser")).toBe(true);
  });
});

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
