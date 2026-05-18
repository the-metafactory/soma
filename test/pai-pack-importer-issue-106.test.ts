/**
 * Issue 106 — pai-pack importer: rename `substrate-specific` →
 * `unrecognized-layout` + new `noise` classification + collapsed
 * plan output.
 *
 * This file pins the new contract surfaces at the pack-importer
 * boundary. CLI / orchestrator surfaces are covered in
 * `test/pai-migration-issue-106.test.ts`.
 *
 * ACs covered here:
 *   - AC-1: `unrecognized-layout` is the new classification name
 *           emitted by the router for files under `src/` the
 *           router doesn't recognize.
 *   - AC-2: Files matching the noise denylist (editor/IDE/language
 *           infrastructure) are classified `noise` at routing time,
 *           silently dropped before refusal accounting, and counted
 *           in the audit. They do NOT land in the refusal list.
 *   - AC-2 corollary: `package.json` / `tsconfig*.json` are only
 *           noise when they have NO `SKILL.md` sibling at the same
 *           level. With a sibling they take the normal route.
 *   - AC-2 corollary: editor-config dir denylist (`.cursor/`,
 *           `.vscode/`, `.idea/`, `.fleet/`, `.zed/`) covers BOTH
 *           symlinks (#104 — silent skip via
 *           `skipped-editor-config-symlink`) AND regular files
 *           (#106 — `noise` classification).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  importPaiPack,
  planPaiPackImport,
  PaiPackUnrecognizedLayoutRefusal,
} from "../src/index";
import type { PaiPackManifest } from "../src/types";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-issue-106-"));
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
      "description: Issue 106 fixture",
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

// ─── AC-1: rename surfaces (typed refusal + error message) ───────────

test("AC-1: refusal class is exported as PaiPackUnrecognizedLayoutRefusal", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);
    // Plant an unrecognized file under src/.
    await writeFile(join(packDir, "src/Foundation.md"), "# Foundation\n", "utf8");

    await expect(planPaiPackImport({ homeDir, paiPackDir: packDir })).rejects.toBeInstanceOf(
      PaiPackUnrecognizedLayoutRefusal,
    );
  });
});

test("AC-1: refusal message uses `--include-unrecognized` flag name", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);
    await writeFile(join(packDir, "src/Foundation.md"), "# Foundation\n", "utf8");

    await expect(planPaiPackImport({ homeDir, paiPackDir: packDir })).rejects.toThrow(
      /--include-unrecognized/,
    );
  });
});

test("AC-1: import succeeds when --include-unrecognized is passed (manifest classification renamed)", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);
    await writeFile(join(packDir, "src/Foundation.md"), "# Foundation\n", "utf8");

    const [plan] = await planPaiPackImport({
      homeDir,
      paiPackDir: packDir,
      includeSubstrateSpecific: true, // legacy alias still supported on options object
    });
    // The unrecognized file lands in the archive — manifest reflects the
    // new classification name.
    const archiveEntry = plan.files.find((f) => f.target.includes("imports/pai-packs/demo/source/src/Foundation.md"));
    expect(archiveEntry?.classification).toBe("unrecognized-layout");
  });
});

// ─── AC-2: noise classification + silent skip ────────────────────────

const NOISE_FIXTURES: Array<{ name: string; relativePath: string; content: string }> = [
  { name: ".gitignore", relativePath: ".gitignore", content: "node_modules\n" },
  { name: ".gitattributes", relativePath: ".gitattributes", content: "* text=auto\n" },
  { name: ".editorconfig", relativePath: ".editorconfig", content: "root = true\n" },
  { name: ".eslintrc.json", relativePath: ".eslintrc.json", content: "{}\n" },
  { name: ".prettierrc", relativePath: ".prettierrc", content: "{}\n" },
  { name: ".nvmrc", relativePath: ".nvmrc", content: "20\n" },
  { name: "bun.lock", relativePath: "bun.lock", content: "# lock\n" },
  { name: "yarn.lock", relativePath: "yarn.lock", content: "# lock\n" },
  { name: "package-lock.json", relativePath: "package-lock.json", content: "{}\n" },
  { name: ".tsbuildinfo", relativePath: "src/Tools/cache.tsbuildinfo", content: "{}\n" },
  { name: ".DS_Store", relativePath: ".DS_Store", content: "x" },
  { name: "Thumbs.db", relativePath: "Thumbs.db", content: "x" },
  { name: ".cursor/ regular file", relativePath: "src/Workflows/.cursor/notes.md", content: "# notes\n" },
  { name: ".vscode/ regular file", relativePath: ".vscode/launch.json", content: "{}\n" },
  { name: ".idea/ regular file", relativePath: ".idea/notes.md", content: "# x\n" },
  { name: ".fleet/ regular file", relativePath: ".fleet/settings.json", content: "{}\n" },
  { name: ".zed/ regular file", relativePath: ".zed/settings.json", content: "{}\n" },
];

for (const fixture of NOISE_FIXTURES) {
  test(`AC-2: noise denylist — ${fixture.name} silently skipped + audited`, async () => {
    await withTempHome(async (homeDir) => {
      const packDir = join(homeDir, "PAI/Packs/Demo");
      await writeMinimalPack(packDir);

      // Plant the noise file.
      const fullPath = join(packDir, fixture.relativePath);
      await mkdir(join(fullPath, ".."), { recursive: true });
      await writeFile(fullPath, fixture.content, "utf8");

      // Plan must succeed with no refusal — noise files are silently
      // dropped before refusal accounting.
      const [plan] = await planPaiPackImport({ homeDir, paiPackDir: packDir });

      // The noise file must NOT appear in plan.files (silent skip).
      expect(plan.files.every((f) => !f.target.includes(fixture.relativePath))).toBe(true);

      // Audit records a `skipped-noise-file` action so reviewers can see
      // what was dropped.
      const skipActions = plan.normalization.actions.filter(
        (action) => action.kind === "skipped-noise-file",
      );
      expect(skipActions.length).toBeGreaterThanOrEqual(1);
      expect(skipActions.some((a) => a.file === fixture.relativePath.split("\\").join("/"))).toBe(true);
    });
  });
}

test("AC-2: tsconfig.json with no SKILL.md sibling is noise", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);

    // tsconfig.json at pack root (no SKILL.md sibling at root) → noise.
    await writeFile(join(packDir, "tsconfig.json"), "{}\n", "utf8");

    const [plan] = await planPaiPackImport({ homeDir, paiPackDir: packDir });
    expect(plan.files.every((f) => !f.target.endsWith("tsconfig.json"))).toBe(true);
    const skips = plan.normalization.actions.filter((a) => a.kind === "skipped-noise-file");
    expect(skips.some((a) => a.file === "tsconfig.json")).toBe(true);
  });
});

test("AC-2: package.json with no SKILL.md sibling is noise", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);

    // package.json at pack root (no SKILL.md sibling — src/SKILL.md is
    // at src/, not at pack root) → noise.
    await writeFile(join(packDir, "package.json"), '{ "name": "x" }\n', "utf8");

    const [plan] = await planPaiPackImport({ homeDir, paiPackDir: packDir });
    expect(plan.files.every((f) => !f.target.endsWith("package.json"))).toBe(true);
    const skips = plan.normalization.actions.filter((a) => a.kind === "skipped-noise-file");
    expect(skips.some((a) => a.file === "package.json")).toBe(true);
  });
});

test("AC-2: package.json WITH SKILL.md sibling at same level routes normally", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);
    // Place a package.json next to src/SKILL.md (same level).
    await writeFile(join(packDir, "src/package.json"), '{ "name": "x" }\n', "utf8");

    // package.json under src/ next to SKILL.md is NOT noise — it should
    // fall through to the unrecognized-layout route (or whatever the
    // router would normally classify it as). Either way, it shouldn't
    // show up as a `skipped-noise-file` audit entry.
    // We don't pass --include-unrecognized, so the pack should refuse.
    await expect(planPaiPackImport({ homeDir, paiPackDir: packDir })).rejects.toBeInstanceOf(
      PaiPackUnrecognizedLayoutRefusal,
    );
  });
});

test("AC-2: noise files are NOT in the refusal list even when other unrecognized files exist", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);

    // Plant a real unrecognized-layout file AND noise files.
    await writeFile(join(packDir, "src/Foundation.md"), "# Foundation\n", "utf8");
    await writeFile(join(packDir, ".gitignore"), "node_modules\n", "utf8");
    await writeFile(join(packDir, "bun.lock"), "# lock\n", "utf8");

    try {
      await planPaiPackImport({ homeDir, paiPackDir: packDir });
      throw new Error("expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PaiPackUnrecognizedLayoutRefusal);
      if (err instanceof PaiPackUnrecognizedLayoutRefusal) {
        // Only Foundation.md should be in the refusal list — noise
        // files were silently dropped before refusal accounting.
        expect(err.files).toContain("src/Foundation.md");
        expect(err.files).not.toContain(".gitignore");
        expect(err.files).not.toContain("bun.lock");
      }
    }
  });
});

test("AC-2: noise audit lands in soma-pack.json after apply", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = join(homeDir, "PAI/Packs/Demo");
    await writeMinimalPack(packDir);
    await writeFile(join(packDir, ".gitignore"), "node_modules\n", "utf8");
    await writeFile(join(packDir, "bun.lock"), "# lock\n", "utf8");

    await importPaiPack({ homeDir, paiPackDir: packDir });

    const manifestRaw = await readFile(join(homeDir, ".soma/skills/demo/soma-pack.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as PaiPackManifest;
    const noiseSkips = manifest.normalization?.actions.filter((a) => a.kind === "skipped-noise-file") ?? [];
    expect(noiseSkips.length).toBeGreaterThanOrEqual(2);
    const files = noiseSkips.map((a) => a.file).sort();
    expect(files).toEqual([".gitignore", "bun.lock"]);
  });
});
