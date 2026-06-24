#!/usr/bin/env bun
/**
 * CI guard — fails if `src/skills/VSA/` content changed but
 * `src/skills/VSA/SKILL.md` `version:` frontmatter did not.
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
import { parseSkillFrontmatter } from "../src/vsa-skill-installer";

const SKILL_DIR = "src/skills/VSA";
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

/**
 * Hash a list of files in a single `git hash-object --stdin-paths` invocation,
 * then fingerprint the `<hash>\t<path>` list. One subprocess for the whole
 * directory regardless of file count — avoids the O(N) git-spawn cost on
 * skill trees with many files.
 */
function fingerprintWorkingFiles(files: readonly string[]): string {
  if (files.length === 0) return "";
  const hashes = execFileSync("git", ["hash-object", "--stdin-paths"], {
    input: files.join("\n"),
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  const lines = files.map((f, i) => `${hashes[i]}\t${f}`).join("\n");
  return execFileSync("git", ["hash-object", "--stdin"], { input: lines, encoding: "utf8" }).trim();
}

/**
 * Hash a list of files at a git ref via a single `git ls-tree` invocation
 * that returns each blob's hash inline. Mirror of fingerprintWorkingFiles.
 */
function fingerprintRefFiles(ref: string, files: readonly string[]): string {
  if (files.length === 0) return "";
  // `git ls-tree -r ref -- files...` returns "mode type hash\tpath" per line.
  const treeOutput = execFileSync("git", ["ls-tree", "-r", ref, "--", ...files], { encoding: "utf8" });
  const refHashByPath = new Map<string, string>();
  for (const line of treeOutput.split("\n")) {
    if (line.length === 0) continue;
    const tabIndex = line.indexOf("\t");
    if (tabIndex < 0) continue;
    const meta = line.slice(0, tabIndex).trim().split(/\s+/);
    const path = line.slice(tabIndex + 1);
    const hash = meta[2];
    if (typeof hash === "string") refHashByPath.set(path, hash);
  }
  const lines = files.map((f) => `${refHashByPath.get(f) ?? ""}\t${f}`).join("\n");
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
  const currentTreeHash = fingerprintWorkingFiles(workingFiles);

  // Hash of base ref's skill directory
  const baseFiles = (gitOrNull(["ls-tree", "-r", "--name-only", base, "--", SKILL_DIR]) ?? "")
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();
  if (baseFiles.length === 0) {
    console.log(`[check-skill-version] base ref ${base} has no ${SKILL_DIR}; first-time landing — ok.`);
    return;
  }
  const baseTreeHash = fingerprintRefFiles(base, baseFiles);

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
