/**
 * Issue 104 — pai-pack-importer: skip IDE/editor config symlinks
 * (`.cursor/`, `.vscode/`, `.idea/`, `.fleet/`, `.zed/`) instead of
 * refusing the pack outright.
 *
 * The previous symlink-refusal rule aborted otherwise-valid packs the
 * moment any symlink — including IDE editor noise like
 * `.cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc` — was
 * encountered. PAI's `art` and `prompting` packs were the trigger.
 * The denylist is intentionally narrow: only well-known editor-config
 * directories are skipped. Every other symlink still aborts the pack
 * as `refused-other` so the security envelope is preserved.
 *
 * ACs:
 * - AC-1: `art` / `prompting`-style packs with `.cursor/rules/*.mdc`
 *         symlinks import successfully (no `refused-other`).
 * - AC-2: New audit action `skipped-editor-config-symlink` recorded
 *         per skipped file in the per-pack `soma-pack.json` audit.
 * - AC-3: A non-editor symlink (e.g., `src/Workflows/payload.md`
 *         symlinked to `/etc/passwd`) still aborts the pack.
 * - AC-4: Fixture-based coverage for both paths.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { importPaiPack, planPaiPackImport } from "../src/index";
import type { PaiPackManifest } from "../src/types";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-issue-104-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writeMinimalPack(packDir: string, packName = "Demo"): Promise<void> {
  await mkdir(join(packDir, "src/Workflows"), { recursive: true });
  await mkdir(join(packDir, "src/Tools"), { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    [
      "---",
      `name: ${packName}`,
      "description: Editor-symlink fixture",
      "---",
      "",
      `# ${packName}`,
      "",
      "Pack docs.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "INSTALL.md"), "# Install\n", "utf8");
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n", "utf8");
  await writeFile(
    join(packDir, "src/SKILL.md"),
    [
      "---",
      `name: ${packName}`,
      "description: Original PAI skill",
      "---",
      "",
      `# ${packName}`,
      "",
      "## Triggers",
      "",
      "- demo",
    ].join("\n"),
    "utf8",
  );
}

// ─── AC-1 + AC-2: .cursor/rules/*.mdc symlink skipped + audit entry ────

test("AC-1+AC-2: `.cursor/rules/*.mdc` symlink is skipped, pack imports, audit records skip", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);

    // Plant a realistic editor-config symlink — Cursor rule file pointing
    // outside the pack root (the same shape PAI's `art` + `prompting`
    // packs have that triggered the original refusal).
    const externalRule = join(homeDir, "shared-rules/use-bun.mdc");
    await mkdir(join(homeDir, "shared-rules"), { recursive: true });
    await writeFile(externalRule, "# Use Bun\n", "utf8");
    await mkdir(join(packDir, "src/Tools/.cursor/rules"), { recursive: true });
    await symlink(externalRule, join(packDir, "src/Tools/.cursor/rules/use-bun.mdc"));

    // Plan must succeed — no `refused symlink` throw.
    const plan = await planPaiPackImport({ homeDir, paiPackDir: packDir });
    expect(plan.skillName).toBe("demo");

    // The cursor symlink must NOT appear in the routed file set.
    expect(plan.files.every((file) => !file.target.includes(".cursor/"))).toBe(true);

    // AC-2: audit records `skipped-editor-config-symlink` for the cursor file.
    const skipActions = plan.normalization.actions.filter(
      (action) => action.kind === "skipped-editor-config-symlink",
    );
    expect(skipActions).toHaveLength(1);
    expect(skipActions[0]?.file).toBe("src/Tools/.cursor/rules/use-bun.mdc");

    // AC-1: apply path also succeeds end-to-end.
    const result = await importPaiPack({ homeDir, paiPackDir: packDir });
    expect(result.skillName).toBe("demo");
    expect(result.normalization.actions.some((a) => a.kind === "skipped-editor-config-symlink")).toBe(true);

    // The per-pack `soma-pack.json` audit surfaces the skip alongside
    // existing normalization actions (AC-2: "audit alongside existing
    // actions").
    const manifestRaw = await readFile(join(homeDir, ".soma/skills/demo/soma-pack.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as PaiPackManifest;
    expect(manifest.normalization?.actions.some((a) => a.kind === "skipped-editor-config-symlink")).toBe(true);
  });
});

test("AC-2: `.vscode/settings.json` symlink is skipped, pack imports, audit records skip", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);

    const externalSettings = join(homeDir, "shared-vscode/settings.json");
    await mkdir(join(homeDir, "shared-vscode"), { recursive: true });
    await writeFile(externalSettings, '{ "editor.tabSize": 2 }\n', "utf8");
    await mkdir(join(packDir, ".vscode"), { recursive: true });
    await symlink(externalSettings, join(packDir, ".vscode/settings.json"));

    const plan = await planPaiPackImport({ homeDir, paiPackDir: packDir });
    expect(plan.files.every((file) => !file.target.includes(".vscode/"))).toBe(true);
    const skipActions = plan.normalization.actions.filter(
      (action) => action.kind === "skipped-editor-config-symlink",
    );
    expect(skipActions).toHaveLength(1);
    expect(skipActions[0]?.file).toBe(".vscode/settings.json");

    const result = await importPaiPack({ homeDir, paiPackDir: packDir });
    expect(result.skillName).toBe("demo");
  });
});

// ─── AC-3: non-editor symlink still REFUSES the pack ──────────────────

test("AC-3: non-editor symlink (`src/Workflows/payload.md` → /etc/passwd) still refuses pack", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);

    // The classic escape attempt the narrow denylist must NOT enable.
    await symlink("/etc/passwd", join(packDir, "src/Workflows/payload.md"));

    await expect(planPaiPackImport({ homeDir, paiPackDir: packDir })).rejects.toThrow(
      /refused symlink path: src\/Workflows\/payload\.md/,
    );
  });
});

test("AC-3: non-editor symlink elsewhere (`src/Tools/leak.ts`) still refuses pack", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);

    const outside = join(homeDir, "outside.ts");
    await writeFile(outside, "// outside\n", "utf8");
    await symlink(outside, join(packDir, "src/Tools/leak.ts"));

    await expect(planPaiPackImport({ homeDir, paiPackDir: packDir })).rejects.toThrow(/refused symlink/);
  });
});

// ─── AC-4: mixed pack — 2 editor-config symlinks + 3 normal files ─────

test("AC-4: mixed pack with editor symlinks AND normal files imports cleanly with audit entries", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);

    // Three normal portable files (Workflows + Tools regular content).
    await writeFile(join(packDir, "src/Workflows/Update.md"), "# Update\n", "utf8");
    await writeFile(join(packDir, "src/Workflows/Verify.md"), "# Verify\n", "utf8");
    await writeFile(join(packDir, "src/Tools/Helper.ts"), "export const helper = true;\n", "utf8");

    // Two editor-config symlinks.
    const externalRule = join(homeDir, "shared-rules/use-bun.mdc");
    await mkdir(join(homeDir, "shared-rules"), { recursive: true });
    await writeFile(externalRule, "# Use Bun\n", "utf8");
    await mkdir(join(packDir, "src/Tools/.cursor/rules"), { recursive: true });
    await symlink(externalRule, join(packDir, "src/Tools/.cursor/rules/use-bun.mdc"));

    const externalIdea = join(homeDir, "shared-idea/workspace.xml");
    await mkdir(join(homeDir, "shared-idea"), { recursive: true });
    await writeFile(externalIdea, "<project />\n", "utf8");
    await mkdir(join(packDir, ".idea"), { recursive: true });
    await symlink(externalIdea, join(packDir, ".idea/workspace.xml"));

    const plan = await planPaiPackImport({ homeDir, paiPackDir: packDir });

    // Audit has exactly 2 skip entries.
    const skipActions = plan.normalization.actions.filter(
      (action) => action.kind === "skipped-editor-config-symlink",
    );
    expect(skipActions).toHaveLength(2);
    const skippedPaths = skipActions.map((a) => a.file).sort();
    expect(skippedPaths).toEqual([".idea/workspace.xml", "src/Tools/.cursor/rules/use-bun.mdc"]);

    // Normal files still get classified + imported.
    expect(plan.files.some((file) => file.target.endsWith("Workflows/Update.md"))).toBe(true);
    expect(plan.files.some((file) => file.target.endsWith("Workflows/Verify.md"))).toBe(true);
    expect(plan.files.some((file) => file.target.endsWith("Tools/Helper.ts"))).toBe(true);

    // No `.cursor` or `.idea` paths leak into the routed file set.
    expect(plan.files.every((file) => !file.target.includes(".cursor/") && !file.target.includes(".idea/"))).toBe(true);

    // Apply succeeds; no refusal.
    const result = await importPaiPack({ homeDir, paiPackDir: packDir });
    expect(result.skillName).toBe("demo");
  });
});

test("AC-4: `.fleet/` and `.zed/` symlinks are also skipped (full denylist coverage)", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);

    const fleetExt = join(homeDir, "fleet-settings.json");
    const zedExt = join(homeDir, "zed-settings.json");
    await writeFile(fleetExt, "{}\n", "utf8");
    await writeFile(zedExt, "{}\n", "utf8");
    await mkdir(join(packDir, ".fleet"), { recursive: true });
    await mkdir(join(packDir, ".zed"), { recursive: true });
    await symlink(fleetExt, join(packDir, ".fleet/settings.json"));
    await symlink(zedExt, join(packDir, ".zed/settings.json"));

    const plan = await planPaiPackImport({ homeDir, paiPackDir: packDir });
    const skipActions = plan.normalization.actions.filter(
      (action) => action.kind === "skipped-editor-config-symlink",
    );
    expect(skipActions.map((a) => a.file).sort()).toEqual([".fleet/settings.json", ".zed/settings.json"]);
  });
});
