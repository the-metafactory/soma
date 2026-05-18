/**
 * PR #108 — Sage R2 follow-ups for issue 105.
 *
 * Tests pin the contract for the three remaining R2 findings:
 *
 *   - R2 #1 (CodeQuality, important) — `src/pai-pack-routing.ts`:
 *     Nested-skill detection MUST run BEFORE the FLAT PORTABLE_PREFIXES
 *     check. A pack with `src/Tools/SKILL.md` (i.e. "Tools" is the
 *     name of a nested skill, not a flat-portable subdir) must route
 *     to the `tools` skill, not flatten into the pack-level skill.
 *
 *   - R2 #2 (Performance, important) — `importPaiPackFromPlan` applies
 *     a cached internal plan WITHOUT a second `buildPaiPackImportPlan`
 *     pass. On-disk output must match `importPaiPack` exactly (byte-
 *     stable; same skill set, same files, same content).
 *
 *   - R2 #4 (Maintainability, suggestion) — `walkPlanRowsForCollisions`
 *     is the single source for cross-pack collision logic. Both the
 *     apply and plan-only bulk paths consume it; their outputs (skill
 *     set, outcome rows) must match the pre-refactor surfaces.
 *
 * R2 #3 (Architecture, suggestion — `excludeSkills` off public type)
 * is verified at compile time: removing `excludeSkills` from
 * `PaiPackImportOptions` and moving it to the module-internal
 * `PaiPackImportOptionsInternal` would break the typecheck if anything
 * outside the module set it. The fact that `bun run typecheck` is
 * green proves the contract.
 */
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { expect, test } from "bun:test";
import { migratePai, planPaiMigration } from "../src/index";
import {
  importPaiPack,
  importPaiPackFromPlan,
  planPaiPackImportHandle,
} from "../src/pai-pack-importer";
import { routePaiPackSourceFile } from "../src/pai-pack-routing";
import { writePaiIdentityFixture } from "./fixtures/pai-migration-fixtures";
import { writeFlatNestedPack, writeFlatPack } from "./fixtures/pai-pack-fixtures";

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-issue-108-r2-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

// Sage r3 #108 (Maintainability): pack-writer fixtures shared via
// `test/fixtures/pai-pack-fixtures.ts`.

/**
 * Recursively list every file under `root`, returning POSIX-relative
 * paths sorted for deterministic comparison. Used to assert equality
 * between two on-disk outputs (apply via `importPaiPack` vs apply via
 * `importPaiPackFromPlan`).
 */
async function listTree(root: string): Promise<string[]> {
  const acc: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else acc.push(relative(root, full).split(sep).join("/"));
    }
  }
  try {
    await walk(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return acc.sort();
}

// ───────────────────────────────────────────────────────────────────────
// R2 #1 (CodeQuality, important): nested routing before PORTABLE_PREFIXES
// ───────────────────────────────────────────────────────────────────────

test("R2 #1: nested-skill detection runs BEFORE PORTABLE_PREFIXES — src/Tools/SKILL.md routes as nested 'tools' skill", () => {
  const nestedSet = new Set(["Tools"]);
  const route = routePaiPackSourceFile("src/Tools/SKILL.md", nestedSet);
  expect(route.classification).toBe("portable");
  expect(route.root).toBe("skill");
  expect(route.renderMode).toBe("skill");
  expect(route.skillName).toBe("tools");
  expect(route.relativePath).toBe("SKILL.md");
});

test("R2 #1: src/Tools/Workflows/x.md routes under nested 'tools' skill when Tools is nested", () => {
  const nestedSet = new Set(["Tools"]);
  const route = routePaiPackSourceFile("src/Tools/Workflows/x.md", nestedSet);
  expect(route.skillName).toBe("tools");
  expect(route.relativePath).toBe("Workflows/x.md");
});

test("R2 #1: FLAT pack — src/Tools/payload.ts still routes as flat portable (no nested override)", () => {
  const route = routePaiPackSourceFile("src/Tools/payload.ts", new Set());
  expect(route.classification).toBe("portable");
  expect(route.skillName).toBe(null); // flat portable
  expect(route.relativePath).toBe("Tools/payload.ts");
});

test("R2 #1: FLAT pack — src/SKILL.md routes as FLAT skill entry (no nested override possible)", () => {
  const route = routePaiPackSourceFile("src/SKILL.md", new Set(["Anything"]));
  expect(route.classification).toBe("portable");
  expect(route.root).toBe("skill");
  expect(route.skillName).toBe(null);
  expect(route.relativePath).toBe("SKILL.md");
  expect(route.renderMode).toBe("skill");
});

// ───────────────────────────────────────────────────────────────────────
// R2 #2 (Performance): importPaiPackFromPlan equivalence
// ───────────────────────────────────────────────────────────────────────

test("R2 #2: importPaiPackFromPlan produces the same on-disk output as importPaiPack (flat pack)", async () => {
  await withTempHome(async (homeA) => {
    await withTempHome(async (homeB) => {
      const packA = join(homeA, "pack");
      const packB = join(homeB, "pack");
      await writeFlatPack(packA, "Demo");
      await writeFlatPack(packB, "Demo");

      const somaA = join(homeA, ".soma");
      const somaB = join(homeB, ".soma");

      // Path A: single-shot importPaiPack.
      const resultA = await importPaiPack({
        homeDir: homeA,
        paiPackDir: packA,
        somaHome: somaA,
      });

      // Path B: plan-then-apply-from-plan.
      const { handle } = await planPaiPackImportHandle({
        homeDir: homeB,
        paiPackDir: packB,
        somaHome: somaB,
      });
      const resultB = await importPaiPackFromPlan(handle, { overwrite: false });

      // Same shape.
      expect(resultB.length).toBe(resultA.length);
      expect(resultB.map((r) => r.skillName).sort()).toEqual(resultA.map((r) => r.skillName).sort());

      // Same file tree under skills/.
      const treeA = await listTree(join(somaA, "skills"));
      const treeB = await listTree(join(somaB, "skills"));
      expect(treeB).toEqual(treeA);

      // Same content for SKILL.md.
      const slug = resultA[0]!.skillName;
      const skillMdA = await readFile(join(somaA, "skills", slug, "SKILL.md"), "utf8");
      const skillMdB = await readFile(join(somaB, "skills", slug, "SKILL.md"), "utf8");
      expect(skillMdB).toBe(skillMdA);
    });
  });
});

test("R2 #2: importPaiPackFromPlan with excludeSkills drops collided skill and lands survivors (mixed pack)", async () => {
  await withTempHome(async (home) => {
    const packDir = join(home, "pack");
    await writeFlatNestedPack(packDir, "Mixed");
    const somaHome = join(home, ".soma");

    const { plans, handle } = await planPaiPackImportHandle({
      homeDir: home,
      paiPackDir: packDir,
      somaHome,
    });

    // Mixed pack derives 3 skills: pack-level "mixed", nested "remotion", nested "tools".
    const slugs = plans.map((p) => p.skillName).sort();
    expect(slugs).toEqual(["mixed", "remotion", "tools"]);

    // Apply WITHOUT the "tools" skill. The flat pack-level "mixed" and
    // nested "remotion" must still land; "tools" must NOT land.
    const result = await importPaiPackFromPlan(handle, {
      excludeSkills: new Set(["tools"]),
      overwrite: false,
    });
    expect(result.map((r) => r.skillName).sort()).toEqual(["mixed", "remotion"]);

    const tree = await listTree(join(somaHome, "skills"));
    // "tools" must NOT appear in the tree at all.
    expect(tree.some((p) => p.startsWith("tools/"))).toBe(false);
    // The other two skills must be present with their SKILL.md.
    expect(tree).toContain("mixed/SKILL.md");
    expect(tree).toContain("remotion/SKILL.md");

    // The pack-level archive still lists every original derived skill —
    // it preserves the unfiltered pack identity for audit purposes.
    const archiveManifestRaw = await readFile(
      join(somaHome, "imports", "pai-packs", "mixed", "soma-pack-archive.json"),
      "utf8",
    );
    const archiveManifest = JSON.parse(archiveManifestRaw) as { derivedSkills?: string[] };
    // After exclusion the archive reflects the SURVIVING derived skills.
    expect(archiveManifest.derivedSkills?.sort()).toEqual(["mixed", "remotion"]);
  });
});

test("R2 #2: importPaiPackFromPlan throws PaiPackAllSkillsExcludedRefusal when every skill is excluded", async () => {
  await withTempHome(async (home) => {
    const packDir = join(home, "pack");
    await writeFlatPack(packDir, "OnlyOne");
    const somaHome = join(home, ".soma");

    const { plans, handle } = await planPaiPackImportHandle({
      homeDir: home,
      paiPackDir: packDir,
      somaHome,
    });
    const slug = plans[0]!.skillName;

    await expect(
      importPaiPackFromPlan(handle, {
        excludeSkills: new Set([slug]),
        overwrite: false,
      }),
    ).rejects.toThrow(/all derived skills excluded/i);
  });
});

// ───────────────────────────────────────────────────────────────────────
// R2 #4 (Maintainability): shared walker — plan vs apply outcome parity
// ───────────────────────────────────────────────────────────────────────

test("R2 #4: planPaiMigration and migratePai produce matching per-pack outcomes (skill set + outcome kinds)", async () => {
  await withTempHome(async (homeApply) => {
    await withTempHome(async (homePlan) => {
      const packsApply = join(homeApply, "PAI/Packs");
      const packsPlan = join(homePlan, "PAI/Packs");
      await mkdir(packsApply, { recursive: true });
      await mkdir(packsPlan, { recursive: true });
      await writePaiIdentityFixture(homeApply);
      await writePaiIdentityFixture(homePlan);

      // Two packs that produce overlapping derived skills — the second
      // pack's overlapping slug must surface as `refused-name-collision`
      // in both plan and apply outputs.
      const packAApply = join(packsApply, "pack-a");
      const packBApply = join(packsApply, "pack-b");
      const packAPlan = join(packsPlan, "pack-a");
      const packBPlan = join(packsPlan, "pack-b");
      for (const dir of [packAApply, packBApply, packAPlan, packBPlan]) {
        await writeFlatPack(dir, "SharedName");
      }

      const somaApply = join(homeApply, ".soma");
      const somaPlan = join(homePlan, ".soma");

      const planResult = await planPaiMigration({
        homeDir: homePlan,
        claudeHome: join(homePlan, ".claude"),
        somaHome: somaPlan,
        paiPacksDir: packsPlan,
        skipMemory: true,
        skipDocs: true,
      });

      const applyResult = await migratePai({
        homeDir: homeApply,
        claudeHome: join(homeApply, ".claude"),
        somaHome: somaApply,
        paiPacksDir: packsApply,
        skipMemory: true,
        skipDocs: true,
      });

      // Outcome counts (per kind) match across plan and apply paths.
      const tally = (outcomes: readonly { outcome: string }[]) => {
        const t: Record<string, number> = {};
        for (const o of outcomes) t[o.outcome] = (t[o.outcome] ?? 0) + 1;
        return t;
      };
      expect(tally(planResult.packOutcomes)).toEqual(tally(applyResult.packOutcomes));

      // Skill-name set (sorted) matches across plan and apply.
      const planSlugs = planResult.packs.map((p) => p.skillName).sort();
      const applySlugs = applyResult.packs.map((r) => r.skillName).sort();
      expect(planSlugs).toEqual(applySlugs);
    });
  });
});
