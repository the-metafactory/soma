/**
 * Shared PAI-pack fixture builders for issue 105 (+ R2/R3 follow-ups
 * on PR #108).
 *
 * Sage r3 #108 (Maintainability suggestion): two test files previously
 * defined `writeFlatPack` independently — drifted helpers raise the
 * cost of evolving the canonical pack shape (e.g. the README/INSTALL/
 * VERIFY contract or the SKILL.md frontmatter). Single-sourcing the
 * builders here pins the shape and keeps the tests focused on what
 * they're asserting, not how to set up a pack.
 *
 * Test-only helpers; not part of the public package surface.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Minimal FLAT pack with `src/SKILL.md` + `src/Workflows/Run.md` + the
 * three required pack-level docs. The pack's `name` (in README and
 * SKILL.md frontmatter) defaults to "Flat"; callers override per test.
 */
export async function writeFlatPack(packDir: string, packName = "Flat"): Promise<void> {
  await mkdir(join(packDir, "src/Workflows"), { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    ["---", `name: ${packName}`, `description: Flat pack`, "---", "", `# ${packName}`, "", "Pack docs.\n"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
  await writeFile(
    join(packDir, "src/SKILL.md"),
    ["---", `name: ${packName}`, "description: flat", "---", "", `# ${packName}`, "", "Body.\n"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "src/Workflows/Run.md"), "# Run\n", "utf8");
}

/**
 * Pack with no FLAT entry — pure-nested layout, just the docs at the
 * pack root. Pairs with `writeNestedSkill` to assemble multi-skill
 * nested packs.
 */
export async function writeNestedPackShell(packDir: string, packName: string): Promise<void> {
  await mkdir(join(packDir, "src"), { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    ["---", `name: ${packName}`, `description: Nested pack`, "---", "", `# ${packName}`, "", "Pack docs.\n"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
}

/**
 * A nested skill bundle under `<packDir>/src/<nestedName>/` with its
 * own `SKILL.md` + `Workflows/Default.md`. The optional `extras`
 * list adds sibling subdirs (each gets a `demo.txt`) so tests can
 * pin substrate-specific vs portable routing for `src/<Name>/<other>`
 * cases.
 */
export async function writeNestedSkill(
  packDir: string,
  nestedName: string,
  options: { extras?: string[] } = {},
): Promise<void> {
  const base = join(packDir, "src", nestedName);
  await mkdir(join(base, "Workflows"), { recursive: true });
  await writeFile(
    join(base, "SKILL.md"),
    [
      "---",
      `name: ${nestedName}`,
      `description: Nested ${nestedName} skill`,
      "---",
      "",
      `# ${nestedName}`,
      "",
      "Body.\n",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(base, "Workflows/Default.md"), `# ${nestedName} Default\n`, "utf8");
  for (const extra of options.extras ?? []) {
    await mkdir(join(base, extra), { recursive: true });
    await writeFile(join(base, extra, "demo.txt"), "demo\n", "utf8");
  }
}

/**
 * Mixed pack — FLAT entry + two nested skills (one named to collide
 * with the existing FLAT portable PORTABLE_PREFIXES set: "Tools").
 * Used by R2 #1 regression tests to confirm nested detection runs
 * BEFORE the flat-portable branch.
 */
export async function writeFlatNestedPack(packDir: string, packName = "Mixed"): Promise<void> {
  await mkdir(join(packDir, "src/Workflows"), { recursive: true });
  await mkdir(join(packDir, "src/Tools/Workflows"), { recursive: true });
  await mkdir(join(packDir, "src/Remotion/Workflows"), { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    ["---", `name: ${packName}`, `description: Mixed pack`, "---", "", `# ${packName}`, "", "Pack docs.\n"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
  await writeFile(
    join(packDir, "src/SKILL.md"),
    ["---", `name: ${packName}`, "description: flat", "---", "", `# ${packName}`, "", "Flat body.\n"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "src/Workflows/Run.md"), "# Run\n", "utf8");
  // Nested "Tools" — must NOT flatten as FLAT portable.
  await writeFile(
    join(packDir, "src/Tools/SKILL.md"),
    ["---", `name: Tools`, "description: nested tools skill", "---", "", `# Tools`, "", "Tools body.\n"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "src/Tools/Workflows/Helper.md"), "# Helper\n", "utf8");
  // Plain nested skill (sanity baseline)
  await writeFile(
    join(packDir, "src/Remotion/SKILL.md"),
    ["---", `name: Remotion`, "description: nested remotion", "---", "", `# Remotion`, "", "Remotion body.\n"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "src/Remotion/Workflows/Render.md"), "# Render\n", "utf8");
}
