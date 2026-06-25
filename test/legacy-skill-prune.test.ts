import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { pruneLegacyVsaSkill } from "../src/legacy-skill-prune";
import { installSomaForClaudeCode, installSomaForCodex } from "../src/index";
import { createPaths } from "../src/paths";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-prune-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

// A SKILL.md identical in shape to the renamed-away Soma ISA skill: frontmatter
// `name: ISA` AND a description beginning with the shared identity sentence.
const SOMA_ISA_SKILL_MD = [
  "---",
  "name: ISA",
  'description: "Owns the Ideal State Artifact: the commitment-time scaffold for articulating done."',
  "effort: medium",
  "---",
  "",
  "# ISA",
  "",
  "Body.",
  "",
].join("\n");

async function plantSkill(skillsDir: string, name: string, skillMd: string): Promise<string> {
  const dir = join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMd, "utf8");
  return dir;
}

test("pruneLegacyVsaSkill removes a soma ISA dir (name + identity marker) and returns true", async () => {
  await withTempHome(async (homeDir) => {
    const skills = join(homeDir, "skills");
    const isaDir = await plantSkill(skills, "ISA", SOMA_ISA_SKILL_MD);

    const removed = await pruneLegacyVsaSkill(skills);

    expect(removed).toBe(true);
    await expect(stat(isaDir)).rejects.toThrow();
  });
});

test("pruneLegacyVsaSkill PRESERVES a user ISA dir whose SKILL.md lacks the identity marker", async () => {
  await withTempHome(async (homeDir) => {
    const skills = join(homeDir, "skills");
    const userMd = ["---", "name: ISA", 'description: "International Standard Atmosphere reference tables."', "---", "", "# ISA", ""].join("\n");
    const isaDir = await plantSkill(skills, "ISA", userMd);

    const removed = await pruneLegacyVsaSkill(skills);

    expect(removed).toBe(false);
    expect(await readFile(join(isaDir, "SKILL.md"), "utf8")).toBe(userMd); // intact
  });
});

test("pruneLegacyVsaSkill PRESERVES an ISA dir whose frontmatter name differs even with the marker", async () => {
  await withTempHome(async (homeDir) => {
    const skills = join(homeDir, "skills");
    // Identity marker present, but `name` is not ISA — both signals required.
    const md = ["---", "name: MyArtifacts", 'description: "Owns the Ideal State Artifact: do not delete me."', "---", "", "# X", ""].join("\n");
    const isaDir = await plantSkill(skills, "ISA", md);

    const removed = await pruneLegacyVsaSkill(skills);

    expect(removed).toBe(false);
    expect(await readFile(join(isaDir, "SKILL.md"), "utf8")).toBe(md);
  });
});

test("pruneLegacyVsaSkill PRESERVES a lowercase 'isa' dir — the load-bearing case-insensitive guard", async () => {
  // On a case-insensitive FS (macOS/APFS, the author's host) a blind rm of path
  // "ISA" would resolve to the same inode as a user dir stored as "isa". The exact
  // on-disk-name match (entry.name === "ISA") prevents that: a dir whose stored
  // name is "isa" is never matched, EVEN with soma's exact provenance content.
  await withTempHome(async (homeDir) => {
    const skills = join(homeDir, "skills");
    const isaDir = await plantSkill(skills, "isa", SOMA_ISA_SKILL_MD);

    const removed = await pruneLegacyVsaSkill(skills);

    expect(removed).toBe(false);
    expect(await readFile(join(isaDir, "SKILL.md"), "utf8")).toBe(SOMA_ISA_SKILL_MD); // intact
  });
});

test("pruneLegacyVsaSkill is a no-op when the ISA dir is absent", async () => {
  await withTempHome(async (homeDir) => {
    const skills = join(homeDir, "skills");
    await plantSkill(skills, "VSA", SOMA_ISA_SKILL_MD.replace("name: ISA", "name: VSA"));

    const removed = await pruneLegacyVsaSkill(skills);

    expect(removed).toBe(false);
    expect(await stat(join(skills, "VSA"))).toBeTruthy(); // sibling untouched
  });
});

test("pruneLegacyVsaSkill is a no-op when the skills dir is absent", async () => {
  await withTempHome(async (homeDir) => {
    const removed = await pruneLegacyVsaSkill(join(homeDir, "does-not-exist"));
    expect(removed).toBe(false);
  });
});

test("pruneLegacyVsaSkill is a no-op when ISA dir has no SKILL.md", async () => {
  await withTempHome(async (homeDir) => {
    const skills = join(homeDir, "skills");
    const isaDir = join(skills, "ISA");
    await mkdir(isaDir, { recursive: true });

    const removed = await pruneLegacyVsaSkill(skills);

    expect(removed).toBe(false);
    expect(await stat(isaDir)).toBeTruthy();
  });
});

test("codex install prunes a sibling ISA skill but preserves projected VSA and user skills", async () => {
  await withTempHome(async (homeDir) => {
    const codexSkills = join(homeDir, ".codex", "skills");
    // Plant a soma-style ISA skill + a genuine user skill in the shared dir.
    await plantSkill(codexSkills, "ISA", SOMA_ISA_SKILL_MD);
    const userSkillMd = ["---", "name: my-skill", 'description: "A user skill."', "---", "", "# my-skill", ""].join("\n");
    await plantSkill(codexSkills, "my-skill", userSkillMd);
    // A user dir literally named ISA-like but non-soma must also survive.
    const userIsaMd = ["---", "name: ISA", 'description: "Not a soma skill at all."', "---", "", "# ISA", ""].join("\n");

    await installSomaForCodex({ homeDir });

    await expect(stat(join(codexSkills, "ISA"))).rejects.toThrow(); // soma ISA pruned
    expect(await readFile(join(codexSkills, "VSA", "SKILL.md"), "utf8")).toContain("name: VSA"); // VSA projected
    expect(await readFile(join(codexSkills, "my-skill", "SKILL.md"), "utf8")).toBe(userSkillMd); // user skill survives

    // Now reproject with a non-soma ISA dir present: it must be preserved.
    const userIsaDir = await plantSkill(codexSkills, "ISA", userIsaMd);
    await installSomaForCodex({ homeDir });
    expect(await readFile(join(userIsaDir, "SKILL.md"), "utf8")).toBe(userIsaMd);
  });
});

test("claude-code install prunes a sibling ISA skill but preserves projected VSA and user skills", async () => {
  await withTempHome(async (homeDir) => {
    const claudeSkills = join(homeDir, ".claude", "skills");
    await plantSkill(claudeSkills, "ISA", SOMA_ISA_SKILL_MD);
    const userSkillMd = ["---", "name: my-skill", 'description: "A user skill."', "---", "", "# my-skill", ""].join("\n");
    await plantSkill(claudeSkills, "my-skill", userSkillMd);

    await installSomaForClaudeCode({ homeDir });

    await expect(stat(join(claudeSkills, "ISA"))).rejects.toThrow(); // soma ISA pruned
    expect(await readFile(join(claudeSkills, "VSA", "SKILL.md"), "utf8")).toContain("name: VSA"); // VSA projected
    expect(await readFile(join(claudeSkills, "my-skill", "SKILL.md"), "utf8")).toBe(userSkillMd); // user skill survives
  });
});

test("install prunes the SOURCE-home ISA so it stops propagating, preserving user skill + canonical VSA", async () => {
  await withTempHome(async (homeDir) => {
    // Bootstrap the soma home first (via a real install), then plant a stale ISA
    // alongside the canonical VSA + a genuine user skill in the SOURCE home.
    await installSomaForCodex({ homeDir });
    const somaSkills = createPaths({ homeDir }).skills();
    await plantSkill(somaSkills, "ISA", SOMA_ISA_SKILL_MD);
    const userSkillMd = ["---", "name: user-source-skill", 'description: "A user source skill."', "---", "", "# x", ""].join("\n");
    await plantSkill(somaSkills, "user-source-skill", userSkillMd);

    // Re-install: source-home prune must remove ISA before loadSomaSkills runs.
    await installSomaForCodex({ homeDir });

    await expect(stat(join(somaSkills, "ISA"))).rejects.toThrow(); // source ISA pruned
    expect(await readFile(join(somaSkills, "VSA", "SKILL.md"), "utf8")).toContain("name: VSA"); // canonical VSA survives
    expect(await readFile(join(somaSkills, "user-source-skill", "SKILL.md"), "utf8")).toBe(userSkillMd); // user skill survives

    // And the stale ISA must NOT have re-propagated to the codex substrate.
    await expect(stat(join(homeDir, ".codex", "skills", "ISA"))).rejects.toThrow();
  });
});
