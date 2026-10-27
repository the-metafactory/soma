import { open, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { readGoalRecordFiles, validateGoalRecords, type GoalRecordWarning } from "../goal-records";
import { createPaths } from "../core/index";
import { parseBehaviorPolicy, type BehaviorPolicy } from "../policy/behavior-policy";
import type { CommunicationContract } from "./communication-contract";
import type { SomaSkill } from "./types";
import type { ProjectionInput } from "./types";
import { readWorkingMethod } from "./working-method";

export interface LoadSomaProfileOptions {
  /**
   * Receives each goal-record warning (a skipped file, an active goal without
   * a sensor or review date, an unknown mission code). Defaults to
   * `console.warn`: a bad goal file never fails the load, but it is not hidden.
   */
  onGoalWarning?: (warning: GoalRecordWarning) => void;
}

export interface LoadSomaHomeOptions extends LoadSomaProfileOptions {
  includeSkills?: boolean;
}

function valueAfterPrefix(content: string, prefix: string, fallback: string): string {
  const line = content.split("\n").find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value === "" ? fallback : (value ?? fallback);
}

// soma#784 D9: M0–Mn are missions, not goals. `## Goals` stays a silent load
// alias so no home has to migrate; when both headings exist, `## Missions` wins.
function purposeMissions(content: string): string[] {
  return hasSection(content, "Missions") ? sectionBullets(content, "Missions") : sectionBullets(content, "Goals");
}

function hasSection(content: string, heading: string): boolean {
  return content.split("\n").some((line) => line.trim() === `## ${heading}`);
}

function sectionBullets(content: string, heading: string): string[] {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);

  if (start === -1) {
    return [];
  }

  const items: string[] = [];

  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) {
      break;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      items.push(trimmed.slice(2).trim());
    }
  }

  return items;
}

function recordFromBullets(items: string[]): Record<string, string | boolean> {
  return Object.fromEntries(
    items.map((item) => {
      const separator = item.indexOf(":");

      if (separator === -1) {
        return [item, true];
      }

      const key = item.slice(0, separator).trim();
      const rawValue = item.slice(separator + 1).trim();
      const value = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
      return [key, value];
    }),
  );
}

function frontmatterValue(content: string, key: string, fallback: string): string {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(content);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? fallback;
}

// Vendor/build directories a principal-authored skill can legitimately contain
// (an installed CLI's own node_modules, a compiled Swift/TS build) but that
// projection must never walk: they hold megabytes-to-gigabytes of dependency
// and build-artifact content that is not skill prose, and reading it all as
// "skill files" is what made codex/cursor/grok/pi-dev/anthropic-cowork catalog
// refreshes hang for minutes (soma#690-follow-up — a stray node_modules under
// ~/.soma/skills/productivity/email alone was 781MB).
const SKILL_SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", "vendor", ".venv", "venv", ".next", ".turbo", ".cache"]);

// A skill file is projected as text (rendered into substrate markdown/rules
// files, regex-rewritten). A compiled binary read as "utf8" is not skill
// content — it is either mojibake or, worse, megabytes of garbage that the
// substrate rewrite then has to scan. Sniff the first chunk for a NUL byte
// (the standard binary heuristic — text files don't contain one) and skip.
const BINARY_SNIFF_BYTES = 8000;

async function isBinaryFile(path: string): Promise<boolean> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return false;

  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function collectSkillFiles(root: string, current = root): Promise<{ path: string; content: string }[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const files: { path: string; content: string }[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = join(current, entry.name);

    if (entry.isDirectory()) {
      if (SKILL_SCAN_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      files.push(...(await collectSkillFiles(root, fullPath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relativePath = relative(root, fullPath);

    if (relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) {
      continue;
    }

    if (await isBinaryFile(fullPath)) {
      continue;
    }

    files.push({
      path: relativePath,
      content: await readFile(fullPath, "utf8"),
    });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function loadSomaSkills(somaHome: string): Promise<SomaSkill[]> {
  const paths = createPaths(somaHome);
  const skillsRoot = paths.skills();
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const skills: SomaSkill[] = [];

  for (const entry of entries) {
    // A skill may be a real dir OR a symlink to one (soma#354: `project-skill`
    // registers skills by symlink). `readdir(withFileTypes)` reports a
    // symlink-to-dir as isSymbolicLink, not isDirectory, so both are admitted;
    // the SKILL.md read below is the real gate — a symlinked file fails it and
    // is skipped.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }

    const skillRoot = join(skillsRoot, entry.name);
    const skillContent = await readFile(join(skillRoot, "SKILL.md"), "utf8").catch(() => undefined);

    if (!skillContent) {
      continue;
    }

    skills.push({
      name: frontmatterValue(skillContent, "name", entry.name),
      path: skillRoot,
      description: frontmatterValue(skillContent, "description", ""),
      triggers: sectionBullets(skillContent, "Triggers"),
      files: await collectSkillFiles(skillRoot),
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// soma#329: read the renamed `purpose.md`, falling back to a pre-rename
// `telos.md` so existing homes load without a forced migration. The markdown
// parser is heading-driven (`## Missions`/`## Principles`/`## Commitments`), so a
// legacy `# Telos` body parses identically.
async function readPurposeProfile(paths: ReturnType<typeof createPaths>): Promise<string> {
  try {
    return await readFile(paths.resolve("profile", "purpose.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  // purpose.md absent — fall back to the legacy telos.md. We deliberately do NOT
  // swallow this read's ENOENT: a home missing BOTH files should still throw
  // loudly, preserving the pre-rename behaviour (no silent fail-open to defaults).
  return readFile(paths.resolve("profile", "telos.md"), "utf8");
}

/**
 * Read `profile/communication.md` — the assistant's communication contract
 * (Identity compartment). The file projects verbatim, so reading it is the
 * whole job; nothing is parsed out of its content.
 *
 * Absent file → `undefined`. Homes created before the starter template shipped
 * do not have one, and `soma init`'s `flag: "wx"` writes never backfill an
 * existing home, so absence is the normal case on an upgrade, not an error.
 * Any other read error propagates: a file that exists but cannot be read must
 * fail loudly rather than silently project nothing.
 *
 * Content is deliberately NOT validated here (sage #636 r3). This is a
 * principal-authored prose file on the path every command takes to load the
 * home, so a rejected character in it must not be able to fail `install`,
 * `reproject`, or a hook. The one rule that needs enforcing — the reserved
 * reference letters — is enforced at the write path in `algorithm.ts`, where a
 * collision can actually occur.
 */
async function readCommunicationContract(paths: ReturnType<typeof createPaths>): Promise<CommunicationContract | undefined> {
  try {
    return { content: await readFile(paths.resolve("profile", "communication.md"), "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadSomaProfile(
  somaHome: string,
  options: LoadSomaProfileOptions = {},
): Promise<Omit<ProjectionInput["profile"], "skills">> {
  const paths = createPaths(somaHome);
  // Independent reads, goal files included. Serial awaits made them pay a
  // round-trip each on a path soma re-executes per subprocess invocation
  // (sage #636 r2).
  // soma#329: `readPurposeProfile` reads the renamed `purpose.md` and falls back
  // to a legacy `telos.md`, so homes created before the rename still load.
  // soma#784 D2/D9: typed goal records live one per file in `profile/goals/`;
  // only their `supports` check needs the missions, so it runs after.
  const [assistant, principal, communication, purpose, workingMethod, goalFiles] = await Promise.all([
    readFile(paths.resolve("profile", "assistant.md"), "utf8"),
    readFile(paths.resolve("profile", "principal.md"), "utf8"),
    readCommunicationContract(paths),
    readPurposeProfile(paths),
    readWorkingMethod(paths.resolve("skills", "the-algorithm", "references"), paths.resolve("skills")),
    readGoalRecordFiles(paths.resolve("profile", "goals")),
  ]);
  const missions = purposeMissions(purpose);
  const { goals, warnings } = await validateGoalRecords(goalFiles, missions);
  const warn = options.onGoalWarning ?? ((warning: GoalRecordWarning) => {
    console.warn(warning.message);
  });
  for (const warning of warnings) warn(warning);

  return {
    assistant: {
      name: valueAfterPrefix(assistant, "Name:", "soma"),
      displayName: valueAfterPrefix(assistant, "Display name:", "Soma"),
      traits: recordFromBullets(sectionBullets(assistant, "Traits")),
    },
    principal: {
      name: valueAfterPrefix(principal, "Name:", "principal"),
      preferredName: valueAfterPrefix(principal, "Preferred name:", "Principal"),
      profile: recordFromBullets(sectionBullets(principal, "Profile")),
    },
    purpose: {
      mission: valueAfterPrefix(purpose, "Mission:", "Keep personal assistant context portable across substrates."),
      missions,
      goals,
      principles: sectionBullets(purpose, "Principles"),
      commitments: sectionBullets(purpose, "Commitments"),
    },
    memory: {
      root: paths.memory(),
      work: paths.work(),
      knowledge: paths.knowledge(),
      learning: paths.learning(),
      relationship: paths.relationship(),
      state: paths.state(),
    },
    ...(communication === undefined ? {} : { communication }),
    ...(workingMethod === undefined ? {} : { workingMethod }),
  };
}

/**
 * Read and parse `policy/behavior.md` — the principal's cross-substrate
 * behavioral rules (Policy compartment).
 *
 * Absent file → `undefined`, not a default rule set: the file is principal-
 * authored, and a home that has not written one must project no behavioral
 * rules rather than rules Soma invented. Any other read error propagates —
 * a policy file that exists but cannot be read must fail loudly, never
 * fail-open to silence.
 */
async function readBehaviorPolicy(paths: ReturnType<typeof createPaths>): Promise<BehaviorPolicy | undefined> {
  try {
    return parseBehaviorPolicy(await readFile(paths.resolve("policy", "behavior.md"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadSomaHome(somaHome: string, options: LoadSomaHomeOptions = {}): Promise<ProjectionInput> {
  // Independent of each other: the behavioral policy must not queue behind the
  // skills directory walk (sage #636 r2).
  const paths = createPaths(somaHome);
  const [profile, skills, behavior] = await Promise.all([
    loadSomaProfile(somaHome, options),
    options.includeSkills === false ? Promise.resolve<SomaSkill[]>([]) : loadSomaSkills(somaHome),
    readBehaviorPolicy(paths),
  ]);

  return {
    profile: {
      ...profile,
      skills,
    },
    ...(behavior === undefined ? {} : { behavior }),
  };
}
