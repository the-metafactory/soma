import { access, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { kebabNestedName, routePaiPackSourceFile, type PaiPackRenderMode } from "./pai-pack-routing";
import { kebabSlug } from "./pai-pack-slug";
import { EDITOR_CONFIG_DIRS, partitionNoise } from "./pai-pack-noise";
import {
  generateSomaSkillManifest,
  mergeNormalizationReports,
  normalizeSkillDescription,
  normalizeSkillContent,
} from "./pai-pack-normalizer";
import type {
  PaiPackGeneratedImportFile,
  PaiPackImportFile,
  PaiPackImportOptions,
  PaiPackImportPlan,
  PaiPackImportResult,
  PaiPackManifest,
  PaiPackNormalizationAction,
  PaiPackNormalizationReport,
  PaiPackSourceImportFile,
  SomaSkillManifest,
} from "./types";

interface PackMetadata {
  name: string;
  description: string;
}

const RESERVED_SKILL_NAMES = new Set(["soma", "the-algorithm"]);
const REQUIRED_PACK_DOC_FILES = ["README.md", "INSTALL.md", "VERIFY.md"];
const NORMALIZED_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * #97 / #106 — typed refusal raised when a pack contains files under
 * `src/` the router didn't recognize and `options.includeSubstrateSpecific`
 * (legacy option name for the `--include-unrecognized` flag) is not
 * set. Carries the offending file list so the migration orchestrator
 * can record a structured per-pack outcome instead of string-matching
 * error messages. The standalone `soma import pai-pack` verb still
 * surfaces the same throw — only its `instanceof` discriminator
 * changes.
 *
 * Pre-#106 this class was `PaiPackSubstrateSpecificRefusal`. The
 * legacy name is re-exported as an alias for one release so
 * downstream SDK callers don't break on import. The error message and
 * `kind` discriminator both use the new wording.
 */
export class PaiPackUnrecognizedLayoutRefusal extends Error {
  readonly kind = "unrecognized-layout" as const;
  readonly files: readonly string[];
  constructor(files: readonly string[]) {
    super(
      `PAI pack import refused unrecognized-layout file(s) without --include-unrecognized: ${files.join(", ")}`,
    );
    this.name = "PaiPackUnrecognizedLayoutRefusal";
    this.files = files;
  }
}

/**
 * #106 — deprecated alias for `PaiPackUnrecognizedLayoutRefusal`. Kept
 * for one release so SDK consumers that imported the old name don't
 * break. Slated for removal after the next minor version.
 *
 * @deprecated Use `PaiPackUnrecognizedLayoutRefusal` instead.
 */
export const PaiPackSubstrateSpecificRefusal = PaiPackUnrecognizedLayoutRefusal;

/**
 * #102 (Sage r2 CodeQuality important) — typed refusal raised when a
 * pack's normalized skill name is in the pack importer's own reserved
 * set (`soma`, `the-algorithm`). The migration orchestrator runs its
 * own broader reserved pre-check (`isa`, `the-algorithm`, `knowledge`,
 * `telos`) BEFORE the inner call; that pre-check can be bypassed via
 * `--overwrite-reserved`. The pack importer's reserved check cannot
 * be bypassed — those names are structurally off-limits — and
 * intersects the migration set at `the-algorithm`. Without this typed
 * error subclass, the inner throw was a plain `Error`, so the
 * migration orchestrator classified it as `refused-other` instead of
 * `refused-reserved` whenever `--overwrite-reserved` was set and the
 * inner throw fired. Carries the offending slug so the orchestrator
 * can record `outcome.skillName` correctly.
 */
export class PaiPackReservedNameRefusal extends Error {
  readonly kind = "reserved-name" as const;
  readonly skillName: string;
  constructor(skillName: string) {
    super(`soma import pai-pack cannot overwrite reserved Soma skill '${skillName}'.`);
    this.name = "PaiPackReservedNameRefusal";
    this.skillName = skillName;
  }
}

/**
 * #105 — internal extension of `PaiPackImportOptions` for the migration
 * orchestrator. Adds `excludeSkills`, the cross-pack collision filter.
 *
 * Sage r2 #108 Architecture (suggestion): kept OFF the public
 * `PaiPackImportOptions` surface — the standalone `soma import pai-pack`
 * CLI never sets it, the inner SDK consumer (migration orchestrator)
 * imports it from this module directly. Leaks of orchestration-only
 * options on the public type let downstream callers depend on a contract
 * we don't intend to support; keeping it module-internal preserves
 * freedom to revise the collision-filter shape without an SDK break.
 *
 * `excludeSkills`: kebab-cased derived skill slugs to omit. Slugs not
 * present in the pack are silently ignored. Empty/undefined means no
 * exclusion.
 */
interface PaiPackImportOptionsInternal extends PaiPackImportOptions {
  excludeSkills?: ReadonlySet<string>;
}

/**
 * #105 — typed refusal raised when caller's `excludeSkills` filters
 * out every derived skill in the pack (Sage r1 #108 finding). The
 * orchestrator catches this and treats it as a successful "no-op"
 * pack — every excluded slug already has its own
 * `refused-name-collision` outcome from the pre-check, so the pack
 * itself doesn't need an additional outcome row.
 */
export class PaiPackAllSkillsExcludedRefusal extends Error {
  readonly kind = "all-skills-excluded" as const;
  readonly excluded: readonly string[];
  constructor(excluded: readonly string[]) {
    super(
      `PAI pack import: all derived skills excluded (${excluded.join(", ")}). Nothing to import.`,
    );
    this.name = "PaiPackAllSkillsExcludedRefusal";
    this.excluded = excluded;
  }
}

/**
 * #105 — typed refusal raised when a pack's nested-skill set contains
 * two `src/<Name>/SKILL.md` paths whose kebab-cased names collapse to
 * the same slug (e.g., `src/Foo/SKILL.md` + `src/foo/SKILL.md`, or
 * `src/extract-wisdom/SKILL.md` + `src/ExtractWisdom/SKILL.md`). The
 * migration orchestrator classifies these as `refused-name-collision`
 * for the entire pack. Carries the colliding slug + the raw source
 * names so the principal can fix the upstream pack.
 *
 * Note: cross-pack collisions (Pack A landed `browser`, Pack B's
 * `src/Browser/SKILL.md` would clobber it) are handled at the
 * migration-orchestrator level, NOT here — the pack importer alone
 * cannot see what other packs have landed.
 */
export class PaiPackNameCollisionRefusal extends Error {
  readonly kind = "name-collision" as const;
  readonly skillName: string;
  readonly sources: readonly string[];
  constructor(skillName: string, sources: readonly string[]) {
    super(
      `PAI pack import refused name collision on '${skillName}': ${sources.join(", ")} collapse to the same Soma skill slug.`,
    );
    this.name = "PaiPackNameCollisionRefusal";
    this.skillName = skillName;
    this.sources = sources;
  }
}

/**
 * #104 — narrow denylist of IDE/editor config directory prefixes whose
 * symlinked contents are silently skipped during pack enumeration
 * instead of aborting the pack. Match is on POSIX-style pack-relative
 * paths and triggers only when the file IS a symbolic link. Non-symlink
 * editor-config files take the noise-classification path (#106)
 * instead of falling into the unrecognized-layout refusal list. Non-editor
 * symlinks still abort the pack as `refused-other`. Keep this list
 * narrow — every entry widens the security envelope.
 *
 * #106 — the dir list is now sourced from the shared
 * `EDITOR_CONFIG_DIRS` constant in `pai-pack-noise.ts` so the symlink
 * denylist (this file) and the regular-file noise denylist
 * (`pai-pack-noise.ts`) can't drift apart. Single-source rule.
 *
 * Each pattern is anchored at a directory boundary so a stray
 * substring (e.g., `my.cursor.thing/`) does not trigger the skip.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const EDITOR_CONFIG_SYMLINK_PATTERNS: { pattern: RegExp; dir: string }[] = EDITOR_CONFIG_DIRS.map((dir) => ({
  // The trailing `/` requirement keeps these matches anchored to file
  // CONTENTS of the dir, not the dir itself (which is a Dirent that
  // never appears here anyway). The leading dot in each dir name is
  // escaped via `escapeRegex` so `.cursor` doesn't match `xcursor`.
  pattern: new RegExp(`(?:^|/)${escapeRegex(dir)}/`),
  dir,
}));

function matchEditorConfigSymlinkDir(relativePosixPath: string): string | null {
  for (const { pattern, dir } of EDITOR_CONFIG_SYMLINK_PATTERNS) {
    if (pattern.test(relativePosixPath)) {
      return dir;
    }
  }
  return null;
}

const SECRET_FILE_PATTERNS = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)[^/]+$/,
  /(^|\/)id_[a-z0-9_-]+$/,
  /(^|\/)[^/]+\.(pem|key|p12|pfx)$/,
  /(^|\/)(credentials|secrets|tokens?)\.(json|yaml|yml|toml|ini|txt)$/,
  /(^|\/)(settings|config)\.json$/,
  /(^|\/)settings\.local\.json$/,
  /(^|\/)local\.settings\.json$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.gem\/credentials$/,
  /(^|\/)\.cargo\/credentials(?:\.toml)?$/,
  /(^|\/)(\.aws|aws)\/credentials$/,
  /(^|\/)(\.kube|kube)\/config$/,
  /(^|\/)pip\.conf$/,
];

type RoutedPaiPackImportFile =
  | (PaiPackSourceImportFile & {
      renderMode: Extract<PaiPackRenderMode, "copy" | "skill" | "skill-body">;
      /**
       * #105 — derived skill slug this file belongs to. Empty string
       * for archive-only files (route.root === "archive") since they
       * live under the pack-level archive root, not any skill root.
       */
      derivedSkill: string;
    })
  | (PaiPackGeneratedImportFile & {
      renderMode: Extract<PaiPackRenderMode, "manifest" | "archive-manifest"> | "soma-skill-manifest";
      derivedSkill: string;
    });

interface InternalPaiPackImportPlan extends PaiPackImportPlan {
  routedFiles: RoutedPaiPackImportFile[];
  normalization: PaiPackNormalizationReport;
  normalizedSkillFiles: Map<string, NormalizedSkillFile>;
  /** #105 — pack-level slug for archive routing. */
  packSlug: string;
  /** #105 — every derived skill slug produced by this plan (sorted). */
  derivedSkills: string[];
  /**
   * Each nested skill's own frontmatter description, normalized via
   * `normalizeSkillDescription`. Keyed by derived skill slug. Used by
   * the staging step to populate the rewritten SKILL.md frontmatter
   * AND by the SomaSkill manifest renderer — both surfaces previously
   * overwrote the nested skill's authentic description with the
   * generic `Imported PAI nested skill: <Name>` string. Pack-level
   * (FLAT) slug is NOT in this map; it uses `plan.description`
   * (the pack-level README-derived description) the same way it
   * always has. A nested skill missing its own description falls
   * back to the generic string at lookup time.
   */
  nestedSkillDescriptions: Map<string, string>;
}

function isRoutedSourceFile(file: RoutedPaiPackImportFile): file is Extract<RoutedPaiPackImportFile, { origin: "source" }> {
  return file.origin === "source";
}

function resolvePackHomes(options: PaiPackImportOptions = {}): { paiPackDir: string; somaHome: string } {
  if (!options.paiPackDir) {
    throw new Error("soma import pai-pack requires --pai-pack-dir <dir>.");
  }

  const home = resolve(options.homeDir ?? homedir());

  return {
    paiPackDir: resolve(options.paiPackDir),
    somaHome: resolve(options.somaHome ?? join(home, ".soma")),
  };
}

/**
 * Slugify a pack name into the canonical Soma skill folder name.
 * Single-source kebab pipeline lives in `src/pai-pack-slug.ts`; this
 * re-export keeps the migrate orchestrator's existing import path
 * (`from "./pai-pack-importer"`) stable so callers don't move during
 * the Sage r1 #108 maintainability fix.
 */
export function slugifySkillName(value: string): string {
  return kebabSlug(value);
}

function parseFrontmatter(content: string): Partial<Record<string, string>> {
  if (!content.startsWith("---\n")) {
    return {};
  }

  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return {};
  }

  const frontmatter = content.slice(4, end);
  const fields: Partial<Record<string, string>> = {};

  for (const line of frontmatter.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key && value && !value.startsWith("[")) {
      fields[key] = value.replace(/^["']|["']$/g, "");
    }
  }

  return fields;
}

/**
 * Read a pack's `README.md` frontmatter + top heading to derive its
 * canonical name + description. Exported so the migrate orchestrator
 * (and any future reserved-name preflight) can read pack identity
 * with the same parser as the importer itself — Sage r2 #95
 * Maintainability finding (avoid second metadata parser that can
 * drift when pack frontmatter rules change).
 */
export async function readPackMetadata(paiPackDir: string): Promise<PackMetadata> {
  const readme = await readFile(join(paiPackDir, "README.md"), "utf8");
  const fields = parseFrontmatter(readme);
  const heading = /^#\s+(.+)$/m.exec(readme)?.[1]?.trim();

  return {
    name: fields.name ?? heading ?? "pai-pack",
    description: fields.description ?? "",
  };
}

interface CollectFilesResult {
  files: string[];
  /**
   * #104 — IDE/editor config symlinks dropped during enumeration. The
   * pack importer surfaces these as `skipped-editor-config-symlink`
   * audit actions on the normalization report so reviewers can see what
   * the pack carried without the symlinks aborting the import.
   */
  skippedEditorSymlinks: { path: string; dir: string }[];
}

async function collectFiles(root: string): Promise<CollectFilesResult> {
  const files: string[] = [];
  const skippedEditorSymlinks: { path: string; dir: string }[] = [];
  const realRoot = await realpath(root);

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name.includes("\\")) {
        throw new Error(`PAI pack import refused ambiguous path separator: ${relative(root, fullPath).split(sep).join("/")}`);
      }

      if (entry.isSymbolicLink()) {
        const relPosix = relative(root, fullPath).split(sep).join("/");
        // #104 — IDE/editor config symlinks (`.cursor/`, `.vscode/`,
        // `.idea/`, `.fleet/`, `.zed/`) are dropped from the import set
        // instead of aborting the pack. Audit entry is emitted upstream
        // in `buildPaiPackImportPlan` once the normalization report is
        // being assembled. Every other symlink still refuses the pack.
        const editorDir = matchEditorConfigSymlinkDir(relPosix);
        if (editorDir) {
          skippedEditorSymlinks.push({ path: relPosix, dir: editorDir });
          continue;
        }
        throw new Error(`PAI pack import refused symlink path: ${relPosix}`);
      }

      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") {
          continue;
        }
        if (entry.name === ".git" || entry.name === ".hg" || entry.name === ".svn") {
          throw new Error(`PAI pack import refused VCS metadata directory: ${relative(root, fullPath).split(sep).join("/")}`);
        }
        await visit(fullPath);
      } else if (entry.isFile()) {
        const realFile = await realpath(fullPath);
        if (!isWithinPath(realRoot, realFile)) {
          throw new Error(`PAI pack import refused path outside pack root: ${relative(root, fullPath).split(sep).join("/")}`);
        }
        const path = relative(root, fullPath).split(sep).join("/");
        if (!path.startsWith("..") && !path.includes("../")) {
          files.push(path);
        }
      }
    }
  }

  await visit(root);
  return { files: files.sort(), skippedEditorSymlinks };
}

async function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    });
}

function isLikelySecretPath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/");
  const segments = normalizedPath.split("/").map((segment) => segment.toLowerCase());
  if (segments.some((segment) => segment === ".git" || segment === ".hg" || segment === ".svn")) {
    return true;
  }
  if (segments.some((segment) => /^(secrets?|credentials?|tokens?)$/.test(segment))) {
    return true;
  }

  const basename = segments.at(-1) ?? "";
  if (/\b(token|secret|credential|key)s?\b/i.test(basename.replace(/[_\-.]+/g, " "))) {
    return true;
  }

  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(normalizedPath.toLowerCase()));
}

/**
 * #105 — scan the file list and return the raw `<Name>` portion of
 * every `src/<Name>/SKILL.md`. Order is the sorted file order from
 * `collectFiles`. Duplicates are impossible from a single fs scan, so
 * the result is a unique set keyed by raw `<Name>`.
 *
 * The orchestrator must compute the kebab projection separately —
 * within-pack collision detection lives on top of this.
 */
function findNestedSkillNames(sourceFiles: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const path of sourceFiles) {
    if (!path.startsWith("src/")) continue;
    const tail = path.slice("src/".length);
    const idx = tail.indexOf("/");
    if (idx === -1) continue;
    const name = tail.slice(0, idx);
    const rest = tail.slice(idx + 1);
    if (rest === "SKILL.md") {
      result.add(name);
    }
  }
  return result;
}

function assertRequiredPackDocs(sourceFiles: readonly string[]): void {
  const sourceFileSet = new Set(sourceFiles);
  const missing = REQUIRED_PACK_DOC_FILES.filter((path) => !sourceFileSet.has(path));
  if (missing.length > 0) {
    throw new Error(`PAI pack import requires V0 pack file(s): ${missing.join(", ")}`);
  }
}

/**
 * #105 — require at least one skill entrypoint, either FLAT
 * (`src/SKILL.md`) or nested (any `src/<Name>/SKILL.md`). Before this
 * issue the importer required `src/SKILL.md` unconditionally, which
 * forced pure-nested packs (like Thinking/) to fail validation before
 * the new router got a chance to recognize the bundles.
 */
function assertHasSkillEntrypoint(
  sourceFiles: readonly string[],
  nestedSkills: ReadonlySet<string>,
): void {
  const hasFlat = sourceFiles.includes("src/SKILL.md");
  if (!hasFlat && nestedSkills.size === 0) {
    throw new Error(
      `PAI pack import requires V0 pack file(s): src/SKILL.md (or at least one nested src/<Name>/SKILL.md)`,
    );
  }
}

function assertSafePackPaths(sourceFiles: string[]): void {
  const unsafePaths = sourceFiles.filter((path) => path.replace(/\\/g, "/").split("/").includes(".."));
  if (unsafePaths.length > 0) {
    throw new Error(`PAI pack import refused unsafe path segment(s): ${unsafePaths.join(", ")}`);
  }
}

function assertUniqueTargets(files: Pick<PaiPackSourceImportFile | PaiPackGeneratedImportFile, "target">[]): void {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];

  for (const file of files) {
    const key = file.target.toLowerCase();
    const previous = seen.get(key);
    if (previous) {
      duplicates.push(`${previous} <-> ${file.target}`);
    } else {
      seen.set(key, file.target);
    }
  }

  if (duplicates.length > 0) {
    throw new Error(`PAI pack import refused duplicate target path(s): ${duplicates.join(", ")}`);
  }
}

function isWithinPath(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let candidate = path;
  while (!(await pathExists(candidate))) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      return candidate;
    }
    candidate = parent;
  }
  return candidate;
}

async function assertParentWithinRealRoot(root: string, target: string): Promise<void> {
  const realRoot = await realpath(root);
  const ancestor = await nearestExistingAncestor(dirname(target));
  const realAncestor = await realpath(ancestor);
  if (!isWithinPath(realRoot, realAncestor)) {
    throw new Error(`PAI pack import refused target parent outside Soma home: ${target}`);
  }
}

async function resolveSafeSourceFile(realPackRoot: string, source: string): Promise<string> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`PAI pack import refused symlink source during apply: ${source}`);
  }

  const realSource = await realpath(source);
  if (!isWithinPath(realPackRoot, realSource)) {
    throw new Error(`PAI pack import refused source outside pack root during apply: ${source}`);
  }

  return realSource;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

function renderManifestForSkill(plan: InternalPaiPackImportPlan, skillSlug: string): string {
  const skillRoot = join(plan.somaHome, "skills", skillSlug);
  const skillFiles = plan.files.filter((file) => isWithinPath(skillRoot, file.target));
  return renderManifestForRoot(
    { ...plan, skillName: skillSlug },
    skillRoot,
    skillFiles,
  );
}

function renderArchiveManifest(plan: InternalPaiPackImportPlan): string {
  const archiveRoot = join(plan.somaHome, "imports", "pai-packs", plan.packSlug);
  const archiveFiles = plan.files.filter(
    (file) => isWithinPath(archiveRoot, file.target) && file.origin === "source",
  );
  return renderManifestForRoot(
    { ...plan, skillName: plan.packSlug },
    archiveRoot,
    archiveFiles,
    { derivedSkills: plan.derivedSkills },
  );
}

function renderManifestForRoot(
  plan: { paiPackDir: string; somaHome: string; skillName: string; packName: string; description: string; normalization: PaiPackNormalizationReport },
  root: string,
  files: PaiPackImportFile[],
  extras: { derivedSkills?: string[] } = {},
): string {
  const manifest: PaiPackManifest = {
    schema: "soma.pai-pack-import.v1",
    skillName: plan.skillName,
    packName: plan.packName,
    description: plan.description,
    normalization: plan.normalization,
    files: files.map((file) => {
      const manifestFile = {
        target: relative(root, file.target).split(sep).join("/"),
        classification: file.classification,
        origin: file.origin,
      };

      if (file.origin === "source") {
        return {
          ...manifestFile,
          origin: "source",
          source: relative(plan.paiPackDir, file.source).split(sep).join("/"),
        };
      }

      return {
        ...manifestFile,
        origin: "generated",
        generator: file.generator,
      };
    }),
  };
  if (extras.derivedSkills) {
    manifest.derivedSkills = [...extras.derivedSkills].sort();
  }

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function rewriteSkillFrontmatter(content: string, skillName: string, description: string): string {
  if (!content.startsWith("---\n")) {
    return content;
  }

  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return content;
  }

  const body = content.slice(end + "\n---".length);
  return ["---", `name: ${JSON.stringify(skillName)}`, `description: ${JSON.stringify(description || `Imported PAI pack: ${skillName}`)}`, "metadata:", "  source: pai-pack", "---", body.trimStart()].join("\n");
}

/**
 * #105 — pack-level frontmatter for a nested skill's own SKILL.md. The
 * nested skill's frontmatter (e.g. `name: ExtractWisdom`) is preserved
 * via the standard rewrite — only its `name` is replaced with the
 * kebab-cased slug. Nested skills get the pack-level description as a
 * fallback when their own frontmatter lacks one.
 */
function nestedSkillDescription(nestedRawName: string): string {
  return `Imported PAI nested skill: ${nestedRawName}`;
}

/**
 * #105 — resolve the kebab projection of a nested skill name and
 * detect within-pack collisions before any plan work runs. Returns the
 * full set of `{ raw, slug }` pairs sorted by raw name for
 * deterministic downstream iteration. Throws
 * `PaiPackNameCollisionRefusal` on collision so the migration
 * orchestrator can classify it via `instanceof`.
 */
interface NestedSkillRecord {
  raw: string;
  slug: string;
}

function buildNestedSkillIndex(nestedRawNames: ReadonlySet<string>): NestedSkillRecord[] {
  const bySlug = new Map<string, string[]>();
  for (const raw of nestedRawNames) {
    const slug = kebabNestedName(raw);
    const list = bySlug.get(slug) ?? [];
    list.push(raw);
    bySlug.set(slug, list);
  }
  for (const [slug, raws] of bySlug) {
    if (raws.length > 1) {
      throw new PaiPackNameCollisionRefusal(slug, raws.sort());
    }
  }
  return Array.from(nestedRawNames, (raw) => ({ raw, slug: kebabNestedName(raw) }))
    .sort((a, b) => a.raw.localeCompare(b.raw));
}

async function buildPaiPackImportPlan(options: PaiPackImportOptionsInternal = {}): Promise<InternalPaiPackImportPlan> {
  const homes = resolvePackHomes(options);
  const { files: sourceFiles, skippedEditorSymlinks } = await collectFiles(homes.paiPackDir);
  assertSafePackPaths(sourceFiles);
  assertRequiredPackDocs(sourceFiles);
  // #105 — detect nested skill bundles BEFORE the skill-entrypoint
  // check, then accept the pack iff it has either FLAT or ≥1 nested
  // entrypoint. The previous unconditional `src/SKILL.md` requirement
  // would have rejected pure-nested packs (Thinking/, Utilities/) that
  // ship with only nested SKILL.md files.
  const nestedRawNames = findNestedSkillNames(sourceFiles);
  // Build index BEFORE entrypoint check so within-pack name collisions
  // (e.g. Foo/ vs foo/) refuse with the typed error instead of falling
  // through to a downstream duplicate-target failure.
  const nestedIndex = buildNestedSkillIndex(nestedRawNames);
  assertHasSkillEntrypoint(sourceFiles, nestedRawNames);

  const metadata = await readPackMetadata(homes.paiPackDir);
  const packSlug = options.skillName ? slugifySkillName(options.skillName) : slugifySkillName(metadata.name);
  if (!packSlug) {
    throw new Error("soma import pai-pack requires a non-empty skill name after normalization.");
  }
  if (!NORMALIZED_SKILL_NAME_PATTERN.test(packSlug)) {
    throw new Error(`soma import pai-pack produced invalid normalized skill name '${packSlug}'.`);
  }

  // #105 — enumerate every Soma skill this pack will derive. The
  // FLAT top-level surface (pack slug) exists iff `src/SKILL.md` is
  // present in the file list; nested skills are the kebab projection
  // of every `src/<Name>/SKILL.md`.
  //
  // `options.excludeSkills` (Sage r1 #108) drops slugs the caller has
  // determined would collide cross-pack. Excluded skills never enter
  // the plan; their files are never staged or written. The pack-level
  // surface (archive / docs) still lands because surviving derived
  // skills depend on it.
  const hasFlatEntry = sourceFiles.includes("src/SKILL.md");

  // The pack-slug reserved refusal applies ONLY when the pack has a
  // FLAT entry. For a pure-
  // nested pack with a reserved pack name (e.g. README `name: soma`
  // with only `src/Foo/SKILL.md` + `src/Bar/SKILL.md`), `packSlug`
  // is just the archive root identifier under `~/.soma/imports/pai-
  // packs/`. It is NOT an imported skill name, so refusing on it
  // would reject otherwise-valid derived skills. The per-derived-
  // skill reserved check below still fires when a NESTED slug is in
  // the reserved set, so genuinely-reserved skill names are still
  // refused on both layouts.
  if (hasFlatEntry && RESERVED_SKILL_NAMES.has(packSlug)) {
    // #102 — typed refusal so the migrate orchestrator classifies
    // this as `refused-reserved` even when its outer pre-check is
    // bypassed by `--overwrite-reserved` (the inner set is narrower
    // and structurally enforced; the slug is preserved in the error).
    throw new PaiPackReservedNameRefusal(packSlug);
  }
  const excludeSkills = options.excludeSkills ?? new Set<string>();
  const derivedSkillSet = new Set<string>();
  if (hasFlatEntry && !excludeSkills.has(packSlug)) derivedSkillSet.add(packSlug);
  for (const { slug } of nestedIndex) {
    if (!excludeSkills.has(slug)) derivedSkillSet.add(slug);
  }
  if (derivedSkillSet.size === 0) {
    // All derived skills excluded — nothing to import. The orchestrator
    // emits per-slug `refused-name-collision` outcomes; the pack just
    // shouldn't run its inner apply.
    throw new PaiPackAllSkillsExcludedRefusal(
      Array.from(excludeSkills).sort(),
    );
  }

  // Each derived skill is also subject to the pack importer's reserved
  // name set; structurally off-limits even for nested bundles.
  for (const slug of derivedSkillSet) {
    if (RESERVED_SKILL_NAMES.has(slug)) {
      throw new PaiPackReservedNameRefusal(slug);
    }
    if (!NORMALIZED_SKILL_NAME_PATTERN.test(slug)) {
      throw new Error(`soma import pai-pack produced invalid normalized skill name '${slug}'.`);
    }
  }
  // FLAT slug colliding with a nested slug (e.g., pack name "Foo" with
  // nested src/Foo/SKILL.md) is a collision — both would target the
  // same skill root. Refuse with the typed error.
  //
  // Use the RAW nested dir name when building the source path.
  // Previously this template used
  // `packSlug`, which is kebab-cased — for a `src/PAIUpgrade/SKILL.md`
  // colliding with pack slug `pai-upgrade`, the refusal would report
  // `src/pai-upgrade/SKILL.md` (a path that does not exist on disk),
  // making the error misleading. Resolving via `nestedIndex.raw`
  // pins the actual filesystem path the principal can inspect.
  const flatCollidingNested = hasFlatEntry
    ? nestedIndex.find(({ slug }) => slug === packSlug)
    : undefined;
  if (flatCollidingNested) {
    throw new PaiPackNameCollisionRefusal(packSlug, [
      "src/SKILL.md",
      `src/${flatCollidingNested.raw}/SKILL.md`,
    ]);
  }

  if (!options.overwrite) {
    for (const slug of derivedSkillSet) {
      await access(join(homes.somaHome, "skills", slug))
        .then(() => {
          throw new Error(`Soma skill '${slug}' already exists. Re-run with --overwrite to replace it.`);
        })
        .catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
          throw error;
        });
    }
    await access(join(homes.somaHome, "imports", "pai-packs", packSlug))
      .then(() => {
        throw new Error(`Soma PAI pack archive '${packSlug}' already exists. Re-run with --overwrite to replace it.`);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      });
  }

  // #106 — partition the source file list into NOISE (editor/IDE/
  // language infrastructure; silently dropped) vs the rest. Noise is
  // removed BEFORE routing so it never appears in the routed file
  // set, never gets classified `unrecognized-layout`, and never
  // appears in the refusal list when one is thrown below. Audit
  // entries (one per skipped noise file) feed the normalization
  // report just like #104's editor-config symlink skips.
  //
  // Two-step ordering with respect to the secret-file check:
  //
  //   1. Editor-config DIR contents (`.vscode/`, `.fleet/`, `.zed/`,
  //      `.cursor/`, `.idea/`) are partitioned FIRST so editor
  //      settings.json files don't trip the broader settings.json
  //      secret pattern. These are pure structural noise; their
  //      contents never represent an actual credential risk.
  //   2. The secret-file check runs on what remains. `.npmrc`
  //      outside an editor-config dir still refuses as a likely
  //      credential file (the project's pre-existing secret contract
  //      MUST hold; noise classification of `.npmrc` is a downgrade
  //      from refusal, not from secret).
  //   3. Remaining noise (lockfiles, .gitignore, .npmrc-IF-not-a-secret,
  //      etc.) is partitioned next, with audit entries.
  const { kept: keptSourceFiles, skipped: skippedNoiseFiles } = partitionNoise(sourceFiles);

  // Secret check on the kept set — only editor-config-dir contents
  // (which the partition already removed via the ide-config category)
  // are exempt. `.npmrc` at pack root or under `src/Tools/` still
  // matched by the partition AND would have matched the secret check
  // too; we need both refusals to remain. Re-introduce secret refusal
  // for any noise-skipped path that ALSO matches a secret pattern AND
  // is NOT under an editor-config dir.
  const noiseSecretLeaks = skippedNoiseFiles.filter(({ path, match }) => {
    if (match.category === "ide-config") return false;
    return isLikelySecretPath(path);
  });
  if (noiseSecretLeaks.length > 0) {
    throw new Error(
      `PAI pack import refused likely secret file(s): ${noiseSecretLeaks.map((f) => f.path).join(", ")}`,
    );
  }

  const secretFiles = keptSourceFiles.filter(isLikelySecretPath);
  if (secretFiles.length > 0) {
    throw new Error(`PAI pack import refused likely secret file(s): ${secretFiles.join(", ")}`);
  }

  const routes = keptSourceFiles.map((path) => ({
    path,
    route: routePaiPackSourceFile(path, nestedRawNames),
  }));
  const unrecognizedLayout = routes.filter(({ route }) => route.classification === "unrecognized-layout");

  // #109 — partial-import semantics: previously ANY unrecognized-layout
  // file refused the whole pack (throw `PaiPackUnrecognizedLayoutRefusal`),
  // which poisoned every real PAI pack (Art, Thinking, Utilities, etc.)
  // because they all ship a mix of portable nested skills AND
  // unrecognized siblings (`src/<Name>/Examples.md`, `src/<Name>/Assets/`,
  // `src/Lib/`, etc.). Real packs MUST be the gold standard, not
  // synthetic happy-path fixtures.
  //
  // New semantics — root cause was hypothesis 5 (pack-level outcome
  // poisoning, per-pack instead of per-file):
  //
  //   - Without `--include-unrecognized` (the new default): unrecognized
  //     files are SILENTLY DROPPED from the routed set. They are NOT
  //     archived. Portable files land normally. The pack outcome remains
  //     `imported`; the count + list of dropped unrecognized files
  //     surfaces via the normalization report (`skipped-unrecognized-file`
  //     audit actions) so reviewers still see what the pack carried
  //     that we didn't classify.
  //
  //   - With `--include-unrecognized`: existing behavior — unrecognized
  //     files DO land in the pack-level archive at
  //     `~/.soma/imports/pai-packs/<pack>/source/<original-path>`.
  //
  // The `assertHasSkillEntrypoint` check above already guarantees that
  // every pack has at least one portable SKILL.md (FLAT or nested), so
  // there is always something landable. A pack with ZERO portable files
  // is structurally impossible after #105's entrypoint check.
  //
  // The `PaiPackUnrecognizedLayoutRefusal` class is retained for
  // back-compat with downstream callers (re-exported from `src/index.ts`)
  // but is no longer thrown by the importer. The orchestrator's
  // `instanceof` catch in `pai-migration.ts:858` becomes dead code we
  // leave in place for one release in case external SDK consumers
  // produce the error themselves.
  const droppedUnrecognizedFiles: string[] = unrecognizedLayout.map(({ path }) => path);

  const routedFiles: RoutedPaiPackImportFile[] = [];
  for (const { path, route } of routes) {
    // #109 — skip unrecognized-layout routes entirely when the caller
    // hasn't opted in to archiving them. Their `route.root` is "archive"
    // and they would otherwise land under
    // `imports/pai-packs/<pack>/source/<path>`.
    if (route.classification === "unrecognized-layout" && !options.includeSubstrateSpecific) {
      continue;
    }
    // Resolve the destination skill slug for portable routes:
    //   - route.skillName === null → pack-level (FLAT) slug
    //   - route.skillName !== null → nested skill slug
    const destSkill = route.skillName ?? packSlug;
    // Sage r1 #108 BLOCKER: skip routed files for any skill that the
    // caller excluded. The pack-level archive surface (route.root ===
    // "archive") is unaffected — it lives under the pack slug, not a
    // skill slug — so unrecognized-layout files still archive even
    // when their associated skill is excluded.
    if (route.root === "skill" && !derivedSkillSet.has(destSkill)) {
      continue;
    }
    const destRoot =
      route.root === "skill"
        ? join(homes.somaHome, "skills", destSkill)
        : join(homes.somaHome, "imports/pai-packs", packSlug);
    routedFiles.push({
      source: join(homes.paiPackDir, path),
      target: join(destRoot, route.relativePath),
      classification: route.classification,
      renderMode: route.renderMode,
      origin: "source",
      derivedSkill: route.root === "skill" ? destSkill : "",
    });
  }

  // #105 — pack-level README/INSTALL/VERIFY land under EACH derived
  // skill so each nested skill is independently invocable with the
  // pack's context attached. The base routing only emits one copy
  // (to the pack-level surface); we replicate it per nested skill
  // that survived the exclusion filter.
  for (const docName of REQUIRED_PACK_DOC_FILES) {
    if (!sourceFiles.includes(docName)) continue;
    const targetBasename = {
      "README.md": "PAI-PACK-README.md",
      "INSTALL.md": "PAI-PACK-INSTALL.md",
      "VERIFY.md": "PAI-PACK-VERIFY.md",
    }[docName];
    if (!targetBasename) continue;
    for (const { slug } of nestedIndex) {
      // Skip if FLAT pack already has this slug — the route already
      // landed it. Skip if the slug was excluded by the caller.
      if (hasFlatEntry && slug === packSlug) continue;
      if (!derivedSkillSet.has(slug)) continue;
      routedFiles.push({
        source: join(homes.paiPackDir, docName),
        target: join(homes.somaHome, "skills", slug, "references", targetBasename),
        classification: "source-doc",
        renderMode: "copy",
        origin: "source",
        derivedSkill: slug,
      });
    }
  }

  // AC-4 — preserve every normalized file's original under
  // imports/pai-packs/<pack-slug>/source/<original-path> so the un-normalized
  // PAI source remains auditable. Copy mode; never normalized.
  // Both "skill" (entry SKILL.md) and "skill-body" (Workflows/Tools .md)
  // get archived — round-3 split introduced skill-body and the archive
  // loop must follow.
  for (const { path, route } of routes) {
    if (route.renderMode === "skill" || route.renderMode === "skill-body") {
      routedFiles.push({
        source: join(homes.paiPackDir, path),
        target: join(homes.somaHome, "imports", "pai-packs", packSlug, "source", path),
        classification: "source-doc",
        renderMode: "copy",
        origin: "source",
        derivedSkill: "",
      });
    }
  }

  // Pre-compute normalization for every skill-rendered file so dry-run can
  // report actions and warnings without writing. The Map is also re-used by
  // the apply path (no second read+normalize pass) — Sage round 1 finding.
  const normalizedSkillFiles = await normalizeSkillFiles(homes.paiPackDir, routedFiles);
  const normalizedDescription = normalizeSkillDescription(metadata.description, {
    file: "README.md",
    fallback: `Imported PAI pack: ${metadata.name}`,
  });
  // #104 — surface IDE/editor config symlink skips alongside existing
  // normalization actions in the per-pack `soma-pack.json` audit. The
  // skips happen during file enumeration (before normalization runs),
  // but the audit shape is the same: `{ file, kind, detail }`. Reviewers
  // see exactly which editor files the pack carried that we dropped.
  const editorSymlinkSkipActions: PaiPackNormalizationAction[] = skippedEditorSymlinks.map(({ path, dir }) => ({
    file: path,
    kind: "skipped-editor-config-symlink",
    detail: `editor-config denylist dir: ${dir}`,
  }));
  // #106 — same shape for noise denylist matches. The detail field
  // includes the category so reviewers can see WHY a file was
  // classified noise (lockfile vs editor-config vs vcs-config vs ...).
  const noiseSkipActions: PaiPackNormalizationAction[] = skippedNoiseFiles.map(({ path, match }) => ({
    file: path,
    kind: "skipped-noise-file",
    detail: `${match.category}: ${match.detail}`,
  }));
  // #109 — audit entries for unrecognized-layout files we silently
  // dropped (default mode — no `--include-unrecognized`). Same shape
  // as the noise skip entries so the per-skill `soma-pack.json` audit
  // surfaces both classes uniformly. When `--include-unrecognized` is
  // set the files DO land in the archive and we don't emit these
  // dropped-audit entries (the archive listing itself is the audit).
  const dropUnrecognizedActions: PaiPackNormalizationAction[] =
    options.includeSubstrateSpecific
      ? []
      : droppedUnrecognizedFiles.map((path) => ({
          file: path,
          kind: "skipped-unrecognized-file",
          detail: "unrecognized layout (no --include-unrecognized)",
        }));
  const normalization = mergeNormalizationReports([
    reportFromNormalizedFiles(normalizedSkillFiles.values()),
    { actions: normalizedDescription.action ? [normalizedDescription.action] : [], warnings: [] },
    { actions: editorSymlinkSkipActions, warnings: [] },
    { actions: noiseSkipActions, warnings: [] },
    { actions: dropUnrecognizedActions, warnings: [] },
  ]);

  // Per-derived-skill manifests: each skill gets its own soma-pack.json
  // (per-skill audit) and soma-skill.json (runtime manifest).
  const derivedSkills = Array.from(derivedSkillSet).sort();
  for (const slug of derivedSkills) {
    routedFiles.push({
      target: join(homes.somaHome, `skills/${slug}/soma-pack.json`),
      classification: "portable",
      renderMode: "manifest",
      origin: "generated",
      generator: "pai-pack-importer",
      derivedSkill: slug,
    });
    routedFiles.push({
      target: join(homes.somaHome, `skills/${slug}/soma-skill.json`),
      classification: "portable",
      renderMode: "soma-skill-manifest",
      origin: "generated",
      generator: "pai-pack-importer",
      derivedSkill: slug,
    });
  }
  // Pack-level archive manifest is always emitted when there are
  // archive-bound files (unrecognized-layout OR every imported pack
  // gets one as part of #105's auditability contract — the archive's
  // `derivedSkills` list is principal-facing).
  //
  // #109 — the archive manifest is classified `unrecognized-layout`
  // only when unrecognized files actually landed in the archive
  // (i.e. `--include-unrecognized` was set). The default drop-on-sight
  // mode means the archive carries only the standard SKILL.md/Workflow
  // backups (rendered as `source/...` copies of every portable file),
  // which is `portable`.
  const archiveCarriesUnrecognized =
    unrecognizedLayout.length > 0 && options.includeSubstrateSpecific === true;
  routedFiles.push({
    target: join(homes.somaHome, `imports/pai-packs/${packSlug}/soma-pack-archive.json`),
    classification: archiveCarriesUnrecognized ? "unrecognized-layout" : "portable",
    renderMode: "archive-manifest",
    origin: "generated",
    generator: "pai-pack-importer",
    derivedSkill: "",
  });

  const escapedTargets = routedFiles.filter((file) => !isWithinPath(homes.somaHome, file.target));
  if (escapedTargets.length > 0) {
    throw new Error(`PAI pack import refused target path outside Soma home: ${escapedTargets.map((file) => file.target).join(", ")}`);
  }
  assertUniqueTargets(routedFiles);

  const files = routedFiles.map(({ renderMode: _renderMode, derivedSkill: _derivedSkill, ...file }) => file);

  // Capture each nested skill's own frontmatter `description` so the
  // staging step and SomaSkill manifest renderer can preserve it
  // instead of clobbering with `nestedSkillDescription(slug)`. We
  // parse the already-normalized SKILL.md content (no second file
  // read).
  const nestedSkillDescriptions = new Map<string, string>();
  for (const file of routedFiles) {
    if (
      file.renderMode !== "skill" ||
      !isRoutedSourceFile(file) ||
      file.derivedSkill === packSlug ||
      file.derivedSkill === ""
    ) {
      continue;
    }
    const normalized = normalizedSkillFiles.get(file.source);
    if (!normalized) continue;
    const fm = parseFrontmatter(normalized.normalized);
    const rawDescription = fm.description;
    if (!rawDescription) continue;
    // Normalize the same way the pack-level description is normalized
    // so trailing punctuation, blank entries, and "your" → "the" type
    // adjustments stay consistent across surfaces.
    const normalizedDesc = normalizeSkillDescription(rawDescription, {
      file: `src/${findNestedRawForSlug(nestedIndex, file.derivedSkill) ?? file.derivedSkill}/SKILL.md`,
      fallback: nestedSkillDescription(file.derivedSkill),
    });
    nestedSkillDescriptions.set(file.derivedSkill, normalizedDesc.description);
  }

  return {
    apply: false,
    paiPackDir: homes.paiPackDir,
    somaHome: homes.somaHome,
    // For the single-plan view, `skillName` is the pack slug — kept
    // for back-compat with manifest renderers. Callers consume
    // `derivedSkills` to enumerate per-skill landing pads.
    skillName: packSlug,
    packName: metadata.name,
    description: normalizedDescription.description,
    files,
    routedFiles,
    normalization,
    normalizedSkillFiles,
    packSlug,
    derivedSkills,
    nestedSkillDescriptions,
  };
}

/**
 * Find the raw nested dir name for a given kebab slug. Used by the
 * description-normalization step so per-file audit paths name the
 * actual on-disk path (consistent with the flat-vs-nested collision
 * message).
 */
function findNestedRawForSlug(
  nestedIndex: readonly NestedSkillRecord[],
  slug: string,
): string | null {
  for (const record of nestedIndex) {
    if (record.slug === slug) return record.raw;
  }
  return null;
}

interface NormalizedSkillFile {
  source: string;
  normalized: string;
  actions: import("./pai-pack-normalizer").NormalizeContentResult["actions"];
  warnings: import("./pai-pack-normalizer").NormalizeContentResult["warnings"];
}

async function readAndNormalizeSkill(
  paiPackDir: string,
  realPackRoot: string,
  sourcePath: string,
): Promise<NormalizedSkillFile> {
  const source = await resolveSafeSourceFile(realPackRoot, sourcePath);
  const content = await readFile(source, "utf8");
  const relPath = relative(paiPackDir, sourcePath).split(sep).join("/");
  const result = normalizeSkillContent(relPath, content);
  return { source: sourcePath, normalized: result.content, actions: result.actions, warnings: result.warnings };
}

async function normalizeSkillFiles(
  paiPackDir: string,
  routedFiles: RoutedPaiPackImportFile[],
): Promise<Map<string, NormalizedSkillFile>> {
  const realPackRoot = await realpath(paiPackDir);
  const skillFiles: { source: string }[] = [];
  const seen = new Set<string>();
  for (const file of routedFiles) {
    if ((file.renderMode === "skill" || file.renderMode === "skill-body") && isRoutedSourceFile(file)) {
      // Each unique source path normalizes once (multiple derived
      // skills can reference the same source through different
      // routings; we only run the normalizer once per source).
      if (!seen.has(file.source)) {
        seen.add(file.source);
        skillFiles.push({ source: file.source });
      }
    }
  }
  const results = await mapWithConcurrency(skillFiles, 8, (file) =>
    readAndNormalizeSkill(paiPackDir, realPackRoot, file.source),
  );
  const map = new Map<string, NormalizedSkillFile>();
  for (const result of results) {
    map.set(result.source, result);
  }
  return map;
}

function reportFromNormalizedFiles(files: Iterable<NormalizedSkillFile>): PaiPackNormalizationReport {
  return mergeNormalizationReports(
    Array.from(files, (file) => ({ actions: file.actions, warnings: file.warnings })),
  );
}

/**
 * #105 — public-facing plan function. Returns one
 * `PaiPackImportPlan` per derived skill in the pack (≥ 1 always).
 *
 * BREAKING CHANGE: previously returned a single `PaiPackImportPlan`.
 * Callers that expected a scalar must adapt — the migration
 * orchestrator (the primary consumer) handles the array shape
 * natively. The standalone `soma import pai-pack` CLI verb prints
 * each plan in turn.
 */
export async function planPaiPackImport(
  options: PaiPackImportOptions = {},
): Promise<PaiPackImportPlan[]> {
  const internal = await buildPaiPackImportPlan(options);
  return splitInternalPlanByDerivedSkill(internal);
}

/**
 * Opaque handle for plan-once, apply-later imports. The migration
 * orchestrator's two-phase apply path uses this to plan once
 * (Phase 1, bounded-concurrent) and apply later (Phase 2, sequential
 * with cross-pack collision filtering) WITHOUT a second full plan
 * rebuild.
 *
 * Security invariant: plan data is stored OFF the handle, in a
 * module-private `WeakMap<handle, planData>`. The handle itself is
 * a frozen empty object — it carries no addressable plan state, so
 * a caller with a legitimate handle cannot mutate
 * `handle.plan.routedFiles` to bypass containment validation. The
 * same WeakMap doubles as the trusted-handle set: forged handles
 * (objects fitting the structural interface but never registered)
 * have no entry and `castHandle` rejects them with a `TypeError`.
 *
 * @internal The handle trio (`PaiPackImportPlanHandle`,
 * `planPaiPackImportHandle`, `importPaiPackFromPlan`) is
 * orchestration-only plumbing. NOT re-exported from `src/index.ts`;
 * the only legitimate consumer is the migration orchestrator, which
 * deep-imports from this module. The WeakMap design is free to
 * change; do not depend on the export.
 */
export interface PaiPackImportPlanHandle {
  readonly __brand: "PaiPackImportPlanHandle";
}

interface TrustedPlanData {
  readonly plan: InternalPaiPackImportPlan;
  readonly options: PaiPackImportOptionsInternal;
}

// Module-private WeakMap from frozen handle → plan data. The handle
// object never holds the plan directly, so an external caller with
// a legitimate handle cannot mutate the cached plan in any way. The
// WeakMap has no external accessor and lookup is the only path from
// handle to plan.
const TRUSTED_PLAN_BY_HANDLE = new WeakMap<object, TrustedPlanData>();

function castHandle(handle: PaiPackImportPlanHandle): TrustedPlanData {
  const candidate: unknown = handle;
  if (candidate === null || typeof candidate !== "object") {
    throw new TypeError("importPaiPackFromPlan: handle must be a PaiPackImportPlanHandle object.");
  }
  const data = TRUSTED_PLAN_BY_HANDLE.get(candidate);
  if (!data) {
    throw new TypeError(
      "importPaiPackFromPlan: handle was not produced by planPaiPackImportHandle. " +
        "Refusing to apply a potentially-forged plan that has not been validated by the builder.",
    );
  }
  return data;
}

/**
 * Plan-once API for the migration orchestrator. Returns the public
 * per-skill plan view (for outcome reporting) alongside an opaque
 * handle that `importPaiPackFromPlan` consumes to apply WITHOUT a
 * second plan rebuild.
 *
 * Standalone CLI consumers (`soma import pai-pack`) keep using
 * `planPaiPackImport` + `importPaiPack` — the handle path is an
 * orchestration-level optimization for callers that already planned
 * and want to apply the same plan.
 *
 * @internal Orchestration plumbing for the migration apply path.
 * Not part of the public SDK surface; do not depend on the export.
 */
export async function planPaiPackImportHandle(
  options: PaiPackImportOptionsInternal = {},
): Promise<{ plans: PaiPackImportPlan[]; handle: PaiPackImportPlanHandle }> {
  const internal = await buildPaiPackImportPlan(options);
  const plans = splitInternalPlanByDerivedSkill(internal);
  // The handle is a frozen empty object — it carries NO addressable
  // plan state. The plan lives in the module-private WeakMap, keyed
  // by the handle. A caller with a legitimate handle cannot mutate
  // `handle.plan` because there is no `.plan` field; the only path
  // from handle to plan is the WeakMap lookup in `castHandle`, which
  // lives in this module file.
  const handle = Object.freeze({ __brand: "PaiPackImportPlanHandle" } as const);
  TRUSTED_PLAN_BY_HANDLE.set(handle, { plan: internal, options });
  return { plans, handle };
}

/**
 * Single source for the "archive attaches to the first derived skill"
 * bucketing rule. Both `splitInternalPlanByDerivedSkill` (the plan
 * surface) and `applyInternalPlan` (the result surface) use this so
 * the policy can't drift between dry-run and applied views: if it
 * ever changes (e.g., to attach the archive to a synthetic "_pack"
 * surface or to skip attachment entirely), one helper updates both
 * paths in lockstep.
 *
 * `fileDerivedSkill` is the routed file's own derived-skill slug;
 * empty string means "archive / pack-level file." Returns:
 *   - the file's own slug when it has one (normal per-skill files);
 *   - the first derived skill when the file is archive-only AND the
 *     pack derived at least one skill;
 *   - `null` when there are no derived skills (defensive — the
 *     caller should skip the file).
 */
function attachArchiveToFirstSkill(
  fileDerivedSkill: string,
  derivedSkills: readonly string[],
): string | null {
  if (fileDerivedSkill) return fileDerivedSkill;
  return derivedSkills[0] ?? null;
}

/**
 * #105 — split the single internal plan (which holds every routed
 * file in one bag) into one externally-visible `PaiPackImportPlan`
 * per derived skill. The archive surface (under
 * `<somaHome>/imports/pai-packs/<pack-slug>/`) is attached to the
 * first (sorted) derived skill so its files don't vanish — callers
 * that want the archive listing can find it on `plans[0].files`.
 *
 * Each plan reports the same `paiPackDir`, `somaHome`, `packName`,
 * `description`, `normalization` — those are pack-level properties
 * shared by every derived skill.
 */
function splitInternalPlanByDerivedSkill(
  internal: InternalPaiPackImportPlan,
): PaiPackImportPlan[] {
  const sharedFields = {
    apply: internal.apply,
    paiPackDir: internal.paiPackDir,
    somaHome: internal.somaHome,
    packName: internal.packName,
    description: internal.description,
    normalization: internal.normalization,
  };

  // Group every routed source file + every generated per-skill manifest
  // under its derived-skill bucket. Archive-only files (derivedSkill ==
  // "") attach to the first skill so they don't disappear from the
  // public plan surface (see `attachArchiveToFirstSkill`).
  const buckets = new Map<string, PaiPackImportFile[]>();
  for (const slug of internal.derivedSkills) buckets.set(slug, []);

  for (const file of internal.routedFiles) {
    const slug = attachArchiveToFirstSkill(file.derivedSkill, internal.derivedSkills);
    if (!slug) continue;
    if (!buckets.has(slug)) buckets.set(slug, []);
    const { renderMode: _r, derivedSkill: _d, ...stripped } = file;
    const bucket = buckets.get(slug);
    if (bucket) bucket.push(stripped);
  }

  return internal.derivedSkills.map((slug) => ({
    ...sharedFields,
    skillName: slug,
    files: buckets.get(slug) ?? [],
  }));
}

async function stagePaiPackFiles(plan: InternalPaiPackImportPlan, stageRoot: string): Promise<void> {
  const realPackRoot = await realpath(plan.paiPackDir);

  await mapWithConcurrency(plan.routedFiles, 8, async (file) => {
    const target = file.target;
    const stagedTarget = join(stageRoot, relative(plan.somaHome, target));
    if (!isWithinPath(stageRoot, stagedTarget)) {
      throw new Error(`PAI pack import refused staged target path outside stage root: ${target}`);
    }

    await mkdir(dirname(stagedTarget), { recursive: true });

    if (file.renderMode === "manifest") {
      // Per-skill soma-pack.json (one per derived skill).
      await writeFile(stagedTarget, renderManifestForSkill(plan, file.derivedSkill), "utf8");
    } else if (file.renderMode === "archive-manifest") {
      await writeFile(stagedTarget, renderArchiveManifest(plan), "utf8");
    } else if (file.renderMode === "soma-skill-manifest") {
      await writeFile(stagedTarget, renderSomaSkillManifest(plan, file.derivedSkill), "utf8");
    } else if (file.renderMode === "skill" || file.renderMode === "skill-body") {
      // Reuse the cached normalization computed during plan construction
      // so we don't re-read or re-normalize the same source per Sage's
      // double-pass finding. Fallback: re-read if cache miss.
      if (!isRoutedSourceFile(file)) {
        throw new Error(`PAI pack import cannot normalize generated file: ${target}`);
      }
      const cached = plan.normalizedSkillFiles.get(file.source);
      const normalizedContent = cached
        ? cached.normalized
        : normalizeSkillContent(
            relative(plan.paiPackDir, file.source).split(sep).join("/"),
            await readFile(await resolveSafeSourceFile(realPackRoot, file.source), "utf8"),
          ).content;
      // Only the entry SKILL.md gets the skill identity frontmatter rewrite.
      // Workflows/Tools markdown keeps its original frontmatter intact —
      // Sage round-3 important: their identity isn't the root skill's.
      //
      // Nested skills use their OWN SKILL.md description (captured
      // in the plan's `nestedSkillDescriptions` map). Fallback to
      // the generic `nestedSkillDescription(slug)` only when the
      // nested skill shipped no description. Pack-level (FLAT) slug
      // keeps using `plan.description` (the README-derived pack
      // description).
      const finalContent = file.renderMode === "skill"
        ? `${rewriteSkillFrontmatter(
            normalizedContent,
            file.derivedSkill,
            resolveDerivedSkillDescription(plan, file.derivedSkill),
          ).trimEnd()}\n`
        : `${normalizedContent.trimEnd()}\n`;
      await writeFile(stagedTarget, finalContent, "utf8");
    } else {
      if (!isRoutedSourceFile(file)) {
        throw new Error(`PAI pack import cannot copy generated file: ${target}`);
      }
      const source = await resolveSafeSourceFile(realPackRoot, file.source);
      await copyFile(source, stagedTarget);
    }
  });
}

function renderSomaSkillManifest(plan: InternalPaiPackImportPlan, skillSlug: string): string {
  const skillRoot = join(plan.somaHome, "skills", skillSlug);
  const skillRelPath = (target: string): string => relative(skillRoot, target).split(sep).join("/");
  const skillFiles = plan.files.filter((file) => isWithinPath(skillRoot, file.target));
  const skillMd = skillFiles.find((file) => skillRelPath(file.target) === "SKILL.md");
  const references = skillFiles
    .filter((file) => file.classification === "source-doc")
    .map((file) => skillRelPath(file.target));
  const workflowFiles = skillFiles
    .filter((file) => skillRelPath(file.target).startsWith("Workflows/"))
    .map((file) => skillRelPath(file.target));
  const manifest: SomaSkillManifest = generateSomaSkillManifest({
    skillName: skillSlug,
    // Preserve each nested skill's own SKILL.md description in its
    // soma-skill.json manifest (same source-of-truth as the SKILL.md
    // frontmatter rewrite above).
    description: resolveDerivedSkillDescription(plan, skillSlug),
    packName: plan.packName,
    entrypoint: skillMd ? skillRelPath(skillMd.target) : "SKILL.md",
    references,
    workflowFiles,
  });
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Single source for resolving the description that a derived skill
 * gets in BOTH its rewritten
 * SKILL.md frontmatter AND its soma-skill.json manifest. Order:
 *   1. Pack-level (FLAT) slug always uses the pack's normalized
 *      README-derived description.
 *   2. Nested skills use their OWN normalized SKILL.md frontmatter
 *      description (captured in `plan.nestedSkillDescriptions`).
 *   3. Nested skills missing a description fall back to the generic
 *      `Imported PAI nested skill: <Name>` string so the manifest is
 *      never empty.
 */
function resolveDerivedSkillDescription(
  plan: InternalPaiPackImportPlan,
  derivedSlug: string,
): string {
  if (derivedSlug === plan.packSlug) return plan.description;
  const own = plan.nestedSkillDescriptions.get(derivedSlug);
  if (own) return own;
  return nestedSkillDescription(derivedSlug);
}

interface PromotionContext {
  plan: InternalPaiPackImportPlan;
  stageRoot: string;
  backupRoot: string;
  overwrite: boolean;
  cleanupRoots: Set<string>;
}

async function promoteStagedImportWithRollback(context: PromotionContext): Promise<void> {
  const { plan, stageRoot, backupRoot, overwrite, cleanupRoots } = context;
  const archiveRoot = join(plan.somaHome, "imports", "pai-packs", plan.packSlug);
  const backupArchiveRoot = join(backupRoot, "imports", "pai-packs", plan.packSlug);
  const hadArchiveRoot = await pathExists(archiveRoot);

  // Track every skill root that needs to be promoted + backed up.
  const skillEntries = plan.derivedSkills.map((slug) => {
    const dest = join(plan.somaHome, "skills", slug);
    const backup = join(backupRoot, "skills", slug);
    const staged = join(stageRoot, "skills", slug);
    return { slug, dest, backup, staged };
  });
  const stagedArchiveRoot = join(stageRoot, "imports", "pai-packs", plan.packSlug);

  const hadDest: Record<string, boolean> = {};
  for (const entry of skillEntries) {
    hadDest[entry.slug] = await pathExists(entry.dest);
  }

  const promotedDest = new Set<string>();
  let promotedArchiveRoot = false;

  try {
    if (overwrite) {
      for (const entry of skillEntries) {
        if (hadDest[entry.slug]) {
          await mkdir(dirname(entry.backup), { recursive: true });
          await rename(entry.dest, entry.backup);
        }
      }
      if (hadArchiveRoot) {
        await mkdir(dirname(backupArchiveRoot), { recursive: true });
        await rename(archiveRoot, backupArchiveRoot);
      }
    }

    for (const entry of skillEntries) {
      if (await pathExists(entry.staged)) {
        await mkdir(dirname(entry.dest), { recursive: true });
        await rename(entry.staged, entry.dest);
        promotedDest.add(entry.slug);
      }
    }

    if (await pathExists(stagedArchiveRoot)) {
      await mkdir(dirname(archiveRoot), { recursive: true });
      await rename(stagedArchiveRoot, archiveRoot);
      promotedArchiveRoot = true;
    }
  } catch (error) {
    try {
      for (const entry of skillEntries) {
        if (promotedDest.has(entry.slug)) {
          await rm(entry.dest, { recursive: true, force: true });
        }
      }
      if (promotedArchiveRoot) {
        await rm(archiveRoot, { recursive: true, force: true });
      }
      for (const entry of skillEntries) {
        if (hadDest[entry.slug] && (await pathExists(entry.backup))) {
          await mkdir(dirname(entry.dest), { recursive: true });
          await rename(entry.backup, entry.dest);
        }
      }
      if (hadArchiveRoot && (await pathExists(backupArchiveRoot))) {
        await mkdir(dirname(archiveRoot), { recursive: true });
        await rename(backupArchiveRoot, archiveRoot);
      }
      await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
      cleanupRoots.delete(backupRoot);
    } catch (rollbackError) {
      cleanupRoots.delete(backupRoot);
      const originalMessage = error instanceof Error ? error.message : String(error);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`PAI pack import failed and rollback failed. Original error: ${originalMessage}. Rollback error: ${rollbackMessage}`, {
        cause: rollbackError,
      });
    }
    throw error;
  }
}

/**
 * #105 — public-facing apply function. Returns one
 * `PaiPackImportResult` per derived skill in the pack (≥ 1 always).
 *
 * BREAKING CHANGE: previously returned a single `PaiPackImportResult`.
 * Callers must adapt to the array shape. The migration orchestrator
 * is the primary consumer and handles N-per-pack natively. The
 * standalone `soma import pai-pack` CLI verb iterates over the result
 * array when rendering its summary.
 */
export async function importPaiPack(
  options: PaiPackImportOptions = {},
): Promise<PaiPackImportResult[]> {
  const plan = { ...(await buildPaiPackImportPlan(options)), apply: true };
  return applyInternalPlan(plan, options.overwrite === true);
}

/**
 * Apply a previously-built plan WITHOUT a second
 * `buildPaiPackImportPlan` pass. `excludeSkills` filters the cached
 * internal plan in-memory; the routed-file list is already grouped
 * by `derivedSkill`, so the filter is O(files) with no I/O. The
 * stage + promote pipeline is shared with `importPaiPack`.
 *
 * Collision-filter contract: every excluded slug is dropped from
 * `routedFiles` BEFORE staging — no excluded skill ever touches
 * disk. The pack-level archive surface (renderMode `archive-manifest`,
 * derivedSkill `""`) is unaffected; its `derivedSkills` field is
 * regenerated from the filtered set.
 *
 * Throws `PaiPackAllSkillsExcludedRefusal` if every derived skill is
 * excluded — matches `importPaiPack`'s contract so the migration
 * orchestrator's typed-catch path stays identical.
 *
 * @internal Orchestration plumbing for the migration apply path.
 * Not part of the public SDK surface; do not depend on the export.
 */
export async function importPaiPackFromPlan(
  handle: PaiPackImportPlanHandle,
  options: { excludeSkills?: ReadonlySet<string>; overwrite?: boolean } = {},
): Promise<PaiPackImportResult[]> {
  const data = castHandle(handle);
  const excludeSkills = options.excludeSkills ?? new Set<string>();
  const filtered = filterInternalPlanByExcludes(data.plan, excludeSkills);
  // `overwrite` follows the apply-time option; if the caller omits it,
  // fall back to the original plan options.
  const overwrite = options.overwrite ?? data.options.overwrite === true;
  return applyInternalPlan(filtered, overwrite);
}

/**
 * #105 / Sage r2 #108 — in-memory filter that drops every routed file
 * whose `derivedSkill` is in `excludeSkills`, prunes the `derivedSkills`
 * list, and regenerates the per-skill manifest rows so the apply path
 * sees a coherent plan. Throws `PaiPackAllSkillsExcludedRefusal` when
 * the filter empties the derived-skill set.
 *
 * Archive files (`derivedSkill === ""`) and the pack-level
 * archive-manifest survive — they aren't tied to any derived skill.
 * Per-skill manifest rows (`manifest`, `soma-skill-manifest`) are
 * REGENERATED here because the manifest renderer reads
 * `plan.derivedSkills` to enumerate sibling skills; filtering it
 * without regenerating would point a surviving skill's manifest at a
 * stale list.
 */
function filterInternalPlanByExcludes(
  plan: InternalPaiPackImportPlan,
  excludeSkills: ReadonlySet<string>,
): InternalPaiPackImportPlan {
  if (excludeSkills.size === 0) {
    return { ...plan, apply: true };
  }
  const survivingDerived = plan.derivedSkills.filter((slug) => !excludeSkills.has(slug));
  if (survivingDerived.length === 0) {
    throw new PaiPackAllSkillsExcludedRefusal(Array.from(excludeSkills).sort());
  }
  const survivingSet = new Set(survivingDerived);
  const routedFiles: RoutedPaiPackImportFile[] = plan.routedFiles.filter((file) => {
    if (file.derivedSkill === "") return true; // archive / pack-level
    return survivingSet.has(file.derivedSkill);
  });
  const files = routedFiles.map(({ renderMode: _renderMode, derivedSkill: _derivedSkill, ...rest }) => rest);
  return {
    ...plan,
    apply: true,
    derivedSkills: survivingDerived,
    routedFiles,
    files,
  };
}

/**
 * Shared apply core extracted from `importPaiPack` so the planning-
 * cache path (`importPaiPackFromPlan`) and the single-shot path share
 * one stage + promote + result-mapping pipeline. Sage r2 #108
 * Maintainability — single-source the apply contract.
 */
async function applyInternalPlan(
  plan: InternalPaiPackImportPlan,
  overwrite: boolean,
): Promise<PaiPackImportResult[]> {
  const written: string[] = [];
  const archiveRoot = join(plan.somaHome, "imports", "pai-packs", plan.packSlug);
  const stageRoot = join(plan.somaHome, ".tmp", `pai-pack-${plan.packSlug}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const backupRoot = join(plan.somaHome, ".tmp", `pai-pack-backup-${plan.packSlug}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const cleanupRoots = new Set([stageRoot, backupRoot]);

  try {
    await mkdir(plan.somaHome, { recursive: true });
    await assertParentWithinRealRoot(plan.somaHome, stageRoot);
    for (const slug of plan.derivedSkills) {
      await assertParentWithinRealRoot(plan.somaHome, join(plan.somaHome, "skills", slug));
    }
    await assertParentWithinRealRoot(plan.somaHome, archiveRoot);

    await stagePaiPackFiles(plan, stageRoot);
    await promoteStagedImportWithRollback({
      plan,
      stageRoot,
      backupRoot,
      overwrite,
      cleanupRoots,
    });

    written.push(...plan.files.map((file) => file.target));
  } finally {
    await Promise.allSettled(Array.from(cleanupRoots, (path) => rm(path, { recursive: true, force: true })));
  }

  // Per-skill result split. Each skill carries its own files subset so
  // the migration orchestrator can record N outcome rows.
  const filesBySlug = new Map<string, string[]>();
  for (const slug of plan.derivedSkills) filesBySlug.set(slug, []);
  const skillRoots = new Map(
    plan.derivedSkills.map((slug) => [slug, join(plan.somaHome, "skills", slug)]),
  );
  for (const target of written) {
    let placed = false;
    for (const [slug, root] of skillRoots) {
      if (isWithinPath(root, target)) {
        const files = filesBySlug.get(slug);
        if (files) files.push(target);
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Archive / pack-level file — bucket to the first derived
      // skill via the shared `attachArchiveToFirstSkill` rule.
      const slug = attachArchiveToFirstSkill("", plan.derivedSkills);
      const files = slug ? filesBySlug.get(slug) : undefined;
      if (files) files.push(target);
    }
  }

  return plan.derivedSkills.map((slug) => ({
    paiPackDir: plan.paiPackDir,
    somaHome: plan.somaHome,
    skillName: slug,
    files: filesBySlug.get(slug) ?? [],
    normalization: plan.normalization,
  }));
}
