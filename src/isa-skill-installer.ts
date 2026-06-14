import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { defaultSomaRepoPath } from "./repo-path";
import { SKILL_MD, rewriteSkillNameFrontmatter } from "./skill-frontmatter";
import { rewriteSubstrateProjectionContent } from "./substrate-projection-rewrites";
import type {
  IsaSkillInstallOptions,
  IsaSkillInstallResult,
  SomaSkillBaseline,
  SomaSkillBaselines,
  SubstrateId,
} from "./types";

interface InternalIsaSkillInstallOptions extends IsaSkillInstallOptions {
  skillNameOverride?: string;
  projectionSubstrate?: SubstrateId;
}

// The canonical ISA skill directory name under <somaHome>/skills. Exported so
// home-projection adapters can recognize the ISA skill and delegate its file
// projection to this dedicated installer instead of double-emitting it through
// the generic portable-skill loop.
export const ISA_SKILL_NAME = "ISA";
const SKILL_NAME = ISA_SKILL_NAME;
const SOURCE_SUBPATH = `src/skills/${SKILL_NAME}`;
const RUNTIME_SUBPATH = `skills/${SKILL_NAME}`;
const BASELINES_SUBPATH = "memory/STATE/skill-baselines.json";
const UPGRADE_MARKER_NAME = ".upgrade-available";

/**
 * Baselines are keyed by destination so multi-substrate installs (#37)
 * track their own drift independently. Default destination uses the
 * unqualified "ISA" key for backwards-compat with pre-#37 baselines.
 */
function baselineKey(destinationDir: string, defaultDir: string): string {
  return resolve(destinationDir) === resolve(defaultDir) ? SKILL_NAME : `${SKILL_NAME}@${resolve(destinationDir)}`;
}

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

function hashEntries(entries: readonly { rel: string; content: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { rel, content } of entries) {
    out[rel] = sha256(content);
  }
  return out;
}

interface BaselinesReadResult {
  baselines: SomaSkillBaselines;
  /** True iff the file existed but failed to parse as JSON. Caller decides
   *  fail-closed vs fail-open behavior; we never silently swallow corruption. */
  corrupt: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBaselines(somaHome: string): Promise<BaselinesReadResult> {
  const path = skillBaselinesPath(somaHome);
  if (!(await exists(path))) return { baselines: {}, corrupt: false };
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    // Validate shape: must be a plain object map of skill-name → baseline.
    // `null`, arrays, primitives, etc. are treated as corruption so the
    // installer falls back to the fail-closed drift path.
    if (!isPlainObject(parsed)) {
      return { baselines: {}, corrupt: true };
    }
    return { baselines: parsed as SomaSkillBaselines, corrupt: false };
  } catch {
    return { baselines: {}, corrupt: true };
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

async function writeSkillFile(destination: string, content: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
}

/**
 * Write a skill file whose `rel` is known to come from the skill's own
 * source listing, so `contentByRel` must contain it. Returns the written
 * destination path. Throws if the (invariant-impossible) lookup misses,
 * documenting the contract without a non-null assertion.
 */
async function writeKnownSkillFile(
  runtimeDir: string,
  rel: string,
  contentByRel: Map<string, string>,
): Promise<string> {
  const dest = join(runtimeDir, rel);
  const content = contentByRel.get(rel);
  if (content === undefined) {
    throw new Error(`isa-skill-installer: no content for skill file ${rel}`);
  }
  await writeSkillFile(dest, content);
  return dest;
}

function transformSkillFileContent(
  relPath: string,
  content: string,
  skillNameOverride?: string,
  projectionSubstrate?: SubstrateId,
): string {
  const rewritten = projectionSubstrate
    ? rewriteSubstrateProjectionContent({ substrate: projectionSubstrate, path: relPath, content })
    : content;
  return rewriteSkillNameFrontmatter(relPath, rewritten, skillNameOverride);
}

/**
 * The single source of truth for ISA skill file CONTENT. Lists the source
 * files (sorted) and applies the substrate transform to each, returning
 * {rel, content} entries. Every ISA projection derives its bytes from here —
 * the on-disk install writes (freshInstall / reconcileSameVersion), the
 * baseline hashes, and the in-memory export bundle (projectIsaSkillBundleFiles)
 * — so install and export cannot drift. Add any content transform HERE, never
 * in a single caller, or the byte-identity invariant breaks silently.
 */
async function computeSourceFileEntries(
  sourceDir: string,
  skillNameOverride?: string,
  projectionSubstrate?: SubstrateId,
): Promise<{ rel: string; content: string }[]> {
  const sourceFiles = await listSkillFiles(sourceDir);
  const entries: { rel: string; content: string }[] = [];
  for (const rel of sourceFiles) {
    const content = transformSkillFileContent(
      rel,
      await readFile(join(sourceDir, rel), "utf8"),
      skillNameOverride,
      projectionSubstrate,
    );
    entries.push({ rel, content });
  }
  return entries;
}

interface DetectedDrift {
  files: string[];
  hasLocalEdits: boolean;
}

async function detectDrift(
  runtimeDir: string,
  baseline: SomaSkillBaseline | undefined,
  sourceFiles: readonly string[],
  baselinesCorrupt: boolean,
): Promise<DetectedDrift> {
  // Fail-closed: if baselines.json is corrupt OR no baseline entry yet but
  // a runtime install exists, we can't prove the runtime is clean. Treat
  // every source-tracked runtime file as edited so the upgrade path writes
  // the `.upgrade-available` marker instead of overwriting.
  if (baselinesCorrupt || baseline === undefined) {
    const runtimeTracked: string[] = [];
    for (const rel of sourceFiles) {
      if (await exists(join(runtimeDir, rel))) runtimeTracked.push(rel);
    }
    return { files: runtimeTracked, hasLocalEdits: runtimeTracked.length > 0 };
  }
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
export function installIsaSkill(options: IsaSkillInstallOptions = {}): Promise<IsaSkillInstallResult> {
  return installIsaSkillInternal(options);
}

export function installIsaSkillProjection(options: InternalIsaSkillInstallOptions = {}): Promise<IsaSkillInstallResult> {
  return installIsaSkillInternal(options);
}

export interface IsaSkillBundleProjectionOptions {
  somaRepoPath?: string;
  skillNameOverride?: string;
  projectionSubstrate?: SubstrateId;
  /**
   * Bundle-relative directory the ISA files live under (e.g. `skills/ISA`
   * or `.cursor/rules/soma/skills/ISA`). Backslashes are normalized to `/`.
   */
  destinationPrefix: string;
}

/**
 * Pure in-memory projection of the ISA skill for a substrate bundle.
 *
 * Returns the same file CONTENT `installIsaSkillProjection` writes under
 * `<substrateHome>/<destinationPrefix>`, but as {path, content}[] with
 * bundle-relative (forward-slash) paths and NO disk writes, baseline
 * tracking, or drift logic. `soma export` uses this so an exported bundle's
 * file set matches an installed home: the ISA skill has a
 * dedicated managed projection and is therefore excluded from the generic
 * portable-skill loop, so without this the bundle's `skills.md` lists the
 * ISA skill while its files are absent.
 *
 * Mirrors a FRESH install — every source file is emitted verbatim (the
 * drift/upgrade states only apply to a pre-existing on-disk runtime, which a
 * freshly exported bundle never has). Returns [] when the configured
 * somaRepoPath ships no skill (same no-op contract as the installer's
 * "no-source" branch).
 */
export async function projectIsaSkillBundleFiles(
  options: IsaSkillBundleProjectionOptions,
): Promise<{ path: string; content: string }[]> {
  const sourceDir = isaSkillSourceDir(resolveSomaRepoPath(options));
  if (!(await exists(sourceDir))) return [];
  const prefix = options.destinationPrefix.replace(/\\/g, "/").replace(/\/+$/, "");
  const entries = await computeSourceFileEntries(sourceDir, options.skillNameOverride, options.projectionSubstrate);
  return entries.map(({ rel, content }) => {
    const relPosix = rel.replace(/\\/g, "/");
    return { path: prefix ? `${prefix}/${relPosix}` : relPosix, content };
  });
}

async function installIsaSkillInternal(options: InternalIsaSkillInstallOptions = {}): Promise<IsaSkillInstallResult> {
  const somaHome = resolveSomaHome(options);
  const somaRepoPath = resolveSomaRepoPath(options);
  const sourceDir = isaSkillSourceDir(somaRepoPath);
  // Substrate adapters (#37) install the skill under their own root
  // (e.g. ~/.codex/skills/ISA). The baseline file still lives under
  // ~/.soma so drift and version tracking remain centralized.
  const runtimeDir = options.skillDestinationDir
    ? resolve(options.skillDestinationDir)
    : isaSkillRuntimeDir(somaHome);
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
  const sourceEntries = await computeSourceFileEntries(sourceDir, options.skillNameOverride, options.projectionSubstrate);
  const sourceFiles = sourceEntries.map((entry) => entry.rel);
  const contentByRel = new Map(sourceEntries.map((entry) => [entry.rel, entry.content] as const));
  const sourceHashes = hashEntries(sourceEntries);

  const runtimeFrontmatter = await readSkillFrontmatter(join(runtimeDir, SKILL_MD));
  const baselinesRead = await readBaselines(somaHome);
  const baselines = baselinesRead.baselines;

  const runtimeFiles = await listSkillFiles(runtimeDir);
  const userAdditions = runtimeFiles.filter((rel) => !sourceFiles.includes(rel) && rel !== UPGRADE_MARKER_NAME);
  const skillKey = baselineKey(runtimeDir, isaSkillRuntimeDir(somaHome));
  const baselineForDest = baselines[skillKey];

  if (runtimeFrontmatter === null || options.force === true) {
    return freshInstall({
      somaHome,
      runtimeDir,
      sourceFiles,
      contentByRel,
      sourceHashes,
      sourceVersion: sourceFrontmatter.version,
      runtimeVersionBefore: runtimeFrontmatter?.version ?? null,
      baselines,
      markerPath,
      userAdditions,
      skillKey,
    });
  }

  const comparison = compareSkillVersions(sourceFrontmatter.version, runtimeFrontmatter.version);
  if (comparison <= 0) {
    return reconcileSameVersion({
      somaHome,
      runtimeDir,
      sourceFiles,
      contentByRel,
      sourceHashes,
      runtimeFiles,
      sourceVersion: sourceFrontmatter.version,
      runtimeVersion: runtimeFrontmatter.version,
      baselines,
      baseline: baselineForDest,
      userAdditions,
      skillKey,
    });
  }

  const drift = await detectDrift(runtimeDir, baselineForDest, sourceFiles, baselinesRead.corrupt);
  if (drift.hasLocalEdits) {
    return writeUpgradeMarker({
      somaHome,
      runtimeDir,
      markerPath,
      sourceVersion: sourceFrontmatter.version,
      runtimeVersion: runtimeFrontmatter.version,
      editedFiles: drift.files,
      userAdditions,
    });
  }

  return freshInstall({
    somaHome,
    runtimeDir,
    sourceFiles,
    contentByRel,
    sourceHashes,
    sourceVersion: sourceFrontmatter.version,
    runtimeVersionBefore: runtimeFrontmatter.version,
    baselines,
    markerPath,
    userAdditions,
    actionOverride: "upgraded",
    skillKey,
  });
}

interface ReconcileSameVersionContext {
  somaHome: string;
  runtimeDir: string;
  sourceFiles: string[];
  contentByRel: Map<string, string>;
  sourceHashes: Record<string, string>;
  runtimeFiles: string[];
  sourceVersion: string;
  runtimeVersion: string;
  baselines: SomaSkillBaselines;
  baseline: SomaSkillBaseline | undefined;
  userAdditions: string[];
  skillKey: string;
}

async function reconcileSameVersion(ctx: ReconcileSameVersionContext): Promise<IsaSkillInstallResult> {
  const missingFiles = ctx.sourceFiles.filter((rel) => !ctx.runtimeFiles.includes(rel));
  if (missingFiles.length === 0) {
    return {
      somaHome: ctx.somaHome,
      skillDir: ctx.runtimeDir,
      sourceVersion: ctx.sourceVersion,
      runtimeVersion: ctx.runtimeVersion,
      action: "unchanged",
      filesWritten: [],
      filesPreservedUserAdditions: ctx.userAdditions,
    };
  }
  const written: string[] = [];
  for (const rel of missingFiles) {
    written.push(await writeKnownSkillFile(ctx.runtimeDir, rel, ctx.contentByRel));
  }
  // Handle the pre-baselines runtime case: existing runtime installed before
  // the baseline feature shipped has no baseline entry. Seed one from the
  // current source hashes so subsequent drift detection works.
  const baselineFilesBefore = ctx.baseline?.files ?? {};
  const restoredFiles: Record<string, string> = { ...baselineFilesBefore };
  for (const rel of missingFiles) {
    restoredFiles[rel] = ctx.sourceHashes[rel];
  }
  const restoredBaseline: SomaSkillBaseline = {
    version: ctx.baseline?.version ?? ctx.sourceVersion,
    files: restoredFiles,
    installedAt: ctx.baseline?.installedAt ?? new Date().toISOString(),
  };
  const nextBaselines = { ...ctx.baselines, [ctx.skillKey]: restoredBaseline };
  await writeBaselines(ctx.somaHome, nextBaselines);
  return {
    somaHome: ctx.somaHome,
    skillDir: ctx.runtimeDir,
    sourceVersion: ctx.sourceVersion,
    runtimeVersion: ctx.runtimeVersion,
    action: "unchanged",
    filesWritten: written,
    filesPreservedUserAdditions: ctx.userAdditions,
  };
}

interface UpgradeMarkerContext {
  somaHome: string;
  runtimeDir: string;
  markerPath: string;
  sourceVersion: string;
  runtimeVersion: string;
  editedFiles: string[];
  userAdditions: string[];
}

async function writeUpgradeMarker(ctx: UpgradeMarkerContext): Promise<IsaSkillInstallResult> {
  await mkdir(ctx.runtimeDir, { recursive: true });
  await writeFile(
    ctx.markerPath,
    `${JSON.stringify({
      skill: SKILL_NAME,
      runtimeVersion: ctx.runtimeVersion,
      sourceVersion: ctx.sourceVersion,
      editedFiles: ctx.editedFiles,
      writtenAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
  return {
    somaHome: ctx.somaHome,
    skillDir: ctx.runtimeDir,
    sourceVersion: ctx.sourceVersion,
    runtimeVersion: ctx.runtimeVersion,
    action: "preserved-local-edits",
    filesWritten: [],
    filesPreservedUserAdditions: ctx.userAdditions,
    upgradeMarker: ctx.markerPath,
  };
}

interface FreshInstallContext {
  somaHome: string;
  runtimeDir: string;
  sourceFiles: string[];
  contentByRel: Map<string, string>;
  sourceHashes: Record<string, string>;
  sourceVersion: string;
  runtimeVersionBefore: string | null;
  baselines: SomaSkillBaselines;
  markerPath: string;
  userAdditions: string[];
  actionOverride?: "fresh" | "upgraded";
  skillKey: string;
}

async function freshInstall(ctx: FreshInstallContext): Promise<IsaSkillInstallResult> {
  const written: string[] = [];
  for (const rel of ctx.sourceFiles) {
    written.push(await writeKnownSkillFile(ctx.runtimeDir, rel, ctx.contentByRel));
  }

  const baselines = { ...ctx.baselines };
  baselines[ctx.skillKey] = {
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
