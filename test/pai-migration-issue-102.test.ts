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
 *   3. Mixed substrate-specific WITH `--include-unrecognized` →
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
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { planPaiMigration } from "../src/pai-migration";
import { runSomaCli } from "../src/cli";
import {
  withMigrationHome as withSharedMigrationHome,
  writeMalformedPaiPack as makeMalformedPack,
  writePaiPackFixture as writePackFixture,
} from "./fixtures/pai-migration-fixtures";

const withMigrationHome = <T>(
  fn: (ctx: { homeDir: string; packsDir: string }) => Promise<T>,
): Promise<T> => withSharedMigrationHome(fn, "soma-102-");

/**
 * Plant a substrate-specific file inside an existing pack fixture.
 * `src/Foundation.md` is not under `src/Workflows/` or `src/Tools/`,
 * so the pack-router classifies it `unrecognized-layout`. Mirrors the
 * user-reported repro on SystemsThinking + RootCauseAnalysis.
 */
async function plantSubstrateSpecificFile(packDir: string, filename = "Foundation.md"): Promise<void> {
  await writeFile(
    join(packDir, "src", filename),
    `# ${filename.replace(".md", "")}\n\nSubstrate-specific doc.\n`,
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

test("scenario 2 (#109) — plan mixed unrecognized without flag: BOTH packs plan as imported (partial-import)", async () => {
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    const subPack = await writePackFixture(packsDir, "SubA");
    await plantSubstrateSpecificFile(subPack);
    await writePackFixture(packsDir, "Clean");
    // The critical assertion: this must NOT throw. Pre-#102 it did.
    // #109 — also no longer refuses the SubA pack; partial-import makes
    // its portable surface land alongside Clean.
    const plan = await planPaiMigration({ homeDir, paiPacksDir: packsDir });
    expect(plan.packOutcomes.length).toBe(2);
    expect(plan.packOutcomes.every((o) => o.outcome === "imported")).toBe(true);
    // Both packs appear in the planned-packs list.
    expect(plan.packs.length).toBe(2);
    expect(plan.packs.map((p) => p.skillName).sort()).toEqual(["clean", "sub-a"]);
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
  //
  // #109 — unrecognized files are now silently dropped (partial-import).
  // We still verify reserved-name refusals surface and that the outcome
  // table renders.
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
    expect(out).toContain("refused-reserved");
    expect(out).toContain("imported");
    // No skill landed on disk (plan path, not apply).
    await expect(stat(join(homeDir, ".soma/skills/healthy"))).rejects.toThrow();
  });
});

test("AC-1 — CLI parses --include-unrecognized for `migrate pai` plan-mode (passthrough)", async () => {
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    const sub = await writePackFixture(packsDir, "SubA");
    await plantSubstrateSpecificFile(sub);
    const out = await runSomaCli([
      "migrate",
      "pai",
      "--include-unrecognized",
      "--home-dir",
      homeDir,
      "--pai-packs-dir",
      packsDir,
    ]);
    // No --apply → plan output. Pack is included in the plan (imported).
    expect(out).toContain("Pack outcomes");
    expect(out).toContain("imported");
    expect(out).not.toContain("refused-unrecognized-layout");
  });
});

test("AC-4 — plan-mode CLI exit ZERO on refused-other (per #112; full plan body still emitted with footer)", async () => {
  // #109 — unrecognized files no longer refuse the pack (partial-import).
  // The remaining `refused-other` branch is still exercised below.
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
    expect(out).toContain("imported");
  });
  // #112 — plan-mode now exits 0 on `refused-other`. The full plan
  // body — including the outcome table AND the "N pack(s) failed
  // with genuine errors:" footer — is returned as the formatted
  // output (not thrown). Apply-mode keeps exit 1 per #97 AC-4;
  // that's covered in `pai-migration-issue-112.test.ts` AC-2.
  //
  // Pre-#112 this assertion was `toBeInstanceOf(SomaCliError) +
  // exitCode === 1`. #112 intentionally inverts the contract for the
  // plan path.
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    await makeMalformedPack(packsDir, "Broken");
    await writePackFixture(packsDir, "Healthy");
    const out = await runSomaCli([
      "migrate",
      "pai",
      "--home-dir",
      homeDir,
      "--pai-packs-dir",
      packsDir,
    ]);
    // No throw → exit 0. Full plan body still emitted.
    expect(out).toContain("Pack outcomes");
    expect(out).toContain("refused-other");
    expect(out).toContain("imported");
    // Footer line — the principal signal — stays in plan mode.
    expect(out).toMatch(/\d+ pack\(s\) failed with genuine errors:/);
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

test("real-world repro (#109) — SystemsThinking + RootCauseAnalysis shape: plan completes, all packs land", async () => {
  // Mimics the user's exact repro: `~/work/PAI/Packs/SystemsThinking`
  // has `src/Foundation.md`, `~/work/PAI/Packs/RootCauseAnalysis` has
  // `src/MethodSelection.md`. Before #102 the first one encountered
  // would throw `PaiPackSubstrateSpecificRefusal` out of
  // `planPaiPackImport` and abort the whole plan.
  //
  // #109 — partial-import semantics: those unrecognized files no longer
  // refuse the pack. All four packs plan as `imported`.
  await withMigrationHome(async ({ homeDir, packsDir }) => {
    const st = await writePackFixture(packsDir, "SystemsThinking");
    await plantSubstrateSpecificFile(st, "Foundation.md");
    const rca = await writePackFixture(packsDir, "RootCauseAnalysis");
    await plantSubstrateSpecificFile(rca, "MethodSelection.md");
    await writePackFixture(packsDir, "Council");
    await writePackFixture(packsDir, "RedTeam");
    // No throw. Plan returns with four imported.
    const plan = await planPaiMigration({ homeDir, paiPacksDir: packsDir });
    expect(plan.packOutcomes.length).toBe(4);
    const refused = plan.packOutcomes.filter(
      (o) => o.outcome === "refused-unrecognized-layout",
    );
    const imported = plan.packOutcomes.filter((o) => o.outcome === "imported");
    expect(refused.length).toBe(0);
    expect(imported.length).toBe(4);
    // All four imported, alphabetical.
    expect(imported.map((o) => o.skillName).sort()).toEqual([
      "council",
      "red-team",
      "root-cause-analysis",
      "systems-thinking",
    ]);
  });
});
