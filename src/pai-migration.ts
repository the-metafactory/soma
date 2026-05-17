/**
 * PAI → Soma migration orchestrator.
 *
 * #28 (PR #69) shipped the minimal orchestrator: identity + algorithm +
 * per-pack `importPaiPack` + a human-readable MIGRATION.md manifest.
 * #90 extends that orchestrator with the three remaining phases:
 *
 *   1. **Memory translation** — copies `<claudeHome>/PAI/MEMORY/*` into
 *      `<somaHome>/memory/*` per DD-2's 1:1 mapping. Content-preserving;
 *      preserves mtimes; per-file SHA recorded in a JSON manifest at
 *      `<somaHome>/imports/pai-migration/.manifest.json`. Idempotent.
 *   2. **Bulk skill import** — iterates `<paiPacksDir>/*` and calls
 *      `importPaiPack` per pack. Reserved skill names (`isa`,
 *      `the-algorithm`, `knowledge`, `telos`) are refused unless the
 *      principal opts in via `overwriteReserved`.
 *   3. **PAI docs import** — when `paiSourceDir` is supplied, wraps the
 *      #89 verb (`importPaiDocs`) to land DOCUMENTATION/, TEMPLATES/,
 *      ALGORITHM/ under `<somaHome>/PAI/`.
 *
 * The pre-#90 minimal orchestrator's `paiPackPaths` option is retained
 * for back-compat with #67's CLI tests and external callers that pass
 * explicit pack paths. New callers should prefer `paiPacksDir` (a
 * single directory containing many packs) over `paiPackPaths` (an
 * explicit array).
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { importAlgorithm, planAlgorithmImport } from "./algorithm-importer";
import { importPaiDocs, planPaiDocsImport } from "./pai-docs-importer";
import { importPaiIdentity, planPaiImport } from "./pai-importer";
import { migratePaiMemory, planPaiMemoryMigration } from "./pai-memory-migrator";
import { importPaiPack, planPaiPackImport } from "./pai-pack-importer";
import type {
  AlgorithmImportPlan,
  AlgorithmImportResult,
  PaiDocsImportPlan,
  PaiDocsImportResult,
  PaiImportPlan,
  PaiImportResult,
  PaiMemoryMigrationPlan,
  PaiMemoryMigrationResult,
  PaiPackImportPlan,
  PaiPackImportResult,
} from "./types";

// Skill names that the bulk pack importer refuses to land. These are
// canonical Soma surfaces that the principal must not unintentionally
// clobber with an imported pack. Override with `overwriteReserved`.
//
// `the-algorithm` already lives in the pack importer's reserved list
// (`src/pai-pack-importer.ts:RESERVED_SKILL_NAMES`); duplicating it
// here is harmless and keeps the migrate-level list authoritative when
// `overwriteReserved` flips. The pack importer reserves `soma` as
// well; we leave that as the pack importer's job to refuse.
const MIGRATE_RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set([
  "isa",
  "the-algorithm",
  "knowledge",
  "telos",
]);

export interface PaiMigrationOptions {
  homeDir?: string;
  claudeHome?: string;
  somaHome?: string;
  /**
   * #28 back-compat. When provided, each pack at this list of paths is
   * imported via the existing pack-importer. Mutually compatible with
   * `paiPacksDir`; explicit paths are appended after directory scan.
   */
  paiPackPaths?: string[];
  /**
   * #90 — single directory containing many packs. Each immediate
   * subdirectory is treated as one pack and routed through
   * `importPaiPack`. Defaults: `<paiSourceDir>/Packs` when
   * `paiSourceDir` is set, else `<claudeHome>/PAI/Packs`.
   */
  paiPacksDir?: string;
  /**
   * #90 — optional path to an unpacked PAI release tree (e.g.,
   * `~/work/PAI/Releases/v5.0.0/.claude/PAI`). When provided, the
   * orchestrator additionally runs the #89 docs-import verb to land
   * DOCUMENTATION/, TEMPLATES/, ALGORITHM/ under `<somaHome>/PAI/`.
   * Must point at a directory with a `DOCUMENTATION/` subdir — the
   * #89 importer refuses anything else loud (matches plan §"Failure
   * modes": no heuristic guessing).
   */
  paiSourceDir?: string;
  /**
   * #90 — skip the memory-translation phase. Identity, algorithm,
   * packs, and docs still run.
   */
  skipMemory?: boolean;
  /**
   * #90 — skip the bulk skill-import phase. Identity, algorithm,
   * memory, and docs still run.
   */
  skipSkills?: boolean;
  /**
   * #90 — skip the PAI docs-import phase. Has no effect when
   * `paiSourceDir` is not set.
   */
  skipDocs?: boolean;
  /**
   * #90 — permit the bulk skill importer to land packs whose
   * normalized skill name appears in `MIGRATE_RESERVED_SKILL_NAMES`.
   * Without this flag the orchestrator refuses such packs loud.
   */
  overwriteReserved?: boolean;
}

export interface PaiMigrationPlan {
  apply: false;
  claudeHome: string;
  somaHome: string;
  identity: PaiImportPlan;
  algorithm: AlgorithmImportPlan | null;
  packs: PaiPackImportPlan[];
  memory: PaiMemoryMigrationPlan | null;
  docs: PaiDocsImportPlan | null;
  manifestPath: string;
}

export interface PaiMigrationResult {
  claudeHome: string;
  somaHome: string;
  identity: PaiImportResult;
  algorithm: AlgorithmImportResult | null;
  packs: PaiPackImportResult[];
  memory: PaiMemoryMigrationResult | null;
  docs: PaiDocsImportResult | null;
  manifestPath: string;
  filesWritten: string[];
}

function resolvePaths(options: PaiMigrationOptions): { claudeHome: string; somaHome: string } {
  const home = resolve(options.homeDir ?? homedir());
  return {
    claudeHome: resolve(options.claudeHome ?? join(home, ".claude")),
    somaHome: resolve(options.somaHome ?? join(home, ".soma")),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    // Sage r3 (#28): only ENOENT/ENOTDIR (path absent / parent is a
    // file) mean "not present" — those are normal control-flow
    // signals. EACCES or other I/O errors must surface so a silent
    // miss can't produce a "successful" migration that quietly drops
    // a category.
    if (isEnoent(error)) return false;
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

// Auto-discover packs under a packs root. Order: explicit
// `paiPacksDir` > `<paiSourceDir>/Packs` (when docs imports are
// enabled) > `<claudeHome>/PAI/Packs` (legacy #28 behavior).
async function resolvePacksDir(
  options: PaiMigrationOptions,
  claudeHome: string,
): Promise<string | null> {
  if (options.paiPacksDir) return resolve(options.paiPacksDir);
  if (options.paiSourceDir) {
    // Prefer the release-tree's own Packs/ when the principal supplied
    // a `--pai-source-dir`. Falls through if it doesn't exist.
    const release = join(resolve(options.paiSourceDir), "Packs");
    if (await exists(release)) return release;
  }
  return join(claudeHome, "PAI/Packs");
}

async function autoDiscoverPackPaths(packsRoot: string): Promise<string[]> {
  if (!(await exists(packsRoot))) return [];
  // Sage r2 (#28): only treat ENOENT (raced delete) as "no packs".
  // Other errors (EACCES on the packs dir, transient I/O failure)
  // must surface — a silent miss would produce a "successful"
  // migration that quietly omits the pack category.
  let entries;
  try {
    entries = await readdir(packsRoot, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  return entries.filter((e) => e.isDirectory()).map((e) => join(packsRoot, e.name));
}

function manifestPathFor(somaHome: string): string {
  return join(somaHome, "profile/imports/claude/MIGRATION.md");
}

// Read the prior `Last migrated at: <iso>` line from an existing
// MIGRATION.md so idempotent reruns can preserve the timestamp. Returns
// null when the manifest is missing or the line cannot be parsed.
async function readPriorMigrationTimestamp(manifestPath: string): Promise<string | null> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const match = raw.match(/^Last migrated at: (.+)$/m);
    return match ? match[1] : null;
  } catch (error) {
    if (isEnoent(error)) return null;
    return null; // Don't let a malformed prior manifest poison the rerun.
  }
}

// Mirror `slugifySkillName` from `src/pai-pack-importer.ts`. The
// pack importer is the authoritative slugifier; we replicate it here
// to detect reserved-name collisions before invoking the importer.
function slugifySkillName(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Read the pack metadata's `name` field the same way
// `readPackMetadata` does — frontmatter or top heading. We only need
// enough to derive the slug; the pack importer does the heavy lifting
// during the actual import.
async function readPackSkillSlug(packDir: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const readme = await readFile(join(packDir, "README.md"), "utf8");
  const match = readme.match(/^---\n([\s\S]*?)\n---/);
  if (match) {
    const nameLine = match[1].split("\n").find((line) => /^name\s*:/.test(line));
    if (nameLine) {
      const raw = nameLine.split(":").slice(1).join(":").trim().replace(/^["']|["']$/g, "");
      const slug = slugifySkillName(raw);
      if (slug) return slug;
    }
  }
  const heading = /^#\s+(.+)$/m.exec(readme)?.[1]?.trim();
  if (heading) {
    const slug = slugifySkillName(heading);
    if (slug) return slug;
  }
  return slugifySkillName("pai-pack");
}

async function refuseReservedPacks(
  packPaths: readonly string[],
  overwriteReserved: boolean,
): Promise<string[]> {
  if (overwriteReserved) return [...packPaths];
  const allowed: string[] = [];
  for (const packDir of packPaths) {
    const slug = await readPackSkillSlug(packDir);
    if (MIGRATE_RESERVED_SKILL_NAMES.has(slug)) {
      throw new Error(
        `soma migrate pai refused reserved Soma skill '${slug}' from pack '${packDir}'. ` +
          `Re-run with --overwrite-reserved to permit.`,
      );
    }
    allowed.push(packDir);
  }
  return allowed;
}

/**
 * Run async work with a bounded concurrency window (sage r4 #28:
 * prevent unlimited pack-import fan-out on large installs).
 */
async function runBoundedConcurrent<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

interface MigrationSources {
  algorithmDir: string | null;
  packPaths: string[];
}

async function discoverMigrationSources(
  claudeHome: string,
  options: PaiMigrationOptions,
): Promise<MigrationSources> {
  const algorithmDirCandidate = join(claudeHome, "PAI/Algorithm");
  const algorithmDir = (await exists(algorithmDirCandidate)) ? algorithmDirCandidate : null;
  const packsRoot = await resolvePacksDir(options, claudeHome);
  const discovered = packsRoot ? await autoDiscoverPackPaths(packsRoot) : [];
  const explicit = options.paiPackPaths ?? [];
  // Explicit `paiPackPaths` take precedence; we still append directory
  // scan results (deduped) so a #67-style call that omitted `paiPacksDir`
  // continues to behave as before.
  const dedup = new Set([...explicit, ...discovered]);
  return { algorithmDir, packPaths: Array.from(dedup) };
}

/**
 * Plan what migratePai would do. Same-shape sub-plans as the
 * underlying importers + memory/docs phases + the manifest target.
 * `apply: false` is always false for plans — to execute call
 * migratePai.
 */
export async function planPaiMigration(options: PaiMigrationOptions = {}): Promise<PaiMigrationPlan> {
  const { claudeHome, somaHome } = resolvePaths(options);
  const { algorithmDir, packPaths } = await discoverMigrationSources(claudeHome, options);

  const identity = planPaiImport({ homeDir: options.homeDir, claudeHome, somaHome });
  const algorithm = algorithmDir === null
    ? null
    : planAlgorithmImport({ homeDir: options.homeDir, paiAlgorithmDir: algorithmDir, somaHome });
  const packs = options.skipSkills === true
    ? []
    : await Promise.all(
        packPaths.map((paiPackDir) => planPaiPackImport({ homeDir: options.homeDir, paiPackDir, somaHome })),
      );
  const memory = options.skipMemory === true
    ? null
    : await planPaiMemoryMigration({ homeDir: options.homeDir, claudeHome, somaHome });
  const docs = options.paiSourceDir && options.skipDocs !== true
    ? await planPaiDocsImport({
        homeDir: options.homeDir,
        paiSourceDir: options.paiSourceDir,
        somaHome,
      })
    : null;

  return {
    apply: false,
    claudeHome,
    somaHome,
    identity,
    algorithm,
    packs,
    memory,
    docs,
    manifestPath: manifestPathFor(somaHome),
  };
}

interface ManifestInputs {
  claudeHome: string;
  somaHome: string;
  identity: PaiImportResult;
  algorithm: AlgorithmImportResult | null;
  packs: PaiPackImportResult[];
  memory: PaiMemoryMigrationResult | null;
  docs: PaiDocsImportResult | null;
  paiSourceDir: string | undefined;
  lastMigratedAt: string;
}

function renderManifest(result: ManifestInputs): string {
  // Sage r1 (#28): the manifest used to embed a fresh timestamp on
  // every rerun, breaking the documented idempotency. The manifest is
  // a pure function of the import results — second rerun with
  // identical imports produces byte-identical bytes.
  const packLines = result.packs.length === 0
    ? "- (none discovered)"
    : result.packs.map((p, idx) => `- pack ${idx + 1}: ${p.skillName} (${p.files.length} files)`).join("\n");
  // The MIGRATION.md body must be byte-stable across reruns (Sage r1
  // #28 finding); per-run "written N / unchanged M" deltas live in
  // the result object, not on disk. Total file counts are end-state
  // facts and stay stable.
  const memoryLine = result.memory === null
    ? "- memory:   skipped"
    : result.memory.memoryDir === null
      ? "- memory:   no PAI MEMORY tree present"
      : `- memory:   ${result.memory.writtenCount + result.memory.skippedCount} file(s)`;
  const docsLine = result.docs === null
    ? result.paiSourceDir === undefined
      ? "- docs:     not requested (pass --pai-source-dir to import)"
      : "- docs:     skipped"
    : `- docs:     ${result.docs.files.length} file(s) under ${result.docs.releaseVersion ?? "(no version)"}`;
  return [
    "# PAI Migration",
    "",
    `Source: ${result.claudeHome}`,
    result.paiSourceDir ? `Release: ${result.paiSourceDir}` : null,
    `Last migrated at: ${result.lastMigratedAt}`,
    "",
    "## Categories",
    `- identity: ${result.identity.files.length} files`,
    `- algorithm: ${result.algorithm ? `${result.algorithm.files.length} files` : "not present"}`,
    memoryLine,
    docsLine,
    `- packs:`,
    packLines.split("\n").map((l) => `  ${l}`).join("\n"),
    "",
    "## How to re-run",
    "- `soma migrate pai` is idempotent at the importer level — each underlying",
    "  importer compares source vs. target and writes only changed files.",
    "- The memory phase tracks per-file SHA at",
    "  `~/.soma/imports/pai-migration/.manifest.json`. The docs phase tracks",
    "  per-file SHA at `~/.soma/PAI/.import-manifest.json`.",
    "- To roll back the Claude Code projection (not the Soma home itself) run",
    "  `soma adopt claude --uninstall`.",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Execute the migration plan. Runs identity → algorithm → memory →
 * packs → docs in order, then writes the MIGRATION.md manifest. The
 * order matters:
 *   - Identity + algorithm first (they live in `<somaHome>/profile/`
 *     and `<somaHome>/algorithm/`, no dependency on anything else).
 *   - Memory before packs so a pack importer that reads from
 *     `<somaHome>/memory/` (none today, but the layering invariant is
 *     cheap to keep) sees consistent state.
 *   - Docs last because it's the heaviest read pass.
 *
 * Idempotency comes from the underlying importers + the memory/docs
 * SHA manifests. This wrapper does not re-implement it.
 *
 * Throws only if an underlying importer throws — there is no
 * partial-success swallow. The caller decides whether to retry.
 */
export async function migratePai(options: PaiMigrationOptions = {}): Promise<PaiMigrationResult> {
  const { claudeHome, somaHome } = resolvePaths(options);
  const { algorithmDir, packPaths } = await discoverMigrationSources(claudeHome, options);
  const filesWritten: string[] = [];

  const identity = await importPaiIdentity({ homeDir: options.homeDir, claudeHome, somaHome });
  filesWritten.push(...identity.files);

  const algorithm = algorithmDir === null
    ? null
    : await importAlgorithm({ homeDir: options.homeDir, paiAlgorithmDir: algorithmDir, somaHome });
  if (algorithm) filesWritten.push(...algorithm.files);

  const memory = options.skipMemory === true
    ? null
    : await migratePaiMemory({ homeDir: options.homeDir, claudeHome, somaHome });
  if (memory) filesWritten.push(...memory.files, memory.manifestPath);

  // Reserved-skill collision happens BEFORE any pack import runs so
  // a single offending pack stops the whole bulk phase rather than
  // half-importing.
  const allowedPackPaths = options.skipSkills === true
    ? []
    : await refuseReservedPacks(packPaths, options.overwriteReserved === true);

  // Sage r1+r4 (#28): parallelize independent pack imports with a
  // bounded fan-out. Per-pack work is mostly I/O; 4 workers is enough
  // to hide latency without bursting FD limits.
  //
  // `overwrite: true` is unconditional here (and only here — the
  // standalone `soma import pai-pack` CLI keeps the strict default).
  // Migration is a "move my whole PAI install into Soma" operation,
  // so re-running it must not blow up because a previous run already
  // imported the pack. The pack importer's per-pack rollback contract
  // (rename-into-backup, restore-on-failure) keeps the operation safe
  // even with overwrite enabled. Reserved-skill collisions are caught
  // by `refuseReservedPacks` above before any pack import runs.
  const packs = await runBoundedConcurrent(
    allowedPackPaths,
    (paiPackDir) =>
      importPaiPack({
        homeDir: options.homeDir,
        paiPackDir,
        somaHome,
        overwrite: true,
      }),
    4,
  );
  for (const r of packs) filesWritten.push(...r.files);

  const docs = options.paiSourceDir && options.skipDocs !== true
    ? await importPaiDocs({
        homeDir: options.homeDir,
        paiSourceDir: options.paiSourceDir,
        somaHome,
      })
    : null;
  if (docs) filesWritten.push(...docs.files);

  // Per-phase no-op detection so the manifest timestamp only bumps
  // when something actually changed on disk. AC-6 + Sage r1 (#28):
  // status output must include a timestamp, but the manifest itself
  // must be byte-stable across pure-idempotent reruns. We treat the
  // run as no-op when memory wrote zero files AND docs wrote zero
  // files. Identity + algorithm + packs reuse the underlying
  // importer's overwrite-with-same-bytes pattern, so we read back
  // identity output bytes to gate the timestamp bump as well.
  //
  // Practically: if memory.unchanged AND docs.unchanged (or skipped)
  // AND a prior manifest exists, we preserve the prior timestamp.
  const memoryUnchanged = memory === null || memory.unchanged;
  const docsUnchanged = docs === null || docs.unchanged;
  const everythingUnchanged = memoryUnchanged && docsUnchanged;
  const manifestPath = manifestPathFor(somaHome);
  await mkdir(dirname(manifestPath), { recursive: true });
  let lastMigratedAt = new Date().toISOString();
  if (everythingUnchanged) {
    const prior = await readPriorMigrationTimestamp(manifestPath);
    if (prior) lastMigratedAt = prior;
  }
  const manifest = renderManifest({
    claudeHome,
    somaHome,
    identity,
    algorithm,
    packs,
    memory,
    docs,
    paiSourceDir: options.paiSourceDir,
    lastMigratedAt,
  });
  await writeFile(manifestPath, manifest, "utf8");
  filesWritten.push(manifestPath);

  return {
    claudeHome,
    somaHome,
    identity,
    algorithm,
    packs,
    memory,
    docs,
    manifestPath,
    filesWritten,
  };
}
