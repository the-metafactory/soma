/**
 * #98 — `soma migrate pai --pai-repo <root>` derivation.
 *
 * Eight fixture scenarios from the issue's AC-6:
 *   1. Clean derivation: `--pai-repo <root>` with valid layout, no
 *      other flags → both paths derived (source-dir + packs-dir).
 *   2. Latest-version selection: multiple semver dirs under Releases/,
 *      including `v10.0.0` to pin SEMVER-not-lexical sort.
 *   3. Ambiguous semver refusal: Releases/ exists but contains zero
 *      semver-named dirs (or only non-semver names like `Pi`, `v2.3`).
 *   4. Missing Packs refusal: Releases tree exists but no Packs/.
 *   5. Missing Releases refusal: Packs/ exists but no Releases/.
 *   6. Full explicit override: --pai-repo + --pai-source-dir + --pai-packs-dir →
 *      explicit wins, root unused.
 *   7. Partial explicit override: --pai-repo + --pai-source-dir only
 *      → source explicit, packs derived from root.
 *   8. Non-existent root refusal: --pai-repo <missing> → refuse loud.
 *
 * Targets both the library surface (`planPaiMigration` / `migratePai`
 * accepts `paiRepo` on `PaiMigrationOptions`) and the CLI surface
 * (`--pai-repo` reaches the same code path).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { migratePai, planPaiMigration } from "../src/pai-migration";
import { runSomaCli } from "../src/cli";
import {
  withTempHome as withSharedTempHome,
  writePaiIdentityFixture as writeIdentityFixture,
  writePaiPackFixture as writePackFixture,
} from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-98-");

/**
 * Plant a canonical PAI repo layout under `<homeDir>/PAI`:
 *   <homeDir>/PAI/Releases/<version>/.claude/PAI/{DOCUMENTATION,TEMPLATES,ALGORITHM}/
 *   <homeDir>/PAI/Packs/<packName>/  (one tiny pack for the bulk phase)
 *
 * Extra non-semver dirs under Releases/ may be planted to assert the
 * semver-aware filter. `versions` controls which directories appear
 * under Releases/.
 */
async function plantPaiRepoFixture(
  homeDir: string,
  options: {
    versions?: string[];
    plantPacks?: boolean;
    plantReleases?: boolean;
  } = {},
): Promise<string> {
  const root = join(homeDir, "PAI");
  const versions = options.versions ?? ["v5.0.0"];
  const plantPacks = options.plantPacks !== false;
  const plantReleases = options.plantReleases !== false;

  if (plantReleases) {
    for (const v of versions) {
      const release = join(root, "Releases", v, ".claude/PAI");
      await mkdir(join(release, "DOCUMENTATION"), { recursive: true });
      await writeFile(join(release, "DOCUMENTATION/SkillSystem.md"), "# Skills\n", "utf8");
      await mkdir(join(release, "TEMPLATES"), { recursive: true });
      await writeFile(join(release, "TEMPLATES/skill.md"), "# Template\n", "utf8");
      await mkdir(join(release, "ALGORITHM"), { recursive: true });
      await writeFile(join(release, "ALGORITHM/v6.3.0.md"), "# Algo\n", "utf8");
    }
  }
  if (plantPacks) {
    await writePackFixture(join(root, "Packs"), "TinyPack");
  }
  return root;
}

// AC-1 + AC-2 — clean derivation: --pai-repo only.
test("#98 --pai-repo derives both source-dir and packs-dir (clean layout)", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir, { withAlgorithm: true });
    const paiRoot = await plantPaiRepoFixture(homeDir);

    const plan = await planPaiMigration({
      homeDir,
      paiRepo: paiRoot,
    });

    // Derived source-dir produced a docs phase plan.
    expect(plan.docs).not.toBeNull();
    expect(plan.docs?.paiSourceDir).toContain(join("Releases", "v5.0.0", ".claude/PAI"));
    // Derived packs-dir picked up the tiny pack.
    expect(plan.packs.length).toBeGreaterThan(0);
    expect(plan.packs[0].paiPackDir).toContain(join("PAI/Packs", "TinyPack"));
  });
});

// AC-1 + AC-2 — CLI surface end-to-end with --pai-repo.
test("#98 CLI: soma migrate pai --pai-repo derives both paths", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir, { withAlgorithm: true });
    const paiRoot = await plantPaiRepoFixture(homeDir);

    const output = await runSomaCli([
      "migrate",
      "pai",
      "--pai-repo",
      paiRoot,
      "--home-dir",
      homeDir,
    ]);
    expect(output).toContain("dry-run");
    // Derived source-dir is referenced in the plan summary via the
    // docs-phase release version line. Packs discovery lands as
    // "packs: 1 discovered" (formatter doesn't echo pack names).
    expect(output).toContain("v5.0.0");
    expect(output).toContain("packs:    1 discovered");
  });
});

// AC-1 — latest-version selection uses SEMVER, not lexical sort.
test("#98 --pai-repo picks latest semver (v10.0.0 > v2.5.0 > v2.0.0 > v1.0.0)", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const paiRoot = await plantPaiRepoFixture(homeDir, {
      versions: ["v1.0.0", "v2.0.0", "v10.0.0", "v2.5.0"],
    });

    const plan = await planPaiMigration({
      homeDir,
      paiRepo: paiRoot,
    });

    expect(plan.docs?.paiSourceDir).toContain(join("Releases", "v10.0.0", ".claude/PAI"));
    expect(plan.docs?.paiSourceDir).not.toContain(join("Releases", "v2.5.0"));
  });
});

// AC-1 — also accepts bare `1.2.3` (no v prefix).
test("#98 --pai-repo accepts bare semver and v-prefixed equivalently", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const paiRoot = await plantPaiRepoFixture(homeDir, {
      versions: ["1.0.0", "v2.0.0"],
    });

    const plan = await planPaiMigration({ homeDir, paiRepo: paiRoot });

    expect(plan.docs?.paiSourceDir).toContain(join("Releases", "v2.0.0", ".claude/PAI"));
  });
});

// AC-3 — Releases/ exists but contains zero parseable semver dirs.
test("#98 --pai-repo refuses loud when Releases/ has no semver-named dirs", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    // Plant ONLY non-semver-named directories under Releases/.
    const paiRoot = await plantPaiRepoFixture(homeDir, {
      versions: ["Pi", "v2.3", "latest", "main"],
    });
    // The fixture writer didn't reject those names; it created
    // <root>/Releases/Pi/.claude/PAI etc. But none parse as 3-segment
    // semver, so derivation must refuse.

    await expect(planPaiMigration({ homeDir, paiRepo: paiRoot })).rejects.toThrow(
      /semver|no.*version/i,
    );
  });
});

// AC-3 — Releases/ exists but is empty.
test("#98 --pai-repo refuses loud when Releases/ exists but is empty", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const paiRoot = join(homeDir, "PAI");
    await mkdir(join(paiRoot, "Releases"), { recursive: true });
    await mkdir(join(paiRoot, "Packs"), { recursive: true });

    await expect(planPaiMigration({ homeDir, paiRepo: paiRoot })).rejects.toThrow(
      /semver|no.*version|empty/i,
    );
  });
});

// AC-4 — Releases/ valid but Packs/ missing.
test("#98 --pai-repo refuses loud when Packs/ is missing", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const paiRoot = await plantPaiRepoFixture(homeDir, { plantPacks: false });

    await expect(planPaiMigration({ homeDir, paiRepo: paiRoot })).rejects.toThrow(
      /Packs/,
    );
  });
});

// AC-3 — Releases/ missing.
test("#98 --pai-repo refuses loud when Releases/ is missing", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const paiRoot = await plantPaiRepoFixture(homeDir, { plantReleases: false });

    await expect(planPaiMigration({ homeDir, paiRepo: paiRoot })).rejects.toThrow(
      /Releases/,
    );
  });
});

// AC-5 — full explicit override: both --pai-source-dir and --pai-packs-dir
// override derivation, root only used for existence (or even unused if both
// explicit). Test by giving a root that lacks Releases/Packs but works
// because both explicit flags are supplied.
test("#98 explicit --pai-source-dir + --pai-packs-dir override --pai-repo derivation", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    // Plant a root with valid Releases/Packs (so --pai-repo passes the
    // existence check) BUT with a different version on disk. Then
    // explicitly point both to a DIFFERENT release tree to assert
    // the explicit flags win.
    const paiRoot = await plantPaiRepoFixture(homeDir, { versions: ["v5.0.0"] });
    // Plant a second, "explicit" tree at a different root.
    const explicitRoot = join(homeDir, "AltPAI");
    const explicitSourceDir = join(explicitRoot, "Releases/v9.9.9/.claude/PAI");
    await mkdir(join(explicitSourceDir, "DOCUMENTATION"), { recursive: true });
    await writeFile(join(explicitSourceDir, "DOCUMENTATION/x.md"), "# x\n", "utf8");
    await writePackFixture(join(explicitRoot, "Packs"), "AltPack");

    const plan = await planPaiMigration({
      homeDir,
      paiRepo: paiRoot,
      paiSourceDir: explicitSourceDir,
      paiPacksDir: join(explicitRoot, "Packs"),
    });

    // Explicit flags wins: source resolves to v9.9.9, pack is AltPack.
    expect(plan.docs?.paiSourceDir).toContain("v9.9.9");
    expect(plan.docs?.paiSourceDir).not.toContain("v5.0.0");
    expect(plan.packs.length).toBe(1);
    expect(plan.packs[0].paiPackDir).toContain("AltPack");
  });
});

// AC-5 partial — explicit --pai-source-dir only; packs still derived from
// --pai-repo.
test("#98 partial override: explicit --pai-source-dir wins, --pai-packs-dir still derived", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const paiRoot = await plantPaiRepoFixture(homeDir, { versions: ["v5.0.0"] });
    const explicitSourceDir = join(homeDir, "ExplicitSrc/.claude/PAI");
    await mkdir(join(explicitSourceDir, "DOCUMENTATION"), { recursive: true });
    await writeFile(join(explicitSourceDir, "DOCUMENTATION/y.md"), "# y\n", "utf8");

    const plan = await planPaiMigration({
      homeDir,
      paiRepo: paiRoot,
      paiSourceDir: explicitSourceDir,
    });

    // Explicit source wins.
    expect(plan.docs?.paiSourceDir).toContain("ExplicitSrc");
    // Derived packs from paiRepo.
    expect(plan.packs.length).toBeGreaterThan(0);
    expect(plan.packs[0].paiPackDir).toContain(join("PAI/Packs", "TinyPack"));
  });
});

// AC-5 partial — explicit --pai-packs-dir only; source derived from --pai-repo.
test("#98 partial override: explicit --pai-packs-dir wins, --pai-source-dir still derived", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const paiRoot = await plantPaiRepoFixture(homeDir, { versions: ["v5.0.0"] });
    const explicitPacksDir = join(homeDir, "ExplicitPacks");
    await writePackFixture(explicitPacksDir, "ExplicitPack");

    const plan = await planPaiMigration({
      homeDir,
      paiRepo: paiRoot,
      paiPacksDir: explicitPacksDir,
    });

    // Derived source from paiRepo.
    expect(plan.docs?.paiSourceDir).toContain(join("Releases/v5.0.0/.claude/PAI"));
    // Explicit packs wins.
    expect(plan.packs.length).toBe(1);
    expect(plan.packs[0].paiPackDir).toContain("ExplicitPack");
  });
});

// AC-3 — non-existent root.
test("#98 --pai-repo refuses loud when root itself does not exist", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const missing = join(homeDir, "does-not-exist");

    await expect(
      planPaiMigration({ homeDir, paiRepo: missing }),
    ).rejects.toThrow(/--pai-repo|does not exist|not found/);
  });
});

// CLI — refusals propagate through runSomaCli.
test("#98 CLI: --pai-repo with missing Releases throws non-zero", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const paiRoot = await plantPaiRepoFixture(homeDir, { plantReleases: false });

    await expect(
      runSomaCli([
        "migrate",
        "pai",
        "--pai-repo",
        paiRoot,
        "--home-dir",
        homeDir,
      ]),
    ).rejects.toThrow(/Releases/);
  });
});

// CLI — `--pai-repo` is documented in --help.
test("#98 CLI: --help mentions --pai-repo", async () => {
  const output = await runSomaCli(["migrate", "pai", "--help"]);
  expect(output).toContain("--pai-repo");
});

// Sage r1 #100 regression — --skip-skills short-circuits Packs derivation.
// The doc claims a missing/malformed Packs/ won't throw when the skill
// phase is explicitly opted out. The orchestrator-level derivation
// must honor that or the documented recovery path is wrong.
test("#98 --pai-repo with --skip-skills no longer requires Packs/", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    // Releases is valid but Packs is intentionally missing.
    const paiRoot = await plantPaiRepoFixture(homeDir, { plantPacks: false });

    // Without --skip-skills this would throw (covered above). With it
    // set, derivation must skip the Packs/ existence check entirely.
    const plan = await planPaiMigration({
      homeDir,
      paiRepo: paiRoot,
      skipSkills: true,
    });

    expect(plan.docs?.paiSourceDir).toContain(join("Releases/v5.0.0/.claude/PAI"));
    expect(plan.packs).toEqual([]);
  });
});

// migratePai (apply) — derivation propagates through to actual writes.
test("#98 migratePai --apply with --pai-repo writes manifest referencing derived release", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir, { withAlgorithm: true });
    const paiRoot = await plantPaiRepoFixture(homeDir, { versions: ["v5.0.0"] });

    const result = await migratePai({
      homeDir,
      paiRepo: paiRoot,
    });

    expect(result.docs).not.toBeNull();
    expect(result.docs?.paiSourceDir).toContain(join("Releases/v5.0.0/.claude/PAI"));
    expect(result.packs.length).toBeGreaterThan(0);
  });
});
