/**
 * PAI MEMORY → Soma memory translator (#90).
 *
 * Moves `<claudeHome>/PAI/MEMORY/<CATEGORY>/...` files into
 * `<somaHome>/memory/<CATEGORY>/...`. Content-preserving by contract
 * (DD-2 + plan §"Failure modes"): no body rewriting in this pass, only
 * directory remapping. Preserves source mtimes. Records per-file SHA in
 * `<somaHome>/imports/pai-migration/.manifest.json`. Idempotent — a
 * second run with no source drift writes zero files.
 *
 * What is NOT migrated:
 *   - Files directly under `<claudeHome>/PAI/MEMORY/` (no enclosing
 *     category dir). Those tend to be readmes or index files that
 *     #88's bootstrap owns at the Soma side; clobbering them silently
 *     would conflict with the canonical taxonomy contract.
 *   - Symlinks anywhere in the tree — rejected loud (matches the
 *     pack/docs importers' stance).
 *
 * Idempotency model (mirrors `pai-docs-importer.ts`):
 *   - Compare source SHA against prior manifest entry.
 *   - When SHA matches AND the target file's current bytes still hash
 *     to that SHA, skip the copy. A target that has been edited or
 *     replaced since the import is restored from the source.
 *   - The manifest's `importedAt` updates only when at least one file
 *     was written this run; otherwise the prior timestamp is preserved
 *     so the manifest is byte-stable on a no-op rerun.
 */
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runBoundedConcurrent } from "./internal-concurrency";
import type {
  PaiMemoryMigrationFile,
  PaiMemoryMigrationManifest,
  PaiMemoryMigrationOptions,
  PaiMemoryMigrationPlan,
  PaiMemoryMigrationResult,
} from "./types";

const MANIFEST_SCHEMA = "soma.pai-memory-migration.v1";
const MANIFEST_RELATIVE = "imports/pai-migration/.manifest.json";

function resolveHomes(options: PaiMemoryMigrationOptions): { claudeHome: string; somaHome: string } {
  const home = resolve(options.homeDir ?? homedir());
  return {
    claudeHome: resolve(options.claudeHome ?? join(home, ".claude")),
    somaHome: resolve(options.somaHome ?? join(home, ".soma")),
  };
}

function isWithinPath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

// Recursively enumerate files under `<memoryDir>/<category>/...`.
// Files directly under `memoryDir` are skipped — #88 owns the README
// at `<somaHome>/memory/` and we must not clobber it.
async function collectCategoryFiles(memoryDir: string): Promise<string[]> {
  const realRoot = await realpath(memoryDir);
  const files: string[] = [];

  async function visit(dir: string, depth: number): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name.includes("\\")) {
        throw new Error(
          `PAI memory migration refused ambiguous path separator: ${relative(memoryDir, fullPath).split(sep).join("/")}`,
        );
      }
      if (entry.isSymbolicLink()) {
        throw new Error(
          `PAI memory migration refused symlink path: ${relative(memoryDir, fullPath).split(sep).join("/")}`,
        );
      }
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === ".hg" || entry.name === ".svn") {
          throw new Error(
            `PAI memory migration refused VCS metadata directory: ${relative(memoryDir, fullPath).split(sep).join("/")}`,
          );
        }
        await visit(fullPath, depth + 1);
        continue;
      }
      if (entry.isFile()) {
        // depth 0 = files directly under MEMORY/ (no category). Those
        // would collide with `<somaHome>/memory/<file>` — bootstrap
        // territory. Skip.
        if (depth === 0) continue;
        const realFile = await realpath(fullPath);
        if (!isWithinPath(realRoot, realFile)) {
          throw new Error(
            `PAI memory migration refused path outside MEMORY root: ${relative(memoryDir, fullPath).split(sep).join("/")}`,
          );
        }
        files.push(relative(memoryDir, fullPath).split(sep).join("/"));
      }
    }
  }

  await visit(memoryDir, 0);
  return files.sort();
}

async function buildPlan(
  options: PaiMemoryMigrationOptions,
  flags: { withSha: boolean },
): Promise<PaiMemoryMigrationPlan> {
  const homes = resolveHomes(options);
  const memoryDirCandidate = join(homes.claudeHome, "PAI/MEMORY");
  if (!(await pathExists(memoryDirCandidate))) {
    return {
      apply: false,
      claudeHome: homes.claudeHome,
      somaHome: homes.somaHome,
      memoryDir: null,
      files: [],
    };
  }
  // Refuse a symlinked PAI MEMORY root with the same loud-fail bar as
  // every other source the importer reads. A malicious or accidental
  // symlink at this top-level path would otherwise let the importer
  // walk an arbitrary directory.
  const memoryStat = await lstat(memoryDirCandidate);
  if (memoryStat.isSymbolicLink()) {
    throw new Error("PAI memory migration refused symlink path: PAI/MEMORY");
  }
  if (!memoryStat.isDirectory()) {
    throw new Error(
      `PAI memory migration: ${memoryDirCandidate} exists but is not a directory.`,
    );
  }

  const relPaths = await collectCategoryFiles(memoryDirCandidate);
  // Sage r2 #95 Performance: per-file stat+read for SHA was serialized
  // in this builder loop. Bounded-concurrency the same as the copy
  // phase — input order is preserved by `runBoundedConcurrent` so the
  // returned plan stays deterministic (manifest entries are sorted
  // by `relativePath` already, but per-input order would match anyway).
  const files = await runBoundedConcurrent(
    relPaths,
    async (rel): Promise<PaiMemoryMigrationFile> => {
      const source = join(memoryDirCandidate, ...rel.split("/"));
      const target = join(homes.somaHome, "memory", ...rel.split("/"));
      const stat = await lstat(source);
      const file: PaiMemoryMigrationFile = {
        source,
        target,
        relativePath: rel,
        mtimeMs: stat.mtimeMs,
      };
      if (flags.withSha) {
        file.sha256 = sha256Hex(await readFile(source));
      }
      return file;
    },
    4,
  );

  return {
    apply: false,
    claudeHome: homes.claudeHome,
    somaHome: homes.somaHome,
    memoryDir: memoryDirCandidate,
    files,
  };
}

export async function planPaiMemoryMigration(
  options: PaiMemoryMigrationOptions = {},
): Promise<PaiMemoryMigrationPlan> {
  return buildPlan(options, { withSha: false });
}

// Read existing manifest. Returns null when missing / corrupt so the
// apply path re-copies every file. Map key is the manifest
// `relativePath` (POSIX path under PAI/MEMORY/).
async function readExistingManifest(
  somaHome: string,
): Promise<{ map: Map<string, string>; importedAt: string } | null> {
  const path = join(somaHome, MANIFEST_RELATIVE);
  if (!(await pathExists(path))) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as PaiMemoryMigrationManifest;
    if (parsed.schema !== MANIFEST_SCHEMA || !Array.isArray(parsed.files)) return null;
    const map = new Map<string, string>();
    for (const entry of parsed.files) {
      map.set(entry.relativePath, entry.sha256);
    }
    return { map, importedAt: parsed.importedAt };
  } catch {
    return null;
  }
}

function renderManifest(
  plan: PaiMemoryMigrationPlan,
  importedAt: string,
): string {
  const manifest: PaiMemoryMigrationManifest = {
    schema: MANIFEST_SCHEMA,
    claudeHome: plan.claudeHome,
    somaHome: plan.somaHome,
    importedAt,
    files: plan.files.map((file) => {
      if (!file.sha256) {
        throw new Error(
          `PAI memory migration: manifest renderer expected file.sha256 to be populated (file: ${file.relativePath}).`,
        );
      }
      return {
        relativePath: file.relativePath,
        target: relative(join(plan.somaHome, "memory"), file.target).split(sep).join("/"),
        sha256: file.sha256,
        mtimeMs: file.mtimeMs,
      };
    }),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function migratePaiMemory(
  options: PaiMemoryMigrationOptions = {},
): Promise<PaiMemoryMigrationResult> {
  const plan = await buildPlan(options, { withSha: true });
  const manifestPath = join(plan.somaHome, MANIFEST_RELATIVE);
  // Always ensure the manifest dir exists so a no-op rerun on an empty
  // PAI MEMORY tree still produces a deterministic surface.
  await mkdir(join(plan.somaHome, "imports/pai-migration"), { recursive: true });

  if (plan.memoryDir === null) {
    // Nothing to migrate. Write an empty manifest only when one
    // doesn't already exist, so the no-op contract holds.
    const existing = await readExistingManifest(plan.somaHome);
    if (existing === null) {
      const importedAt = new Date().toISOString();
      await writeFile(
        manifestPath,
        renderManifest(plan, importedAt),
        "utf8",
      );
      return {
        claudeHome: plan.claudeHome,
        somaHome: plan.somaHome,
        memoryDir: null,
        importedAt,
        writtenCount: 0,
        skippedCount: 0,
        unchanged: true,
        manifestPath,
        files: [],
        writtenTargets: [],
      };
    }
    return {
      claudeHome: plan.claudeHome,
      somaHome: plan.somaHome,
      memoryDir: null,
      importedAt: existing.importedAt,
      writtenCount: 0,
      skippedCount: 0,
      unchanged: true,
      manifestPath,
      files: [],
      writtenTargets: [],
    };
  }

  const previous = await readExistingManifest(plan.somaHome);

  // Sage r1 #95 Performance suggestion: process per-file work with a
  // small bounded concurrency window so large MEMORY trees don't pay
  // one file's full I/O latency at a time. Per-file work is
  // independent and dominated by syscalls — 4-wide matches the pack
  // import phase and the docs importer's footprint. The original
  // plan.files order is preserved in `outcomes` so the manifest and
  // returned target list stay deterministic.
  type Outcome = { written: boolean; target: string };
  async function processFile(file: PaiMemoryMigrationFile): Promise<Outcome> {
    const priorSha = previous?.map.get(file.relativePath);
    if (priorSha && priorSha === file.sha256 && (await pathExists(file.target))) {
      // Re-hash the target's current bytes. Manifest agreement alone
      // is not enough — a user edit since import would otherwise
      // leave a "successful" migration with the wrong target bytes.
      const targetStat = await lstat(file.target);
      if (targetStat.isFile()) {
        const targetSha = sha256Hex(await readFile(file.target));
        if (targetSha === file.sha256) {
          return { written: false, target: file.target };
        }
      }
    }
    // Target-side parent must be inside the Soma home root. The plan
    // builder already constructed `file.target` relative to
    // `<somaHome>/memory/<rel>`; verify once more before any IO.
    if (!isWithinPath(plan.somaHome, file.target)) {
      throw new Error(
        `PAI memory migration refused target outside Soma home: ${file.target}`,
      );
    }
    await mkdir(join(file.target, ".."), { recursive: true });
    await copyFile(file.source, file.target);
    // Preserve source mtime on the target file.
    const mtimeSeconds = file.mtimeMs / 1000;
    await utimes(file.target, mtimeSeconds, mtimeSeconds);
    return { written: true, target: file.target };
  }

  const outcomes = await runBoundedConcurrent(plan.files, processFile, 4);
  let writtenCount = 0;
  let skippedCount = 0;
  const allTargets: string[] = [];
  const writtenTargets: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.written) {
      writtenCount += 1;
      writtenTargets.push(outcome.target);
    } else {
      skippedCount += 1;
    }
    allTargets.push(outcome.target);
  }

  // Decide manifest timestamp:
  //   - At least one write this run → bump timestamp.
  //   - Zero writes (idempotent no-op) → preserve prior timestamp so
  //     the manifest is byte-stable across reruns.
  const importedAt =
    writtenCount === 0 && previous
      ? previous.importedAt
      : new Date().toISOString();
  await writeFile(manifestPath, renderManifest(plan, importedAt), "utf8");

  return {
    claudeHome: plan.claudeHome,
    somaHome: plan.somaHome,
    memoryDir: plan.memoryDir,
    importedAt,
    writtenCount,
    skippedCount,
    unchanged: writtenCount === 0,
    manifestPath,
    files: allTargets,
    writtenTargets,
  };
}
