/**
 * Shared fixture builders for PAI → Soma migration tests (#90).
 *
 * Three test files exercise overlapping fixture shapes:
 *   - `test/pai-migration.test.ts` (#28 minimal scope)
 *   - `test/pai-migration-issue-90.test.ts` (#90 orchestration)
 *   - `test/cli-migrate.test.ts` (#67 CLI surface)
 *
 * Centralizing the builders here keeps the pack/source/memory contract
 * single-sourced — Sage round 1 #95 Maintainability nit.
 *
 * Test-only helpers; not part of the public package surface.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Write a minimal PAI identity tree under `<homeDir>/.claude/PAI/USER`
 * sufficient for `importPaiIdentity` to accept it. Optionally also
 * plants an `Algorithm/v6.3.0.md` so the algorithm phase exercises.
 */
export async function writePaiIdentityFixture(
  homeDir: string,
  opts: { withAlgorithm?: boolean } = {},
): Promise<void> {
  const userRoot = join(homeDir, ".claude/PAI/USER");
  await mkdir(join(userRoot, "TELOS"), { recursive: true });
  await writeFile(
    join(userRoot, "PRINCIPAL_IDENTITY.md"),
    "# Principal\n\n- **Name:** Test User\n- **Pronunciation:** Test\n- **Location:** Nowhere\n- **Timezone:** UTC\n- **Role:** Tester\n- **Focus:** Testing\n",
    "utf8",
  );
  await writeFile(
    join(userRoot, "DA_IDENTITY.md"),
    "# DA Identity\n\n- **Full Name:** Bot\n- **Name:** Bot\n- **Display Name:** Bot\n- **Color:** #000\n- **Voice ID:** v\n- **Role:** assistant\n- **Operating Environment:** test\n",
    "utf8",
  );
  for (const file of ["MISSION.md", "GOALS.md", "STRATEGIES.md", "BELIEFS.md"]) {
    await writeFile(join(userRoot, "TELOS", file), `# ${file}\n\nFixture\n`, "utf8");
  }
  if (opts.withAlgorithm) {
    const algoDir = join(homeDir, ".claude/PAI/Algorithm");
    await mkdir(algoDir, { recursive: true });
    await writeFile(join(algoDir, "v6.3.0.md"), "# Algorithm v6.3.0\n", "utf8");
  }
}

/**
 * Write a minimal PAI MEMORY tree under `<homeDir>/.claude/PAI/MEMORY`
 * for memory-translation tests. Default content covers the canonical
 * 3-cat layout the user's local install ships with.
 */
export async function writePaiMemoryFixture(homeDir: string): Promise<void> {
  const root = join(homeDir, ".claude/PAI/MEMORY");
  await mkdir(join(root, "LEARNING"), { recursive: true });
  await writeFile(join(root, "LEARNING/lesson.md"), "# Lesson\n", "utf8");
  await mkdir(join(root, "WORK/20260117_test"), { recursive: true });
  await writeFile(join(root, "WORK/20260117_test/notes.md"), "notes\n", "utf8");
}

/**
 * Write a tiny PAI pack tree under `<packsDir>/<packName>` valid
 * enough for `importPaiPack` to accept. The pack's slug is derived
 * from `skillName` (defaults to `packName`), which means callers can
 * collide the slug against the orchestrator's reserved-name set by
 * passing `skillName: "ISA"` etc.
 */
export async function writePaiPackFixture(
  packsDir: string,
  packName: string,
  options: { skillName?: string; description?: string } = {},
): Promise<string> {
  const packDir = join(packsDir, packName);
  const skillName = options.skillName ?? packName;
  const description = options.description ?? `Tiny ${packName} pack.`;
  await mkdir(join(packDir, "src"), { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    `---\nname: ${skillName}\ndescription: ${description}\n---\n\n# ${packName}\n\nFixture.\n`,
    "utf8",
  );
  await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
  await writeFile(
    join(packDir, "src/SKILL.md"),
    `---\nname: ${skillName}\ndescription: ${description}\n---\n\n# ${packName}\n\nFixture skill body.\n`,
    "utf8",
  );
  return packDir;
}

/**
 * Write a minimal PAI release tree under
 * `<homeDir>/PAI/Releases/v5.0.0/.claude/PAI` sufficient for
 * `importPaiDocs` to recognize via its `DOCUMENTATION/` guard.
 * Returns the source dir.
 */
export async function writePaiReleaseFixture(homeDir: string): Promise<string> {
  const sourceDir = join(homeDir, "PAI/Releases/v5.0.0/.claude/PAI");
  await mkdir(join(sourceDir, "DOCUMENTATION/Skills"), { recursive: true });
  await writeFile(
    join(sourceDir, "DOCUMENTATION/Skills/SkillSystem.md"),
    "# Skill System\n",
    "utf8",
  );
  return sourceDir;
}
