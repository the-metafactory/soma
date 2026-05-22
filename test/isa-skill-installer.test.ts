import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { installIsaSkill } from "../src/index";
import type { SomaSkillBaselines } from "../src/index";
import { SOMA_SKILL_DESCRIPTION_MAX_LENGTH } from "../src/pai-pack-normalizer";
import {
  compareSkillVersions,
  isaSkillRuntimeDir,
  parseSkillFrontmatter,
  skillBaselinesPath,
} from "../src/isa-skill-installer";

async function withTempHome<T>(fn: (homeDir: string, somaRepoPath: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-isa-skill-"));
  const somaRepoPath = join(homeDir, "_repo");
  await mkdir(join(somaRepoPath, "src", "skills", "ISA", "Workflows"), { recursive: true });
  // Seed a minimal source skill
  await writeFile(
    join(somaRepoPath, "src", "skills", "ISA", "SKILL.md"),
    "---\nname: ISA\nversion: 1.0.0\npack-id: pai-isa-v1.0.0\n---\n\n# ISA\n",
    "utf8",
  );
  await writeFile(
    join(somaRepoPath, "src", "skills", "ISA", "Workflows", "Scaffold.md"),
    "# Scaffold\n\nWorkflow body.\n",
    "utf8",
  );
  try {
    return await fn(homeDir, somaRepoPath);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function bumpSourceVersion(somaRepoPath: string, version: string): Promise<void> {
  const path = join(somaRepoPath, "src", "skills", "ISA", "SKILL.md");
  const content = (await readFile(path, "utf8")).replace(/version: .+/, `version: ${version}`);
  await writeFile(path, content, "utf8");
}

async function writeRuntimeFile(somaHome: string, relPath: string, content: string): Promise<void> {
  const full = join(isaSkillRuntimeDir(somaHome), relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

test("parseSkillFrontmatter extracts version and pack-id", () => {
  const result = parseSkillFrontmatter("---\nname: ISA\nversion: 1.2.3\npack-id: pai-isa-v1.0.0\n---\n\nbody");
  expect(result).toEqual({ version: "1.2.3", packId: "pai-isa-v1.0.0" });
});

test("parseSkillFrontmatter returns null when version or pack-id missing", () => {
  expect(parseSkillFrontmatter("---\nname: ISA\n---")).toBeNull();
  expect(parseSkillFrontmatter("---\nname: ISA\nversion: 1.0.0\n---")).toBeNull();
});

test("compareSkillVersions: source > runtime", () => {
  expect(compareSkillVersions("1.1.0", "1.0.0")).toBe(1);
  expect(compareSkillVersions("2.0.0", "1.9.9")).toBe(1);
  expect(compareSkillVersions("1.0.1", "1.0.0")).toBe(1);
});

test("compareSkillVersions: equal", () => {
  expect(compareSkillVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareSkillVersions("v1.0.0", "1.0.0")).toBe(0);
});

test("compareSkillVersions: source < runtime", () => {
  expect(compareSkillVersions("1.0.0", "1.0.1")).toBe(-1);
});

test("compareSkillVersions: unparseable defaults to equal", () => {
  expect(compareSkillVersions("garbage", "1.0.0")).toBe(0);
  expect(compareSkillVersions("1.0.0", "garbage")).toBe(0);
});

test("AC-2: fresh install copies skill files to ~/.soma/skills/ISA/ idempotently", async () => {
  await withTempHome(async (homeDir, somaRepoPath) => {
    const somaHome = join(homeDir, ".soma");
    const first = await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    expect(first.action).toBe("fresh");
    expect(first.filesWritten.length).toBeGreaterThan(0);
    expect(await readFile(join(somaHome, "skills", "ISA", "SKILL.md"), "utf8")).toContain("version: 1.0.0");

    const second = await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    expect(second.action).toBe("unchanged");
    expect(second.filesWritten).toHaveLength(0);
  });
});

test("AC-4: per-file baseline hashes recorded in memory/STATE/skill-baselines.json", async () => {
  await withTempHome(async (homeDir, somaRepoPath) => {
    const somaHome = join(homeDir, ".soma");
    await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    const baselines = JSON.parse(await readFile(skillBaselinesPath(somaHome), "utf8")) as SomaSkillBaselines;
    expect(baselines.ISA?.version).toBe("1.0.0");
    expect(baselines.ISA?.files["SKILL.md"]).toMatch(/^sha256:/);
    expect(baselines.ISA?.files["Workflows/Scaffold.md"]).toMatch(/^sha256:/);
  });
});

test("AC-3: version comparison triggers silent upgrade when no local edits", async () => {
  await withTempHome(async (homeDir, somaRepoPath) => {
    const somaHome = join(homeDir, ".soma");
    await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    await bumpSourceVersion(somaRepoPath, "1.1.0");
    // Also change a file's content so the upgrade is meaningful
    await writeFile(
      join(somaRepoPath, "src", "skills", "ISA", "Workflows", "Scaffold.md"),
      "# Scaffold v2\n\nUpdated body.\n",
      "utf8",
    );

    const result = await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    expect(result.action).toBe("upgraded");
    expect(result.sourceVersion).toBe("1.1.0");
    expect(result.runtimeVersion).toBe("1.0.0");
    expect(await readFile(join(somaHome, "skills", "ISA", "Workflows", "Scaffold.md"), "utf8")).toContain("Updated body");
  });
});

test("AC-5: local edits + newer source = .upgrade-available marker, no overwrite", async () => {
  await withTempHome(async (homeDir, somaRepoPath) => {
    const somaHome = join(homeDir, ".soma");
    await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    // User edits Scaffold.md
    await writeRuntimeFile(somaHome, "Workflows/Scaffold.md", "# Scaffold MY EDIT\n");

    await bumpSourceVersion(somaRepoPath, "1.2.0");
    await writeFile(
      join(somaRepoPath, "src", "skills", "ISA", "Workflows", "Scaffold.md"),
      "# Scaffold v3\n",
      "utf8",
    );

    const result = await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    expect(result.action).toBe("preserved-local-edits");
    expect(result.upgradeMarker).toContain(".upgrade-available");
    // Local edit preserved
    expect(await readFile(join(somaHome, "skills", "ISA", "Workflows", "Scaffold.md"), "utf8")).toBe("# Scaffold MY EDIT\n");
    // Marker contents reference the edited file
    const marker = JSON.parse(await readFile(result.upgradeMarker!, "utf8"));
    expect(marker.editedFiles).toContain("Workflows/Scaffold.md");
    expect(marker.sourceVersion).toBe("1.2.0");
  });
});

test("files added by user in runtime are preserved as user additions", async () => {
  await withTempHome(async (homeDir, somaRepoPath) => {
    const somaHome = join(homeDir, ".soma");
    await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    await writeRuntimeFile(somaHome, "Workflows/MyCustom.md", "# Custom\n");

    await bumpSourceVersion(somaRepoPath, "1.3.0");
    const result = await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    expect(result.action).toBe("upgraded");
    expect(result.filesPreservedUserAdditions).toContain("Workflows/MyCustom.md");
    expect(await readFile(join(somaHome, "skills", "ISA", "Workflows", "MyCustom.md"), "utf8")).toBe("# Custom\n");
  });
});

test("unchanged path restores files-in-source-missing-from-runtime", async () => {
  await withTempHome(async (homeDir, somaRepoPath) => {
    const somaHome = join(homeDir, ".soma");
    await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    // User deletes a workflow file by accident
    await rm(join(somaHome, "skills", "ISA", "Workflows", "Scaffold.md"));

    const result = await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    expect(result.action).toBe("unchanged");
    expect(result.filesWritten.length).toBeGreaterThan(0);
    // Restored
    expect(await readFile(join(somaHome, "skills", "ISA", "Workflows", "Scaffold.md"), "utf8")).toContain("Workflow body");
  });
});

test("baselines.json with non-object JSON (array or null) is treated as corrupt", async () => {
  await withTempHome(async (homeDir, somaRepoPath) => {
    const somaHome = join(homeDir, ".soma");
    await installIsaSkill({ homeDir, somaHome, somaRepoPath });

    const cases = ["null", "[]", '"string"', "42", "true"];
    for (const [i, malformed] of cases.entries()) {
      await writeFile(skillBaselinesPath(somaHome), malformed, "utf8");
      await bumpSourceVersion(somaRepoPath, `1.${i + 10}.0`);
      const result = await installIsaSkill({ homeDir, somaHome, somaRepoPath });
      expect(result.action).toBe("preserved-local-edits");
    }
  });
});

test("corrupt baselines.json triggers preserve-local-edits on upgrade (fail-closed)", async () => {
  await withTempHome(async (homeDir, somaRepoPath) => {
    const somaHome = join(homeDir, ".soma");
    await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    // Corrupt baselines file
    await writeFile(skillBaselinesPath(somaHome), "not json {{{", "utf8");

    await bumpSourceVersion(somaRepoPath, "1.4.0");
    const result = await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    expect(result.action).toBe("preserved-local-edits");
    expect(result.upgradeMarker).toBeDefined();
    // Source NOT overwritten
    expect(await readFile(join(somaHome, "skills", "ISA", "Workflows", "Scaffold.md"), "utf8")).toContain("Workflow body");
  });
});

test("upgrade with no baseline (legacy install) treats existing files as drift (fail-closed)", async () => {
  await withTempHome(async (homeDir, somaRepoPath) => {
    const somaHome = join(homeDir, ".soma");
    // Simulate pre-baselines runtime
    const runtimeDir = isaSkillRuntimeDir(somaHome);
    await mkdir(join(runtimeDir, "Workflows"), { recursive: true });
    await writeFile(
      join(runtimeDir, "SKILL.md"),
      "---\nname: ISA\nversion: 1.0.0\npack-id: pai-isa-v1.0.0\n---\n\n# ISA\n",
      "utf8",
    );
    await writeFile(join(runtimeDir, "Workflows", "Scaffold.md"), "# Legacy edited\n", "utf8");

    await bumpSourceVersion(somaRepoPath, "1.5.0");
    const result = await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    expect(result.action).toBe("preserved-local-edits");
    // Legacy content preserved, not overwritten
    expect(await readFile(join(runtimeDir, "Workflows", "Scaffold.md"), "utf8")).toBe("# Legacy edited\n");
  });
});

test("pre-baselines runtime (no baseline entry) survives same-version restore", async () => {
  await withTempHome(async (homeDir, somaRepoPath) => {
    const somaHome = join(homeDir, ".soma");
    // Simulate a runtime installed before the baseline feature: copy source
    // files to runtime location, but do NOT write skill-baselines.json.
    const runtimeDir = isaSkillRuntimeDir(somaHome);
    await mkdir(join(runtimeDir, "Workflows"), { recursive: true });
    await writeFile(
      join(runtimeDir, "SKILL.md"),
      "---\nname: ISA\nversion: 1.0.0\npack-id: pai-isa-v1.0.0\n---\n\n# ISA\n",
      "utf8",
    );
    await writeFile(
      join(runtimeDir, "Workflows", "Scaffold.md"),
      "# Scaffold\n\nWorkflow body.\n",
      "utf8",
    );
    // User deletes one file. Same-version restore must NOT crash on missing baseline.
    await rm(join(runtimeDir, "Workflows", "Scaffold.md"));

    const result = await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    expect(result.action).toBe("unchanged");
    expect(result.filesWritten.length).toBeGreaterThan(0);
    // Baseline now seeded
    const baselines = JSON.parse(await readFile(skillBaselinesPath(somaHome), "utf8")) as SomaSkillBaselines;
    expect(baselines.ISA?.files["Workflows/Scaffold.md"]).toMatch(/^sha256:/);
  });
});

test("force: true reinstalls regardless of state", async () => {
  await withTempHome(async (homeDir, somaRepoPath) => {
    const somaHome = join(homeDir, ".soma");
    await installIsaSkill({ homeDir, somaHome, somaRepoPath });
    // Local edit
    await writeRuntimeFile(somaHome, "Workflows/Scaffold.md", "# edited\n");

    const result = await installIsaSkill({ homeDir, somaHome, somaRepoPath, force: true });
    expect(result.action).toBe("fresh");
    // Source content restored
    expect(await readFile(join(somaHome, "skills", "ISA", "Workflows", "Scaffold.md"), "utf8")).toContain("Workflow body");
  });
});

test("missing source dir returns no-source result (graceful no-op)", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-isa-skill-missing-"));
  try {
    const result = await installIsaSkill({
      homeDir,
      somaHome: join(homeDir, ".soma"),
      somaRepoPath: join(homeDir, "nope"),
    });
    expect(result.action).toBe("no-source");
    expect(result.filesWritten).toHaveLength(0);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("source SKILL.md missing version frontmatter throws", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-isa-skill-badfront-"));
  const somaRepoPath = join(homeDir, "_repo");
  await mkdir(join(somaRepoPath, "src", "skills", "ISA"), { recursive: true });
  await writeFile(join(somaRepoPath, "src", "skills", "ISA", "SKILL.md"), "---\nname: ISA\n---\n", "utf8");
  try {
    await expect(
      installIsaSkill({ homeDir, somaHome: join(homeDir, ".soma"), somaRepoPath }),
    ).rejects.toThrow("missing version or pack-id");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("ship config: real src/skills/ISA carries version + pack-id frontmatter", async () => {
  const repoSkill = join(import.meta.dirname, "..", "src", "skills", "ISA", "SKILL.md");
  const content = await readFile(repoSkill, "utf8");
  const fm = parseSkillFrontmatter(content);
  expect(fm).not.toBeNull();
  expect(fm?.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(fm?.packId).toMatch(/^pai-isa/);
});

test("ship config: real src/skills/ISA description fits portable metadata limit", async () => {
  const repoSkill = join(import.meta.dirname, "..", "src", "skills", "ISA", "SKILL.md");
  const content = await readFile(repoSkill, "utf8");
  const description = /^description:\s*"([\s\S]*?)"$/m.exec(content)?.[1];
  expect(description).toBeDefined();
  expect(description!.length).toBeLessThanOrEqual(SOMA_SKILL_DESCRIPTION_MAX_LENGTH);
  expect(content).toContain("## Fast Path");
  expect(content).toContain("## Reference Loading");
});
