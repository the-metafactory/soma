import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";
import { bootstrapSomaHome, importPaiPack, loadSomaHome, planPaiPackImport } from "../src/index";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-pai-pack-import-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writePackFixture(homeDir: string): Promise<string> {
  const packDir = join(homeDir, "PAI/Packs/Telos");

  await mkdir(join(packDir, "src/Workflows"), { recursive: true });
  await mkdir(join(packDir, "src/Tools"), { recursive: true });
  await mkdir(join(packDir, "src/DashboardTemplate/App"), { recursive: true });
  await writeFile(
    join(packDir, "README.md"),
    [
      "---",
      "name: Telos",
      "description: Life OS and project analysis",
      "---",
      "",
      "# Telos",
      "",
      "Pack docs.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "INSTALL.md"), "# Install\n\nClaude-oriented install guide.\n", "utf8");
  await writeFile(join(packDir, "VERIFY.md"), "# Verify\n\nChecks.\n", "utf8");
  await writeFile(
    join(packDir, "src/SKILL.md"),
    [
      "---",
      "name: Telos",
      "description: Original PAI Telos skill",
      "---",
      "",
      "# Telos",
      "",
      "## Triggers",
      "",
      "- telos",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(packDir, "src/Workflows/Update.md"), "# Update\n", "utf8");
  await writeFile(join(packDir, "src/Tools/UpdateTelos.ts"), "export const tool = true;\n", "utf8");
  await writeFile(join(packDir, "src/DashboardTemplate/App/page.tsx"), "export default function Page() { return null; }\n", "utf8");
  await writeFile(join(packDir, "src/DashboardTemplate/logo.png"), new Uint8Array([0, 159, 146, 150, 255]));

  return packDir;
}

test("requires an explicit PAI Pack directory", async () => {
  await expect(planPaiPackImport({ homeDir: "/tmp/soma-test-home" })).rejects.toThrow("requires --pai-pack-dir");
});

test("plans a PAI Pack import without writing files", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = await writePackFixture(homeDir);
    const plan = await planPaiPackImport({ homeDir, paiPackDir: packDir });

    expect(plan.apply).toBe(false);
    expect(plan.skillName).toBe("telos");
    expect(plan.files).toContainEqual(
      expect.objectContaining({
        source: join(packDir, "src/SKILL.md"),
        target: join(homeDir, ".soma/skills/telos/SKILL.md"),
        classification: "portable",
      }),
    );
    expect(plan.files.some((file) => file.classification === "template" && file.target.endsWith("DashboardTemplate/App/page.tsx"))).toBe(true);
    expect(plan.files.some((file) => file.classification === "source-doc" && file.target.endsWith("PAI-PACK-INSTALL.md"))).toBe(true);
    const manifest = plan.files.find((file) => file.target.endsWith("soma-pack.json"));
    expect(manifest).toMatchObject({ origin: "generated", generator: "pai-pack-importer" });
    expect(manifest && "source" in manifest).toBe(false);
    await expect(stat(join(homeDir, ".soma"))).rejects.toThrow();
  });
});

test("rejects invalid, reserved, colliding, secret, and substrate-specific pack imports", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = await writePackFixture(homeDir);

    await expect(planPaiPackImport({ homeDir, paiPackDir: packDir, skillName: "!!!" })).rejects.toThrow("non-empty skill name");
    await expect(planPaiPackImport({ homeDir, paiPackDir: packDir, skillName: "soma" })).rejects.toThrow("reserved Soma skill");

    await mkdir(join(homeDir, ".soma/skills/telos"), { recursive: true });
    await expect(planPaiPackImport({ homeDir, paiPackDir: packDir })).rejects.toThrow("already exists");
    await expect(planPaiPackImport({ homeDir, paiPackDir: packDir, overwrite: true })).resolves.toMatchObject({ skillName: "telos" });

    const secretPackDir = await writePackFixture(join(homeDir, "secret"));
    await writeFile(join(secretPackDir, "src/DashboardTemplate/.env"), "TOKEN=secret\n", "utf8");
    await expect(planPaiPackImport({ homeDir, paiPackDir: secretPackDir, overwrite: true })).rejects.toThrow("likely secret");
    await rm(join(secretPackDir, "src/DashboardTemplate/.env"));
    await writeFile(join(secretPackDir, "src/DashboardTemplate/.ENV"), "TOKEN=secret\n", "utf8");
    await expect(planPaiPackImport({ homeDir, paiPackDir: secretPackDir, overwrite: true })).rejects.toThrow("likely secret");
    await rm(join(secretPackDir, "src/DashboardTemplate/.ENV"));
    await writeFile(join(secretPackDir, "src/DashboardTemplate/.npmrc"), "//registry.npmjs.org/:_authToken=secret\n", "utf8");
    await expect(planPaiPackImport({ homeDir, paiPackDir: secretPackDir, overwrite: true })).rejects.toThrow("likely secret");
    await rm(join(secretPackDir, "src/DashboardTemplate/.npmrc"));
    await writeFile(join(secretPackDir, "src/Tools/config.json"), "{}", "utf8");
    await expect(planPaiPackImport({ homeDir, paiPackDir: secretPackDir, overwrite: true })).rejects.toThrow("likely secret");
    await rm(join(secretPackDir, "src/Tools/config.json"));
    await writeFile(join(secretPackDir, "src/Tools/local.settings.json"), "{}", "utf8");
    await expect(planPaiPackImport({ homeDir, paiPackDir: secretPackDir, overwrite: true })).rejects.toThrow("likely secret");
    await rm(join(secretPackDir, "src/Tools/local.settings.json"));
    await mkdir(join(secretPackDir, "src/Tools/secrets"), { recursive: true });
    await writeFile(join(secretPackDir, "src/Tools/secrets/prod.txt"), "secret\n", "utf8");
    await expect(planPaiPackImport({ homeDir, paiPackDir: secretPackDir, overwrite: true })).rejects.toThrow("likely secret");
    await rm(join(secretPackDir, "src/Tools/secrets"), { recursive: true, force: true });
    await writeFile(join(secretPackDir, "src/Tools/github-token.txt"), "token\n", "utf8");
    await expect(planPaiPackImport({ homeDir, paiPackDir: secretPackDir, overwrite: true })).rejects.toThrow("likely secret");
    await rm(join(secretPackDir, "src/Tools/github-token.txt"));
    await mkdir(join(secretPackDir, "src/DashboardTemplate/.git"), { recursive: true });
    await writeFile(join(secretPackDir, "src/DashboardTemplate/.git/config"), "[remote]\n", "utf8");
    await expect(planPaiPackImport({ homeDir, paiPackDir: secretPackDir, overwrite: true })).rejects.toThrow("VCS metadata");
    await rm(join(secretPackDir, "src/DashboardTemplate/.git"), { recursive: true, force: true });
    await writeFile(join(secretPackDir, "src/Tools/id_ecdsa"), "OPENSSH PRIVATE KEY\n", "utf8");
    await expect(planPaiPackImport({ homeDir, paiPackDir: secretPackDir, overwrite: true })).rejects.toThrow("likely secret");
    await rm(join(secretPackDir, "src/Tools/id_ecdsa"));
    await writeFile(join(secretPackDir, "src\\DashboardTemplate\\.env"), "TOKEN=secret\n", "utf8");
    await expect(planPaiPackImport({ homeDir, paiPackDir: secretPackDir, overwrite: true })).rejects.toThrow("ambiguous path separator");

    const unsafePackDir = await writePackFixture(join(homeDir, "unsafe"));
    await writeFile(join(unsafePackDir, "src\\..\\escape.md"), "# Escape\n", "utf8");
    await expect(planPaiPackImport({ homeDir, paiPackDir: unsafePackDir, overwrite: true })).rejects.toThrow("ambiguous path separator");

    const symlinkPackDir = await writePackFixture(join(homeDir, "symlink"));
    const outsideDir = join(homeDir, "outside");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "benign.md"), "# Outside\n", "utf8");
    await symlink(outsideDir, join(symlinkPackDir, "src/Workflows/Linked"));
    await expect(planPaiPackImport({ homeDir, paiPackDir: symlinkPackDir, overwrite: true })).rejects.toThrow("refused symlink");

    const substratePackDir = await writePackFixture(join(homeDir, "substrate"));
    await mkdir(join(substratePackDir, "claude"), { recursive: true });
    await writeFile(join(substratePackDir, "claude/profile.md"), "# Claude profile\n", "utf8");
    await expect(planPaiPackImport({ homeDir, paiPackDir: substratePackDir, overwrite: true })).rejects.toThrow("substrate-specific");
    const substratePlan = await planPaiPackImport({ homeDir, paiPackDir: substratePackDir, overwrite: true, includeSubstrateSpecific: true });
    expect(substratePlan.files).toContainEqual(
      expect.objectContaining({
        target: join(homeDir, ".soma/imports/pai-packs/telos/source/claude/profile.md"),
        classification: "substrate-specific",
      }),
    );
  });
});

test("rejects incomplete PAI Pack structures", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = await writePackFixture(homeDir);
    await rm(join(packDir, "src/SKILL.md"));

    await expect(planPaiPackImport({ homeDir, paiPackDir: packDir })).rejects.toThrow("requires V0 pack file(s): src/SKILL.md");

    const noReadmePackDir = await writePackFixture(join(homeDir, "no-readme"));
    await rm(join(noReadmePackDir, "README.md"));

    await expect(planPaiPackImport({ homeDir, paiPackDir: noReadmePackDir, overwrite: true })).rejects.toThrow("requires V0 pack file(s): README.md");
  });
});

test("does not treat non-src template-looking paths as templates", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = await writePackFixture(homeDir);
    await mkdir(join(packDir, "docs/DashboardTemplate"), { recursive: true });
    await writeFile(join(packDir, "docs/DashboardTemplate/readme.md"), "# Template docs\n", "utf8");

    await expect(planPaiPackImport({ homeDir, paiPackDir: packDir })).rejects.toThrow("substrate-specific");
  });
});

test("imports a PAI Pack as a Soma skill", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = await writePackFixture(homeDir);
    await bootstrapSomaHome({ homeDir });
    const result = await importPaiPack({ homeDir, paiPackDir: packDir });
    const context = await loadSomaHome(result.somaHome);

    expect(result.files).toContain(join(homeDir, ".soma/skills/telos/SKILL.md"));
    await expect(readFile(join(homeDir, ".soma/skills/telos/SKILL.md"), "utf8")).resolves.toContain('name: "telos"');
    await expect(readFile(join(homeDir, ".soma/skills/telos/references/PAI-PACK-INSTALL.md"), "utf8")).resolves.toContain("Claude-oriented install guide");
    const manifest = JSON.parse(await readFile(join(homeDir, ".soma/skills/telos/soma-pack.json"), "utf8")) as {
      files: { target: string; classification: string; origin: string; source?: string; generator?: string }[];
    };
    expect(manifest.files).toContainEqual(expect.objectContaining({ classification: "template", source: "src/DashboardTemplate/App/page.tsx" }));
    expect(manifest.files).toContainEqual(expect.objectContaining({ origin: "generated", generator: "pai-pack-importer" }));
    expect(await readFile(join(homeDir, ".soma/skills/telos/DashboardTemplate/logo.png"))).toEqual(Buffer.from([0, 159, 146, 150, 255]));
    expect(context.profile.skills.some((skill) => skill.name === "telos")).toBe(true);
  });
});

test("refuses existing PAI Pack archives without overwrite", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = await writePackFixture(homeDir);
    await mkdir(join(homeDir, ".soma/imports/pai-packs/telos"), { recursive: true });

    await expect(planPaiPackImport({ homeDir, paiPackDir: packDir })).rejects.toThrow("archive 'telos' already exists");
  });
});

test("keeps substrate archives out of the skill manifest", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = await writePackFixture(homeDir);
    await mkdir(join(packDir, "claude"), { recursive: true });
    await writeFile(join(packDir, "claude/profile.md"), "# Claude profile\n", "utf8");
    await importPaiPack({ homeDir, paiPackDir: packDir, includeSubstrateSpecific: true });

    await expect(readFile(join(homeDir, ".soma/imports/pai-packs/telos/source/claude/profile.md"), "utf8")).resolves.toContain("# Claude profile");
    const archiveManifest = JSON.parse(await readFile(join(homeDir, ".soma/imports/pai-packs/telos/soma-pack-archive.json"), "utf8")) as {
      files: { target: string; classification: string; origin: string; source?: string }[];
    };
    expect(archiveManifest.files).toContainEqual(
      expect.objectContaining({ target: "source/claude/profile.md", classification: "substrate-specific", origin: "source", source: "claude/profile.md" }),
    );
    await expect(readFile(join(homeDir, ".soma/skills/telos/soma-pack.json"), "utf8")).resolves.not.toContain("imports/pai-packs");
    await expect(readFile(join(homeDir, ".soma/skills/telos/soma-pack.json"), "utf8")).resolves.not.toContain("claude/profile.md");
  });
});

test("overwrites imported skills without leaving stale files", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = await writePackFixture(homeDir);
    await importPaiPack({ homeDir, paiPackDir: packDir });
    await writeFile(join(homeDir, ".soma/skills/telos/Workflows/Stale.md"), "# Stale\n", "utf8");
    await mkdir(join(homeDir, ".soma/imports/pai-packs/telos/source/claude"), { recursive: true });
    await writeFile(join(homeDir, ".soma/imports/pai-packs/telos/source/claude/settings.json"), "{}", "utf8");

    await importPaiPack({ homeDir, paiPackDir: packDir, overwrite: true });

    await expect(readFile(join(homeDir, ".soma/skills/telos/Workflows/Stale.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(homeDir, ".soma/imports/pai-packs/telos/source/claude/settings.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(homeDir, ".soma/skills/telos/Workflows/Update.md"), "utf8")).resolves.toContain("# Update");
  });
});

test("cli dry-runs and applies a PAI Pack import", async () => {
  await withTempHome(async (homeDir) => {
    const packDir = await writePackFixture(homeDir);
    const dryRun = await runSomaCli(["import", "pai-pack", "--home-dir", homeDir, "--pai-pack-dir", packDir]);

    expect(dryRun).toContain("Soma PAI Pack import plan");
    expect(dryRun).toContain("skillName: telos");
    expect(dryRun).toContain("- template: 2");
    await expect(stat(join(homeDir, ".soma"))).rejects.toThrow();

    const applied = await runSomaCli(["import", "pai-pack", "--apply", "--home-dir", homeDir, "--pai-pack-dir", packDir]);

    expect(applied).toContain("Soma PAI Pack import applied");
    expect(applied).toContain("Import makes the skill available in Soma. Refresh the target substrate projection before expecting the skill in that substrate.");
    expect(applied).toContain(`bun run soma install <substrate> --apply --soma-home ${join(homeDir, ".soma")}`);
    await expect(readFile(join(homeDir, ".soma/skills/telos/Workflows/Update.md"), "utf8")).resolves.toContain("# Update");
  });
});

test("cli quotes post-import projection guidance paths when needed", async () => {
  await withTempHome(async (rootDir) => {
    const homeDir = join(rootDir, "home with spaces");
    const packDir = await writePackFixture(rootDir);
    const applied = await runSomaCli(["import", "pai-pack", "--apply", "--home-dir", homeDir, "--pai-pack-dir", packDir]);

    expect(applied).toContain(`bun run soma install <substrate> --apply --soma-home '${join(homeDir, ".soma")}'`);
  });
});
