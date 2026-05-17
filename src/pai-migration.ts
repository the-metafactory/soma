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
import { basename, dirname, join, resolve } from "node:path";
import { importAlgorithm, planAlgorithmImport } from "./algorithm-importer";
import { runBoundedConcurrent } from "./internal-concurrency";
import { importPaiDocs, planPaiDocsImport } from "./pai-docs-importer";
import { importPaiIdentity, planPaiImport } from "./pai-importer";
import { migratePaiMemory, planPaiMemoryMigration } from "./pai-memory-migrator";
import {
  importPaiPack,
  PaiPackSubstrateSpecificRefusal,
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
  PaiPackOutcome,
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
   *
   * #97 — refusal is now per-pack and recorded in `packOutcomes`
   * instead of aborting the whole migration. Other packs proceed.
   */
  overwriteReserved?: boolean;
  /**
   * #97 — pass-through to `importPaiPack`'s `includeSubstrateSpecific`
   * option. When set, packs that contain substrate-specific files
   * (anything under `src/` that isn't `src/SKILL.md`, `src/Workflows/`,
   * `src/Tools/`, or `src/{Dashboard,Report}Template/`) land in their
   * skill home; archived copies live under
   * `<somaHome>/imports/pai-packs/<skill>/source/`. Without this flag
   * such packs are SKIPPED (not aborted) and recorded in
   * `packOutcomes` as `refused-substrate-specific`.
   */
  includeSubstrateSpecific?: boolean;
  /**
   * #98 — single root pointing at a canonical PAI repo checkout. The
   * orchestrator derives both `paiSourceDir` (→ `<root>/Releases/<latest-semver>/.claude/PAI`)
   * and `paiPacksDir` (→ `<root>/Packs`) from it, BEFORE the planning
   * or apply phases run. Explicit `paiSourceDir` / `paiPacksDir` in
   * the same options object always win — derivation only fills the
   * unset slots. Refusal is loud (thrown Error) when:
   *   - `<root>` itself is missing.
   *   - `<root>/Releases/` is missing (and `paiSourceDir` is unset).
   *   - `<root>/Releases/` contains zero semver-named (`v?\d+\.\d+\.\d+`)
   *     directories.
   *   - `<root>/Packs/` is missing (and `paiPacksDir` is unset).
   *
   * Semver sort is real, not lexical — `v10.0.0 > v2.0.0`. Bare
   * `1.2.3` and `v1.2.3` are accepted equivalently. Anything that
   * isn't a parseable 3-segment semver (e.g. `Pi`, `v2.3`, `latest`)
   * is filtered out before the highest is picked.
   */
  paiRepo?: string;
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
  /**
   * Successfully imported packs only. Refused packs do NOT appear
   * here — they live in `packOutcomes` instead. Existing tests +
   * downstream consumers that count "packs imported" stay correct
   * by reading this list.
   */
  packs: PaiPackImportResult[];
  /**
   * #97 — per-pack outcome record for the bulk-skill-import phase.
   * One entry per pack the orchestrator attempted (including those
   * refused for substrate-specific files, reserved-name collisions,
   * or genuine errors). Order matches the discovery order so the
   * principal-facing summary table is stable across reruns. The CLI
   * exit-code policy is: zero unless any outcome is `refused-other`.
   */
  packOutcomes: PaiPackOutcome[];
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

// #98 — semver derivation for --pai-repo.
//
// PAI's canonical release layout is `<root>/Releases/v<major>.<minor>.<patch>/.claude/PAI`.
// Sibling directories under `Releases/` may include non-semver names
// (e.g. `Pi`, `README.md`, `v2.3`) — those are filtered out before
// picking the highest version. We accept both bare `1.2.3` and the
// `v` prefix because the real PAI repo on this machine mixes them.
//
// Sort is REAL semver, not lexical: `v10.0.0 > v2.0.0`. The previous
// would-be lexical sort would happily report `v2.5.0` as latest when
// `v10.0.0` exists.
interface ParsedSemver {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

function parseSemverDirName(name: string): ParsedSemver | null {
  // Accept `1.2.3` or `v1.2.3`. Reject `v1.2`, `v1`, `latest`,
  // `main`, `1.2.3-pre` (no pre-release support per issue scope).
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (match === null) return null;
  return {
    raw: name,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

// Pick the highest semver-named directory under `releasesDir`. Returns
// the entry name (e.g. `v5.0.0`) — the caller composes the full path.
// Throws if no parseable semver dirs are present (refuse-loud per AC-3).
async function pickLatestSemverDir(releasesDir: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(releasesDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error(
        `--pai-repo derivation: ${releasesDir} does not exist. Expected a directory of semver-named release subdirectories.`,
      );
    }
    throw error;
  }
  const semverDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => parseSemverDirName(e.name))
    .filter((parsed): parsed is ParsedSemver => parsed !== null);
  if (semverDirs.length === 0) {
    const sample = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .slice(0, 5);
    throw new Error(
      `--pai-repo derivation: ${releasesDir} contains no semver-named directories ` +
        `(expected names like \`v1.2.3\` or \`1.2.3\`). ` +
        `${sample.length === 0 ? "Releases/ is empty." : `Saw: ${sample.join(", ")}.`} ` +
        `Pass --pai-source-dir explicitly to override.`,
    );
  }
  semverDirs.sort(compareSemver);
  return semverDirs[semverDirs.length - 1].raw;
}

/**
 * Apply --pai-repo derivation. Returns a NEW options object with
 * `paiSourceDir` and `paiPacksDir` filled in from `paiRepo` when they
 * are not already explicitly set. Mutates nothing — the caller passes
 * the returned options forward.
 *
 * Refuse-loud contract:
 *   - `<root>` must exist as a directory.
 *   - If `paiSourceDir` is NOT explicit: `<root>/Releases/<latest-semver>/.claude/PAI`
 *     must resolve; missing/empty/non-semver Releases throws.
 *   - If `paiPacksDir` is NOT explicit: `<root>/Packs` must exist.
 *
 * No-op when `paiRepo` is unset. The result type's `paiRepo` field is
 * stripped to make the derivation invisible to downstream phases.
 */
async function applyPaiRepoDerivation(
  options: PaiMigrationOptions,
): Promise<PaiMigrationOptions> {
  if (!options.paiRepo) return options;
  const root = resolve(options.paiRepo);
  if (!(await exists(root))) {
    throw new Error(
      `--pai-repo: ${root} does not exist. Expected a PAI repo root with Releases/ and Packs/ subdirectories.`,
    );
  }
  const derived: PaiMigrationOptions = { ...options };
  // Source-dir derivation is only triggered when the explicit flag
  // isn't set. Same for packs-dir below — explicit always wins per
  // AC-5.
  if (!derived.paiSourceDir) {
    const releasesDir = join(root, "Releases");
    if (!(await exists(releasesDir))) {
      throw new Error(
        `--pai-repo: ${releasesDir} does not exist. Either supply --pai-source-dir explicitly or fix the repo layout.`,
      );
    }
    const latestName = await pickLatestSemverDir(releasesDir);
    derived.paiSourceDir = join(releasesDir, latestName, ".claude/PAI");
  }
  if (!derived.paiPacksDir) {
    // Sage r1 #100 important: short-circuit Packs derivation when
    // `--skip-skills` is set. Otherwise the documented recovery path
    // ("skip-skills also short-circuits pack discovery, so a
    // malformed Packs/ dir won't throw") is wrong — derivation
    // refused before `discoverMigrationSources` got a chance to
    // honor skipSkills. Mirrors that downstream skip exactly: when
    // the skill phase is explicitly off, Packs/ existence is no
    // longer a precondition.
    if (derived.skipSkills !== true) {
      const packsDir = join(root, "Packs");
      if (!(await exists(packsDir))) {
        throw new Error(
          `--pai-repo: ${packsDir} does not exist. Either supply --pai-packs-dir explicitly or fix the repo layout.`,
        );
      }
      derived.paiPacksDir = packsDir;
    }
  }
  return derived;
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

/**
 * #97 — bulk-pack-import strategy. For each pack:
 *
 *   1. Try to read the pack's normalized skill slug. If that itself
 *      fails (malformed README, missing file), the pack is
 *      `refused-other`.
 *   2. If the slug is in the migration reserved-name set and
 *      `overwriteReserved` is false, record `refused-reserved` and
 *      skip the import call.
 *   3. Otherwise run `importPaiPack`. Catch
 *      `PaiPackSubstrateSpecificRefusal` → `refused-substrate-specific`.
 *      Any other throw → `refused-other`. Success → `imported`.
 *
 * Each pack is processed independently; the bulk phase never aborts
 * the whole migration on a per-pack failure. The orchestrator
 * collects per-pack outcomes for the manifest + CLI exit-code policy.
 *
 * Concurrency model: per-pack pipeline must classify each error to
 * the right outcome bucket; that's awkward to layer on top of
 * `runBoundedConcurrent`'s "first error wins, abort the rest"
 * contract, so the bulk phase runs serially. Per-pack work is a few
 * small file reads + a directory copy; serial latency on a typical
 * `~/work/PAI/Packs` install (≤30 packs) is well under one second.
 * If that ever becomes a bottleneck the per-pack pipeline can be
 * promoted to a `Promise.all` with per-task try/catch.
 */
interface BulkImportInputs {
  homeDir: string | undefined;
  somaHome: string;
  packPaths: readonly string[];
  overwriteReserved: boolean;
  includeSubstrateSpecific: boolean;
}

interface BulkImportResult {
  packs: PaiPackImportResult[];
  outcomes: PaiPackOutcome[];
}

async function importPacksWithOutcomes(
  inputs: BulkImportInputs,
): Promise<BulkImportResult> {
  // Sage r2 #99 Performance: per-pack work is mostly I/O (small file
  // reads + a directory copy); bounded concurrency mirrors the
  // pre-#97 4-wide fan-out and the planner / fingerprint passes.
  // `importOnePackWithOutcome` swallows its own per-pack errors into
  // `outcome.outcome === "refused-other"`, so the helper is
  // guaranteed to settle — `runBoundedConcurrent`'s "first error
  // wins" abort contract never fires for legitimate pack failures.
  const results = await runBoundedConcurrent(
    [...inputs.packPaths],
    (paiPackDir) => importOnePackWithOutcome(inputs, paiPackDir),
    4,
  );

  const packs: PaiPackImportResult[] = [];
  const outcomes: PaiPackOutcome[] = [];
  for (const { pack, outcome } of results) {
    if (pack) packs.push(pack);
    outcomes.push(outcome);
  }

  return { packs, outcomes };
}

/**
 * Sage r1 #99 Maintainability finding — extracted per-pack pipeline so
 * each step (metadata read / reserved check / import / error
 * classification) is locally legible and adding a new refusal kind
 * touches one function instead of the whole orchestration loop.
 *
 * Returns `{ pack }` only when the pack was successfully imported
 * (always paired with `outcome.outcome === "imported"`). Otherwise
 * returns just the outcome with the appropriate `refused-*` kind.
 */
async function importOnePackWithOutcome(
  inputs: BulkImportInputs,
  paiPackDir: string,
): Promise<{ pack?: PaiPackImportResult; outcome: PaiPackOutcome }> {
  let slug: string;
  try {
    slug = await readPackSkillSlug(paiPackDir);
  } catch (error) {
    // Couldn't even read the pack's metadata — surface the error
    // verbatim; the principal needs the original reason in the
    // summary table. No `skillName` because metadata read failed.
    return {
      outcome: { paiPackDir, outcome: "refused-other", reason: errorMessage(error) },
    };
  }

  if (!inputs.overwriteReserved && MIGRATE_RESERVED_SKILL_NAMES.has(slug)) {
    return {
      outcome: {
        paiPackDir,
        outcome: "refused-reserved",
        skillName: slug,
        reason: `reserved Soma skill '${slug}' — re-run with --overwrite-reserved to permit.`,
      },
    };
  }

  try {
    // `overwrite: true` mirrors the pre-#97 behavior — migration is
    // a "move my whole PAI install into Soma" operation and must not
    // blow up because a previous run already imported the pack. The
    // pack importer's per-pack rollback contract still protects
    // on-disk safety.
    const result = await importPaiPack({
      homeDir: inputs.homeDir,
      paiPackDir,
      somaHome: inputs.somaHome,
      overwrite: true,
      includeSubstrateSpecific: inputs.includeSubstrateSpecific,
    });
    return {
      pack: result,
      outcome: { paiPackDir, outcome: "imported", skillName: result.skillName },
    };
  } catch (error) {
    if (error instanceof PaiPackSubstrateSpecificRefusal) {
      return {
        outcome: {
          paiPackDir,
          outcome: "refused-substrate-specific",
          skillName: slug,
          reason: `substrate-specific file(s): ${error.files.join(", ")}`,
        },
      };
    }
    return {
      outcome: {
        paiPackDir,
        outcome: "refused-other",
        skillName: slug,
        reason: errorMessage(error),
      },
    };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Sage r1 #99 Maintainability finding — single-source the per-pack
 * outcome table rendering so the CLI summary and `MIGRATION.md` body
 * can't drift when a new outcome kind or label scheme is introduced.
 * Sorted-by-`paiPackDir` matches the existing byte-stability contract
 * for the manifest body.
 *
 * `lineIndent` controls leading whitespace (the manifest body uses
 * two-space indent under its section header; the CLI summary uses
 * the same for visual parity).
 *
 * `labelKind` controls the fallback when a pack has no resolved
 * skill name yet: `"basename"` for the manifest (compact, stable),
 * `"path"` for the CLI summary (the principal sees full paths in
 * other lines so this matches the surrounding context).
 */
export function formatPackOutcomeLines(
  outcomes: readonly PaiPackOutcome[],
  options: { lineIndent?: string; labelKind?: "basename" | "path" } = {},
): string[] {
  const indent = options.lineIndent ?? "  ";
  const labelKind = options.labelKind ?? "basename";
  if (outcomes.length === 0) return [`${indent}(no packs attempted)`];
  const sorted = [...outcomes].sort((a, b) => a.paiPackDir.localeCompare(b.paiPackDir));
  return sorted.map((o) => {
    const fallback = labelKind === "basename" ? basename(o.paiPackDir) : o.paiPackDir;
    const label = o.skillName ?? fallback;
    const reasonSuffix = o.reason ? ` — ${o.reason}` : "";
    return `${indent}- ${label}: ${o.outcome}${reasonSuffix}`;
  });
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
  // Sage r3 #95 important: pack discovery must not run when the skill
  // phase is explicitly skipped. Otherwise a bad/unreadable
  // `paiPacksDir` throws even though `--skip-skills` was set.
  if (options.skipSkills === true) {
    return { algorithmDir, packPaths: [] };
  }
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
  // #98 — derive paiSourceDir + paiPacksDir from --pai-repo before any
  // phase runs. Explicit flags win; missing/empty/non-semver Releases
  // and missing Packs both refuse loud here (per AC-3/AC-4) so the
  // failure surfaces at the orchestrator entry point rather than as a
  // cryptic downstream error in one of the phase importers.
  const derived = await applyPaiRepoDerivation(options);
  const { claudeHome, somaHome } = resolvePaths(derived);
  const { algorithmDir, packPaths } = await discoverMigrationSources(claudeHome, derived);
  options = derived;

  const identity = planPaiImport({ homeDir: options.homeDir, claudeHome, somaHome });
  const algorithm = algorithmDir === null
    ? null
    : planAlgorithmImport({ homeDir: options.homeDir, paiAlgorithmDir: algorithmDir, somaHome });
  const packs = options.skipSkills === true
    ? []
    // Sage r5 #95 Performance: bound the per-pack plan reads to 4
    // workers (matches the apply path's import fan-out). The previous
    // Promise.all opened one async pack-plan per discovered pack
    // regardless of count.
    : await runBoundedConcurrent(
        packPaths,
        (paiPackDir) => planPaiPackImport({ homeDir: options.homeDir, paiPackDir, somaHome }),
        4,
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
  /**
   * #97 — per-pack outcome list. Embedded into the manifest body so
   * `--status` can report refused outcomes per AC-3 and so the body
   * fingerprint changes when an outcome flips between reruns. Sorted
   * by `paiPackDir` before render to keep the body byte-stable across
   * reruns (matches the `runBoundedConcurrent` discovery order
   * `Array.from(Set)` returned previously).
   */
  packOutcomes: PaiPackOutcome[];
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
  // Sage r3 #99 CodeQuality (important) — defensive map lookup. The
  // arrays are currently aligned by construction (`packFingerprints`
  // is computed from `inputs.packs`, same array passed here), but
  // Sage flagged the index-based access as fragile against future
  // edits where `packs` and `packFingerprints` could drift if either
  // got re-sorted or filtered separately. Keying by `paiPackDir`
  // removes the implicit alignment invariant.
  const fingerprintByDir = new Map<string, string>();
  for (let i = 0; i < result.packs.length; i += 1) {
    fingerprintByDir.set(result.packs[i].paiPackDir, result.packFingerprints[i] ?? "empty");
  }
  const packFingerprintLines = result.packs.length === 0
    ? ""
    : "\n" + result.packs
        .map((p, idx) => `  - pack ${idx + 1} fingerprint: ${fingerprintByDir.get(p.paiPackDir) ?? "empty"}`)
        .join("\n");
  // #97 — per-pack outcome table. Sorted by paiPackDir (via the
  // shared `formatPackOutcomeLines` helper) so the body stays
  // byte-stable across reruns (idempotency invariant). Sage r1 #99:
  // the helper single-sources the line shape for the CLI summary +
  // manifest body so new outcome kinds only need one render update.
  const outcomeLines = formatPackOutcomeLines(result.packOutcomes, {
    labelKind: "basename",
  }).join("\n");
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
    "## Pack outcomes",
    outcomeLines,
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

// Compose the migration's content fingerprints, render the manifest
// body, and decide whether to preserve the prior `Last migrated at:`
// timestamp or bump it.
//
// Idempotency model (Sage r1+r2 #95):
//   1. Compute content fingerprints over identity / algorithm /
//      per-pack-entry-SKILL.md bytes so the manifest body reflects
//      content-level changes (not just file-count changes) in
//      phases whose underlying importers don't expose a per-file
//      "wrote vs skipped" signal.
//   2. Render the manifest body with a sentinel timestamp.
//   3. Read the prior manifest (if any), substitute the same
//      sentinel for its timestamp line.
//   4. If sentinel-bodies are byte-equal, the migration is fully
//      idempotent — reuse the prior timestamp.
//   5. Otherwise, write the new manifest with `new Date()`.
//
// This covers all phases by construction: any phase that changed
// counts, names, file lists, OR file content produces a different
// body and forces a timestamp bump. Pack fingerprint is restricted
// to the entry SKILL.md (Sage r2 #95 Performance) — the only file
// the pack importer rewrites, sufficient for the contract.
interface StableManifestInputs {
  claudeHome: string;
  somaHome: string;
  identity: PaiImportResult;
  algorithm: AlgorithmImportResult | null;
  packs: PaiPackImportResult[];
  /** #97 — see ManifestInputs for byte-stability contract. */
  packOutcomes: PaiPackOutcome[];
  memory: PaiMemoryMigrationResult | null;
  docs: PaiDocsImportResult | null;
  paiSourceDir: string | undefined;
  manifestPath: string;
}

async function renderStableMigrationManifest(
  inputs: StableManifestInputs,
): Promise<{ manifest: string; lastMigratedAt: string }> {
  const identityFingerprint = await fingerprintFiles(inputs.identity.files);
  const algorithmFingerprint = inputs.algorithm
    ? await fingerprintFiles(inputs.algorithm.files)
    : null;
  // Sage r4 #95 Performance: bound the per-pack fingerprint reads to
  // 4 workers (matches the import + preflight fan-out). Promise.all
  // over `packs.map` opens one async file read per pack regardless of
  // count, which could burst FD limits on large installs.
  const packFingerprints = await runBoundedConcurrent(
    inputs.packs,
    fingerprintPackEntry,
    4,
  );
  const sentinelTs = "__PAI_MIGRATION_TS_SENTINEL__";
  const newBodyWithSentinel = renderManifest({
    claudeHome: inputs.claudeHome,
    somaHome: inputs.somaHome,
    identity: inputs.identity,
    algorithm: inputs.algorithm,
    packs: inputs.packs,
    packOutcomes: inputs.packOutcomes,
    memory: inputs.memory,
    docs: inputs.docs,
    paiSourceDir: inputs.paiSourceDir,
    lastMigratedAt: sentinelTs,
    identityFingerprint,
    algorithmFingerprint,
    packFingerprints,
  });
  const priorBytes = await readManifestBytes(inputs.manifestPath);
  const priorWithSentinel = priorBytes === null
    ? null
    : priorBytes.replace(/^Last migrated at: .+$/m, `Last migrated at: ${sentinelTs}`);
  const priorTs = priorBytes === null ? null : extractMigrationTimestamp(priorBytes);
  const lastMigratedAt =
    priorWithSentinel !== null && priorWithSentinel === newBodyWithSentinel && priorTs !== null
      ? priorTs
      : new Date().toISOString();
  return {
    manifest: newBodyWithSentinel.replace(sentinelTs, lastMigratedAt),
    lastMigratedAt,
  };
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
  // #98 — mirror planPaiMigration: derive paiSourceDir + paiPacksDir
  // from --pai-repo before any phase runs.
  const derived = await applyPaiRepoDerivation(options);
  options = derived;
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

  // #97 — bulk pack phase runs each pack independently and classifies
  // its outcome instead of aborting on first failure. Reserved-skill
  // collisions and substrate-specific refusals are now per-pack
  // policy-respected outcomes; only genuine errors force a non-zero
  // CLI exit (see `formatPaiMigrationResult` + the CLI exit-code
  // gate). Pack data on disk (when `imported`) still lands via the
  // existing `importPaiPack` contract — rollback included.
  const { packs, outcomes: packOutcomes } = options.skipSkills === true
    ? { packs: [] as PaiPackImportResult[], outcomes: [] as PaiPackOutcome[] }
    : await importPacksWithOutcomes({
        homeDir: options.homeDir,
        somaHome,
        packPaths,
        overwriteReserved: options.overwriteReserved === true,
        includeSubstrateSpecific: options.includeSubstrateSpecific === true,
      });
  for (const r of packs) filesWritten.push(...r.files);

  const docs = options.paiSourceDir && options.skipDocs !== true
    ? await importPaiDocs({
        homeDir: options.homeDir,
        paiSourceDir: options.paiSourceDir,
        somaHome,
      })
    : null;
  // Sage r5 #95 important (mirrors r2 memory bug): the docs importer's
  // `files: string[]` is "every in-scope target" (written + skipped),
  // so pushing it wholesale over-reports writes after idempotent
  // reruns. The importer exposes `writtenCount` but not a per-file
  // written-targets list. Until that surface lands, omit the docs
  // targets from `filesWritten` — the docs phase's own manifest at
  // <somaHome>/PAI/.import-manifest.json is the authoritative
  // per-file record, and `result.docs.writtenCount` is the per-run
  // accounting. The behavior matches how memory is recorded.
  if (docs && docs.writtenCount > 0) {
    // We don't know which specific files were written, but the
    // manifest path is always touched on apply. Recording it gives
    // the principal a single anchor for "docs did write this run".
    filesWritten.push(join(somaHome, "PAI/.import-manifest.json"));
  }

  // Sage r3 #95 Maintainability: the timestamp gate + fingerprint
  // composition lives in `renderStableMigrationManifest` so this
  // orchestrator stays focused on phase composition. The helper
  // returns the manifest bytes ready to write + the resolved
  // timestamp (preserved on idempotent rerun, freshly bumped
  // otherwise).
  const manifestPath = manifestPathFor(somaHome);
  await mkdir(dirname(manifestPath), { recursive: true });
  const { manifest } = await renderStableMigrationManifest({
    claudeHome,
    somaHome,
    identity,
    algorithm,
    packs,
    packOutcomes,
    memory,
    docs,
    paiSourceDir: options.paiSourceDir,
    manifestPath,
  });
  await writeFile(manifestPath, manifest, "utf8");
  filesWritten.push(manifestPath);

  return {
    claudeHome,
    somaHome,
    identity,
    algorithm,
    packs,
    packOutcomes,
    memory,
    docs,
    manifestPath,
    filesWritten,
  };
}
