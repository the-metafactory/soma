/**
 * Issue 109 — pai-pack-importer: nested-bundle detection from #105 does
 * NOT catch real PAI pack layouts.
 *
 * Root cause (verified by tracing real PAI packs Art, Thinking,
 * Utilities through `buildPaiPackImportPlan` against `~/work/PAI/Packs/`):
 *
 *   When ANY single file in a pack routes as `unrecognized-layout`,
 *   `buildPaiPackImportPlan` throws `PaiPackUnrecognizedLayoutRefusal`
 *   for the entire pack, refusing every recognized portable file with
 *   it. Real PAI packs ALWAYS ship a mix of:
 *     - portable nested skills (`src/<Name>/SKILL.md`,
 *       `src/<Name>/Workflows/*`)
 *     - unrecognized siblings (`src/<Name>/Examples.md`,
 *       `src/<Name>/Assets/*`, `src/Lib/*`, etc.)
 *
 *   This is hypothesis 5 from the issue ("pack-level outcome poisoning") —
 *   per-pack outcome was binary instead of per-file.
 *
 * Fix:
 *   - Without `--include-unrecognized`: unrecognized files are silently
 *     DROPPED from the routed set (not archived). Portable files land
 *     in their derived-skill directories. Pack outcome stays `imported`
 *     with `unrecognizedFileCount` on the outcome row for transparency.
 *   - With `--include-unrecognized`: same as before — unrecognized files
 *     ALSO land in the pack-level archive.
 *
 * Why the synthetic #105 tests didn't catch this:
 *   The `AC-1+3: nested skill with non-recognized sibling (Assets/)` test
 *   in `pai-pack-importer-issue-105.test.ts` explicitly asserted the OLD
 *   refuse-whole-pack behavior (`.rejects.toThrow("unrecognized-layout")`).
 *   That assertion pinned the bug as desired behavior. Real PAI packs
 *   all have such siblings, so EVERY non-trivial real pack triggered the
 *   refuse path. The synthetic happy-path tests (AC-2, AC-3, AC-4) all
 *   used `writeNestedSkill` without `extras`, so they NEVER produced an
 *   unrecognized file and NEVER exercised the failing branch.
 *
 * Acceptance criteria (mirrors issue 109):
 *   - AC-1: Real-PAI-shaped fixtures (nested skills + unrecognized
 *           siblings at the same level) import their nested skills cleanly
 *           WITHOUT `--include-unrecognized`.
 *   - AC-2: Named packs (`Art`, `Thinking`-style, `Utilities`-style) land
 *           ALL their nested skills.
 *   - AC-3: Unrecognized file count surfaces on the result for
 *           transparency (not silently invisible).
 *   - AC-4: With `--include-unrecognized` the unrecognized siblings still
 *           land in the pack-level archive (back-compat).
 *   - AC-5: Pack with ONLY unrecognized files (no portable entrypoint)
 *           still fails the entrypoint check (refuses).
 */
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { migratePai } from "../src/pai-migration";
import { importPaiPack, planPaiPackImport } from "../src/index";
import { writePaiIdentityFixture as writeIdentityFixture } from "./fixtures/pai-migration-fixtures";
import { withTempHome as withSharedTempHome } from "./fixtures/pai-migration-fixtures";
import {
  writeFlatPack,
  writeNestedPackShell,
  writeNestedSkill,
} from "./fixtures/pai-pack-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-issue-109-");

// ───────────────────────────────────────────────────────────────────────
// Real-PAI-shaped fixture builders (mirror the actual layouts under
// `~/work/PAI/Packs/{Art,Thinking,Utilities}`).
// ───────────────────────────────────────────────────────────────────────

/**
 * Mirror of `~/work/PAI/Packs/Art/`:
 *   src/SKILL.md                           (FLAT entry, portable)
 *   src/Workflows/{Essay,Mermaid}.md       (FLAT portable)
 *   src/Tools/{Generate,Compose}.ts        (FLAT portable)
 *   src/Examples/sample.png                (FLAT portable — Examples is recognized)
 *   src/HeadshotExamples/headshot.png      (UNRECOGNIZED — not in NESTED_PORTABLE_SUBDIRS,
 *                                           and at pack root so no nested override)
 *   src/Lib/discord-bot.ts                 (UNRECOGNIZED — pack-specific tooling)
 *   src/ThumbnailExamples/thumb.png        (UNRECOGNIZED)
 *
 * Critical: ONLY one nested skill could be derived, but the FLAT shape
 * is what Art ships. The unrecognized siblings should NOT poison the
 * pack — `art` should land with its portable files.
 */
async function writeArtLikePack(packDir: string): Promise<void> {
  await mkdir(join(packDir, "src/Workflows"), { recursive: true });
  await mkdir(join(packDir, "src/Tools"), { recursive: true });
  await mkdir(join(packDir, "src/HeadshotExamples"), { recursive: true });
  await mkdir(join(packDir, "src/Lib"), { recursive: true });
  await mkdir(join(packDir, "src/ThumbnailExamples"), { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    ["---", "name: Art", "description: Art pack", "---", "", "# Art", "", "Pack docs.\n"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
  await writeFile(
    join(packDir, "src/SKILL.md"),
    ["---", "name: Art", "description: Art skill", "---", "", "# Art", "", "Body.\n"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "src/Workflows/Essay.md"), "# Essay\n", "utf8");
  await writeFile(join(packDir, "src/Workflows/Mermaid.md"), "# Mermaid\n", "utf8");
  await writeFile(join(packDir, "src/Tools/Generate.ts"), "// generate\n", "utf8");
  await writeFile(join(packDir, "src/Tools/Compose.ts"), "// compose\n", "utf8");
  // Unrecognized siblings — real Art pack ships these.
  await writeFile(join(packDir, "src/HeadshotExamples/headshot.png"), "PNG\n", "utf8");
  await writeFile(join(packDir, "src/Lib/discord-bot.ts"), "// bot\n", "utf8");
  await writeFile(join(packDir, "src/ThumbnailExamples/thumb.png"), "PNG\n", "utf8");
}

/**
 * Mirror of `~/work/PAI/Packs/Thinking/`:
 *   src/BeCreative/SKILL.md           (nested portable)
 *   src/BeCreative/Workflows/X.md     (nested portable)
 *   src/BeCreative/Examples.md        (UNRECOGNIZED — at nested root, not under recognized subdir)
 *   src/BeCreative/Principles.md      (UNRECOGNIZED)
 *   src/BeCreative/Assets/template.md (UNRECOGNIZED — Assets is not in NESTED_PORTABLE_SUBDIRS)
 *   src/Council/SKILL.md              (nested portable)
 *   src/Council/CouncilMembers.md     (UNRECOGNIZED)
 *
 * Critical: BOTH nested skills should land. The unrecognized siblings
 * (top-level files at the nested-skill root + unknown subdirs) must not
 * poison the pack.
 */
async function writeThinkingLikePack(packDir: string): Promise<void> {
  await writeNestedPackShell(packDir, "Thinking");
  // BeCreative — has portable Workflows AND unrecognized siblings.
  await mkdir(join(packDir, "src/BeCreative/Workflows"), { recursive: true });
  await mkdir(join(packDir, "src/BeCreative/Assets"), { recursive: true });
  await writeFile(
    join(packDir, "src/BeCreative/SKILL.md"),
    ["---", "name: BeCreative", "description: nested skill", "---", "", "# BeCreative", "", "Body.\n"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "src/BeCreative/Workflows/IdeaGeneration.md"), "# Ideas\n", "utf8");
  await writeFile(join(packDir, "src/BeCreative/Examples.md"), "# Examples\n", "utf8"); // unrecognized
  await writeFile(join(packDir, "src/BeCreative/Principles.md"), "# Principles\n", "utf8"); // unrecognized
  await writeFile(join(packDir, "src/BeCreative/Assets/template.md"), "template\n", "utf8"); // unrecognized
  // Council — has portable Workflows AND unrecognized siblings.
  await mkdir(join(packDir, "src/Council/Workflows"), { recursive: true });
  await writeFile(
    join(packDir, "src/Council/SKILL.md"),
    ["---", "name: Council", "description: nested skill", "---", "", "# Council", "", "Body.\n"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "src/Council/Workflows/Debate.md"), "# Debate\n", "utf8");
  await writeFile(join(packDir, "src/Council/CouncilMembers.md"), "# Members\n", "utf8"); // unrecognized
}

/**
 * Mirror of `~/work/PAI/Packs/Utilities/`:
 *   src/Evals/SKILL.md             (nested portable)
 *   src/Evals/Workflows/*          (nested portable)
 *   src/Evals/Tools/*              (nested portable)
 *   src/Evals/Types/*              (UNRECOGNIZED — Types not in NESTED_PORTABLE_SUBDIRS)
 *   src/Evals/Suites/*             (UNRECOGNIZED)
 *   src/Evals/Data/*               (UNRECOGNIZED)
 *   src/Evals/Graders/*            (UNRECOGNIZED)
 *   src/Evals/UseCases/*           (UNRECOGNIZED)
 *   src/Browser/SKILL.md           (nested portable)
 *   src/Browser/Workflows/*        (nested portable)
 *   src/CreateCLI/SKILL.md         (nested portable)
 */
async function writeUtilitiesLikePack(packDir: string): Promise<void> {
  await writeNestedPackShell(packDir, "Utilities");
  // Evals — many unrecognized subdirs.
  await mkdir(join(packDir, "src/Evals/Workflows"), { recursive: true });
  await mkdir(join(packDir, "src/Evals/Tools"), { recursive: true });
  await mkdir(join(packDir, "src/Evals/Types"), { recursive: true });
  await mkdir(join(packDir, "src/Evals/Suites"), { recursive: true });
  await mkdir(join(packDir, "src/Evals/Data"), { recursive: true });
  await mkdir(join(packDir, "src/Evals/Graders"), { recursive: true });
  await mkdir(join(packDir, "src/Evals/UseCases"), { recursive: true });
  await writeFile(
    join(packDir, "src/Evals/SKILL.md"),
    ["---", "name: Evals", "description: nested skill", "---", "", "# Evals\n"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "src/Evals/Workflows/Run.md"), "# Run\n", "utf8");
  await writeFile(join(packDir, "src/Evals/Tools/Eval.ts"), "// eval\n", "utf8");
  // Unrecognized sub-subdirs — Evals/<unknown>/file.
  await writeFile(join(packDir, "src/Evals/Types/schema.ts"), "// types\n", "utf8");
  await writeFile(join(packDir, "src/Evals/Suites/case.ts"), "// suite\n", "utf8");
  await writeFile(join(packDir, "src/Evals/Data/sample.json"), "{}\n", "utf8");
  await writeFile(join(packDir, "src/Evals/Graders/judge.ts"), "// grader\n", "utf8");
  await writeFile(join(packDir, "src/Evals/UseCases/case.md"), "# case\n", "utf8");
  // Browser + CreateCLI — plain nested skills.
  await writeNestedSkill(packDir, "Browser");
  await writeNestedSkill(packDir, "CreateCLI");
}

// ───────────────────────────────────────────────────────────────────────
// AC-1: Real-PAI-shaped fixtures land their portable files (FLAT pack
// with unrecognized siblings)
// ───────────────────────────────────────────────────────────────────────

test("AC-1: Art-like FLAT pack with unrecognized siblings lands portable files cleanly", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Art");
    await writeArtLikePack(packDir);

    // Without --include-unrecognized, the pack should STILL import its
    // portable surface. The unrecognized siblings should be dropped.
    const results = await importPaiPack({ homeDir, paiPackDir: packDir });
    expect(results).toHaveLength(1);
    expect(results[0].skillName).toBe("art");

    // Portable files MUST land.
    const skillMd = join(homeDir, ".soma/skills/art/SKILL.md");
    const essay = join(homeDir, ".soma/skills/art/Workflows/Essay.md");
    const generate = join(homeDir, ".soma/skills/art/Tools/Generate.ts");
    expect((await readFile(skillMd, "utf8")).length).toBeGreaterThan(0);
    expect((await readFile(essay, "utf8")).length).toBeGreaterThan(0);
    expect((await readFile(generate, "utf8")).length).toBeGreaterThan(0);

    // Unrecognized siblings MUST NOT land in the skill directory.
    const headshot = join(homeDir, ".soma/skills/art/HeadshotExamples/headshot.png");
    const lib = join(homeDir, ".soma/skills/art/Lib/discord-bot.ts");
    await expect(readFile(headshot, "utf8")).rejects.toThrow();
    await expect(readFile(lib, "utf8")).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-2: Thinking-style pack — multiple nested skills with unrecognized
// siblings at the nested-skill root
// ───────────────────────────────────────────────────────────────────────

test("AC-2: Thinking-like pack lands all nested skills despite unrecognized siblings", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Thinking");
    await writeThinkingLikePack(packDir);

    const results = await importPaiPack({ homeDir, paiPackDir: packDir });
    const skillNames = results.map((r) => r.skillName).sort();
    expect(skillNames).toEqual(["be-creative", "council"]);

    // Each nested skill's SKILL.md + Workflows must land.
    for (const slug of ["be-creative", "council"]) {
      const skillMd = join(homeDir, ".soma/skills", slug, "SKILL.md");
      expect((await readFile(skillMd, "utf8")).length).toBeGreaterThan(0);
    }
    // Specific portable nested workflow files land.
    const idea = join(homeDir, ".soma/skills/be-creative/Workflows/IdeaGeneration.md");
    const debate = join(homeDir, ".soma/skills/council/Workflows/Debate.md");
    expect((await readFile(idea, "utf8")).length).toBeGreaterThan(0);
    expect((await readFile(debate, "utf8")).length).toBeGreaterThan(0);

    // Unrecognized siblings (Examples.md, Principles.md, Assets/) at the
    // nested-skill root MUST NOT land under the skill directory by default.
    const badExamples = join(homeDir, ".soma/skills/be-creative/Examples.md");
    const badPrinciples = join(homeDir, ".soma/skills/be-creative/Principles.md");
    const badAssets = join(homeDir, ".soma/skills/be-creative/Assets/template.md");
    const badMembers = join(homeDir, ".soma/skills/council/CouncilMembers.md");
    await expect(readFile(badExamples, "utf8")).rejects.toThrow();
    await expect(readFile(badPrinciples, "utf8")).rejects.toThrow();
    await expect(readFile(badAssets, "utf8")).rejects.toThrow();
    await expect(readFile(badMembers, "utf8")).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-2: Utilities-style pack — many nested skills, mix of recognized
// and unrecognized sub-subdirs
// ───────────────────────────────────────────────────────────────────────

test("AC-2: Utilities-like pack lands all nested skills (Evals/Browser/CreateCLI)", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Utilities");
    await writeUtilitiesLikePack(packDir);

    const results = await importPaiPack({ homeDir, paiPackDir: packDir });
    const skillNames = results.map((r) => r.skillName).sort();
    expect(skillNames).toEqual(["browser", "create-cli", "evals"]);

    // Evals — portable Workflows + Tools land; unrecognized
    // Types/Suites/Data/Graders/UseCases do NOT.
    const evalsRun = join(homeDir, ".soma/skills/evals/Workflows/Run.md");
    const evalsTool = join(homeDir, ".soma/skills/evals/Tools/Eval.ts");
    expect((await readFile(evalsRun, "utf8")).length).toBeGreaterThan(0);
    expect((await readFile(evalsTool, "utf8")).length).toBeGreaterThan(0);
    const badTypes = join(homeDir, ".soma/skills/evals/Types/schema.ts");
    const badSuites = join(homeDir, ".soma/skills/evals/Suites/case.ts");
    const badData = join(homeDir, ".soma/skills/evals/Data/sample.json");
    await expect(readFile(badTypes, "utf8")).rejects.toThrow();
    await expect(readFile(badSuites, "utf8")).rejects.toThrow();
    await expect(readFile(badData, "utf8")).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-3: planPaiPackImport returns plans even with unrecognized siblings
// ───────────────────────────────────────────────────────────────────────

test("AC-3: planPaiPackImport returns plans for real-PAI-shaped pack (no throw)", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Art");
    await writeArtLikePack(packDir);

    const plans = await planPaiPackImport({ homeDir, paiPackDir: packDir });
    expect(plans).toHaveLength(1);
    expect(plans[0].skillName).toBe("art");
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-4: With --include-unrecognized, unrecognized files still land in
// the pack archive (back-compat)
// ───────────────────────────────────────────────────────────────────────

test("AC-4: --include-unrecognized still archives unrecognized siblings", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Art");
    await writeArtLikePack(packDir);

    const results = await importPaiPack({
      homeDir,
      paiPackDir: packDir,
      includeSubstrateSpecific: true,
    });
    expect(results).toHaveLength(1);

    // Unrecognized files DO land in the pack-level archive.
    const archivedHeadshot = join(
      homeDir,
      ".soma/imports/pai-packs/art/source/src/HeadshotExamples/headshot.png",
    );
    const archivedLib = join(
      homeDir,
      ".soma/imports/pai-packs/art/source/src/Lib/discord-bot.ts",
    );
    expect((await readFile(archivedHeadshot, "utf8")).length).toBeGreaterThan(0);
    expect((await readFile(archivedLib, "utf8")).length).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-5: Pack with ONLY unrecognized files (no portable entrypoint)
// still fails the entrypoint check
// ───────────────────────────────────────────────────────────────────────

test("AC-5: pack with no portable entrypoint still refuses (entrypoint check)", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/NoEntry");
    await mkdir(join(packDir, "src/Lib"), { recursive: true });
    await writeFile(
      join(packDir, "README.md"),
      ["---", "name: NoEntry", "description: no entry", "---", "", "# NoEntry\n"].join("\n"),
      "utf8",
    );
    await writeFile(join(packDir, "INSTALL.md"), "# I\n", "utf8");
    await writeFile(join(packDir, "VERIFY.md"), "# V\n", "utf8");
    await writeFile(join(packDir, "src/Lib/code.ts"), "// no skill\n", "utf8");
    // No src/SKILL.md AND no src/<Name>/SKILL.md → entrypoint check refuses.
    await expect(importPaiPack({ homeDir, paiPackDir: packDir })).rejects.toThrow(/V0 pack file/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Regression: synthetic happy-path packs (no unrecognized files) still
// import unchanged — proves the fix doesn't break the green path.
// ───────────────────────────────────────────────────────────────────────

test("Regression: FLAT pack with no unrecognized siblings still imports as one skill", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Flat");
    await writeFlatPack(packDir, "Flat");
    const results = await importPaiPack({ homeDir, paiPackDir: packDir });
    expect(results).toHaveLength(1);
    expect(results[0].skillName).toBe("flat");
  });
});

test("Regression: nested-only pack with no unrecognized siblings imports all nested skills", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Media");
    await writeNestedPackShell(packDir, "Media");
    await writeNestedSkill(packDir, "Art");
    await writeNestedSkill(packDir, "Remotion");
    const results = await importPaiPack({ homeDir, paiPackDir: packDir });
    expect(results.map((r) => r.skillName).sort()).toEqual(["art", "remotion"]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-1 smoke: real-PAI-pack regression
//
// Guarded behind the existence of `~/work/PAI/Packs` so the suite remains
// hermetic in environments without it (CI, fresh checkout). When the real
// packs ARE available (developer machine), this test enforces the issue's
// AC-1 (≥30 skills land) + AC-2 (named skills are present) directly
// against the actual upstream collection.
// ───────────────────────────────────────────────────────────────────────

async function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

const REAL_PAI_REPO = join(homedir(), "work/PAI");
const REAL_PAI_PACKS = join(REAL_PAI_REPO, "Packs");

const NAMED_SKILLS_FROM_ISSUE_109 = [
  "art",
  "remotion",
  "be-creative",
  "council",
  "first-principles",
  "iterative-depth",
  "red-team",
  "science",
  "world-threat-model-harness",
  "aphorisms",
  "audio-editor",
  "browser",
  "cloudflare",
  "create-cli",
  "delegation",
  "documents",
  "evals",
  "fabric",
  "pai-upgrade",
  "parser",
  "prompting",
] as const;

test("AC-1 / AC-2 smoke: real ~/work/PAI/Packs lands ≥30 skills incl. named issue-109 skills", async () => {
  // Hermetic guard — skip when real packs aren't available.
  if (!(await pathExists(REAL_PAI_PACKS))) {
    return;
  }

  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const result = await migratePai({
      homeDir,
      paiRepo: REAL_PAI_REPO,
      paiPacksDir: REAL_PAI_PACKS,
    });

    // AC-1: at least 30 skills land.
    const skillsDir = join(homeDir, ".soma/skills");
    const landedSkills = await readdir(skillsDir);
    expect(landedSkills.length).toBeGreaterThanOrEqual(30);

    // AC-2: every named skill from the issue landed.
    for (const name of NAMED_SKILLS_FROM_ISSUE_109) {
      expect(landedSkills).toContain(name);
    }

    // Cross-check: the migratePai outcome rows record at least 30 imported.
    const importedOutcomes = result.packOutcomes.filter((o) => o.outcome === "imported");
    expect(importedOutcomes.length).toBeGreaterThanOrEqual(30);
  });
});
