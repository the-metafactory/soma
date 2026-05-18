/**
 * #102 — `soma migrate pai` plan-mode log-and-continue (apply-only
 * blindspot of #97).
 *
 * #97 (PR #99) shipped log-and-continue for the apply path:
 * `migratePai` no longer aborts when a pack has substrate-specific
 * files / collides with a reserved skill name / fails for genuine
 * reasons. Each pack is classified into one of four `PaiPackOutcome`
 * buckets and the migration continues.
 *
 * Plan path was not wrapped. `planPaiMigration` calls `planPaiPackImport`
 * raw through `runBoundedConcurrent`; the first refusal escapes and
 * aborts the entire plan — exactly the symptom the user hit while
 * running `soma migrate pai --pai-repo ~/work/PAI` (no `--apply`).
 *
 * Six scenarios mirror the apply-mode tests in
 * `test/pai-migration-issue-97.test.ts` but exercise `planPaiMigration`
 * (and the CLI plan-mode surface) instead of `migratePai`:
 *
 *   1. All packs clean → every entry planned, every outcome `imported`.
 *   2. Mixed substrate-specific without flag → refused entries recorded,
 *      others planned, no throw, exit 0.
 *   3. Mixed substrate-specific WITH `--include-substrate-specific` →
 *      all entries planned (matches apply path semantics).
 *   4. Mixed reserved-collision without `--overwrite-reserved` →
 *      refused-reserved recorded, others planned, exit 0.
 *   5. Single pack genuine failure (malformed) → refused-other recorded,
 *      other packs still planned, CLI exit non-zero AFTER rest of
 *      plan completes.
 *   6. Plan output includes the per-pack outcome table — same shape
 *      as apply (AC-5).
 *
 * Plus a real-world repro scenario that mimics the user's
 * `~/work/PAI/Packs/{SystemsThinking,RootCauseAnalysis}` shape (packs
 * with `src/Foundation.md` + `src/MethodSelection.md`) and confirms
 * the plan completes without the raw throw the user originally saw.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { planPaiMigration } from "../src/pai-migration";
import { runSomaCli, SomaCliError } from "../src/cli";
import {
  withTempHome as withSharedTempHome,
  writePaiIdentityFixture as writeIdentityFixture,
  writePaiPackFixture as writePackFixture,
} from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-102-");

/**
 * Sage r1 #103 Maintainability — single-source the per-scenario
 * setup. Every test in this file writes the identity fixture and
 * derives `<homeDir>/Packs` as the packs root, so a helper keeps
 * future fixture changes one-edit-away from propagating everywhere.
 */
async function withMigrationHome<T>(
  fn: (ctx: { homeDir: string; packsDir: string }) => Promise<T>,
): Promise<T> {
  return withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    return fn({ homeDir, packsDir });
  });
}

/**
 * Plant a substrate-specific file inside an existing pack fixture.
 * `src/Foundation.md` is not under `src/Workflows/` or `src/Tools/`,
 * so the pack-router classifies it `substrate-specific`. Mirrors the
 * user-reported repro on SystemsThinking + RootCauseAnalysis.
 */
async function plantSubstrateSpecificFile(packDir: string, filename = "Foundation.md"): Promise<void> {
  await writeFile(
    join(packDir, "src", filename),
    `# ${filename.replace(".md", "")}\n\nSubstrate-specific doc.\n`,
    "utf8",
  );
}

async function makeMalformedPack(packsDir: string, packName: string): Promise<void> {
  // Missing INSTALL.md → REQUIRED_PACK_FILES check fails → buildPaiPackImportPlan
  // throws → planPaiPackImport surfaces it → orchestrator must catch it as
  // refused-other (mirrors the apply path).
  const packDir = join(packsDir, packName);
  await mkdir(join(packDir, "src"), { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    `---\nname: ${packName}\ndescription: malformed\n---\n\n# ${packName}\n`,
    "utf8",
  );
  // INSTALL.md intentionally omitted.
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
  await writeFile(
    join(packDir, "src/SKILL.md"),
    `---\nname: ${packName}\ndescription: malformed\n---\n\n# ${packName}\n`,
    "utf8",
  );
}

test("scenario 1 — plan all-packs-clean: every pack planned, every outcome `imported`", async () => {
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    await writePackFixture(packsDir, "Alpha");
    await writePackFixture(packsDir, "Beta");
    const plan = await planPaiMigration({ homeDir, paiPacksDir: packsDir });
    expect(plan.apply).toBe(false);
    expect(plan.packOutcomes.length).toBe(2);
    expect(plan.packOutcomes.every((o) => o.outcome === "imported")).toBe(true);
    expect(plan.packs.length).toBe(2);
  });
});

test("scenario 2 — plan mixed substrate-specific without flag: refused-substrate-specific, others plan, no throw", async () => {
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    const subPack = await writePackFixture(packsDir, "SubA");
    await plantSubstrateSpecificFile(subPack);
    await writePackFixture(packsDir, "Clean");
    // The critical assertion: this must NOT throw. Pre-#102 it did.
    const plan = await planPaiMigration({ homeDir, paiPacksDir: packsDir });
    expect(plan.packOutcomes.length).toBe(2);
    const subOutcome = plan.packOutcomes.find((o) =>
      /sub-a|suba/i.test(o.skillName ?? o.paiPackDir),
    );
    const cleanOutcome = plan.packOutcomes.find((o) =>
      /clean/i.test(o.skillName ?? o.paiPackDir),
    );
    expect(subOutcome?.outcome).toBe("refused-substrate-specific");
    expect(cleanOutcome?.outcome).toBe("imported");
    // Only the clean pack appears in the planned-packs list.
    expect(plan.packs.length).toBe(1);
    expect(plan.packs[0].skillName).toBe("clean");
  });
});

test("scenario 3 — plan mixed substrate-specific WITH includeSubstrateSpecific: all planned", async () => {
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    const subPack = await writePackFixture(packsDir, "SubA");
    await plantSubstrateSpecificFile(subPack);
    await writePackFixture(packsDir, "Clean");
    const plan = await planPaiMigration({
      homeDir,
      paiPacksDir: packsDir,
      includeSubstrateSpecific: true,
    });
    expect(plan.packOutcomes.every((o) => o.outcome === "imported")).toBe(true);
    expect(plan.packs.length).toBe(2);
  });
});

test("scenario 4 — plan mixed reserved-collision without overwriteReserved: refused-reserved, others plan, no throw", async () => {
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    await writePackFixture(packsDir, "ISA", { skillName: "ISA" });
    await writePackFixture(packsDir, "Clean");
    const plan = await planPaiMigration({ homeDir, paiPacksDir: packsDir });
    expect(plan.packOutcomes.length).toBe(2);
    const isaOutcome = plan.packOutcomes.find((o) => /isa/i.test(o.skillName ?? ""));
    const cleanOutcome = plan.packOutcomes.find((o) => /clean/i.test(o.skillName ?? ""));
    expect(isaOutcome?.outcome).toBe("refused-reserved");
    expect(cleanOutcome?.outcome).toBe("imported");
    expect(plan.packs.length).toBe(1);
    expect(plan.packs[0].skillName).toBe("clean");
  });
});

test("scenario 5 — plan single pack genuine failure (malformed): refused-other recorded; other packs still planned", async () => {
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    await makeMalformedPack(packsDir, "Broken");
    await writePackFixture(packsDir, "Healthy");
    const plan = await planPaiMigration({ homeDir, paiPacksDir: packsDir });
    expect(plan.packOutcomes.length).toBe(2);
    const broken = plan.packOutcomes.find((o) => /broken/i.test(o.paiPackDir));
    const healthy = plan.packOutcomes.find((o) => /healthy/i.test(o.skillName ?? ""));
    expect(broken?.outcome).toBe("refused-other");
    expect(broken?.reason).toMatch(/INSTALL\.md|required/i);
    expect(healthy?.outcome).toBe("imported");
    expect(plan.packs.length).toBe(1);
    expect(plan.packs[0].skillName).toBe("healthy");
  });
});

test("scenario 6 (AC-5) — plan output includes per-pack outcome table; CLI plan does not throw on substrate-specific", async () => {
  // CLI plan surface: NOT `--apply`, NOT `--status`. The default plan
  // mode must include the per-pack outcome table and must not throw on
  // substrate-specific packs.
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    const sub = await writePackFixture(packsDir, "SubA");
    await plantSubstrateSpecificFile(sub);
    await writePackFixture(packsDir, "ISA", { skillName: "ISA" });
    await writePackFixture(packsDir, "Healthy");
    const out = await runSomaCli([
      "migrate",
      "pai",
      "--home-dir",
      homeDir,
      "--pai-packs-dir",
      packsDir,
    ]);
    expect(out).toContain("Pack outcomes");
    expect(out).toContain("refused-substrate-specific");
    expect(out).toContain("refused-reserved");
    expect(out).toContain("imported");
    // No skill landed on disk (plan path, not apply).
    await expect(stat(join(homeDir, ".soma/skills/healthy"))).rejects.toThrow();
  });
});

test("AC-1 — CLI parses --include-substrate-specific for `migrate pai` plan-mode (passthrough)", async () => {
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    const sub = await writePackFixture(packsDir, "SubA");
    await plantSubstrateSpecificFile(sub);
    const out = await runSomaCli([
      "migrate",
      "pai",
      "--include-substrate-specific",
      "--home-dir",
      homeDir,
      "--pai-packs-dir",
      packsDir,
    ]);
    // No --apply → plan output. Pack is included in the plan (imported).
    expect(out).toContain("Pack outcomes");
    expect(out).toContain("imported");
    expect(out).not.toContain("refused-substrate-specific");
  });
});

test("AC-4 — plan-mode CLI exit non-zero when a pack outcome is refused-other (after rest of plan completes)", async () => {
  // Substrate-specific only → exit zero.
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    const sub = await writePackFixture(packsDir, "SubA");
    await plantSubstrateSpecificFile(sub);
    await writePackFixture(packsDir, "Healthy");
    const out = await runSomaCli([
      "migrate",
      "pai",
      "--home-dir",
      homeDir,
      "--pai-packs-dir",
      packsDir,
    ]);
    expect(out).toContain("refused-substrate-specific");
    expect(out).toContain("imported");
  });
  // Malformed pack → SomaCliError exitCode 1; output still includes
  // the full plan body for the other packs.
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    await makeMalformedPack(packsDir, "Broken");
    await writePackFixture(packsDir, "Healthy");
    let caught: unknown = null;
    try {
      await runSomaCli([
        "migrate",
        "pai",
        "--home-dir",
        homeDir,
        "--pai-packs-dir",
        packsDir,
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SomaCliError);
    expect((caught as SomaCliError).exitCode).toBe(1);
    // The full plan body — including the outcome table — must be in
    // the error message so the principal sees what happened.
    const msg = (caught as SomaCliError).message;
    expect(msg).toContain("Pack outcomes");
    expect(msg).toContain("refused-other");
    expect(msg).toContain("imported");
  });
});

test("Sage r2 #103 CodeQuality — inner pack-importer reserved-name throw classifies as refused-reserved (overwriteReserved bypass)", async () => {
  // Regression for Sage's r2 important finding: when --overwrite-reserved
  // is set, the outer migrate-level pre-check is skipped. The pack
  // importer's own narrower reserved set (`soma`, `the-algorithm`)
  // still throws — that throw must classify as `refused-reserved`
  // (not `refused-other`) so the outcome taxonomy stays correct and
  // the CLI exit code stays zero on a structurally-reserved name.
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    await writePackFixture(packsDir, "the-algorithm", { skillName: "the-algorithm" });
    await writePackFixture(packsDir, "Clean");
    const plan = await planPaiMigration({
      homeDir,
      paiPacksDir: packsDir,
      overwriteReserved: true,
    });
    const algo = plan.packOutcomes.find((o) => /the-algorithm/.test(o.skillName ?? ""));
    const clean = plan.packOutcomes.find((o) => /clean/i.test(o.skillName ?? ""));
    expect(algo?.outcome).toBe("refused-reserved");
    expect(algo?.skillName).toBe("the-algorithm");
    expect(clean?.outcome).toBe("imported");
  });
});

test("real-world repro — SystemsThinking + RootCauseAnalysis shape: plan completes without raw throw", async () => {
  // Mimics the user's exact repro: `~/work/PAI/Packs/SystemsThinking`
  // has `src/Foundation.md`, `~/work/PAI/Packs/RootCauseAnalysis` has
  // `src/MethodSelection.md`. Before #102 the first one encountered
  // would throw `PaiPackSubstrateSpecificRefusal` out of
  // `planPaiPackImport` and abort the whole plan.
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    const st = await writePackFixture(packsDir, "SystemsThinking");
    await plantSubstrateSpecificFile(st, "Foundation.md");
    const rca = await writePackFixture(packsDir, "RootCauseAnalysis");
    await plantSubstrateSpecificFile(rca, "MethodSelection.md");
    await writePackFixture(packsDir, "Council");
    await writePackFixture(packsDir, "RedTeam");
    // No throw. Plan returns with two refused + two imported.
    const plan = await planPaiMigration({ homeDir, paiPacksDir: packsDir });
    expect(plan.packOutcomes.length).toBe(4);
    const refused = plan.packOutcomes.filter(
      (o) => o.outcome === "refused-substrate-specific",
    );
    const imported = plan.packOutcomes.filter((o) => o.outcome === "imported");
    expect(refused.length).toBe(2);
    expect(imported.length).toBe(2);
    expect(refused.map((o) => o.skillName).sort()).toEqual([
      "root-cause-analysis",
      "systems-thinking",
    ]);
    expect(imported.map((o) => o.skillName).sort()).toEqual(["council", "red-team"]);
  });
});
