/**
 * #97 — soma migrate pai per-pack log-and-continue semantics.
 *
 * Five fixture scenarios from the issue's AC-5:
 *   1. All packs clean → all imported.
 *   2. Mixed substrate-specific without flag → substrate packs refused
 *      with outcome `refused-unrecognized-layout`, others import, exit 0.
 *   3. Mixed substrate-specific WITH `--include-unrecognized` →
 *      all import.
 *   4. Mixed reserved-collision without `--overwrite-reserved` →
 *      `refused-reserved` recorded, others import, exit 0.
 *   5. Single pack genuine failure (malformed) →
 *      `refused-other` recorded, other packs still attempted, exit
 *      non-zero on the CLI surface.
 *
 * AC-3 surface (manifest contains per-pack outcomes; --status reads
 * them) is covered by a sixth test that asserts MIGRATION.md body
 * fingerprint contains the per-pack outcome lines.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { migratePai } from "../src/pai-migration";
import { runSomaCli, SomaCliError } from "../src/cli";
import {
  withTempHome as withSharedTempHome,
  writePaiIdentityFixture as writeIdentityFixture,
  writeMalformedPaiPack as makeMalformedPack,
  writePaiPackFixture as writePackFixture,
} from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-97-");

/**
 * Plant a substrate-specific file inside an existing pack fixture.
 * `src/Foundation.md` is not under `src/Workflows/` or `src/Tools/`,
 * so the pack-router classifies it `unrecognized-layout`. This mirrors
 * the user-reported repro on SystemsThinking + RootCauseAnalysis.
 */
async function plantSubstrateSpecificFile(packDir: string): Promise<void> {
  await writeFile(
    join(packDir, "src/Foundation.md"),
    "# Foundation\n\nSubstrate-specific doc.\n",
    "utf8",
  );
}

test("scenario 1 — all-packs-clean: every pack imports, every outcome is `imported`", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await writePackFixture(packsDir, "Alpha");
    await writePackFixture(packsDir, "Beta");
    const result = await migratePai({ homeDir, paiPacksDir: packsDir });
    expect(result.packOutcomes.length).toBe(2);
    expect(result.packOutcomes.every((o) => o.outcome === "imported")).toBe(true);
    expect(result.packs.length).toBe(2);
  });
});

test("scenario 2 (#109) — mixed unrecognized without flag: both packs import (partial-import semantics)", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    const subPack = await writePackFixture(packsDir, "SubA");
    await plantSubstrateSpecificFile(subPack);
    await writePackFixture(packsDir, "Clean");
    const result = await migratePai({ homeDir, paiPacksDir: packsDir });
    // #109 — the unrecognized sibling no longer poisons the SubA pack;
    // both packs land their portable surfaces. Pre-#109 this was
    // `refused-unrecognized-layout` for SubA (the pack-level poisoning
    // bug surfaced as the universal real-PAI smoke-test failure mode).
    expect(result.packOutcomes.length).toBe(2);
    const byName = new Map(result.packOutcomes.map((o) => [o.skillName ?? o.paiPackDir, o]));
    const subOutcome = [...byName.values()].find((o) => /sub-a|suba/i.test(o.skillName ?? o.paiPackDir));
    const cleanOutcome = [...byName.values()].find((o) => /clean/i.test(o.skillName ?? o.paiPackDir));
    expect(subOutcome?.outcome).toBe("imported");
    expect(cleanOutcome?.outcome).toBe("imported");
    // BOTH packs land on disk.
    await stat(join(homeDir, ".soma/skills/clean/SKILL.md"));
    await stat(join(homeDir, ".soma/skills/sub-a/SKILL.md"));
    // The unrecognized file does NOT land under the skill dir.
    await expect(stat(join(homeDir, ".soma/skills/sub-a/Foundation.md"))).rejects.toThrow();
  });
});

test("scenario 3 — mixed substrate-specific WITH includeSubstrateSpecific: all import", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    const subPack = await writePackFixture(packsDir, "SubA");
    await plantSubstrateSpecificFile(subPack);
    await writePackFixture(packsDir, "Clean");
    const result = await migratePai({
      homeDir,
      paiPacksDir: packsDir,
      includeSubstrateSpecific: true,
    });
    expect(result.packOutcomes.every((o) => o.outcome === "imported")).toBe(true);
    expect(result.packs.length).toBe(2);
    await stat(join(homeDir, ".soma/skills/sub-a/SKILL.md"));
  });
});

test("scenario 4 — mixed reserved-collision without overwriteReserved: refused-reserved, others import, no throw", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await writePackFixture(packsDir, "ISA", { skillName: "ISA" });
    await writePackFixture(packsDir, "Clean");
    const result = await migratePai({ homeDir, paiPacksDir: packsDir });
    expect(result.packOutcomes.length).toBe(2);
    const isaOutcome = result.packOutcomes.find((o) => /isa/i.test(o.skillName ?? ""));
    const cleanOutcome = result.packOutcomes.find((o) => /clean/i.test(o.skillName ?? ""));
    expect(isaOutcome?.outcome).toBe("refused-reserved");
    expect(cleanOutcome?.outcome).toBe("imported");
    await stat(join(homeDir, ".soma/skills/clean/SKILL.md"));
    await expect(stat(join(homeDir, ".soma/skills/isa"))).rejects.toThrow();
  });
});

test("scenario 5 — single pack genuine failure (malformed): refused-other recorded; other packs still attempted", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await makeMalformedPack(packsDir, "Broken");
    await writePackFixture(packsDir, "Healthy");
    const result = await migratePai({ homeDir, paiPacksDir: packsDir });
    expect(result.packOutcomes.length).toBe(2);
    const broken = result.packOutcomes.find((o) => /broken/i.test(o.paiPackDir));
    const healthy = result.packOutcomes.find((o) => /healthy/i.test(o.skillName ?? ""));
    expect(broken?.outcome).toBe("refused-other");
    expect(broken?.reason).toMatch(/INSTALL\.md/);
    expect(healthy?.outcome).toBe("imported");
  });
});

test("AC-4 — CLI exit non-zero only when a pack outcome is refused-other; zero on policy-respected refusals", async () => {
  // #109 — unrecognized files no longer refuse the pack (partial-import).
  // The reserved-name refusal is still tested via the ISA pack below.
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    const sub = await writePackFixture(packsDir, "SubA");
    await plantSubstrateSpecificFile(sub);
    await writePackFixture(packsDir, "ISA", { skillName: "ISA" });
    await writePackFixture(packsDir, "Healthy");
    // The CLI returns its formatted string on success — no throw.
    const out = await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--home-dir",
      homeDir,
      "--pai-packs-dir",
      packsDir,
    ]);
    // ISA pack still surfaces as refused-reserved; SubA + Healthy import.
    expect(out).toContain("refused-reserved");
    expect(out).toContain("imported");
  });
  // Malformed pack present → SomaCliError, exitCode 1.
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await makeMalformedPack(packsDir, "Broken");
    await writePackFixture(packsDir, "Healthy");
    let caught: unknown = null;
    try {
      await runSomaCli([
        "migrate",
        "pai",
        "--apply",
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
    // Even though one pack failed, the OTHER pack landed.
    await stat(join(homeDir, ".soma/skills/healthy/SKILL.md"));
  });
});

test("AC-1 — CLI parses --include-unrecognized for `migrate pai` (passthrough)", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    const sub = await writePackFixture(packsDir, "SubA");
    await plantSubstrateSpecificFile(sub);
    const out = await runSomaCli([
      "migrate",
      "pai",
      "--apply",
      "--include-unrecognized",
      "--home-dir",
      homeDir,
      "--pai-packs-dir",
      packsDir,
    ]);
    expect(out).toContain("imported");
    await stat(join(homeDir, ".soma/skills/sub-a/SKILL.md"));
  });
});

test("AC-3 (#109) — --status reports per-pack outcomes from the migration manifest", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    // Use a malformed pack so we still exercise a non-`imported`
    // outcome row in the status output; #109 makes plain unrecognized
    // packs land cleanly via partial-import.
    await makeMalformedPack(packsDir, "Broken");
    await writePackFixture(packsDir, "Healthy");
    try {
      await runSomaCli([
        "migrate",
        "pai",
        "--apply",
        "--home-dir",
        homeDir,
        "--pai-packs-dir",
        packsDir,
      ]);
    } catch {
      // Malformed pack → exit non-zero. We still want the status read
      // below, so swallow the error here.
    }
    const status = await runSomaCli([
      "migrate",
      "pai",
      "--status",
      "--home-dir",
      homeDir,
    ]);
    expect(status).toMatch(/broken.*refused-other/);
    expect(status).toMatch(/healthy.*imported/);
  });
});

test("Sage r3 #99 — pack fingerprint lines pair correctly with imported pack names under mixed outcomes", async () => {
  // Regression for Sage's r3 important finding: when an earlier
  // discovered pack is refused, the imported pack must NOT inherit
  // the refused pack's fingerprint. The fix keys fingerprints by
  // `paiPackDir` so future edits to the orchestrator's pack-list
  // shape can't silently break the pairing.
  //
  // #109 — unrecognized files no longer refuse the pack, so we use a
  // malformed pack (missing INSTALL.md) to keep an actual refused row
  // alongside an imported row in the fingerprint output.
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    // Discovery order matters: "a-refused" sorts before "b-imported"
    // so a buggy implementation would shift the imported pack's
    // fingerprint slot.
    await makeMalformedPack(packsDir, "a-refused");
    await writePackFixture(packsDir, "b-imported", { skillName: "b-imported" });
    const result = await migratePai({ homeDir, paiPacksDir: packsDir });
    expect(result.packs.length).toBe(1);
    expect(result.packs[0].skillName).toBe("b-imported");
    const manifest = await readFile(result.manifestPath, "utf8");
    expect(manifest).toMatch(/pack 1: b-imported \(\d+ files\)/);
    const fpMatch = /pack 1 fingerprint: ([0-9a-f]+|empty)/.exec(manifest);
    expect(fpMatch).not.toBeNull();
    expect(fpMatch![1]).not.toBe("empty");
  });
});

test("migratePai is still idempotent across reruns with mixed outcomes (manifest body byte-stable)", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    const sub = await writePackFixture(packsDir, "SubA");
    await plantSubstrateSpecificFile(sub);
    await writePackFixture(packsDir, "Healthy");
    const first = await migratePai({ homeDir, paiPacksDir: packsDir });
    const firstManifest = await readFile(first.manifestPath, "utf8");
    await new Promise((r) => setTimeout(r, 5));
    const second = await migratePai({ homeDir, paiPacksDir: packsDir });
    const secondManifest = await readFile(second.manifestPath, "utf8");
    expect(secondManifest).toBe(firstManifest);
  });
});
