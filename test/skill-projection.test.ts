import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planProjectSkill, planUnprojectSkill, projectSkill, projectSkills, unprojectSkill } from "../src/skill-projection";
import { bootstrapSomaHome } from "../src/index";
import { runSomaCli } from "../src/cli";

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

      const result = await projectSkill({ skillDir, substrates: ["claude-code", "cursor"], homeDir });

      expect(result.skill).toBe("MyTool");

      // Loader symlink — invocable dir keyed by frontmatter name, not "pack-dir".
      const loaderLink = join(homeDir, ".claude", "skills", "MyTool");
      expect((await lstat(loaderLink)).isSymbolicLink()).toBe(true);
      expect(await readlinkAbs(loaderLink)).toBe(resolve(skillDir));

      // Registry symlink in the soma home (the scan source the catalog reads).
      const registryLink = join(homeDir, ".soma", "skills", "MyTool");
      expect((await lstat(registryLink)).isSymbolicLink()).toBe(true);
      expect(await readlinkAbs(registryLink)).toBe(resolve(skillDir));

      // Catalog lists it (soma#371: compact registry entry, not a `## <name>` heading).
      const catalog = await readFile(join(homeDir, ".cursor", "rules", "soma", "SKILLS.md"), "utf8");
      expect(catalog).toContain("**MyTool**");
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
      await projectSkill({ skillDir, substrates: ["claude-code", "cursor"], homeDir });

      const result = await unprojectSkill({ skill: "MyTool", substrates: ["claude-code", "cursor"], homeDir });
      expect(result.registryRemoved).toBe(true);

      await expect(lstat(join(homeDir, ".claude", "skills", "MyTool"))).rejects.toThrow();
      await expect(lstat(join(homeDir, ".soma", "skills", "MyTool"))).rejects.toThrow();

      const catalog = await readFile(join(homeDir, ".cursor", "rules", "soma", "SKILLS.md"), "utf8");
      expect(catalog).not.toContain("**MyTool**");
    });
  });

  test("resolves a registry symlink path to its skill name (stat follows the link)", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      await projectSkill({ skillDir, substrates: ["claude-code"], homeDir });
      const registryLink = join(homeDir, ".soma", "skills", "MyTool");

      // Unproject by the registry SYMLINK path — must resolve to "MyTool",
      // not fall through to a slash-bearing name.
      const result = await unprojectSkill({ skill: registryLink, substrates: ["claude-code"], homeDir });
      expect(result.skill).toBe("MyTool");
      await expect(lstat(join(homeDir, ".claude", "skills", "MyTool"))).rejects.toThrow();
    });
  });

  test("planUnprojectSkill lists removals without touching the filesystem", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      await projectSkill({ skillDir, substrates: ["claude-code"], homeDir });

      const plan = await planUnprojectSkill({ skill: "MyTool", substrates: ["claude-code"], homeDir });
      expect(plan.skill).toBe("MyTool");
      expect(plan.links.some((l) => l.scope === "registry")).toBe(true);

      // Still present — plan wrote nothing.
      expect((await lstat(join(homeDir, ".claude", "skills", "MyTool"))).isSymbolicLink()).toBe(true);
      expect((await lstat(join(homeDir, ".soma", "skills", "MyTool"))).isSymbolicLink()).toBe(true);
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

  test("force removes an authored registry dir (and the plan reflects it)", async () => {
    await withTempHome(async (homeDir) => {
      const registryDir = join(homeDir, ".soma", "skills", "Authored");
      await mkdir(registryDir, { recursive: true });
      await writeFile(join(registryDir, "SKILL.md"), `---\nname: Authored\n---\n`, "utf8");
      await projectSkill({ skillDir: registryDir, substrates: ["claude-code"], homeDir });

      // Without force the plan must NOT list the registry as a removal.
      const planNoForce = await planUnprojectSkill({ skill: "Authored", substrates: ["claude-code"], homeDir });
      expect(planNoForce.links.some((l) => l.scope === "registry")).toBe(false);

      // With force the plan lists it, and apply removes it.
      const planForce = await planUnprojectSkill({ skill: "Authored", substrates: ["claude-code"], homeDir, force: true });
      expect(planForce.links.some((l) => l.scope === "registry")).toBe(true);

      const result = await unprojectSkill({ skill: "Authored", substrates: ["claude-code"], homeDir, force: true });
      expect(result.registryRemoved).toBe(true);
      await expect(lstat(registryDir)).rejects.toThrow();
    });
  });
});

describe("projectSkills (batch)", () => {
  test("links all skills into the substrate + catalog with a single refresh", async () => {
    await withTempHome(async (homeDir) => {
      for (const name of ["Alpha", "Beta"]) {
        const dir = join(homeDir, ".soma", "skills", name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
      }

      const result = await projectSkills({
        skillDirs: [join(homeDir, ".soma", "skills", "Alpha"), join(homeDir, ".soma", "skills", "Beta")],
        substrates: ["claude-code", "cursor"],
        homeDir,
      });

      expect(result.skills.map((s) => s.skill).sort()).toEqual(["Alpha", "Beta"]);
      expect((await lstat(join(homeDir, ".claude", "skills", "Alpha"))).isSymbolicLink()).toBe(true);
      expect((await lstat(join(homeDir, ".claude", "skills", "Beta"))).isSymbolicLink()).toBe(true);

      const catalog = await readFile(join(homeDir, ".cursor", "rules", "soma", "SKILLS.md"), "utf8");
      expect(catalog).toContain("**Alpha**");
      expect(catalog).toContain("**Beta**");
    });
  });

  test("a mid-batch failure still leaves the catalog consistent with what was linked", async () => {
    await withTempHome(async (homeDir) => {
      const okDir = join(homeDir, ".soma", "skills", "Ok");
      await mkdir(okDir, { recursive: true });
      await writeFile(join(okDir, "SKILL.md"), `---\nname: Ok\n---\n`, "utf8");
      const missingDir = join(homeDir, ".soma", "skills", "Missing"); // no SKILL.md

      await expect(
        projectSkills({ skillDirs: [okDir, missingDir], substrates: ["claude-code", "cursor"], homeDir }),
      ).rejects.toThrow();

      // Ok was linked before the failure; the finally-refresh catalogued it.
      expect((await lstat(join(homeDir, ".claude", "skills", "Ok"))).isSymbolicLink()).toBe(true);
      const catalog = await readFile(join(homeDir, ".cursor", "rules", "soma", "SKILLS.md"), "utf8");
      expect(catalog).toContain("**Ok**");
    });
  });

  test("rolls back the registry link when a loader link fails, so the catalog never lists a non-invocable skill", async () => {
    await withTempHome(async (homeDir) => {
      // Source outside the registry, so a registry symlink IS created first.
      const srcDir = join(homeDir, "src", "Solo");
      await mkdir(srcDir, { recursive: true });
      await writeFile(join(srcDir, "SKILL.md"), `---\nname: Solo\n---\n`, "utf8");
      // A real dir already occupies the loader slot → loader ensureSymlink throws
      // (no --force), AFTER the registry link succeeded.
      const loaderSlot = join(homeDir, ".claude", "skills", "Solo");
      await mkdir(loaderSlot, { recursive: true });
      await writeFile(join(loaderSlot, "SKILL.md"), "user\n", "utf8");

      await expect(
        projectSkills({ skillDirs: [srcDir], substrates: ["claude-code", "cursor"], homeDir }),
      ).rejects.toThrow(/non-symlink/);

      // Registry link rolled back → Solo is neither registered nor cataloged.
      await expect(lstat(join(homeDir, ".soma", "skills", "Solo"))).rejects.toThrow();
      const catalog = await readFile(join(homeDir, ".cursor", "rules", "soma", "SKILLS.md"), "utf8");
      expect(catalog).not.toContain("**Solo**");
      // The user's real loader dir is untouched.
      expect((await lstat(loaderSlot)).isDirectory()).toBe(true);
    });
  });
});

describe("soma install --skills", () => {
  async function authorRegistrySkill(homeDir: string, name: string): Promise<void> {
    const dir = join(homeDir, ".soma", "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: "x"\n---\n# ${name}\n`, "utf8");
  }

  test("projects selected skills into the substrate loader on apply, and writes no catalog for a loader substrate", async () => {
    await withTempHome(async (homeDir) => {
      await authorRegistrySkill(homeDir, "Widget");

      const out = await runSomaCli(["install", "claude-code", "--apply", "--home-dir", homeDir, "--skills", "Widget"]);
      expect(out).toContain("Projected skills:");

      expect((await lstat(join(homeDir, ".claude", "skills", "Widget"))).isSymbolicLink()).toBe(true);
      // soma#638: Claude Code discovers Widget through its own loader, so the
      // install writes no rules/soma/SKILLS.md to advertise it a second time.
      await expect(stat(join(homeDir, ".claude", "rules", "soma", "SKILLS.md"))).rejects.toThrow();
    });
  });

  test("soma#638: a catalog substrate still gets its catalog on apply", async () => {
    await withTempHome(async (homeDir) => {
      await authorRegistrySkill(homeDir, "Widget");

      await runSomaCli(["install", "cursor", "--apply", "--home-dir", homeDir, "--skills", "Widget"]);

      const catalog = await readFile(join(homeDir, ".cursor", "rules", "soma", "SKILLS.md"), "utf8");
      expect(catalog).toContain("**Widget**");
    });
  });

  test("dry-run names the skills but writes nothing", async () => {
    await withTempHome(async (homeDir) => {
      await authorRegistrySkill(homeDir, "Widget");

      const out = await runSomaCli(["install", "claude-code", "--home-dir", homeDir, "--skills", "Widget"]);
      expect(out).toContain("Skills to project (on --apply): Widget");
      await expect(lstat(join(homeDir, ".claude", "skills", "Widget"))).rejects.toThrow();
    });
  });

  test("rejects a path-shaped --skills value", async () => {
    await withTempHome(async (homeDir) => {
      await expect(
        runSomaCli(["install", "claude-code", "--apply", "--home-dir", homeDir, "--skills", "../evil"]),
      ).rejects.toThrow(/skill names, not paths/);
    });
  });
});

/**
 * soma#542 — eager substrates get a generated frontmatter-only stub instead of a
 * symlink, because their loader reads every projected SKILL.md at session start.
 * pi-dev is the only eager adapter today; claude-code stands in for on-demand.
 */
describe("eager skill loading (soma#542)", () => {
  const piLoader = (homeDir: string, name: string) => join(homeDir, ".pi", "agent", "skills", name);

  test("writes a frontmatter-only stub, not a symlink, into an eager loader", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");

      const result = await projectSkill({ skillDir, substrates: ["pi-dev"], homeDir });

      const stubDir = piLoader(homeDir, "MyTool");
      expect((await lstat(stubDir)).isSymbolicLink()).toBe(false);
      expect((await lstat(stubDir)).isDirectory()).toBe(true);

      const stub = await readFile(join(stubDir, "SKILL.md"), "utf8");
      // Frontmatter survives verbatim, so the loader can still list and route it.
      expect(stub.startsWith("---\nname: MyTool\ndescription: \"A test skill.\"\n---")).toBe(true);
      // ...and the body is a pointer, not the body. It names the REGISTRY slot,
      // not the source dir: a substrate reader refuses paths outside the Soma
      // home, and the source may be projected from anywhere.
      expect(stub).toContain(join(homeDir, ".soma", "skills", "MyTool", "SKILL.md"));
      expect(stub).not.toContain(resolve(skillDir, "SKILL.md"));
      expect(stub).toContain("soma:skill-stub");
      expect(stub).not.toContain("# MyTool");

      expect(result.links.find((link) => link.substrate === "pi-dev")?.status).toBe("stubbed");
    });
  });

  test("the registry slot stays a symlink to the real body", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      await projectSkill({ skillDir, substrates: ["pi-dev"], homeDir });

      const registry = join(homeDir, ".soma", "skills", "MyTool");
      expect((await lstat(registry)).isSymbolicLink()).toBe(true);
      expect(await readlinkAbs(registry)).toBe(resolve(skillDir));
    });
  });

  test("an on-demand substrate still gets a symlink in the same run", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");

      await projectSkill({ skillDir, substrates: ["claude-code", "pi-dev"], homeDir });

      expect((await lstat(join(homeDir, ".claude", "skills", "MyTool"))).isSymbolicLink()).toBe(true);
      expect((await lstat(piLoader(homeDir, "MyTool"))).isSymbolicLink()).toBe(false);
    });
  });

  test("reprojection is byte-idempotent and reports unchanged", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      await projectSkill({ skillDir, substrates: ["pi-dev"], homeDir });
      const first = await readFile(join(piLoader(homeDir, "MyTool"), "SKILL.md"), "utf8");

      const again = await projectSkill({ skillDir, substrates: ["pi-dev"], homeDir });

      expect(again.links.find((link) => link.substrate === "pi-dev")?.status).toBe("unchanged");
      expect(await readFile(join(piLoader(homeDir, "MyTool"), "SKILL.md"), "utf8")).toBe(first);
    });
  });

  test("replaces its own stub when the source frontmatter changes", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      await projectSkill({ skillDir, substrates: ["pi-dev"], homeDir });

      await writeFile(
        join(skillDir, "SKILL.md"),
        `---\nname: MyTool\ndescription: "Now with triggers."\n---\n\n# MyTool\n`,
        "utf8",
      );
      const again = await projectSkill({ skillDir, substrates: ["pi-dev"], homeDir });

      expect(again.links.find((link) => link.substrate === "pi-dev")?.status).toBe("replaced");
      expect(await readFile(join(piLoader(homeDir, "MyTool"), "SKILL.md"), "utf8")).toContain("Now with triggers.");
    });
  });

  test("refuses to overwrite a real non-stub dir without force, and overwrites with it", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      const stubDir = piLoader(homeDir, "MyTool");
      await mkdir(stubDir, { recursive: true });
      await writeFile(join(stubDir, "SKILL.md"), "---\nname: MyTool\n---\n\nHand-authored.\n", "utf8");

      await expect(projectSkill({ skillDir, substrates: ["pi-dev"], homeDir })).rejects.toThrow(
        /not a Soma-generated skill stub/,
      );
      expect(await readFile(join(stubDir, "SKILL.md"), "utf8")).toContain("Hand-authored.");

      await projectSkill({ skillDir, substrates: ["pi-dev"], homeDir, force: true });
      expect(await readFile(join(stubDir, "SKILL.md"), "utf8")).toContain("soma:skill-stub");
    });
  });

  test("unproject removes a Soma stub without --force", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      await projectSkill({ skillDir, substrates: ["pi-dev"], homeDir });

      const result = await unprojectSkill({ skill: "MyTool", substrates: ["pi-dev"], homeDir });

      expect(result.links.find((link) => link.substrate === "pi-dev")?.status).toBe("removed");
      await expect(lstat(piLoader(homeDir, "MyTool"))).rejects.toThrow();
    });
  });

  test("unproject still refuses a real dir that is not a Soma stub", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");
      await projectSkill({ skillDir, substrates: ["pi-dev"], homeDir });
      await writeFile(join(piLoader(homeDir, "MyTool"), "SKILL.md"), "---\nname: MyTool\n---\n\nMine now.\n", "utf8");

      await expect(unprojectSkill({ skill: "MyTool", substrates: ["pi-dev"], homeDir })).rejects.toThrow(
        /not a Soma-created symlink or stub/,
      );
    });
  });

  test("the plan names the shape apply will write", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = await writeSourceSkill(homeDir, "MyTool");

      const plan = await planProjectSkill({ skillDir, substrates: ["claude-code", "pi-dev"], homeDir });

      expect(plan.links.find((link) => link.substrate === "pi-dev")?.kind).toBe("stub");
      expect(plan.links.find((link) => link.substrate === "claude-code")?.kind).toBe("symlink");
      expect(plan.links.find((link) => link.scope === "registry")?.kind).toBe("symlink");
    });
  });
});

describe("soma#638: canonical source, projected discovery", () => {
  test("a skill edited in the soma registry is live in the substrate with no reprojection", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = join(homeDir, ".soma", "skills", "Widget");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), `---\nname: Widget\n---\n# v1\n`, "utf8");

      await projectSkill({ skillDir, substrates: ["claude-code"], homeDir });
      const loaderSkillMd = join(homeDir, ".claude", "skills", "Widget", "SKILL.md");
      expect(await readFile(loaderSkillMd, "utf8")).toContain("# v1");

      // Edit the canonical copy only — no install, no reproject.
      await writeFile(join(skillDir, "SKILL.md"), `---\nname: Widget\n---\n# v2\n`, "utf8");
      expect(await readFile(loaderSkillMd, "utf8")).toContain("# v2");
    });
  });

  test("unprojecting removes the substrate slot but never the canonical skill", async () => {
    await withTempHome(async (homeDir) => {
      const skillDir = join(homeDir, ".soma", "skills", "Widget");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), `---\nname: Widget\n---\n# body\n`, "utf8");

      await projectSkill({ skillDir, substrates: ["claude-code"], homeDir });
      await unprojectSkill({ skill: "Widget", substrates: ["claude-code"], homeDir });

      await expect(lstat(join(homeDir, ".claude", "skills", "Widget"))).rejects.toThrow();
      // The canonical skill was authored in the registry, so it is the source —
      // unprojecting a substrate must never reach through and delete it.
      expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toContain("# body");
    });
  });
});

describe("soma#638: the registry is the curated set", () => {
  async function authorSkill(homeDir: string, name: string): Promise<void> {
    const dir = join(homeDir, ".soma", "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: "x"\n---\n# ${name}\n`, "utf8");
  }

  test("install projects every registry skill into a loader substrate, with no --skills", async () => {
    await withTempHome(async (homeDir) => {
      await authorSkill(homeDir, "Alpha");
      await authorSkill(homeDir, "Beta");

      await runSomaCli(["install", "claude-code", "--apply", "--home-dir", homeDir]);

      for (const name of ["Alpha", "Beta"]) {
        expect((await lstat(join(homeDir, ".claude", "skills", name))).isSymbolicLink()).toBe(true);
      }
    });
  });

  test("--skills still narrows the projection to an explicit subset", async () => {
    await withTempHome(async (homeDir) => {
      await authorSkill(homeDir, "Alpha");
      await authorSkill(homeDir, "Beta");

      await runSomaCli(["install", "claude-code", "--apply", "--home-dir", homeDir, "--skills", "Alpha"]);

      expect((await lstat(join(homeDir, ".claude", "skills", "Alpha"))).isSymbolicLink()).toBe(true);
      await expect(lstat(join(homeDir, ".claude", "skills", "Beta"))).rejects.toThrow();
    });
  });

  test("a catalog substrate keeps its opt-in loader — its catalog already names the registry", async () => {
    await withTempHome(async (homeDir) => {
      await authorSkill(homeDir, "Alpha");

      await runSomaCli(["install", "cursor", "--apply", "--home-dir", homeDir]);

      await expect(lstat(join(homeDir, ".cursor", "rules", "soma", "skills", "Alpha"))).rejects.toThrow();
      const catalog = await readFile(join(homeDir, ".cursor", "rules", "soma", "SKILLS.md"), "utf8");
      expect(catalog).toContain("**Alpha**");
    });
  });

  test("VSA is left to its own installer, not symlinked over", async () => {
    await withTempHome(async (homeDir) => {
      await authorSkill(homeDir, "Alpha");

      await runSomaCli(["install", "claude-code", "--apply", "--home-dir", homeDir]);

      const vsa = join(homeDir, ".claude", "skills", "VSA");
      expect((await lstat(vsa)).isSymbolicLink()).toBe(false);
      expect(await readFile(join(vsa, "SKILL.md"), "utf8")).toContain("name:");
    });
  });
});

describe("soma#638 review fixes", () => {
  async function authorSkill(homeDir: string, dir: string, frontmatterName: string): Promise<void> {
    const skillDir = join(homeDir, ".soma", "skills", dir);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${frontmatterName}\n---\n# ${dir}\n`, "utf8");
  }

  test("a registry skill whose frontmatter name is VSA is skipped, not allowed to abort the install", async () => {
    await withTempHome(async (homeDir) => {
      // The loader slot is named from frontmatter, so excluding on the dir
      // basename alone let this claim VSA's slot — a real dir owned by the
      // dedicated installer — and ensureSymlink aborted the WHOLE install.
      await authorSkill(homeDir, "renamed-vsa", "VSA");
      await authorSkill(homeDir, "Real", "Real");

      await runSomaCli(["install", "claude-code", "--apply", "--home-dir", homeDir]);

      // Every other skill still projected...
      expect((await lstat(join(homeDir, ".claude", "skills", "Real"))).isSymbolicLink()).toBe(true);
      // ...and VSA's slot is still the dedicated installer's real directory.
      expect((await lstat(join(homeDir, ".claude", "skills", "VSA"))).isSymbolicLink()).toBe(false);
    });
  });

  test("reproject picks up a skill added to the registry since install", async () => {
    await withTempHome(async (homeDir) => {
      await runSomaCli(["install", "claude-code", "--apply", "--home-dir", homeDir]);
      await authorSkill(homeDir, "Added", "Added");

      await runSomaCli(["reproject", "claude-code", "--home-dir", homeDir]);

      expect((await lstat(join(homeDir, ".claude", "skills", "Added"))).isSymbolicLink()).toBe(true);
    });
  });

  test("the dry-run plan names the skills --apply will link, with no --skills passed", async () => {
    await withTempHome(async (homeDir) => {
      await authorSkill(homeDir, "Alpha", "Alpha");

      const out = await runSomaCli(["install", "claude-code", "--home-dir", homeDir]);

      expect(out).toContain("Skills to project (on --apply):");
      expect(out).toContain("Alpha");
      // A plan is a promise about what lands — it must not write anything.
      await expect(lstat(join(homeDir, ".claude", "skills", "Alpha"))).rejects.toThrow();
    });
  });

  test("a catalog substrate's plan stays silent about skills it will not project", async () => {
    await withTempHome(async (homeDir) => {
      await authorSkill(homeDir, "Alpha", "Alpha");

      const out = await runSomaCli(["install", "cursor", "--home-dir", homeDir]);

      expect(out).not.toContain("Skills to project (on --apply):");
    });
  });
});
