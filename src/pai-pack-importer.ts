import { access, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { routePaiPackSourceFile, type PaiPackRenderMode } from "./pai-pack-routing";
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
  PaiPackNormalizationReport,
  PaiPackSourceImportFile,
  SomaSkillManifest,
} from "./types";

interface PackMetadata {
  name: string;
  description: string;
}

const RESERVED_SKILL_NAMES = new Set(["soma", "the-algorithm"]);
const REQUIRED_PACK_FILES = ["README.md", "INSTALL.md", "VERIFY.md", "src/SKILL.md"];
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
  | (PaiPackSourceImportFile & { renderMode: Extract<PaiPackRenderMode, "copy" | "skill" | "skill-body"> })
  | (PaiPackGeneratedImportFile & {
      renderMode: Extract<PaiPackRenderMode, "manifest" | "archive-manifest"> | "soma-skill-manifest";
    });

interface InternalPaiPackImportPlan extends PaiPackImportPlan {
  routedFiles: RoutedPaiPackImportFile[];
  normalization: PaiPackNormalizationReport;
  normalizedSkillFiles: Map<string, NormalizedSkillFile>;
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
 */
export function slugifySkillName(value: string): string {
  return value
    .trim()
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

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const realRoot = await realpath(root);

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name.includes("\\")) {
        throw new Error(`PAI pack import refused ambiguous path separator: ${relative(root, fullPath).split(sep).join("/")}`);
      }

      if (entry.isSymbolicLink()) {
        throw new Error(`PAI pack import refused symlink path: ${relative(root, fullPath).split(sep).join("/")}`);
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
  return files.sort();
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

function assertRequiredPackFiles(sourceFiles: string[]): void {
  const sourceFileSet = new Set(sourceFiles);
  const missing = REQUIRED_PACK_FILES.filter((path) => !sourceFileSet.has(path));
  if (missing.length > 0) {
    throw new Error(`PAI pack import requires V0 pack file(s): ${missing.join(", ")}`);
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

function renderManifest(plan: PaiPackImportPlan): string {
  const skillRoot = join(plan.somaHome, "skills", plan.skillName);
  const skillFiles = plan.files.filter((file) => isWithinPath(skillRoot, file.target));
  return renderManifestForRoot(plan, skillRoot, skillFiles);
}

function renderArchiveManifest(plan: PaiPackImportPlan): string {
  const archiveRoot = join(plan.somaHome, "imports", "pai-packs", plan.skillName);
  const archiveFiles = plan.files.filter((file) => isWithinPath(archiveRoot, file.target) && file.origin === "source");
  return renderManifestForRoot(plan, archiveRoot, archiveFiles);
}

function renderManifestForRoot(plan: PaiPackImportPlan, root: string, files: PaiPackImportFile[]): string {
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

async function buildPaiPackImportPlan(options: PaiPackImportOptions = {}): Promise<InternalPaiPackImportPlan> {
  const homes = resolvePackHomes(options);
  const sourceFiles = await collectFiles(homes.paiPackDir);
  assertSafePackPaths(sourceFiles);
  assertRequiredPackFiles(sourceFiles);

  const metadata = await readPackMetadata(homes.paiPackDir);
  const skillName = options.skillName ? slugifySkillName(options.skillName) : slugifySkillName(metadata.name);
  if (!skillName) {
    throw new Error("soma import pai-pack requires a non-empty skill name after normalization.");
  }
  if (!NORMALIZED_SKILL_NAME_PATTERN.test(skillName)) {
    throw new Error(`soma import pai-pack produced invalid normalized skill name '${skillName}'.`);
  }
  if (RESERVED_SKILL_NAMES.has(skillName)) {
    // #102 — typed refusal so the migrate orchestrator classifies
    // this as `refused-reserved` even when its outer pre-check is
    // bypassed by `--overwrite-reserved` (the inner set is narrower
    // and structurally enforced; the slug is preserved in the error).
    // The standalone `soma import pai-pack` verb still surfaces the
    // same human-readable message via `Error.message`.
    throw new PaiPackReservedNameRefusal(skillName);
  }
  if (!options.overwrite) {
    await access(join(homes.somaHome, "skills", skillName))
      .then(() => {
        throw new Error(`Soma skill '${skillName}' already exists. Re-run with --overwrite to replace it.`);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      });
    await access(join(homes.somaHome, "imports", "pai-packs", skillName))
      .then(() => {
        throw new Error(`Soma PAI pack archive '${skillName}' already exists. Re-run with --overwrite to replace it.`);
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

  const routes = sourceFiles.map((path) => ({ path, route: routePaiPackSourceFile(path) }));
  const substrateSpecific = routes.filter(({ route }) => route.classification === "substrate-specific");
  if (substrateSpecific.length > 0 && !options.includeSubstrateSpecific) {
    // #97 — typed refusal so callers (the migrate orchestrator in
    // particular) can classify the failure structurally without
    // string-matching the message. The thrown message text is
    // preserved verbatim for the standalone `soma import pai-pack`
    // surface and existing tests that assert on it.
    throw new PaiPackSubstrateSpecificRefusal(substrateSpecific.map(({ path }) => path));
  }

  const routedFiles: RoutedPaiPackImportFile[] = routes.map(({ path, route }) => ({
    source: join(homes.paiPackDir, path),
    target: join(homes.somaHome, route.root === "skill" ? "skills" : "imports/pai-packs", skillName, route.relativePath),
    classification: route.classification,
    renderMode: route.renderMode,
    origin: "source",
  }));

  // AC-4 — preserve every normalized file's original under
  // imports/pai-packs/<skill>/source/<original-path> so the un-normalized
  // PAI source remains auditable. Copy mode; never normalized.
  // Both "skill" (entry SKILL.md) and "skill-body" (Workflows/Tools .md)
  // get archived — round-3 split introduced skill-body and the archive
  // loop must follow.
  for (const { path, route } of routes) {
    if (route.renderMode === "skill" || route.renderMode === "skill-body") {
      routedFiles.push({
        source: join(homes.paiPackDir, path),
        target: join(homes.somaHome, "imports", "pai-packs", skillName, "source", path),
        classification: "source-doc",
        renderMode: "copy",
        origin: "source",
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
  const normalization = mergeNormalizationReports([
    reportFromNormalizedFiles(normalizedSkillFiles.values()),
    { actions: normalizedDescription.action ? [normalizedDescription.action] : [], warnings: [] },
  ]);

  routedFiles.push({
    target: join(homes.somaHome, `skills/${skillName}/soma-pack.json`),
    classification: "portable",
    renderMode: "manifest",
    origin: "generated",
    generator: "pai-pack-importer",
  });
  // Always emit a runtime skill manifest (soma-skill.json) alongside the
  // pack provenance manifest.
  routedFiles.push({
    target: join(homes.somaHome, `skills/${skillName}/soma-skill.json`),
    classification: "portable",
    renderMode: "soma-skill-manifest",
    origin: "generated",
    generator: "pai-pack-importer",
  });
  if (substrateSpecific.length > 0) {
    routedFiles.push({
      target: join(homes.somaHome, `imports/pai-packs/${skillName}/soma-pack-archive.json`),
      classification: "substrate-specific",
      renderMode: "archive-manifest",
      origin: "generated",
      generator: "pai-pack-importer",
    });
  }

  const escapedTargets = routedFiles.filter((file) => !isWithinPath(homes.somaHome, file.target));
  if (escapedTargets.length > 0) {
    throw new Error(`PAI pack import refused target path outside Soma home: ${escapedTargets.map((file) => file.target).join(", ")}`);
  }
  assertUniqueTargets(routedFiles);

  const files = routedFiles.map(({ renderMode: _renderMode, ...file }) => file);

  return {
    apply: false,
    paiPackDir: homes.paiPackDir,
    somaHome: homes.somaHome,
    skillName,
    packName: metadata.name,
    description: normalizedDescription.description,
    files,
    routedFiles,
    normalization,
    normalizedSkillFiles,
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
  const skillFiles: PaiPackSourceImportFile[] = [];
  for (const file of routedFiles) {
    if (file.renderMode === "skill" || file.renderMode === "skill-body") {
      skillFiles.push(file);
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

export async function planPaiPackImport(options: PaiPackImportOptions = {}): Promise<PaiPackImportPlan> {
  const { routedFiles: _routedFiles, ...plan } = await buildPaiPackImportPlan(options);
  return plan;
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
      await writeFile(stagedTarget, renderManifest(plan), "utf8");
    } else if (file.renderMode === "archive-manifest") {
      await writeFile(stagedTarget, renderArchiveManifest(plan), "utf8");
    } else if (file.renderMode === "soma-skill-manifest") {
      await writeFile(stagedTarget, renderSomaSkillManifest(plan), "utf8");
    } else if (file.renderMode === "skill" || file.renderMode === "skill-body") {
      // Reuse the cached normalization computed during plan construction
      // so we don't re-read or re-normalize the same source per Sage's
      // double-pass finding. Fallback: re-read if cache miss.
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
        ? `${rewriteSkillFrontmatter(normalizedContent, plan.skillName, plan.description).trimEnd()}\n`
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

function renderSomaSkillManifest(plan: InternalPaiPackImportPlan): string {
  const skillRoot = join(plan.somaHome, "skills", plan.skillName);
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
    skillName: plan.skillName,
    description: plan.description,
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
  skillRoot: string;
  sourceArchiveRoot: string;
  overwrite: boolean;
  cleanupRoots: Set<string>;
}

async function promoteStagedImportWithRollback(context: PromotionContext): Promise<void> {
  const { plan, stageRoot, backupRoot, skillRoot, sourceArchiveRoot, overwrite, cleanupRoots } = context;
  const backupSkillRoot = join(backupRoot, "skills", plan.skillName);
  const backupArchiveRoot = join(backupRoot, "imports", "pai-packs", plan.skillName);
  const hadSkillRoot = await pathExists(skillRoot);
  const hadArchiveRoot = await pathExists(sourceArchiveRoot);

  const stagedSkillRoot = join(stageRoot, "skills", plan.skillName);
  const stagedArchiveRoot = join(stageRoot, "imports", "pai-packs", plan.skillName);
  let promotedSkillRoot = false;
  let promotedArchiveRoot = false;

  try {
    if (overwrite) {
      if (hadSkillRoot) {
        await mkdir(dirname(backupSkillRoot), { recursive: true });
        await rename(skillRoot, backupSkillRoot);
      }
      if (hadArchiveRoot) {
        await mkdir(dirname(backupArchiveRoot), { recursive: true });
        await rename(sourceArchiveRoot, backupArchiveRoot);
      }
    }

    if (await pathExists(stagedSkillRoot)) {
      await mkdir(dirname(skillRoot), { recursive: true });
      await rename(stagedSkillRoot, skillRoot);
      promotedSkillRoot = true;
    }

    if (await pathExists(stagedArchiveRoot)) {
      await mkdir(dirname(sourceArchiveRoot), { recursive: true });
      await rename(stagedArchiveRoot, sourceArchiveRoot);
      promotedArchiveRoot = true;
    }
  } catch (error) {
    try {
      if (promotedSkillRoot) {
        await rm(skillRoot, { recursive: true, force: true });
      }
      if (promotedArchiveRoot) {
        await rm(sourceArchiveRoot, { recursive: true, force: true });
      }
      if (hadSkillRoot && (await pathExists(backupSkillRoot))) {
        await mkdir(dirname(skillRoot), { recursive: true });
        await rename(backupSkillRoot, skillRoot);
      }
      if (hadArchiveRoot && (await pathExists(backupArchiveRoot))) {
        await mkdir(dirname(sourceArchiveRoot), { recursive: true });
        await rename(backupArchiveRoot, sourceArchiveRoot);
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

export async function importPaiPack(options: PaiPackImportOptions = {}): Promise<PaiPackImportResult> {
  const plan = { ...(await buildPaiPackImportPlan(options)), apply: true };
  const written: string[] = [];
  const skillRoot = join(plan.somaHome, "skills", plan.skillName);
  const sourceArchiveRoot = join(plan.somaHome, "imports", "pai-packs", plan.skillName);
  const stageRoot = join(plan.somaHome, ".tmp", `pai-pack-${plan.skillName}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const backupRoot = join(plan.somaHome, ".tmp", `pai-pack-backup-${plan.skillName}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const cleanupRoots = new Set([stageRoot, backupRoot]);

  try {
    await mkdir(plan.somaHome, { recursive: true });
    await assertParentWithinRealRoot(plan.somaHome, stageRoot);
    await assertParentWithinRealRoot(plan.somaHome, skillRoot);
    await assertParentWithinRealRoot(plan.somaHome, sourceArchiveRoot);

    await stagePaiPackFiles(plan, stageRoot);
    await promoteStagedImportWithRollback({
      plan,
      stageRoot,
      backupRoot,
      skillRoot,
      sourceArchiveRoot,
      overwrite: options.overwrite === true,
      cleanupRoots,
    });

    written.push(...plan.files.map((file) => file.target));
  } finally {
    await Promise.allSettled(Array.from(cleanupRoots, (path) => rm(path, { recursive: true, force: true })));
  }

  return {
    paiPackDir: plan.paiPackDir,
    somaHome: plan.somaHome,
    skillName: plan.skillName,
    files: written,
    normalization: plan.normalization,
  };
}
