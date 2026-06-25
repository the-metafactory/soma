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
//   2. SKILL.md description contains this identity sentence (anywhere) —
//      shared verbatim by the old ISA and the canonical VSA skill.
const SOMA_VSA_SKILL_NAME = "ISA" as const;
const SOMA_VSA_SKILL_IDENTITY_MARKER = "Owns the Ideal State Artifact" as const;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;

// NOTE: matches a single-line scalar value only. Soma's ISA/VSA `name` and
// `description` are always single-line; a folded/multi-line YAML value would not
// be captured here — which fails SAFE (the provenance gate would not match, so the
// dir is preserved rather than wrongly deleted).
function frontmatterField(content: string, key: string): string | undefined {
  const frontmatter = FRONTMATTER.exec(content);
  if (!frontmatter) return undefined;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const raw = new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, "m").exec(frontmatter[1])?.[1]?.trim();
  if (raw === undefined) return undefined;
  // Strip a BALANCED surrounding quote pair only (not one leading + one trailing
  // independently, which would normalize a malformed `'ISA"` to `ISA`).
  const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw);
  return quoted ? quoted[1] : raw;
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
 * Conservative — `skills/` also holds the principal's own skills (dozens of them).
 * A user dir named "ISA" whose SKILL.md lacks the marker (or has a different
 * `name`) is preserved untouched. NOTE: the gate keys on Soma's OWN published ISA
 * identity, so a verbatim user FORK of the old ISA skill (frontmatter kept) is
 * indistinguishable from the orphan and would also be removed — acceptable, since
 * it IS the renamed-away Soma skill (its successor is VSA). The gate proves "a dir
 * lacking the identity is safe", not "this is provably not user-authored".
 * isEnoent-safe: a missing ISA dir, SKILL.md, or skills dir is a no-op.
 *
 * DESTRUCTIVE: removal is `rm -rf` with no backup. If the gate ever mis-fires
 * (e.g. the indistinguishable verbatim-fork case above), the dir's contents are
 * destroyed irrecoverably — recover only from a `soma snapshot`.
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

/**
 * A `vsaSkillProjection.prepare` hook that prunes a sibling renamed-away ISA skill
 * from a substrate's shared skills dir before the canonical VSA skill installs.
 * Shared by every substrate whose VSA skill lives at `<substrateHome>/<skillsSubpath>/VSA`.
 */
export function vsaSiblingPrunePrepare(skillsSubpath = "skills"): (substrateHome: string) => Promise<void> {
  return async (substrateHome: string) => {
    await pruneLegacyVsaSkill(resolve(substrateHome, skillsSubpath));
  };
}
