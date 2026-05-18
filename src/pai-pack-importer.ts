import { access, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { kebabNestedName, routePaiPackSourceFile, type PaiPackRenderMode } from "./pai-pack-routing";
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
 * #97 — typed refusal raised when a pack contains substrate-specific
 * files and `options.includeSubstrateSpecific` is not set. Carries
 * the offending file list so the migration orchestrator can record a
 * structured per-pack outcome instead of string-matching error
 * messages. The standalone `soma import pai-pack` verb still surfaces
 * the same throw — only its `instanceof` discriminator changes.
 */
export class PaiPackSubstrateSpecificRefusal extends Error {
  readonly kind = "substrate-specific" as const;
  readonly files: readonly string[];
  constructor(files: readonly string[]) {
    super(
      `PAI pack import refused substrate-specific file(s) without --include-substrate-specific: ${files.join(", ")}`,
    );
    this.name = "PaiPackSubstrateSpecificRefusal";
    this.files = files;
  }
}

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
 * editor-config files take the normal classification path; non-editor
 * symlinks still abort the pack as `refused-other`. Keep this list
 * narrow — every entry widens the security envelope.
 *
 * Each pattern is anchored at either the pack root or a directory
 * boundary so a stray substring (e.g., `my.cursor.thing/`) does not
 * trigger the skip.
 */
const EDITOR_CONFIG_SYMLINK_PATTERNS: { pattern: RegExp; dir: string }[] = [
  { pattern: /(?:^|\/)\.cursor\//, dir: ".cursor" },
  { pattern: /(?:^|\/)\.vscode\//, dir: ".vscode" },
  { pattern: /(?:^|\/)\.idea\//, dir: ".idea" },
  { pattern: /(?:^|\/)\.fleet\//, dir: ".fleet" },
  { pattern: /(?:^|\/)\.zed\//, dir: ".zed" },
];

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
 *
 * Exported so the migrate orchestrator (and any future reserved-name
 * preflight) can derive the same slug without duplicating the
 * function — Sage #95 Maintainability finding (avoid drift between
 * the importer's reserved check and the orchestrator's reserved
 * check).
 *
 * Two transformations split CamelCase boundaries before lowercasing:
 *   1. `([A-Z]+)([A-Z][a-z])` → `$1-$2`  — splits ALL-CAPS prefix from
 *      a following Capital+lowercase (e.g., `PAIUpgrade` →
 *      `PAI-Upgrade`, `HTMLParser` → `HTML-Parser`).
 *   2. `([a-z0-9])([A-Z])` → `$1-$2`     — standard CamelCase split
 *      (e.g., `ExtractWisdom` → `Extract-Wisdom`).
 *
 * Order matters: rule 1 runs first so it can fire on `PAI` before
 * rule 2 sees `IU` (no lower-upper boundary there). Then lowercasing
 * and final non-alnum-to-hyphen normalization runs.
 */
export function slugifySkillName(value: string): string {
  return value
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

async function buildPaiPackImportPlan(options: PaiPackImportOptions = {}): Promise<InternalPaiPackImportPlan> {
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
  if (RESERVED_SKILL_NAMES.has(packSlug)) {
    // #102 — typed refusal so the migrate orchestrator classifies
    // this as `refused-reserved` even when its outer pre-check is
    // bypassed by `--overwrite-reserved` (the inner set is narrower
    // and structurally enforced; the slug is preserved in the error).
    throw new PaiPackReservedNameRefusal(packSlug);
  }

  // #105 — enumerate every Soma skill this pack will derive. The
  // FLAT top-level surface (pack slug) exists iff `src/SKILL.md` is
  // present in the file list; nested skills are the kebab projection
  // of every `src/<Name>/SKILL.md`.
  const hasFlatEntry = sourceFiles.includes("src/SKILL.md");
  const derivedSkillSet = new Set<string>();
  if (hasFlatEntry) derivedSkillSet.add(packSlug);
  for (const { slug } of nestedIndex) derivedSkillSet.add(slug);

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
  if (hasFlatEntry && nestedIndex.some(({ slug }) => slug === packSlug)) {
    throw new PaiPackNameCollisionRefusal(packSlug, ["src/SKILL.md", `src/${packSlug}/SKILL.md`]);
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

  const secretFiles = sourceFiles.filter(isLikelySecretPath);
  if (secretFiles.length > 0) {
    throw new Error(`PAI pack import refused likely secret file(s): ${secretFiles.join(", ")}`);
  }

  const routes = sourceFiles.map((path) => ({
    path,
    route: routePaiPackSourceFile(path, nestedRawNames),
  }));
  const substrateSpecific = routes.filter(({ route }) => route.classification === "substrate-specific");
  if (substrateSpecific.length > 0 && !options.includeSubstrateSpecific) {
    // #97 — typed refusal so callers (the migrate orchestrator in
    // particular) can classify the failure structurally without
    // string-matching the message. The thrown message text is
    // preserved verbatim for the standalone `soma import pai-pack`
    // surface and existing tests that assert on it.
    throw new PaiPackSubstrateSpecificRefusal(substrateSpecific.map(({ path }) => path));
  }

  const routedFiles: RoutedPaiPackImportFile[] = [];
  for (const { path, route } of routes) {
    // Resolve the destination skill slug for portable routes:
    //   - route.skillName === null → pack-level (FLAT) slug
    //   - route.skillName !== null → nested skill slug
    const destSkill = route.skillName ?? packSlug;
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
  // (to the pack-level surface); we replicate it per nested skill.
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
      // landed it.
      if (hasFlatEntry && slug === packSlug) continue;
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
  const normalization = mergeNormalizationReports([
    reportFromNormalizedFiles(normalizedSkillFiles.values()),
    { actions: normalizedDescription.action ? [normalizedDescription.action] : [], warnings: [] },
    { actions: editorSymlinkSkipActions, warnings: [] },
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
  // archive-bound files (substrate-specific OR every imported pack
  // gets one as part of #105's auditability contract — the archive's
  // `derivedSkills` list is principal-facing).
  routedFiles.push({
    target: join(homes.somaHome, `imports/pai-packs/${packSlug}/soma-pack-archive.json`),
    classification: substrateSpecific.length > 0 ? "substrate-specific" : "portable",
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
  };
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
  // public plan surface.
  const buckets = new Map<string, PaiPackImportFile[]>();
  for (const slug of internal.derivedSkills) buckets.set(slug, []);
  const firstSlug = internal.derivedSkills[0];

  for (const file of internal.routedFiles) {
    const slug = file.derivedSkill || firstSlug;
    if (!slug) continue;
    if (!buckets.has(slug)) buckets.set(slug, []);
    const { renderMode: _r, derivedSkill: _d, ...stripped } = file;
    buckets.get(slug)!.push(stripped);
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
      const finalContent = file.renderMode === "skill"
        ? `${rewriteSkillFrontmatter(
            normalizedContent,
            file.derivedSkill,
            file.derivedSkill === plan.packSlug
              ? plan.description
              : nestedSkillDescription(file.derivedSkill),
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
    description:
      skillSlug === plan.packSlug
        ? plan.description
        : nestedSkillDescription(skillSlug),
    packName: plan.packName,
    entrypoint: skillMd ? skillRelPath(skillMd.target) : "SKILL.md",
    references,
    workflowFiles,
  });
  return `${JSON.stringify(manifest, null, 2)}\n`;
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
      overwrite: options.overwrite === true,
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
  const firstSlug = plan.derivedSkills[0];
  const skillRoots = new Map(
    plan.derivedSkills.map((slug) => [slug, join(plan.somaHome, "skills", slug)]),
  );
  for (const target of written) {
    let placed = false;
    for (const [slug, root] of skillRoots) {
      if (isWithinPath(root, target)) {
        filesBySlug.get(slug)!.push(target);
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Archive / pack-level file — attach to first slug so it doesn't
      // disappear from the result surface.
      if (firstSlug) filesBySlug.get(firstSlug)!.push(target);
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
