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
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { expect, test } from "bun:test";
import { migratePai, planPaiMigration } from "../src/index";
import {
  importPaiPack,
  importPaiPackFromPlan,
  planPaiPackImportHandle,
} from "../src/pai-pack-importer";
import { routePaiPackSourceFile } from "../src/pai-pack-routing";
import {
  withTempHome as withSharedTempHome,
  writePaiIdentityFixture,
} from "./fixtures/pai-migration-fixtures";
import { writeFlatNestedPack, writeFlatPack } from "./fixtures/pai-pack-fixtures";

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

// Sage r8 #108 (Maintainability suggestion): single source for the
// mkdtemp/rm temp-home lifecycle (in `pai-migration-fixtures.ts`).
const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-issue-108-r2-");

// Pack-writer fixtures shared via `test/fixtures/pai-pack-fixtures.ts`.

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
      const slug = resultA[0].skillName;
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
    const slug = plans[0].skillName;

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

// ───────────────────────────────────────────────────────────────────────
// R7 #1 (CodeQuality, important): pure-nested pack with reserved pack name
// ───────────────────────────────────────────────────────────────────────

test("R7 #1: pure-nested pack with reserved pack name is permitted (only archive uses packSlug)", async () => {
  await withTempHome(async (home) => {
    const packDir = join(home, "pack");
    await mkdir(packDir, { recursive: true });
    // Pack README declares a reserved name (`soma`), but the pack
    // ships ONLY nested skills — no `src/SKILL.md`. The `packSlug`
    // value here is just the archive root identifier under
    // `~/.soma/imports/pai-packs/soma/`, NOT an imported skill name.
    // The pre-R7 implementation refused this loud; the R7 fix only
    // applies the packSlug-reserved refusal when a FLAT entry exists.
    await writeFile(
      join(packDir, "README.md"),
      "---\nname: soma\ndescription: Pure nested pack happens to be named soma.\n---\n\n# soma\n",
      "utf8",
    );
    await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
    await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
    await mkdir(join(packDir, "src/Foo/Workflows"), { recursive: true });
    await writeFile(
      join(packDir, "src/Foo/SKILL.md"),
      "---\nname: Foo\ndescription: Foo nested skill.\n---\n\n# Foo\n",
      "utf8",
    );
    await writeFile(join(packDir, "src/Foo/Workflows/Default.md"), "# Default\n", "utf8");
    const somaHome = join(home, ".soma");

    const result = await importPaiPack({ homeDir: home, paiPackDir: packDir, somaHome });
    expect(result.length).toBe(1);
    expect(result[0].skillName).toBe("foo");

    // The archive landed under `imports/pai-packs/soma/` — the
    // reserved pack name is only used as an archive identifier,
    // not an imported skill name.
    const archiveExists = await readFile(
      join(somaHome, "imports/pai-packs/soma/soma-pack-archive.json"),
      "utf8",
    );
    expect(archiveExists.length).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// R9 #1 (CodeQuality, important): survivor completeness in apply path
// ───────────────────────────────────────────────────────────────────────

/**
 * Contract: when the migrate apply path calls
 * `importPaiPackFromPlan(handle, {excludeSkills})`, every survivor
 * (plan.skillName not in excludeSkills) must appear in the returned
 * items. If the importer silently drops one, the orchestrator must
 * emit a `refused-other` row for it so the principal sees a missing
 * outcome instead of a silent gap. The standard happy path (no
 * collisions, every survivor lands) is exercised by every other
 * importer test; this test exercises the contract guard.
 */
test("R9 #1: every imported pack's survivor set matches its returned item set", async () => {
  await withTempHome(async (home) => {
    const packsDir = join(home, "PAI/Packs");
    await mkdir(packsDir, { recursive: true });
    await writePaiIdentityFixture(home);
    // Multi-skill nested pack — three derived skills, none excluded.
    const packDir = join(packsDir, "MultiPack");
    await mkdir(packDir, { recursive: true });
    await writeFile(
      join(packDir, "README.md"),
      "---\nname: MultiPack\ndescription: Multi-skill pack.\n---\n\n# MultiPack\n",
      "utf8",
    );
    await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
    await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
    for (const skill of ["Alpha", "Beta", "Gamma"]) {
      await mkdir(join(packDir, "src", skill, "Workflows"), { recursive: true });
      await writeFile(
        join(packDir, "src", skill, "SKILL.md"),
        `---\nname: ${skill}\ndescription: ${skill} desc.\n---\n\n# ${skill}\n`,
        "utf8",
      );
      await writeFile(join(packDir, "src", skill, "Workflows/Default.md"), `# ${skill}\n`, "utf8");
    }

    const result = await migratePai({
      homeDir: home,
      claudeHome: join(home, ".claude"),
      somaHome: join(home, ".soma"),
      paiPacksDir: packsDir,
      skipMemory: true,
      skipDocs: true,
    });

    // All three nested skills appear as `imported` outcomes; none
    // silently dropped. (Contract violations would record an extra
    // `refused-other` row with a clear "contract violation" reason.)
    const imported = result.packOutcomes
      .filter((o) => o.outcome === "imported")
      .map((o) => o.skillName)
      .sort();
    expect(imported).toEqual(["alpha", "beta", "gamma"]);
    const contractViolations = result.packOutcomes.filter(
      (o) => o.outcome === "refused-other" && o.reason?.includes("contract violation"),
    );
    expect(contractViolations).toEqual([]);
  });
});

test("R7 #1: nested skill itself in reserved set is still refused (per-derived-skill check fires)", async () => {
  await withTempHome(async (home) => {
    const packDir = join(home, "pack");
    await mkdir(packDir, { recursive: true });
    await writeFile(
      join(packDir, "README.md"),
      "---\nname: ValidPack\ndescription: Valid pack with reserved nested.\n---\n\n# ValidPack\n",
      "utf8",
    );
    await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
    await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
    // Nested skill named "soma" — genuinely reserved as an IMPORTED
    // skill name. The per-derived-skill loop below must still refuse.
    await mkdir(join(packDir, "src/soma/Workflows"), { recursive: true });
    await writeFile(
      join(packDir, "src/soma/SKILL.md"),
      "---\nname: soma\ndescription: Tries to be soma.\n---\n\n# soma\n",
      "utf8",
    );
    await writeFile(join(packDir, "src/soma/Workflows/Default.md"), "# Default\n", "utf8");
    const somaHome = join(home, ".soma");

    await expect(
      importPaiPack({ homeDir: home, paiPackDir: packDir, somaHome }),
    ).rejects.toThrow(/reserved Soma skill 'soma'/i);
  });
});

// ───────────────────────────────────────────────────────────────────────
// R5 #2 (Security, blocker): forged handles are rejected
// ───────────────────────────────────────────────────────────────────────

test("R5 #2: importPaiPackFromPlan rejects a forged handle (not produced by planPaiPackImportHandle)", async () => {
  await withTempHome(async (home) => {
    const somaHome = join(home, ".soma");
    await mkdir(somaHome, { recursive: true });
    // Forge a handle that matches the structural interface but was
    // NOT registered in the module-private trusted WeakSet.
    const forged = { __brand: "PaiPackImportPlanHandle" as const };
    await expect(
       
      importPaiPackFromPlan(forged as any, { overwrite: false }),
    ).rejects.toThrow(/was not produced by planPaiPackImportHandle/i);
  });
});

test("R5 #2: importPaiPackFromPlan rejects null and non-object handles", async () => {
  await expect(
     
    importPaiPackFromPlan(null as any),
  ).rejects.toThrow(/must be a PaiPackImportPlanHandle/i);
  await expect(
     
    importPaiPackFromPlan("nope" as any),
  ).rejects.toThrow(/must be a PaiPackImportPlanHandle/i);
});

test("R6 #1: legitimate handle carries NO addressable plan state (immutable)", async () => {
  await withTempHome(async (home) => {
    const packDir = join(home, "pack");
    await writeFlatPack(packDir, "Immutable");
    const somaHome = join(home, ".soma");

    const { handle } = await planPaiPackImportHandle({
      homeDir: home,
      paiPackDir: packDir,
      somaHome,
    });

    // The handle must be frozen and carry no addressable plan/options
    // a malicious caller could mutate. The plan lives in the
    // module-private WeakMap, not on the handle.
    expect(Object.isFrozen(handle)).toBe(true);
    const keys = Object.keys(handle);
    expect(keys).toEqual(["__brand"]);
     
    expect((handle as any).plan).toBeUndefined();
     
    expect((handle as any).options).toBeUndefined();
    // Mutation attempts must NOT silently install a `.plan` either.
    expect(() => {
       
      (handle as any).plan = { evil: true };
    }).toThrow(); // frozen object → strict mode TypeError
     
    expect((handle as any).plan).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────
// R5 #1 (CodeQuality, important): nested SKILL.md descriptions are preserved
// ───────────────────────────────────────────────────────────────────────

test("R5 #1: nested skill's own SKILL.md description is preserved (not clobbered with generic string)", async () => {
  await withTempHome(async (home) => {
    const packDir = join(home, "pack");
    await mkdir(join(packDir, "src/Remotion/Workflows"), { recursive: true });
    await writeFile(
      join(packDir, "README.md"),
      "---\nname: MultiSkillPack\ndescription: Pack-level description.\n---\n\n# MultiSkillPack\n",
      "utf8",
    );
    await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
    await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
    // Nested skill with its OWN, distinctive description.
    const nestedDescription = "Render videos via Remotion from React components.";
    await writeFile(
      join(packDir, "src/Remotion/SKILL.md"),
      `---\nname: Remotion\ndescription: ${nestedDescription}\n---\n\n# Remotion\n`,
      "utf8",
    );
    await writeFile(
      join(packDir, "src/Remotion/Workflows/Render.md"),
      "# Render\n",
      "utf8",
    );
    const somaHome = join(home, ".soma");
    await importPaiPack({ homeDir: home, paiPackDir: packDir, somaHome });

    // The nested skill's SKILL.md MUST carry its own description in
    // the rewritten frontmatter — NOT the generic
    // `Imported PAI nested skill: Remotion` string.
    const remotionSkillMd = await readFile(join(somaHome, "skills/remotion/SKILL.md"), "utf8");
    expect(remotionSkillMd).toContain(nestedDescription);
    expect(remotionSkillMd).not.toContain("Imported PAI nested skill");

    // Same in the soma-skill.json manifest.
    const remotionManifestRaw = await readFile(join(somaHome, "skills/remotion/soma-skill.json"), "utf8");
    const remotionManifest = JSON.parse(remotionManifestRaw) as { description?: string };
    expect(remotionManifest.description).toBe(nestedDescription);
  });
});

test("R5 #1: nested skill missing description falls back to generic", async () => {
  await withTempHome(async (home) => {
    const packDir = join(home, "pack");
    await mkdir(join(packDir, "src/Bare/Workflows"), { recursive: true });
    await writeFile(
      join(packDir, "README.md"),
      "---\nname: BarePack\ndescription: Bare pack.\n---\n\n# BarePack\n",
      "utf8",
    );
    await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
    await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
    // Nested SKILL.md without a description field at all.
    await writeFile(
      join(packDir, "src/Bare/SKILL.md"),
      "---\nname: Bare\n---\n\n# Bare\n",
      "utf8",
    );
    await writeFile(join(packDir, "src/Bare/Workflows/Default.md"), "# Default\n", "utf8");
    const somaHome = join(home, ".soma");
    await importPaiPack({ homeDir: home, paiPackDir: packDir, somaHome });

    const manifestRaw = await readFile(join(somaHome, "skills/bare/soma-skill.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as { description?: string };
    // Fallback string is the generic one (this is the legacy behavior
    // for a nested skill that genuinely has no description).
    expect(manifest.description).toContain("Imported PAI nested skill");
  });
});

// ───────────────────────────────────────────────────────────────────────
// R3 #3 (CodeQuality): flat-vs-nested collision sources use RAW name
// ───────────────────────────────────────────────────────────────────────

test("R3 #3: FLAT-vs-nested collision refusal reports RAW nested dir name (not kebab slug)", async () => {
  await withTempHome(async (home) => {
    const packDir = join(home, "pack");
    await mkdir(join(packDir, "src/PAIUpgrade"), { recursive: true });
    await writeFile(
      join(packDir, "README.md"),
      "---\nname: PAIUpgrade\ndescription: collision\n---\n\n# PAIUpgrade\n",
      "utf8",
    );
    await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
    await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
    // Pack-level slug is "pai-upgrade"; nested skill named "PAIUpgrade"
    // ALSO kebabs to "pai-upgrade". The refusal must point at the
    // real on-disk path `src/PAIUpgrade/SKILL.md`, not the kebab-cased
    // `src/pai-upgrade/SKILL.md` (which does not exist).
    await writeFile(
      join(packDir, "src/SKILL.md"),
      "---\nname: PAIUpgrade\ndescription: flat\n---\n\n# PAIUpgrade\n",
      "utf8",
    );
    await writeFile(
      join(packDir, "src/PAIUpgrade/SKILL.md"),
      "---\nname: PAIUpgrade\ndescription: nested\n---\n\n# PAIUpgrade\n",
      "utf8",
    );
    const somaHome = join(home, ".soma");

    let caught: unknown = null;
    try {
      await importPaiPack({ homeDir: home, paiPackDir: packDir, somaHome });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeTruthy();
    const message = (caught as Error).message;
    expect(message).toContain("src/PAIUpgrade/SKILL.md");
    expect(message).not.toContain("src/pai-upgrade/SKILL.md");
  });
});

// ───────────────────────────────────────────────────────────────────────
// R4 #1 (CodeQuality, important): failed apply does NOT reserve slug
// ───────────────────────────────────────────────────────────────────────

/**
 * Sage r4 #108 contract: a pack that fails mid-apply MUST NOT reserve
 * its derived skill slug for cross-pack collision tracking. Pack-a
 * fails as `refused-other`; pack-b with the same slug should still
 * be attempted (and either land cleanly or fail on its own merits)
 * rather than spuriously refused as `refused-name-collision`.
 *
 * To produce a deterministic apply-time `refused-other`, pack-a is
 * built with a forbidden path the importer rejects during enumeration
 * (`PAI pack import refused likely secret file(s):`). The migrate
 * orchestrator catches this as `refused-other` (it's a plain Error,
 * not a typed refusal). Pack-b is a clean pack with the same skill
 * slug.
 */
test("R4 #1: pack-a failure does NOT reserve slug — pack-b with same slug still attempted", async () => {
  await withTempHome(async (home) => {
    const packsDir = join(home, "PAI/Packs");
    await mkdir(packsDir, { recursive: true });
    await writePaiIdentityFixture(home);

    // pack-a sorts before pack-b alphabetically. Build pack-a with a
    // file the importer refuses to enumerate (a `.env`).
    const packA = join(packsDir, "pack-a");
    await writeFlatPack(packA, "Shared");
    await writeFile(join(packA, ".env"), "SECRET=oops\n", "utf8");

    // pack-b is clean and produces the same derived skill slug.
    const packB = join(packsDir, "pack-b");
    await writeFlatPack(packB, "Shared");

    const result = await migratePai({
      homeDir: home,
      claudeHome: join(home, ".claude"),
      somaHome: join(home, ".soma"),
      paiPacksDir: packsDir,
      skipMemory: true,
      skipDocs: true,
    });

    // pack-a fails (refused-other) — its slug "shared" was never
    // reserved. pack-b is therefore free to land its own "shared".
    const packBOutcomes = result.packOutcomes.filter((o) => o.paiPackDir === packB);
    const packBCollision = packBOutcomes.find((o) => o.outcome === "refused-name-collision");
    expect(packBCollision).toBeUndefined();
    // Pack-b must have landed successfully — its "shared" skill is on disk.
    const packBImported = packBOutcomes.find((o) => o.outcome === "imported" && o.skillName === "shared");
    expect(packBImported).toBeDefined();
  });
});
