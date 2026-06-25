import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { isEnoent } from "../../fs-errors";
import { rewriteSkillNameFrontmatter } from "../../skill-frontmatter";
import { rewriteSubstrateProjectionContent } from "../../substrate-projection-rewrites";
import type { Projection, SomaSkill } from "../../types";

export const PI_DEV_VSA_SKILL_ID = "vsa";

// Prior names the Soma VSA skill was projected under in pi-dev before the canonical
// lowercase "vsa": "isa" (the former PI_DEV_VSA_SKILL_ID) and a legacy capital "VSA"
// (older code). Both were Soma-projected; pruned before reprojecting "vsa". (pi-dev
// lowercases all skill ids, so it never produced a capital "ISA".)
const LEGACY_PI_DEV_VSA_SKILL_DIRS = ["VSA", "isa"] as const;

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

export function piDevVsaSkillDestinationDir(substrateHome: string): string {
  return resolve(substrateHome, "agent/skills", PI_DEV_VSA_SKILL_ID);
}

export async function removeLegacyPiDevVsaSkillProjection(substrateHome: string): Promise<void> {
  const skillsDir = resolve(substrateHome, "agent/skills");
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  // The exact on-disk-name match is LOAD-BEARING, not a redundant guard: on a
  // case-insensitive FS a blind rm of path "VSA" resolves to the SAME inode as
  // canonical "vsa" and would wipe the (possibly user-edited) current skill. By
  // only removing a dir whose ACTUAL stored name is a legacy name, a canonical
  // dir stored as "vsa" is never matched (readdir yields "vsa" ≠ "VSA"), while a
  // genuine legacy dir stored as "VSA"/"isa" (pre-canonical) is migrated away.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if ((LEGACY_PI_DEV_VSA_SKILL_DIRS as readonly string[]).includes(entry.name)) {
      await rm(resolve(skillsDir, entry.name), { recursive: true, force: true });
    }
  }
}
