#!/usr/bin/env bun
/**
 * CI guard — fails if `src/skills/ISA/` content changed but
 * `src/skills/ISA/SKILL.md` `version:` frontmatter did not.
 *
 * Triggered by: `bun scripts/check-skill-version.ts [--base <ref>]`
 * Default base ref: `origin/main`.
 *
 * Exit codes:
 *   0  ok (no skill changes, or version was bumped)
 *   1  skill content changed without version bump — FAIL
 *   2  usage / runtime error
 *
 * Wire as required GitHub Actions check on PRs that modify `src/skills/`.
 */
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSkillFrontmatter } from "../src/isa-skill-installer";

const SKILL_DIR = "src/skills/ISA";
const SKILL_MD = `${SKILL_DIR}/SKILL.md`;

function parseBaseRef(): string {
  const idx = process.argv.indexOf("--base");
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const value = process.argv[idx + 1];
    if (typeof value === "string") return value;
  }
  return process.env.SOMA_CHECK_BASE ?? "origin/main";
}

function git(args: string): string {
  return execSync(`git ${args}`, { encoding: "utf8" }).trim();
}

function gitOrNull(args: string): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

async function readVersionAt(ref: string): Promise<string | null> {
  const content = ref === "WORKING"
    ? await readFile(resolve(SKILL_MD), "utf8").catch(() => null)
    : gitOrNull(`show ${ref}:${SKILL_MD}`);
  if (content === null) return null;
  return parseSkillFrontmatter(content)?.version ?? null;
}

async function main(): Promise<void> {
  const base = parseBaseRef();

  // Compare the tree hash of the skill directory in working copy vs base ref.
  let baseTreeHash: string | null;
  try {
    baseTreeHash = git(`rev-parse ${base}:${SKILL_DIR}`);
  } catch {
    // Base ref has no skill directory yet — first-time landing; allow.
    console.log(`[check-skill-version] base ref ${base} has no ${SKILL_DIR}; first-time landing — ok.`);
    return;
  }

  // Hash of working tree's skill directory
  let currentTreeHash: string;
  try {
    // git write-tree on a partial path requires building an index; use ls-files + hash-object.
    const files = git(`ls-files ${SKILL_DIR}`).split("\n").filter((line) => line.length > 0).sort();
    if (files.length === 0) {
      console.log(`[check-skill-version] no tracked files in ${SKILL_DIR}; nothing to check.`);
      return;
    }
    // Compose a flat content fingerprint: hash of "<git-hash>\t<path>\n..."
    const lines = files.map((f) => `${git(`hash-object ${f}`)}\t${f}`).join("\n");
    currentTreeHash = execSync("git hash-object --stdin", { input: lines, encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[check-skill-version] could not compute tree hash for ${SKILL_DIR}: ${message}`);
    process.exit(2);
  }

  // Compute the same fingerprint for the base ref
  try {
    const baseFiles = git(`ls-tree -r --name-only ${base} -- ${SKILL_DIR}`)
      .split("\n")
      .filter((line) => line.length > 0)
      .sort();
    if (baseFiles.length > 0) {
      const baseLines = baseFiles
        .map((f) => {
          const blobHash = git(`rev-parse ${base}:${f}`);
          return `${blobHash}\t${f}`;
        })
        .join("\n");
      baseTreeHash = execSync("git hash-object --stdin", { input: baseLines, encoding: "utf8" }).trim();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[check-skill-version] could not compute base tree hash for ${SKILL_DIR}: ${message}`);
    process.exit(2);
  }

  if (currentTreeHash === baseTreeHash) {
    console.log(`[check-skill-version] no changes in ${SKILL_DIR} vs ${base} — ok.`);
    return;
  }

  const baseVersion = await readVersionAt(base);
  const currentVersion = await readVersionAt("WORKING");

  if (baseVersion === null) {
    console.log(`[check-skill-version] base ref ${base} has no version frontmatter; first version is being set — ok.`);
    return;
  }
  if (currentVersion === null) {
    console.error(`[check-skill-version] FAIL — current ${SKILL_MD} missing version frontmatter.`);
    process.exit(1);
  }
  if (currentVersion === baseVersion) {
    console.error(
      `[check-skill-version] FAIL — ${SKILL_DIR} content changed vs ${base} but SKILL.md version is still ${currentVersion}. ` +
        `Bump SKILL.md frontmatter version: <semver> before merging.`,
    );
    process.exit(1);
  }

  console.log(
    `[check-skill-version] ok — ${SKILL_DIR} content changed and version bumped from ${baseVersion} → ${currentVersion}.`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[check-skill-version] runtime error: ${message}`);
  process.exit(2);
});
