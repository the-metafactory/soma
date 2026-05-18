/**
 * Issue 105 — pai-pack-importer: support nested skill bundles.
 *
 * PAI packs often ship multiple skills under one pack root, each at
 * `src/<Name>/SKILL.md` with its own `Workflows/`, `Tools/`, etc. Before
 * this issue the router only recognized a FLAT layout (`src/SKILL.md` +
 * `src/Workflows/` at the pack root); every nested bundle dropped into
 * the catch-all substrate-specific bucket.
 *
 * Implementation contract (the test file pins what ships):
 *
 *  - AC-1: Router recognizes `src/<Name>/{SKILL.md,Workflows/,Tools/,
 *          References/,Examples/}` as portable. `src/<Name>/<other>` is
 *          still substrate-specific.
 *  - AC-2: A pack with N nested skills (where N skills means N
 *          `src/<Name>/SKILL.md` files) imports as N independent Soma
 *          skills at `~/.soma/skills/<kebab-name>/`.
 *  - AC-3: A FLAT pack (existing behaviour — `src/SKILL.md` at root with
 *          no nested skills) still imports as exactly ONE Soma skill.
 *  - AC-4: A mixed pack (top-level `src/SKILL.md` PLUS nested
 *          `src/<Name>/SKILL.md`) imports as 1 + N skills.
 *  - AC-5: Two `src/<Name>/SKILL.md` paths that collapse to the same
 *          kebab-name within one pack refuse with a typed
 *          `PaiPackNameCollisionRefusal`. Across packs, the second pack
 *          surfaces as `refused-name-collision` unless `--overwrite` is
 *          set.
 *  - AC-6: Pack-level `README.md` / `INSTALL.md` / `VERIFY.md` attach to
 *          EACH derived skill as `References/PAI-PACK-{README,INSTALL,
 *          VERIFY}.md` so any nested skill is independently invocable.
 *  - AC-7: The pack-level archive at
 *          `~/.soma/imports/pai-packs/<pack-slug>/` records the original
 *          pack layout for auditability and `soma-pack.json` lists every
 *          `derived-skills`.
 *  - AC-8: `importPaiPack` now returns `PaiPackImportResult[]` (Option A
 *          breaking change). Single-skill packs return a one-element
 *          array.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { importPaiPack, planPaiPackImport } from "../src/index";
import { routePaiPackSourceFile } from "../src/pai-pack-routing";
import type { PaiPackManifest } from "../src/types";

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-issue-105-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writeFlatPack(packDir: string, packName = "Flat"): Promise<void> {
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

async function writeNestedSkill(
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

async function writeNestedPackShell(packDir: string, packName: string): Promise<void> {
  await mkdir(join(packDir, "src"), { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    ["---", `name: ${packName}`, `description: Nested pack`, "---", "", `# ${packName}`, "", "Pack docs.\n"].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
}

// ───────────────────────────────────────────────────────────────────────
// AC-1: Router classification
// ───────────────────────────────────────────────────────────────────────

test("AC-1: router classifies nested SKILL.md as portable with nested-skill set", () => {
  const nested = new Set(["Art", "Remotion"]);
  const route = routePaiPackSourceFile("src/Art/SKILL.md", nested);
  expect(route.classification).toBe("portable");
  expect(route.root).toBe("skill");
  expect(route.renderMode).toBe("skill");
  // Target should land under the nested skill's own kebab name, not the pack root.
  expect(route.relativePath).toBe("SKILL.md");
  expect(route.skillName).toBe("art");
});

test("AC-1: router classifies nested Workflows/Tools/References/Examples as portable under nested skill", () => {
  const nested = new Set(["Remotion"]);
  for (const subdir of ["Workflows", "Tools", "References", "Examples"]) {
    const route = routePaiPackSourceFile(`src/Remotion/${subdir}/file.md`, nested);
    expect(route.classification).toBe("portable");
    expect(route.root).toBe("skill");
    expect(route.skillName).toBe("remotion");
    expect(route.relativePath).toBe(`${subdir}/file.md`);
  }
});

test("AC-1: router still classifies src/<Name>/<other> as substrate-specific", () => {
  // `src/Art/Lib/` and `src/Art/Assets/` are not portable subdirs — they
  // stay archive-only. The nested skill set HAS Art, so the rule is on
  // the subdir name not on whether the parent is a known nested skill.
  const nested = new Set(["Art"]);
  const route = routePaiPackSourceFile("src/Art/Assets/icon.png", nested);
  expect(route.classification).toBe("substrate-specific");
  expect(route.root).toBe("archive");
});

test("AC-1: when nested skill set is empty, src/<Name>/SKILL.md stays substrate-specific", () => {
  // The detection rule: a Name is treated as nested iff src/<Name>/SKILL.md
  // exists in the pack file set. Without that, nested dirs stay archive.
  const empty = new Set<string>();
  const route = routePaiPackSourceFile("src/Foo/SKILL.md", empty);
  expect(route.classification).toBe("substrate-specific");
});

test("AC-1: FLAT routing (src/SKILL.md, src/Workflows/, src/Tools/) unchanged", () => {
  const nested = new Set<string>();
  expect(routePaiPackSourceFile("src/SKILL.md", nested)).toMatchObject({
    classification: "portable",
    root: "skill",
    relativePath: "SKILL.md",
    renderMode: "skill",
    skillName: null,
  });
  expect(routePaiPackSourceFile("src/Workflows/Run.md", nested)).toMatchObject({
    classification: "portable",
    root: "skill",
    skillName: null,
  });
  expect(routePaiPackSourceFile("src/Tools/run.ts", nested)).toMatchObject({
    classification: "portable",
    root: "skill",
    skillName: null,
  });
});

test("AC-1: source-doc and template classifications still win over nested detection", () => {
  const nested = new Set(["Tools"]); // adversarial — shouldn't pollute root routing
  expect(routePaiPackSourceFile("README.md", nested).classification).toBe("source-doc");
  expect(routePaiPackSourceFile("src/DashboardTemplate/foo.tsx", nested).classification).toBe("template");
});

// ───────────────────────────────────────────────────────────────────────
// AC-3: FLAT pack still imports as ONE skill
// ───────────────────────────────────────────────────────────────────────

test("AC-3: FLAT pack imports as exactly one Soma skill", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Flat");
    await writeFlatPack(packDir, "Flat");
    const results = await importPaiPack({ homeDir, paiPackDir: packDir });
    expect(results).toHaveLength(1);
    expect(results[0].skillName).toBe("flat");
    expect(results[0].files.some((p) => p.endsWith(".soma/skills/flat/SKILL.md"))).toBe(true);
    expect(results[0].files.some((p) => p.endsWith(".soma/skills/flat/Workflows/Run.md"))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-2: 2-skill nested pack
// ───────────────────────────────────────────────────────────────────────

test("AC-2: 2-skill nested pack imports as 2 Soma skills", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Media");
    await writeNestedPackShell(packDir, "Media");
    await writeNestedSkill(packDir, "Art");
    await writeNestedSkill(packDir, "Remotion");

    const results = await importPaiPack({ homeDir, paiPackDir: packDir });
    const skillNames = results.map((r) => r.skillName).sort();
    expect(skillNames).toEqual(["art", "remotion"]);

    for (const name of ["art", "remotion"]) {
      const skillMd = join(homeDir, ".soma", "skills", name, "SKILL.md");
      const wf = join(homeDir, ".soma", "skills", name, "Workflows/Default.md");
      expect((await readFile(skillMd, "utf8")).length).toBeGreaterThan(0);
      expect((await readFile(wf, "utf8")).length).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-2 / scale: 5+ skill nested pack
// ───────────────────────────────────────────────────────────────────────

test("AC-2: 5-skill nested pack imports as 5 Soma skills (Thinking-style)", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Thinking");
    await writeNestedPackShell(packDir, "Thinking");
    const names = ["BeCreative", "Council", "FirstPrinciples", "IterativeDepth", "RedTeam"];
    for (const n of names) {
      await writeNestedSkill(packDir, n);
    }

    const results = await importPaiPack({ homeDir, paiPackDir: packDir });
    const skillNames = results.map((r) => r.skillName).sort();
    expect(skillNames).toEqual(["be-creative", "council", "first-principles", "iterative-depth", "red-team"]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-4: Mixed (top-level + nested)
// ───────────────────────────────────────────────────────────────────────

test("AC-4: mixed pack (top-level SKILL.md + nested) imports as 1 + N skills", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Utilities");
    await writeNestedPackShell(packDir, "Utilities");
    // Top-level SKILL.md
    await writeFile(
      join(packDir, "src/SKILL.md"),
      ["---", "name: Utilities", "description: top", "---", "", "# Utilities\n"].join("\n"),
      "utf8",
    );
    await mkdir(join(packDir, "src/Workflows"), { recursive: true });
    await writeFile(join(packDir, "src/Workflows/Top.md"), "# Top\n", "utf8");
    // Plus 2 nested
    await writeNestedSkill(packDir, "Browser");
    await writeNestedSkill(packDir, "Documents");

    const results = await importPaiPack({ homeDir, paiPackDir: packDir });
    const skillNames = results.map((r) => r.skillName).sort();
    expect(skillNames).toEqual(["browser", "documents", "utilities"]);

    // Top-level skill gets its workflow under utilities/Workflows/Top.md
    const topWf = join(homeDir, ".soma/skills/utilities/Workflows/Top.md");
    expect((await readFile(topWf, "utf8")).length).toBeGreaterThan(0);
    // Browser gets its workflow under browser/Workflows/Default.md
    const browserWf = join(homeDir, ".soma/skills/browser/Workflows/Default.md");
    expect((await readFile(browserWf, "utf8")).length).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-1 / AC-3 again: substrate-specific siblings under a nested skill
// ───────────────────────────────────────────────────────────────────────

test("AC-1+3: nested skill with non-recognized sibling (Assets/) still archives sibling", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/MediaWithAssets");
    await writeNestedPackShell(packDir, "MediaWithAssets");
    await writeNestedSkill(packDir, "Art", { extras: ["Assets"] });

    // Without --include-substrate-specific the import should refuse the pack
    // because src/Art/Assets/demo.txt classifies as substrate-specific.
    await expect(importPaiPack({ homeDir, paiPackDir: packDir })).rejects.toThrow("substrate-specific");

    // With include-substrate-specific the pack imports — but the asset lands
    // in the pack-level archive, not in the nested Art skill.
    const results = await importPaiPack({
      homeDir,
      paiPackDir: packDir,
      includeSubstrateSpecific: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0].skillName).toBe("art");
    // The asset is NOT under skills/art/Assets — it's under the pack archive.
    const skillFiles = results[0].files;
    expect(skillFiles.some((p) => p.includes("/skills/art/Assets/demo.txt"))).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-5: Within-pack collision
// ───────────────────────────────────────────────────────────────────────

test("AC-5: within-pack collision (ExtractWisdom + extract-wisdom) refuses pack with name-collision", async () => {
  // Two distinct nested-skill dirs that kebab to the same slug. Using
  // `ExtractWisdom` (CamelCase → `extract-wisdom`) plus literal
  // `extract-wisdom` exercises the within-pack collision path while
  // staying portable on case-insensitive filesystems (APFS on macOS
  // treats `Foo/` and `foo/` as the same path so that pair can't even
  // be expressed by the fixture).
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Collision");
    await writeNestedPackShell(packDir, "Collision");
    await writeNestedSkill(packDir, "ExtractWisdom");
    await writeNestedSkill(packDir, "extract-wisdom");

    await expect(importPaiPack({ homeDir, paiPackDir: packDir })).rejects.toThrow(/name collision|name-collision/i);
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-6: Pack-level docs attach to EACH derived skill
// ───────────────────────────────────────────────────────────────────────

test("AC-6: pack-level README/INSTALL/VERIFY attach to each derived skill", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Media");
    await writeNestedPackShell(packDir, "Media");
    await writeNestedSkill(packDir, "Art");
    await writeNestedSkill(packDir, "Remotion");

    const results = await importPaiPack({ homeDir, paiPackDir: packDir });
    for (const r of results) {
      const refDir = join(homeDir, ".soma/skills", r.skillName, "references");
      const readme = join(refDir, "PAI-PACK-README.md");
      const install = join(refDir, "PAI-PACK-INSTALL.md");
      const verify = join(refDir, "PAI-PACK-VERIFY.md");
      expect((await readFile(readme, "utf8")).length).toBeGreaterThan(0);
      expect((await readFile(install, "utf8")).length).toBeGreaterThan(0);
      expect((await readFile(verify, "utf8")).length).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-7: archive records derived-skills
// ───────────────────────────────────────────────────────────────────────

test("AC-7: pack archive records derived-skills list", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Media");
    await writeNestedPackShell(packDir, "Media");
    await writeNestedSkill(packDir, "Art");
    await writeNestedSkill(packDir, "Remotion");

    await importPaiPack({ homeDir, paiPackDir: packDir });

    const archiveManifestPath = join(homeDir, ".soma/imports/pai-packs/media/soma-pack-archive.json");
    const raw = await readFile(archiveManifestPath, "utf8");
    const manifest = JSON.parse(raw) as PaiPackManifest & { derivedSkills?: string[] };
    expect(manifest.derivedSkills?.sort()).toEqual(["art", "remotion"]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// AC-8: planPaiPackImport returns plan-array
// ───────────────────────────────────────────────────────────────────────

test("AC-8: planPaiPackImport returns array of plans, one per derived skill", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Media");
    await writeNestedPackShell(packDir, "Media");
    await writeNestedSkill(packDir, "Art");
    await writeNestedSkill(packDir, "Remotion");

    const plans = await planPaiPackImport({ homeDir, paiPackDir: packDir });
    expect(plans).toHaveLength(2);
    const names = plans.map((p) => p.skillName).sort();
    expect(names).toEqual(["art", "remotion"]);
    for (const plan of plans) {
      expect(plan.apply).toBe(false);
    }
  });
});
