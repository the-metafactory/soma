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
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { importAlgorithm, planAlgorithmImport } from "./algorithm-importer";
import { runBoundedConcurrent } from "./internal-concurrency";
import { importPaiDocs, planPaiDocsImport } from "./pai-docs-importer";
import { importPaiIdentity, planPaiImport } from "./pai-importer";
import { migratePaiMemory, planPaiMemoryMigration } from "./pai-memory-migrator";
import {
  importPaiPack,
  planPaiPackImport,
  readPackMetadata,
  slugifySkillName,
} from "./pai-pack-importer";
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

// Read the full bytes of an existing MIGRATION.md so the orchestrator
// can compare body-equivalence (minus the timestamp line) before
// deciding whether to preserve or bump the `Last migrated at:` value.
// Returns null when the manifest is missing or unreadable.
async function readManifestBytes(manifestPath: string): Promise<string | null> {
  try {
    return await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    return null; // Don't let a malformed prior manifest poison the rerun.
  }
}

function extractMigrationTimestamp(manifest: string): string | null {
  const match = manifest.match(/^Last migrated at: (.+)$/m);
  return match ? match[1] : null;
}

// Derive a pack's canonical slug using the importer's own metadata
// reader + slugifier. Single-source — Sage r2 #95 Maintainability
// finding (no second parser that can drift when pack frontmatter
// rules change).
async function readPackSkillSlug(packDir: string): Promise<string> {
  const meta = await readPackMetadata(packDir);
  return slugifySkillName(meta.name);
}

async function refuseReservedPacks(
  packPaths: readonly string[],
  overwriteReserved: boolean,
): Promise<string[]> {
  if (overwriteReserved) return [...packPaths];
  // Sage r1 #95 Performance suggestion: parallelize the README reads
  // so installs with many packs don't pay serial filesystem latency
  // before the import phase even starts. 4-wide concurrency mirrors
  // the actual import phase below; per-call work is one small file
  // read.
  const slugs = await runBoundedConcurrent(packPaths, readPackSkillSlug, 4);
  for (let i = 0; i < packPaths.length; i += 1) {
    if (MIGRATE_RESERVED_SKILL_NAMES.has(slugs[i])) {
      throw new Error(
        `soma migrate pai refused reserved Soma skill '${slugs[i]}' from pack '${packPaths[i]}'. ` +
          `Re-run with --overwrite-reserved to permit.`,
      );
    }
  }
  return [...packPaths];
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
  // Sage r1 #95: content fingerprint over identity + algorithm + per-pack
  // entry SKILL.md bytes. Embedded into the manifest body so any
  // content-level drift in those phases (not just file-count changes)
  // produces a different body and forces a timestamp bump on rerun.
  identityFingerprint: string;
  algorithmFingerprint: string | null;
  packFingerprints: string[];
}

// Compute a stable SHA-256 fingerprint over a set of file paths. Used
// to detect content-level drift in phases whose underlying importers
// don't expose a per-file "wrote vs skipped" signal. We hash the files
// in sorted order so the fingerprint is independent of write order
// and concurrency timing.
async function fingerprintFiles(paths: readonly string[]): Promise<string> {
  if (paths.length === 0) return "empty";
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(path);
    hash.update(":");
    try {
      hash.update(await readFile(path));
    } catch (error) {
      // Missing target = part of the fingerprint (no swallow).
      hash.update(error instanceof Error ? error.message : String(error));
    }
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

// Fingerprint a single pack by hashing its entry SKILL.md only — the
// file the pack importer rewrites with skill identity + normalized
// frontmatter. Sage r2 #95 Performance: full-pack fingerprinting
// doubled the I/O on the apply path; restricting to the entry file
// keeps the timestamp-bump contract intact while avoiding a duplicate
// read pass over every workflow / tool / source-doc copy.
async function fingerprintPackEntry(pack: PaiPackImportResult): Promise<string> {
  const skillRoot = join(pack.somaHome, "skills", pack.skillName);
  const entryPath = join(skillRoot, "SKILL.md");
  return fingerprintFiles([entryPath]);
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
  const packFingerprintLines = result.packs.length === 0
    ? ""
    : "\n" + result.packs
        .map((p, idx) => `  - pack ${idx + 1} fingerprint: ${result.packFingerprints[idx] ?? "empty"}`)
        .join("\n");
  return [
    "# PAI Migration",
    "",
    `Source: ${result.claudeHome}`,
    result.paiSourceDir ? `Release: ${result.paiSourceDir}` : null,
    `Last migrated at: ${result.lastMigratedAt}`,
    "",
    "## Categories",
    `- identity: ${result.identity.files.length} files`,
    `  - identity fingerprint: ${result.identityFingerprint}`,
    `- algorithm: ${result.algorithm ? `${result.algorithm.files.length} files` : "not present"}`,
    result.algorithm ? `  - algorithm fingerprint: ${result.algorithmFingerprint ?? "empty"}` : null,
    memoryLine,
    docsLine,
    `- packs:`,
    packLines.split("\n").map((l) => `  ${l}`).join("\n") + packFingerprintLines,
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
  // Sage r2 #95 important: `memory.files` lists every in-scope target
  // (both written and idempotency-skipped). `filesWritten` is the
  // per-run "things touched on disk this invocation" log; pushing
  // every memory target over-reported writes after idempotent reruns.
  // We push only the per-phase write count's worth — see
  // `memory.result.writtenTargets` for the canonical list. The
  // result object's writtenCount/skippedCount remains authoritative;
  // `filesWritten`'s length should match actual writes so a fully
  // idempotent rerun reports `Total files written: 1` (manifest only).
  if (memory) {
    if (memory.writtenTargets.length > 0) {
      filesWritten.push(...memory.writtenTargets);
    }
    filesWritten.push(memory.manifestPath);
  }

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

  // Timestamp / idempotency gate (Sage r1 #95 important):
  //
  // The previous gate only considered `memory.unchanged &&
  // docs.unchanged`, which incorrectly preserved the prior timestamp
  // when identity / algorithm / packs DID write bytes. The fix is to
  // make the gate manifest-content-equivalent rather than
  // phase-flag-based:
  //
  //   1. Compute content fingerprints over identity / algorithm /
  //      per-pack entry-SKILL.md bytes so the manifest body reflects
  //      content-level changes (not just file-count changes) in
  //      phases whose underlying importers don't expose a per-file
  //      "wrote vs skipped" signal.
  //   2. Render the manifest body with a sentinel timestamp.
  //   3. Read the prior manifest (if any), substitute the same
  //      sentinel for its timestamp line.
  //   4. If the two bodies are byte-equal, the migration is fully
  //      idempotent — reuse the prior timestamp.
  //   5. Otherwise, write the new manifest with `new Date()`.
  //
  // This covers all five phases by construction: any phase that
  // changed counts, names, file lists, OR file content will produce
  // a different body and force a timestamp bump.
  // Sage r2 #95 Performance: pack fingerprints used to hash every
  // imported pack file (workflows, tools, source-doc copies) which
  // doubled the I/O on the apply path. The entry `SKILL.md` is the
  // only file the pack importer rewrites (frontmatter normalization
  // + skill identity), and it's where content drift between pack
  // versions actually shows up; fingerprinting just that file is
  // sufficient for the timestamp-bump contract and avoids the
  // duplicate-read scaling pitfall.
  const identityFingerprint = await fingerprintFiles(identity.files);
  const algorithmFingerprint = algorithm ? await fingerprintFiles(algorithm.files) : null;
  const packFingerprints = await Promise.all(packs.map((p) => fingerprintPackEntry(p)));
  const manifestPath = manifestPathFor(somaHome);
  await mkdir(dirname(manifestPath), { recursive: true });
  const sentinelTs = "__PAI_MIGRATION_TS_SENTINEL__";
  const newBodyWithSentinel = renderManifest({
    claudeHome,
    somaHome,
    identity,
    algorithm,
    packs,
    memory,
    docs,
    paiSourceDir: options.paiSourceDir,
    lastMigratedAt: sentinelTs,
    identityFingerprint,
    algorithmFingerprint,
    packFingerprints,
  });
  const priorBytes = await readManifestBytes(manifestPath);
  const priorWithSentinel = priorBytes === null
    ? null
    : priorBytes.replace(/^Last migrated at: .+$/m, `Last migrated at: ${sentinelTs}`);
  const priorTs = priorBytes === null ? null : extractMigrationTimestamp(priorBytes);
  const lastMigratedAt =
    priorWithSentinel !== null && priorWithSentinel === newBodyWithSentinel && priorTs !== null
      ? priorTs
      : new Date().toISOString();
  const manifest = newBodyWithSentinel.replace(sentinelTs, lastMigratedAt);
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
