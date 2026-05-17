/**
 * #90 — PAI memory translation phase.
 *
 * `<claudeHome>/PAI/MEMORY/*` → `<somaHome>/memory/*` is a 1:1
 * directory remap by DD-2 contract. Content-preserving (no rewrites
 * in the first pass), mtime-preserving, per-file SHA recorded in
 * the manifest at `<somaHome>/imports/pai-migration/.manifest.json`,
 * idempotent on rerun.
 *
 * Fixture-based. Sage round 0 preempt: idempotency + reserved-skill
 * collision get strong tests before opening the PR.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { migratePaiMemory, planPaiMemoryMigration } from "../src/pai-memory-migrator";
import type { PaiMemoryMigrationManifest } from "../src/types";
import { withTempHome as withSharedTempHome } from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-90-mem-");

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

interface MemoryFixtureOptions {
  withLearning?: boolean;
  withReflections?: boolean;
  withSkills?: boolean;
  withWork?: boolean;
  // Extra v5.0.0 cats the user already keeps locally.
  withKnowledge?: boolean;
  withResearch?: boolean;
  // Out-of-scope sentinel files at MEMORY root (must not be migrated).
  withRootReadme?: boolean;
}

async function writePaiMemoryFixture(
  homeDir: string,
  opts: MemoryFixtureOptions = {},
): Promise<string> {
  const root = join(homeDir, ".claude/PAI/MEMORY");
  await mkdir(root, { recursive: true });
  if (opts.withRootReadme) {
    // PAI ships a README.md at MEMORY/ — we DO migrate it as a
    // top-level file under <somaHome>/memory/, BUT only if a similar
    // file isn't already there. The README at memory/ root in Soma
    // is owned by #88 — we must not overwrite it. So this fixture
    // case exercises the "files at MEMORY root that map nowhere" path.
    await writeFile(join(root, "README.md"), "# PAI MEMORY root readme\n", "utf8");
  }
  if (opts.withLearning) {
    await mkdir(join(root, "LEARNING"), { recursive: true });
    await writeFile(join(root, "LEARNING/lesson-001.md"), "# Lesson 001\nBe careful.\n", "utf8");
  }
  if (opts.withReflections) {
    await mkdir(join(root, "LEARNING/REFLECTIONS"), { recursive: true });
    await writeFile(
      join(root, "LEARNING/REFLECTIONS/2026-01.md"),
      "# January reflection\nFelt good.\n",
      "utf8",
    );
  }
  if (opts.withSkills) {
    await mkdir(join(root, "SKILLS/CreateSkill"), { recursive: true });
    await writeFile(
      join(root, "SKILLS/CreateSkill/state.json"),
      JSON.stringify({ runs: 3 }),
      "utf8",
    );
  }
  if (opts.withWork) {
    await mkdir(join(root, "WORK/20260117-103045_test-task"), { recursive: true });
    await writeFile(
      join(root, "WORK/20260117-103045_test-task/ISA.md"),
      "# Test task ISA\n",
      "utf8",
    );
  }
  if (opts.withKnowledge) {
    await mkdir(join(root, "KNOWLEDGE/People"), { recursive: true });
    await writeFile(
      join(root, "KNOWLEDGE/People/alice.md"),
      "# Alice\nfriend.\n",
      "utf8",
    );
  }
  if (opts.withResearch) {
    await mkdir(join(root, "RESEARCH"), { recursive: true });
    await writeFile(join(root, "RESEARCH/topic-1.md"), "# Topic 1\n", "utf8");
  }
  return root;
}

test("planPaiMemoryMigration with no MEMORY dir returns memoryDir=null, files=[]", async () => {
  await withTempHome(async (homeDir) => {
    const plan = await planPaiMemoryMigration({ homeDir });
    expect(plan.apply).toBe(false);
    expect(plan.memoryDir).toBeNull();
    expect(plan.files).toEqual([]);
  });
});

test("planPaiMemoryMigration enumerates every file under PAI/MEMORY", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiMemoryFixture(homeDir, {
      withLearning: true,
      withReflections: true,
      withSkills: true,
      withWork: true,
    });
    const plan = await planPaiMemoryMigration({ homeDir });
    expect(plan.memoryDir).toBe(join(homeDir, ".claude/PAI/MEMORY"));
    const targets = plan.files.map((f) => f.relativePath).sort();
    expect(targets).toEqual([
      "LEARNING/REFLECTIONS/2026-01.md",
      "LEARNING/lesson-001.md",
      "SKILLS/CreateSkill/state.json",
      "WORK/20260117-103045_test-task/ISA.md",
    ]);
    // Dry-run plan must not populate SHAs (cheap planning).
    expect(plan.files.every((f) => f.sha256 === undefined)).toBe(true);
  });
});

test("planPaiMemoryMigration computes target as <somaHome>/memory/<relative>", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiMemoryFixture(homeDir, { withLearning: true });
    const plan = await planPaiMemoryMigration({ homeDir });
    expect(plan.files[0].target).toBe(
      join(homeDir, ".soma/memory/LEARNING/lesson-001.md"),
    );
  });
});

test("migratePaiMemory copies every in-scope file content-preserving", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiMemoryFixture(homeDir, {
      withLearning: true,
      withReflections: true,
      withSkills: true,
      withWork: true,
    });
    const result = await migratePaiMemory({ homeDir });
    expect(result.writtenCount).toBe(4);
    expect(result.skippedCount).toBe(0);
    expect(result.unchanged).toBe(false);
    for (const target of result.files) {
      // Every recorded target must exist on disk.
      await stat(target);
    }
    // Content preserved byte-for-byte.
    const learning = await readFile(
      join(homeDir, ".soma/memory/LEARNING/lesson-001.md"),
      "utf8",
    );
    expect(learning).toBe("# Lesson 001\nBe careful.\n");
    const reflection = await readFile(
      join(homeDir, ".soma/memory/LEARNING/REFLECTIONS/2026-01.md"),
      "utf8",
    );
    expect(reflection).toBe("# January reflection\nFelt good.\n");
  });
});

test("migratePaiMemory preserves source mtimes on target files", async () => {
  await withTempHome(async (homeDir) => {
    const root = await writePaiMemoryFixture(homeDir, { withLearning: true });
    // Pin a known mtime so the test is deterministic.
    const known = new Date("2024-06-15T12:34:56Z");
    await utimes(join(root, "LEARNING/lesson-001.md"), known, known);
    await migratePaiMemory({ homeDir });
    const stats = await stat(join(homeDir, ".soma/memory/LEARNING/lesson-001.md"));
    expect(Math.floor(stats.mtimeMs / 1000)).toBe(Math.floor(known.getTime() / 1000));
  });
});

test("migratePaiMemory writes per-file SHA manifest at imports/pai-migration/.manifest.json", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiMemoryFixture(homeDir, { withLearning: true, withReflections: true });
    const result = await migratePaiMemory({ homeDir });
    expect(result.manifestPath).toBe(
      join(homeDir, ".soma/imports/pai-migration/.manifest.json"),
    );
    const raw = await readFile(result.manifestPath, "utf8");
    const manifest = JSON.parse(raw) as PaiMemoryMigrationManifest;
    expect(manifest.schema).toBe("soma.pai-memory-migration.v1");
    expect(manifest.files.length).toBe(2);
    // Every manifest entry must carry a non-empty 64-hex SHA.
    for (const entry of manifest.files) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.relativePath.length).toBeGreaterThan(0);
      expect(entry.mtimeMs).toBeGreaterThan(0);
    }
    // SHAs must match the actual source bytes.
    const lessonSha = sha256("# Lesson 001\nBe careful.\n");
    const lessonEntry = manifest.files.find((f) => f.relativePath === "LEARNING/lesson-001.md");
    expect(lessonEntry).toBeDefined();
    expect(lessonEntry!.sha256).toBe(lessonSha);
  });
});

test("migratePaiMemory is idempotent: second run with same source = no writes", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiMemoryFixture(homeDir, {
      withLearning: true,
      withSkills: true,
      withWork: true,
    });
    const first = await migratePaiMemory({ homeDir });
    expect(first.writtenCount).toBeGreaterThan(0);
    const second = await migratePaiMemory({ homeDir });
    expect(second.writtenCount).toBe(0);
    expect(second.skippedCount).toBe(first.writtenCount);
    expect(second.unchanged).toBe(true);
  });
});

test("migratePaiMemory manifest is stable across reruns when source unchanged", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiMemoryFixture(homeDir, { withLearning: true, withReflections: true });
    const first = await migratePaiMemory({ homeDir });
    const beforeManifest = await readFile(first.manifestPath, "utf8");
    await migratePaiMemory({ homeDir });
    const afterManifest = await readFile(first.manifestPath, "utf8");
    expect(afterManifest).toBe(beforeManifest);
  });
});

test("migratePaiMemory re-copies when target file has been mutated since import", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiMemoryFixture(homeDir, { withLearning: true });
    const first = await migratePaiMemory({ homeDir });
    expect(first.writtenCount).toBe(1);
    // Mutate the target after import. Source bytes unchanged.
    const target = join(homeDir, ".soma/memory/LEARNING/lesson-001.md");
    await writeFile(target, "MUTATED\n", "utf8");
    // The manifest says target SHA = original SHA; new target bytes
    // differ. Re-running must restore the source over the corrupted
    // target — manifest agreement alone is not enough.
    const second = await migratePaiMemory({ homeDir });
    expect(second.writtenCount).toBe(1);
    const restored = await readFile(target, "utf8");
    expect(restored).toBe("# Lesson 001\nBe careful.\n");
  });
});

test("migratePaiMemory re-copies when source bytes change", async () => {
  await withTempHome(async (homeDir) => {
    const root = await writePaiMemoryFixture(homeDir, { withLearning: true });
    await migratePaiMemory({ homeDir });
    // Source drifts. Idempotent contract: the source wins.
    await writeFile(join(root, "LEARNING/lesson-001.md"), "# Lesson 001\nUpdated.\n", "utf8");
    const second = await migratePaiMemory({ homeDir });
    expect(second.writtenCount).toBe(1);
    const target = await readFile(
      join(homeDir, ".soma/memory/LEARNING/lesson-001.md"),
      "utf8",
    );
    expect(target).toBe("# Lesson 001\nUpdated.\n");
  });
});

test("migratePaiMemory does NOT overwrite the README.md at <somaHome>/memory/ root", async () => {
  // #88 owns the README at memory/ root. The memory translator must
  // not touch files directly at <claudeHome>/PAI/MEMORY/<file> when
  // those paths would collide with #88's bootstrap-owned files at the
  // <somaHome>/memory/ root. The contract: only files INSIDE a category
  // directory get migrated; files at the MEMORY/ root are ignored.
  await withTempHome(async (homeDir) => {
    // Bootstrap the canonical Soma README at memory/ root.
    await mkdir(join(homeDir, ".soma/memory"), { recursive: true });
    await writeFile(join(homeDir, ".soma/memory/README.md"), "# Soma memory (bootstrap)\n", "utf8");
    await writePaiMemoryFixture(homeDir, { withRootReadme: true, withLearning: true });
    const result = await migratePaiMemory({ homeDir });
    // README at MEMORY root must not have been migrated.
    const somaReadme = await readFile(join(homeDir, ".soma/memory/README.md"), "utf8");
    expect(somaReadme).toBe("# Soma memory (bootstrap)\n");
    // The lesson under LEARNING did get migrated.
    expect(result.writtenCount).toBe(1);
  });
});

test("migratePaiMemory refuses symlinks inside the MEMORY tree", async () => {
  await withTempHome(async (homeDir) => {
    const root = await writePaiMemoryFixture(homeDir, { withLearning: true });
    // Plant a symlink inside the tree.
    await symlink("/etc/hostname", join(root, "LEARNING/escape.md"));
    await expect(migratePaiMemory({ homeDir })).rejects.toThrow(/symlink/i);
  });
});

test("planPaiMemoryMigration handles extra v5.0.0 cats (KNOWLEDGE, RESEARCH) cleanly", async () => {
  await withTempHome(async (homeDir) => {
    await writePaiMemoryFixture(homeDir, {
      withKnowledge: true,
      withResearch: true,
      withLearning: true,
    });
    const plan = await planPaiMemoryMigration({ homeDir });
    const cats = new Set(plan.files.map((f) => f.relativePath.split("/")[0]));
    expect(cats.has("KNOWLEDGE")).toBe(true);
    expect(cats.has("RESEARCH")).toBe(true);
    expect(cats.has("LEARNING")).toBe(true);
  });
});
