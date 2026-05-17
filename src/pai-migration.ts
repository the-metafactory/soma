/**
 * PAI → Soma migration orchestrator (#28 minimal scope).
 *
 * Wraps the three existing importers (`importPaiIdentity`,
 * `importAlgorithm`, `importPaiPack`) behind a single `migratePai`
 * call + writes a human-readable MIGRATION.md manifest at
 * `~/.soma/profile/imports/claude/MIGRATION.md`.
 *
 * Out of scope for this minimal cut (filed as follow-ups on #28):
 *   - per-category importers for skills/agents/commands/hooks
 *   - auto-memory copy
 *   - idempotency conflict detection beyond what the underlying
 *     importers already provide
 *   - TTY auto-detect prompt
 *   - CLI integration (lands in soma#67 `soma migrate pai`)
 *
 * The thin orchestrator is enough to:
 *   - Land the canonical `soma migrate pai` integration point.
 *   - Give a single manifest the user can read to confirm what was
 *     imported in one place.
 *   - Unblock #29's full Claude Code install path.
 */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { importAlgorithm, planAlgorithmImport } from "./algorithm-importer";
import { importPaiIdentity, planPaiImport } from "./pai-importer";
import { importPaiPack, planPaiPackImport } from "./pai-pack-importer";
import type {
  AlgorithmImportPlan,
  AlgorithmImportResult,
  PaiImportPlan,
  PaiImportResult,
  PaiPackImportPlan,
  PaiPackImportResult,
} from "./types";

export interface PaiMigrationOptions {
  homeDir?: string;
  claudeHome?: string;
  somaHome?: string;
  /**
   * When provided, each pack at this list of paths is imported via the
   * existing pack-importer. When omitted, packs are auto-discovered
   * under `<claudeHome>/PAI/Packs/` (no-op when the directory does not
   * exist).
   */
  paiPackPaths?: string[];
}

export interface PaiMigrationPlan {
  apply: false;
  claudeHome: string;
  somaHome: string;
  identity: PaiImportPlan;
  algorithm: AlgorithmImportPlan | null;
  packs: PaiPackImportPlan[];
  manifestPath: string;
}

export interface PaiMigrationResult {
  claudeHome: string;
  somaHome: string;
  identity: PaiImportResult;
  algorithm: AlgorithmImportResult | null;
  packs: PaiPackImportResult[];
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
  } catch {
    return false;
  }
}

async function autoDiscoverPackPaths(claudeHome: string): Promise<string[]> {
  const packsRoot = join(claudeHome, "PAI/Packs");
  if (!(await exists(packsRoot))) return [];
  const entries = await readdir(packsRoot, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => join(packsRoot, e.name));
}

function manifestPathFor(somaHome: string): string {
  return join(somaHome, "profile/imports/claude/MIGRATION.md");
}

/**
 * Shared discovery between dry-run and apply paths (sage r1 finding):
 * resolves algorithm presence and pack paths once so the two surfaces
 * cannot drift as new categories are added.
 */
async function discoverMigrationSources(
  claudeHome: string,
  options: PaiMigrationOptions,
): Promise<{ algorithmDir: string | null; packPaths: string[] }> {
  const algorithmDirCandidate = join(claudeHome, "PAI/Algorithm");
  const algorithmDir = (await exists(algorithmDirCandidate)) ? algorithmDirCandidate : null;
  const packPaths = options.paiPackPaths ?? (await autoDiscoverPackPaths(claudeHome));
  return { algorithmDir, packPaths };
}

/**
 * Plan what migratePai would do. Same-shape sub-plans as the
 * underlying importers + the manifest target. `apply: false` is
 * always false for plans — to execute call migratePai.
 */
export async function planPaiMigration(options: PaiMigrationOptions = {}): Promise<PaiMigrationPlan> {
  const { claudeHome, somaHome } = resolvePaths(options);
  const { algorithmDir, packPaths } = await discoverMigrationSources(claudeHome, options);

  const identity = planPaiImport({ homeDir: options.homeDir, claudeHome, somaHome });
  const algorithm = algorithmDir === null
    ? null
    : planAlgorithmImport({ homeDir: options.homeDir, paiAlgorithmDir: algorithmDir, somaHome });
  const packs = await Promise.all(
    packPaths.map((paiPackDir) => planPaiPackImport({ homeDir: options.homeDir, paiPackDir, somaHome })),
  );

  return {
    apply: false,
    claudeHome,
    somaHome,
    identity,
    algorithm,
    packs,
    manifestPath: manifestPathFor(somaHome),
  };
}

function renderManifest(result: Omit<PaiMigrationResult, "manifestPath" | "filesWritten">): string {
  // Sage r1: the manifest used to embed a fresh timestamp on every
  // rerun, breaking the documented idempotency. Now the manifest is a
  // pure function of the import results — second rerun with identical
  // imports produces byte-identical bytes.
  const packLines = result.packs.length === 0
    ? "- (none discovered)"
    : result.packs.map((p, idx) => `- pack ${idx + 1}: ${p.files.length} files`).join("\n");
  return [
    "# PAI Migration",
    "",
    `Source: ${result.claudeHome}`,
    "",
    "## Categories",
    `- identity: ${result.identity.files.length} files`,
    `- algorithm: ${result.algorithm ? `${result.algorithm.files.length} files` : "not present"}`,
    `- packs:`,
    packLines.split("\n").map((l) => `  ${l}`).join("\n"),
    "",
    "## What was skipped",
    "- Skills / agents / commands / hooks / auto-memory: not yet covered by the",
    "  minimal orchestrator. Per-category importers will follow in incremental PRs",
    "  layered on top of #28.",
    "",
    "## How to re-run",
    "- `soma migrate pai` is idempotent at the importer level — each underlying",
    "  importer compares source vs. target and writes only changed files.",
    "- To roll back the Claude Code projection (not the Soma home itself) run",
    "  `soma adopt claude --uninstall` (soma#68).",
    "",
  ].join("\n");
}

/**
 * Execute the migration plan. Runs identity → algorithm → packs in
 * order, then writes the MIGRATION.md manifest. Idempotency comes
 * from the underlying importers; this wrapper does not re-implement
 * it.
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

  // Sage r1: parallelize independent pack imports — each pack imports
  // into its own subtree under <somaHome>/skills/, so there is no
  // cross-pack ordering constraint.
  const packs: PaiPackImportResult[] = await Promise.all(
    packPaths.map((paiPackDir) => importPaiPack({ homeDir: options.homeDir, paiPackDir, somaHome })),
  );
  for (const r of packs) filesWritten.push(...r.files);

  const manifestPath = manifestPathFor(somaHome);
  await mkdir(dirname(manifestPath), { recursive: true });
  const manifest = renderManifest({ claudeHome, somaHome, identity, algorithm, packs });
  await writeFile(manifestPath, manifest, "utf8");
  filesWritten.push(manifestPath);

  return { claudeHome, somaHome, identity, algorithm, packs, manifestPath, filesWritten };
}
