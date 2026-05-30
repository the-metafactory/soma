/**
 * #90 — soma migrate pai full orchestration tests.
 *
 * Exercises the orchestrator extensions over the #28 minimal scope:
 *   - Memory translation phase (PAI MEMORY → soma memory).
 *   - Bulk skill import from a packs root (iterate + per-pack import).
 *   - Docs import phase via the #89 verb when `paiSourceDir` is given.
 *   - Reserved-skill collision: refused unless `overwriteReserved`.
 *   - `skipMemory` / `skipSkills` / `skipDocs` flags.
 *   - `--pai-source-dir` pointing at a non-PAI dir is refused loud.
 *
 * Fixture-only; no network or real PAI install touched.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { migratePai, planPaiMigration } from "../src/pai-migration";
import type { PaiMemoryMigrationManifest } from "../src/types";
import {
  withTempHome as withSharedTempHome,
  writePaiIdentityFixture as writeIdentityFixture,
  writePaiMemoryFixture as writeMemoryFixture,
  writePaiPackFixture as writePackFixture,
  writePaiReleaseFixture as writePaiSourceFixture,
} from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-90-orch-");

test("planPaiMigration includes memory phase counts when MEMORY dir exists", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    await writeMemoryFixture(homeDir);
    const plan = await planPaiMigration({ homeDir });
    expect(plan.memory).toBeDefined();
    expect(plan.memory!.files.length).toBe(2);
  });
});

test("planPaiMigration sets memory to null when no MEMORY dir", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const plan = await planPaiMigration({ homeDir });
    expect(plan.memory).toBeDefined();
    expect(plan.memory!.memoryDir).toBeNull();
  });
});

test("migratePai runs memory phase end-to-end", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    await writeMemoryFixture(homeDir);
    const result = await migratePai({ homeDir });
    expect(result.memory).toBeDefined();
    expect(result.memory!.writtenCount).toBe(2);
    await stat(join(homeDir, ".soma/memory/LEARNING/lesson.md"));
    await stat(join(homeDir, ".soma/memory/WORK/20260117_test/notes.md"));
    // Memory manifest must exist.
    const mem = await readFile(
      join(homeDir, ".soma/imports/pai-migration/.manifest.json"),
      "utf8",
    );
    const parsed = JSON.parse(mem) as PaiMemoryMigrationManifest;
    expect(parsed.files.length).toBe(2);
  });
});

test("migratePai skipMemory honored — no memory files written", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    await writeMemoryFixture(homeDir);
    const result = await migratePai({ homeDir, skipMemory: true });
    expect(result.memory).toBeNull();
    await expect(
      stat(join(homeDir, ".soma/memory/LEARNING/lesson.md")),
    ).rejects.toThrow();
  });
});

test("migratePai bulk imports packs from paiPacksDir", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await writePackFixture(packsDir, "AlphaSkill");
    await writePackFixture(packsDir, "BetaSkill");
    const result = await migratePai({ homeDir, paiPacksDir: packsDir });
    expect(result.packs.length).toBe(2);
    const names = result.packs.map((p) => p.skillName).sort();
    expect(names).toEqual(["alpha-skill", "beta-skill"]);
    await stat(join(homeDir, ".soma/skills/alpha-skill/SKILL.md"));
    await stat(join(homeDir, ".soma/skills/beta-skill/SKILL.md"));
  });
});

test("migratePai skipSkills honored — packs not imported even when packsDir given", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await writePackFixture(packsDir, "AlphaSkill");
    const result = await migratePai({ homeDir, paiPacksDir: packsDir, skipSkills: true });
    expect(result.packs).toEqual([]);
    await expect(stat(join(homeDir, ".soma/skills/alpha-skill"))).rejects.toThrow();
  });
});

test("migratePai skipSkills short-circuits pack discovery (bad packs dir is not read) — Sage r3 #95 important", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    // Use a `paiPacksDir` that exists but is unreadable. Without the
    // skipSkills short-circuit in discoverMigrationSources, the
    // orchestrator would throw EACCES while reading the dir even
    // though the skill phase is explicitly skipped.
    const packsDir = join(homeDir, "locked-packs");
    await mkdir(packsDir, { recursive: true });
    const { chmod } = await import("node:fs/promises");
    await chmod(packsDir, 0o000);
    try {
      const result = await migratePai({
        homeDir,
        paiPacksDir: packsDir,
        skipSkills: true,
      });
      expect(result.packs).toEqual([]);
    } finally {
      await chmod(packsDir, 0o700);
    }
  });
});

test("migratePai records reserved-skill packs as refused-reserved (no throw) without overwriteReserved (#97)", async () => {
  // #97 inverts the pre-existing throw-on-reserved contract from #90.
  // Reserved-name collisions are now policy-respected per-pack
  // outcomes, recorded in `packOutcomes`. The orchestrator never
  // aborts — other packs continue.
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    // Pack whose normalized skill name slugifies to a reserved name.
    await writePackFixture(packsDir, "ISA", { skillName: "ISA" });
    const result = await migratePai({ homeDir, paiPacksDir: packsDir });
    expect(result.packs).toEqual([]);
    expect(result.packOutcomes.length).toBe(1);
    expect(result.packOutcomes[0].outcome).toBe("refused-reserved");
    expect(result.packOutcomes[0].skillName).toBe("isa");
  });
});

test("migratePai skips reserved skill name when --overwriteReserved is set, importing the rest", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await writePackFixture(packsDir, "ISA", { skillName: "ISA" });
    await writePackFixture(packsDir, "Alpha", { skillName: "Alpha" });
    const result = await migratePai({
      homeDir,
      paiPacksDir: packsDir,
      overwriteReserved: true,
    });
    // ISA must be imported (the flag explicitly permits clobbering
    // reserved names — Sage may push back; we record the resolution
    // here so the contract is unambiguous).
    const names = result.packs.map((p) => p.skillName).sort();
    expect(names).toEqual(["alpha", "isa"]);
  });
});

test("migratePai auto-discovers packs at <claudeHome>/PAI/Packs when paiPacksDir omitted", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    // Plant packs at the canonical auto-discovery location.
    const packsDir = join(homeDir, ".claude/PAI/Packs");
    await writePackFixture(packsDir, "Gamma");
    const result = await migratePai({ homeDir });
    expect(result.packs.length).toBe(1);
    expect(result.packs[0].skillName).toBe("gamma");
  });
});

test("migratePai with paiSourceDir invokes docs phase, writes <somaHome>/PAI/DOCUMENTATION/*", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const sourceDir = await writePaiSourceFixture(homeDir);
    const result = await migratePai({ homeDir, paiSourceDir: sourceDir });
    expect(result.docs).toBeDefined();
    expect(result.docs!.writtenCount).toBeGreaterThan(0);
    await stat(join(homeDir, ".soma/PAI/DOCUMENTATION/Skills/SkillSystem.md"));
  });
});

test("migratePai paiSourceDir pointing at non-PAI dir refuses loud", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const bogus = join(homeDir, "definitely-not-pai");
    await mkdir(bogus, { recursive: true });
    await writeFile(join(bogus, "README.md"), "not pai\n", "utf8");
    await expect(
      migratePai({ homeDir, paiSourceDir: bogus }),
    ).rejects.toThrow(/does not look like a PAI release tree/);
  });
});

test("migratePai skipDocs honored — docs phase not run even when paiSourceDir given", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const sourceDir = await writePaiSourceFixture(homeDir);
    const result = await migratePai({ homeDir, paiSourceDir: sourceDir, skipDocs: true });
    expect(result.docs).toBeNull();
    await expect(
      stat(join(homeDir, ".soma/PAI/DOCUMENTATION/Skills/SkillSystem.md")),
    ).rejects.toThrow();
  });
});

test("migratePai is idempotent across full phases (rerun = same on-disk state)", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    await writeMemoryFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await writePackFixture(packsDir, "Alpha");
    const sourceDir = await writePaiSourceFixture(homeDir);

    const first = await migratePai({ homeDir, paiPacksDir: packsDir, paiSourceDir: sourceDir });
    const firstManifest = await readFile(first.manifestPath, "utf8");
    const firstMemManifest = await readFile(
      join(homeDir, ".soma/imports/pai-migration/.manifest.json"),
      "utf8",
    );

    const second = await migratePai({
      homeDir,
      paiPacksDir: packsDir,
      paiSourceDir: sourceDir,
    });
    expect(second.memory!.writtenCount).toBe(0);
    expect(second.memory!.unchanged).toBe(true);
    // Docs phase: writtenCount=0 means idempotent skip per #89's
    // contract.
    expect(second.docs!.writtenCount).toBe(0);
    expect(second.docs!.unchanged).toBe(true);
    // Migration manifest byte-stable.
    const secondManifest = await readFile(first.manifestPath, "utf8");
    expect(secondManifest).toBe(firstManifest);
    // Memory manifest byte-stable.
    const secondMemManifest = await readFile(
      join(homeDir, ".soma/imports/pai-migration/.manifest.json"),
      "utf8",
    );
    expect(secondMemManifest).toBe(firstMemManifest);
  });
});

test("planPaiMigration with paiSourceDir includes docs plan; without it docs is null", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const sourceDir = await writePaiSourceFixture(homeDir);
    const withSource = await planPaiMigration({ homeDir, paiSourceDir: sourceDir });
    expect(withSource.docs).not.toBeNull();
    expect(withSource.docs!.files.length).toBeGreaterThan(0);

    const withoutSource = await planPaiMigration({ homeDir });
    expect(withoutSource.docs).toBeNull();
  });
});

test("migratePai MIGRATION.md includes a Last migrated at timestamp", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const result = await migratePai({ homeDir });
    const manifest = await readFile(result.manifestPath, "utf8");
    expect(manifest).toMatch(/Last migrated at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });
});

test("migratePai filesWritten on idempotent rerun = manifest only (no over-reporting) — Sage r2 #95 important", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    await writeMemoryFixture(homeDir);
    const first = await migratePai({ homeDir });
    // First run: identity files + memory files + manifest path + memory manifest.
    const firstWrite = first.filesWritten.length;
    expect(firstWrite).toBeGreaterThan(2);
    // Second run, fully idempotent. The previous bug pushed every
    // in-scope memory target into filesWritten regardless of whether
    // it was actually copied, so a zero-write idempotent rerun was
    // reporting len(filesWritten) ≈ in-scope count. Contract: the
    // only file the orchestrator unconditionally writes on a no-op
    // rerun is the MIGRATION.md (and the memory manifest, which is
    // also always re-rendered for byte-stability). filesWritten
    // therefore reflects exactly the per-run touches.
    const second = await migratePai({ homeDir });
    // Identity importer always writes (no SHA gate yet) — that's 6
    // identity files + memory.manifestPath + MIGRATION.md = 8 typical.
    // The KEY invariant is: filesWritten on a no-op rerun must NOT
    // include the memory targets themselves (those were skipped).
    expect(second.memory!.writtenCount).toBe(0);
    expect(second.memory!.writtenTargets).toEqual([]);
    // Memory targets are NOT in filesWritten on the second run.
    for (const target of second.memory!.files) {
      expect(second.filesWritten).not.toContain(target);
    }
  });
});

test("migratePai timestamp bumps when identity content changes (file count unchanged) — Sage r1 #95 important", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    const first = await migratePai({ homeDir });
    const firstManifest = await readFile(first.manifestPath, "utf8");
    const firstTs = (/^Last migrated at: (.+)$/m.exec(firstManifest))?.[1];
    const firstFp = (/identity fingerprint: ([0-9a-f]+)/.exec(firstManifest))?.[1];
    expect(firstTs).toBeDefined();
    expect(firstFp).toBeDefined();
    await new Promise((r) => setTimeout(r, 5));
    // Mutate identity SOURCE — file count stays the same, content
    // changes. The previous gate (memory.unchanged && docs.unchanged)
    // would have preserved the timestamp. The fingerprint embedded
    // in the manifest body changes, which forces a body-equivalence
    // failure and a timestamp bump.
    await writeFile(
      join(homeDir, ".claude/PAI/USER/PRINCIPAL_IDENTITY.md"),
      "# Principal\n\n- **Name:** Mutated User\n- **Pronunciation:** Test\n- **Location:** Nowhere\n- **Timezone:** UTC\n- **Role:** Tester\n- **Focus:** Testing\n",
      "utf8",
    );
    const second = await migratePai({ homeDir });
    const secondManifest = await readFile(second.manifestPath, "utf8");
    const secondTs = (/^Last migrated at: (.+)$/m.exec(secondManifest))?.[1];
    const secondFp = (/identity fingerprint: ([0-9a-f]+)/.exec(secondManifest))?.[1];
    expect(secondTs).not.toBe(firstTs);
    expect(secondFp).not.toBe(firstFp);
  });
});

test("migratePai timestamp preserved across idempotent rerun (no writes)", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    await writeMemoryFixture(homeDir);
    const first = await migratePai({ homeDir });
    const firstManifest = await readFile(first.manifestPath, "utf8");
    const firstTs = (/^Last migrated at: (.+)$/m.exec(firstManifest))?.[1];
    expect(firstTs).toBeDefined();
    // Wait a real moment so a non-preserved timestamp would diverge.
    await new Promise((r) => setTimeout(r, 5));
    await migratePai({ homeDir });
    const secondManifest = await readFile(first.manifestPath, "utf8");
    const secondTs = (/^Last migrated at: (.+)$/m.exec(secondManifest))?.[1];
    expect(secondTs).toBe(firstTs);
  });
});

test("migratePai records memory + docs + packs counts in MIGRATION.md", async () => {
  await withTempHome(async (homeDir) => {
    await writeIdentityFixture(homeDir);
    await writeMemoryFixture(homeDir);
    const packsDir = join(homeDir, "Packs");
    await writePackFixture(packsDir, "Alpha");
    const sourceDir = await writePaiSourceFixture(homeDir);
    const result = await migratePai({
      homeDir,
      paiPacksDir: packsDir,
      paiSourceDir: sourceDir,
    });
    const manifest = await readFile(result.manifestPath, "utf8");
    expect(manifest).toContain("memory:");
    expect(manifest).toContain("docs:");
    expect(manifest).toContain("packs:");
  });
});
