import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planProjectSkill, projectSkill, unprojectSkill } from "../src/skill-projection";
import { bootstrapSomaHome } from "../src/index";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-skill-projection-"));
  try {
    // project-skill runs against a real soma home (the catalog refresh reads it).
    await bootstrapSomaHome({ homeDir });
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

/** Source skill whose dir basename ≠ frontmatter name, to prove name resolution. */
async function writeSourceSkill(homeDir: string, frontmatterName: string, dirName = "pack-dir"): Promise<string> {
  const skillDir = join(homeDir, "source", dirName);
  await mkdir(join(skillDir, "Workflows"), { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${frontmatterName}\ndescription: "A test skill."\n---\n\n# ${frontmatterName}\n`,
    "utf8",
  );
  await writeFile(join(skillDir, "Workflows", "Run.md"), "# Run\n", "utf8");
  return skillDir;
}

async function readlinkAbs(linkPath: string): Promise<string> {
  const target = await readlink(linkPath);
  return resolve(linkPath, "..", target);
}

describe("projectSkill", () => {
  test("symlinks into the claude-code loader and the soma registry, and lists it in the catalog", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");

      const result = await projectSkill({ skillDir, substrates: ["claude-code"], homeDir });

      expect(result.skill).toBe("MyTool");

      // Loader symlink — invocable dir keyed by frontmatter name, not "pack-dir".
      const loaderLink = join(homeDir, ".claude", "skills", "MyTool");
      expect((await lstat(loaderLink)).isSymbolicLink()).toBe(true);
      expect(await readlinkAbs(loaderLink)).toBe(resolve(skillDir));

      // Registry symlink in the soma home (the scan source the catalog reads).
      const registryLink = join(homeDir, ".soma", "skills", "MyTool");
      expect((await lstat(registryLink)).isSymbolicLink()).toBe(true);
      expect(await readlinkAbs(registryLink)).toBe(resolve(skillDir));

      // Catalog lists it.
      const catalog = await readFile(join(homeDir, ".claude", "rules", "soma", "SKILLS.md"), "utf8");
      expect(catalog).toContain("## MyTool");
    });
  });

  test("is idempotent — a second projection reports unchanged links", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      await projectSkill({ skillDir, substrates: ["claude-code"], homeDir });

      const second = await projectSkill({ skillDir, substrates: ["claude-code"], homeDir });
      for (const link of second.links) {
        expect(link.status).toBe("unchanged");
      }
    });
  });

  test("refuses to clobber a real (non-symlink) dir in the loader slot without force", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      // A user's own real skill dir already sits in the loader slot.
      const loaderSlot = join(homeDir, ".claude", "skills", "MyTool");
      await mkdir(loaderSlot, { recursive: true });
      await writeFile(join(loaderSlot, "SKILL.md"), "user skill\n", "utf8");

      await expect(projectSkill({ skillDir, substrates: ["claude-code"], homeDir })).rejects.toThrow(/non-symlink/);
      // The user's dir is untouched.
      expect((await lstat(loaderSlot)).isDirectory()).toBe(true);
      expect((await lstat(loaderSlot)).isSymbolicLink()).toBe(false);
    });
  });

  test("replaces a real dir with force (migrating a hand-made copy)", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      const loaderSlot = join(homeDir, ".claude", "skills", "MyTool");
      await mkdir(loaderSlot, { recursive: true });
      await writeFile(join(loaderSlot, "SKILL.md"), "stale\n", "utf8");

      const result = await projectSkill({ skillDir, substrates: ["claude-code"], homeDir, force: true });
      const loaderLinkStatus = result.links.find((l) => l.scope === "substrate")?.status;
      expect(loaderLinkStatus).toBe("replaced");
      expect((await lstat(loaderSlot)).isSymbolicLink()).toBe(true);
    });
  });

  test("projects into multiple substrates", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      await projectSkill({ skillDir, substrates: ["claude-code", "codex"], homeDir });

      expect((await lstat(join(homeDir, ".claude", "skills", "MyTool"))).isSymbolicLink()).toBe(true);
      expect((await lstat(join(homeDir, ".codex", "skills", "MyTool"))).isSymbolicLink()).toBe(true);
    });
  });

  test("rejects --substrate-home with more than one substrate", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      await expect(
        projectSkill({ skillDir, substrates: ["claude-code", "codex"], homeDir, substrateHome: join(homeDir, "x") }),
      ).rejects.toThrow(/single substrate/);
    });
  });
});

describe("planProjectSkill", () => {
  test("reports intended links without writing anything", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      const plan = await planProjectSkill({ skillDir, substrates: ["claude-code"], homeDir });

      expect(plan.skill).toBe("MyTool");
      expect(plan.links.some((l) => l.scope === "registry")).toBe(true);
      expect(plan.links.some((l) => l.scope === "substrate")).toBe(true);

      // Nothing was written.
      await expect(lstat(join(homeDir, ".claude", "skills", "MyTool"))).rejects.toThrow();
      await expect(lstat(join(homeDir, ".soma", "skills", "MyTool"))).rejects.toThrow();
    });
  });
});

describe("unprojectSkill", () => {
  test("removes the loader + registry symlinks and drops the skill from the catalog", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      await projectSkill({ skillDir, substrates: ["claude-code"], homeDir });

      const result = await unprojectSkill({ skill: "MyTool", substrates: ["claude-code"], homeDir });
      expect(result.registryRemoved).toBe(true);

      await expect(lstat(join(homeDir, ".claude", "skills", "MyTool"))).rejects.toThrow();
      await expect(lstat(join(homeDir, ".soma", "skills", "MyTool"))).rejects.toThrow();

      const catalog = await readFile(join(homeDir, ".claude", "rules", "soma", "SKILLS.md"), "utf8");
      expect(catalog).not.toContain("## MyTool");
    });
  });

  test("leaves an authored registry dir intact (only removes the substrate projection)", async () => {
    await withTempHome(async (homeDir) => {
      // Author the skill directly in the registry (Purpose-style), not via a symlink.
      const registryDir = join(homeDir, ".soma", "skills", "Authored");
      await mkdir(registryDir, { recursive: true });
      await writeFile(
        join(registryDir, "SKILL.md"),
        `---\nname: Authored\ndescription: "Authored in place."\n---\n`,
        "utf8",
      );
      await projectSkill({ skillDir: registryDir, substrates: ["claude-code"], homeDir });
      expect((await lstat(join(homeDir, ".claude", "skills", "Authored"))).isSymbolicLink()).toBe(true);

      const result = await unprojectSkill({ skill: "Authored", substrates: ["claude-code"], homeDir });
      expect(result.registryRemoved).toBe(false);

      // Loader projection gone; authored registry dir preserved.
      await expect(lstat(join(homeDir, ".claude", "skills", "Authored"))).rejects.toThrow();
      expect((await lstat(registryDir)).isDirectory()).toBe(true);
    });
  });
});
