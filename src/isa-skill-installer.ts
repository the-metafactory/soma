import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { defaultSomaRepoPath } from "./repo-path";
import type {
  IsaSkillInstallOptions,
  IsaSkillInstallResult,
  SomaSkillBaseline,
  SomaSkillBaselines,
} from "./types";

const SKILL_NAME = "ISA";
const SOURCE_SUBPATH = `src/skills/${SKILL_NAME}`;
const RUNTIME_SUBPATH = `skills/${SKILL_NAME}`;
const BASELINES_SUBPATH = "memory/STATE/skill-baselines.json";
const UPGRADE_MARKER_NAME = ".upgrade-available";
const SKILL_MD = "SKILL.md";

function resolveSomaHome(options: Pick<IsaSkillInstallOptions, "homeDir" | "somaHome"> = {}): string {
  return resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

function resolveSomaRepoPath(options: Pick<IsaSkillInstallOptions, "somaRepoPath"> = {}): string {
  return resolve(options.somaRepoPath ?? defaultSomaRepoPath());
}

export function isaSkillSourceDir(somaRepoPath: string): string {
  return join(somaRepoPath, SOURCE_SUBPATH);
}

export function isaSkillRuntimeDir(somaHome: string): string {
  return join(somaHome, RUNTIME_SUBPATH);
}

export function skillBaselinesPath(somaHome: string): string {
  return join(somaHome, BASELINES_SUBPATH);
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

async function listSkillFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  if (!(await exists(root))) return out;
  for await (const path of walkFiles(root)) {
    out.push(relative(root, path));
  }
  return out.sort();
}

async function hashSkillFiles(root: string, relativePaths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of relativePaths) {
    out[rel] = sha256(await readFile(join(root, rel), "utf8"));
  }
  return out;
}

async function readBaselines(somaHome: string): Promise<SomaSkillBaselines> {
  const path = skillBaselinesPath(somaHome);
  if (!(await exists(path))) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as SomaSkillBaselines;
  } catch {
    return {};
  }
}

async function writeBaselines(somaHome: string, baselines: SomaSkillBaselines): Promise<void> {
  const path = skillBaselinesPath(somaHome);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(baselines, null, 2)}\n`, "utf8");
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

interface SemverParts { major: number; minor: number; patch: number }

function parseSemver(input: string): SemverParts | null {
  const match = SEMVER.exec(input.trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Returns 1 if `source > runtime`, 0 if equal, -1 if source < runtime.
 * Treats unparseable versions as equal (no upgrade attempted).
 */
export function compareSkillVersions(source: string, runtime: string): number {
  const s = parseSemver(source);
  const r = parseSemver(runtime);
  if (s === null || r === null) return 0;
  if (s.major !== r.major) return s.major > r.major ? 1 : -1;
  if (s.minor !== r.minor) return s.minor > r.minor ? 1 : -1;
  if (s.patch !== r.patch) return s.patch > r.patch ? 1 : -1;
  return 0;
}

const VERSION_KEY = /^version:\s*(.+?)\s*$/m;
const PACK_ID_KEY = /^pack-id:\s*(.+?)\s*$/m;

export interface SkillFrontmatter {
  version: string;
  packId: string;
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  const versionMatch = VERSION_KEY.exec(content);
  const packIdMatch = PACK_ID_KEY.exec(content);
  if (versionMatch === null || packIdMatch === null) return null;
  return { version: versionMatch[1], packId: packIdMatch[1] };
}

async function readSkillFrontmatter(skillMdPath: string): Promise<SkillFrontmatter | null> {
  if (!(await exists(skillMdPath))) return null;
  return parseSkillFrontmatter(await readFile(skillMdPath, "utf8"));
}

async function copyFile(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, await readFile(source, "utf8"), "utf8");
}

interface DetectedDrift {
  files: string[];
  hasLocalEdits: boolean;
}

async function detectDrift(runtimeDir: string, baseline: SomaSkillBaseline | undefined): Promise<DetectedDrift> {
  if (baseline === undefined) return { files: [], hasLocalEdits: false };
  const editedFiles: string[] = [];
  for (const [rel, expectedHash] of Object.entries(baseline.files)) {
    const runtimePath = join(runtimeDir, rel);
    if (!(await exists(runtimePath))) {
      editedFiles.push(rel);
      continue;
    }
    const actualHash = sha256(await readFile(runtimePath, "utf8"));
    if (actualHash !== expectedHash) {
      editedFiles.push(rel);
    }
  }
  return { files: editedFiles, hasLocalEdits: editedFiles.length > 0 };
}

/**
 * Install or upgrade the ISA skill into the Soma home.
 *
 * States:
 *   - No runtime → fresh install: copy all source files, record baseline.
 *   - Runtime version == source version → unchanged (no copy, no marker).
 *   - Runtime version < source version, no local edits → silent upgrade.
 *     Copies all source files. Files in runtime absent from source preserved.
 *   - Runtime version < source version, local edits → write `.upgrade-available`
 *     marker, no overwrite. User decides via `soma isa skill upgrade` (#36).
 *   - `force: true` → behave as fresh install regardless of state.
 */
export async function installIsaSkill(options: IsaSkillInstallOptions = {}): Promise<IsaSkillInstallResult> {
  const somaHome = resolveSomaHome(options);
  const somaRepoPath = resolveSomaRepoPath(options);
  const sourceDir = isaSkillSourceDir(somaRepoPath);
  const runtimeDir = isaSkillRuntimeDir(somaHome);
  const markerPath = join(runtimeDir, UPGRADE_MARKER_NAME);

  if (!(await exists(sourceDir))) {
    // No bundled skill at the configured somaRepoPath — install runs as a
    // no-op so callers passing custom repo paths without the skill (tests,
    // partial installs) don't break. Production callers always resolve via
    // defaultSomaRepoPath() which points at the Soma repo root and DOES ship
    // the skill.
    return {
      somaHome,
      skillDir: runtimeDir,
      sourceVersion: "",
      runtimeVersion: null,
      action: "no-source",
      filesWritten: [],
      filesPreservedUserAdditions: [],
    };
  }
  const sourceFrontmatter = await readSkillFrontmatter(join(sourceDir, SKILL_MD));
  if (sourceFrontmatter === null) {
    throw new Error(`ISA skill source ${SKILL_MD} missing version or pack-id frontmatter.`);
  }
  const sourceFiles = await listSkillFiles(sourceDir);
  const sourceHashes = await hashSkillFiles(sourceDir, sourceFiles);

  const runtimeFrontmatter = await readSkillFrontmatter(join(runtimeDir, SKILL_MD));
  const baselines = await readBaselines(somaHome);
  const baseline = baselines[SKILL_NAME];

  const runtimeFiles = await listSkillFiles(runtimeDir);
  const userAdditions = runtimeFiles.filter((rel) => !sourceFiles.includes(rel) && rel !== UPGRADE_MARKER_NAME);

  if (runtimeFrontmatter === null || options.force === true) {
    return freshInstall({
      somaHome,
      sourceDir,
      runtimeDir,
      sourceFiles,
      sourceHashes,
      sourceVersion: sourceFrontmatter.version,
      runtimeVersionBefore: runtimeFrontmatter?.version ?? null,
      baselines,
      markerPath,
      userAdditions,
    });
  }

  const comparison = compareSkillVersions(sourceFrontmatter.version, runtimeFrontmatter.version);
  if (comparison <= 0) {
    return {
      somaHome,
      skillDir: runtimeDir,
      sourceVersion: sourceFrontmatter.version,
      runtimeVersion: runtimeFrontmatter.version,
      action: "unchanged",
      filesWritten: [],
      filesPreservedUserAdditions: userAdditions,
    };
  }

  const drift = await detectDrift(runtimeDir, baseline);
  if (drift.hasLocalEdits) {
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      markerPath,
      `${JSON.stringify({
        skill: SKILL_NAME,
        runtimeVersion: runtimeFrontmatter.version,
        sourceVersion: sourceFrontmatter.version,
        editedFiles: drift.files,
        writtenAt: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8",
    );
    return {
      somaHome,
      skillDir: runtimeDir,
      sourceVersion: sourceFrontmatter.version,
      runtimeVersion: runtimeFrontmatter.version,
      action: "preserved-local-edits",
      filesWritten: [],
      filesPreservedUserAdditions: userAdditions,
      upgradeMarker: markerPath,
    };
  }

  return freshInstall({
    somaHome,
    sourceDir,
    runtimeDir,
    sourceFiles,
    sourceHashes,
    sourceVersion: sourceFrontmatter.version,
    runtimeVersionBefore: runtimeFrontmatter.version,
    baselines,
    markerPath,
    userAdditions,
    actionOverride: "upgraded",
  });
}

interface FreshInstallContext {
  somaHome: string;
  sourceDir: string;
  runtimeDir: string;
  sourceFiles: string[];
  sourceHashes: Record<string, string>;
  sourceVersion: string;
  runtimeVersionBefore: string | null;
  baselines: SomaSkillBaselines;
  markerPath: string;
  userAdditions: string[];
  actionOverride?: "fresh" | "upgraded";
}

async function freshInstall(ctx: FreshInstallContext): Promise<IsaSkillInstallResult> {
  const written: string[] = [];
  for (const rel of ctx.sourceFiles) {
    const dest = join(ctx.runtimeDir, rel);
    await copyFile(join(ctx.sourceDir, rel), dest);
    written.push(dest);
  }

  const baselines = { ...ctx.baselines };
  baselines[SKILL_NAME] = {
    version: ctx.sourceVersion,
    files: ctx.sourceHashes,
    installedAt: new Date().toISOString(),
  };
  await writeBaselines(ctx.somaHome, baselines);

  if (await exists(ctx.markerPath)) {
    await unlink(ctx.markerPath).catch(() => undefined);
  }

  return {
    somaHome: ctx.somaHome,
    skillDir: ctx.runtimeDir,
    sourceVersion: ctx.sourceVersion,
    runtimeVersion: ctx.runtimeVersionBefore,
    action: ctx.actionOverride ?? "fresh",
    filesWritten: written,
    filesPreservedUserAdditions: ctx.userAdditions,
  };
}
