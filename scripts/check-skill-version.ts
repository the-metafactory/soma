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
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSkillFrontmatter } from "../src/isa-skill-installer";

const SKILL_DIR = "src/skills/ISA";
const SKILL_MD = `${SKILL_DIR}/SKILL.md`;
const REF_PATTERN = /^[\w./@-]+$/;

function parseBaseRef(): string {
  const idx = process.argv.indexOf("--base");
  let raw = "origin/main";
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const value = process.argv[idx + 1];
    if (typeof value === "string") raw = value;
  } else if (process.env.SOMA_CHECK_BASE !== undefined) {
    raw = process.env.SOMA_CHECK_BASE;
  }
  if (!REF_PATTERN.test(raw)) {
    console.error(`[check-skill-version] FAIL — base ref \`${raw}\` contains disallowed characters.`);
    process.exit(2);
  }
  // Belt-and-suspenders: defer to git's own ref validator.
  try {
    execFileSync("git", ["check-ref-format", "--allow-onelevel", raw], { stdio: "pipe" });
  } catch {
    console.error(`[check-skill-version] FAIL — base ref \`${raw}\` rejected by git check-ref-format.`);
    process.exit(2);
  }
  return raw;
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitOrNull(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

async function readVersionAt(ref: string): Promise<string | null> {
  const content = ref === "WORKING"
    ? await readFile(resolve(SKILL_MD), "utf8").catch(() => null)
    : gitOrNull(["show", `${ref}:${SKILL_MD}`]);
  if (content === null) return null;
  return parseSkillFrontmatter(content)?.version ?? null;
}

function fingerprintTrackedFiles(files: readonly string[], hashForFile: (relPath: string) => string): string {
  const lines = files.map((f) => `${hashForFile(f)}\t${f}`).join("\n");
  return execFileSync("git", ["hash-object", "--stdin"], { input: lines, encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  const base = parseBaseRef();

  // Hash of working tree's skill directory
  const workingFiles = git(["ls-files", SKILL_DIR])
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();
  if (workingFiles.length === 0) {
    console.log(`[check-skill-version] no tracked files in ${SKILL_DIR}; nothing to check.`);
    return;
  }
  const currentTreeHash = fingerprintTrackedFiles(workingFiles, (f) => git(["hash-object", f]));

  // Hash of base ref's skill directory
  const baseFiles = (gitOrNull(["ls-tree", "-r", "--name-only", base, "--", SKILL_DIR]) ?? "")
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();
  if (baseFiles.length === 0) {
    console.log(`[check-skill-version] base ref ${base} has no ${SKILL_DIR}; first-time landing — ok.`);
    return;
  }
  const baseTreeHash = fingerprintTrackedFiles(baseFiles, (f) => git(["rev-parse", `${base}:${f}`]));

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
