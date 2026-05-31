import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { rewriteSkillNameFrontmatter } from "../../skill-frontmatter";
import { rewriteSubstrateProjectionContent } from "../../substrate-projection-rewrites";
import type { Projection, SomaSkill } from "../../types";

export const PI_DEV_ISA_SKILL_ID = "isa";

export function piDevSkillId(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "skill";
}

export function renderPiDevSkillFileContent(skillName: string, filePath: string, content: string): string {
  return rewriteSkillNameFrontmatter(
    filePath,
    rewriteSubstrateProjectionContent({ substrate: "pi-dev", path: filePath, content }),
    piDevSkillId(skillName),
  );
}

export function buildPiDevPortableSkillFiles(skills: SomaSkill[]): Projection["files"] {
  const ids = new Map<string, string>();
  const files: Projection["files"] = [];

  for (const skill of skills) {
    const id = piDevSkillId(skill.name);
    const existingName = ids.get(id);
    if (existingName && existingName !== skill.name) {
      throw new Error(`Pi.dev skill id collision: ${JSON.stringify(existingName)} and ${JSON.stringify(skill.name)} both normalize to ${JSON.stringify(id)}.`);
    }
    ids.set(id, skill.name);

    for (const file of skill.files ?? []) {
      files.push({
        path: `agent/skills/${id}/${file.path}`,
        content: renderPiDevSkillFileContent(skill.name, file.path, file.content),
      });
    }
  }

  return files;
}

export function piDevIsaSkillDestinationDir(substrateHome: string): string {
  return resolve(substrateHome, "agent/skills", PI_DEV_ISA_SKILL_ID);
}

function legacyPiDevIsaSkillDestinationDir(substrateHome: string): string {
  return resolve(substrateHome, "agent/skills/ISA");
}

export async function removeLegacyPiDevIsaSkillProjection(substrateHome: string): Promise<void> {
  const skillsDir = resolve(substrateHome, "agent/skills");
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entries.some((entry) => entry.isDirectory() && entry.name === "ISA")) {
    await rm(legacyPiDevIsaSkillDestinationDir(substrateHome), { recursive: true, force: true });
  }
}
