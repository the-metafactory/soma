import { readdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { isEnoent } from "./fs-errors";

// The on-disk name the Soma VSA skill was projected/stored under before the
// #329 rename to "VSA". Matched EXACTLY against the real readdir entry name —
// the exact-name match is load-bearing on case-insensitive filesystems, where a
// blind rm of "ISA" could resolve to the SAME inode as a user dir cased "isa".
const LEGACY_VSA_SKILL_DIR = "ISA" as const;

// The renamed-away Soma skill is identified by a two-signal provenance gate so a
// USER skill that merely happens to be named "ISA" is never deleted:
//   1. SKILL.md frontmatter `name: ISA`
//   2. SKILL.md description begins (anywhere) with this identity sentence —
//      shared verbatim by the old ISA and the canonical VSA skill.
const SOMA_VSA_SKILL_NAME = "ISA" as const;
const SOMA_VSA_SKILL_IDENTITY_MARKER = "Owns the Ideal State Artifact" as const;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;

function frontmatterField(content: string, key: string): string | undefined {
  const frontmatter = FRONTMATTER.exec(content);
  if (!frontmatter) return undefined;
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m").exec(frontmatter[1]);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

// True only when BOTH provenance signals match the Soma renamed-away VSA
// predecessor. Conservative by construction: any missing/differing signal → false.
function isSomaRenamedVsaSkill(skillMd: string): boolean {
  const name = frontmatterField(skillMd, "name");
  if (name !== SOMA_VSA_SKILL_NAME) return false;
  const description = frontmatterField(skillMd, "description");
  return description?.includes(SOMA_VSA_SKILL_IDENTITY_MARKER) ?? false;
}

/**
 * Remove the Soma renamed-away "ISA" skill dir from a shared `skills/` directory
 * IFF the two-signal provenance gate passes (frontmatter `name: ISA` AND its
 * description contains "Owns the Ideal State Artifact").
 *
 * Safe by design — `skills/` also holds the principal's own skills (dozens of
 * them). A user dir named "ISA" whose SKILL.md lacks the marker (or has a
 * different `name`) is preserved untouched. isEnoent-safe: a missing ISA dir, a
 * missing SKILL.md, or a missing skills dir is a no-op.
 *
 * @param skillsDir absolute path to the shared `skills/` directory.
 * @returns true when the soma ISA dir was removed, false otherwise.
 */
export async function pruneLegacyVsaSkill(skillsDir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }

  // Exact on-disk-name match (see LEGACY_VSA_SKILL_DIR). On a case-insensitive FS
  // a user dir stored as "isa" yields readdir name "isa" ≠ "ISA" → never matched.
  const legacyDir = entries.find((entry) => entry.isDirectory() && entry.name === LEGACY_VSA_SKILL_DIR);
  if (!legacyDir) return false;

  const skillMdPath = resolve(skillsDir, legacyDir.name, "SKILL.md");
  let skillMd: string;
  try {
    skillMd = await readFile(skillMdPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }

  if (!isSomaRenamedVsaSkill(skillMd)) return false;

  await rm(resolve(skillsDir, legacyDir.name), { recursive: true, force: true });
  return true;
}
