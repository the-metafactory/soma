// soma import pai-docs — import PAI DOCUMENTATION/, TEMPLATES/, ALGORITHM/
// from a PAI release tree into ~/.soma/PAI/. First step of the PAI →
// Soma migration chain (#89) per DD-1: Soma is the new canonical home
// of personal AI state; PAI's release tree is the source we translate
// from.
//
// Shape mirrors src/pai-pack-importer.ts (option types, dry-run vs
// apply, audit shape). Reuses the lexical + symlink-realpath escape
// guards from `soma export --out` (src/cli.ts `writeProjectionExportFile`):
// every write must land under a pre-resolved realpath(somaHome).
//
// What gets imported (per issue #89 scope table):
//   - DOCUMENTATION/  (required — sources without it are refused loud)
//   - TEMPLATES/      (if present)
//   - ALGORITHM/      (if present)
//
// What does NOT get imported: MEMORY/, USER/, PULSE/, TOOLS/, bin/,
// PAI-Install/, statusline-command.sh, PAI_SYSTEM_PROMPT.md. Those are
// runtime / user-state / install infrastructure or have explicit Soma
// equivalents (memory taxonomy under #88, identity already handled by
// `soma import pai`).

import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  PaiDocsImportFile,
  PaiDocsImportManifest,
  PaiDocsImportOptions,
  PaiDocsImportPlan,
  PaiDocsImportResult,
  PaiDocsImportSubdir,
} from "./types";

// Sub-directories of a PAI release tree we import into ~/.soma/PAI/.
// DOCUMENTATION is required (it is the whole point — it resolves the
// broken doc refs that #86 currently shunts to `~/.soma/UNMAPPED/PAI/`).
// TEMPLATES + ALGORITHM are optional but copied when present.
//
// Exported (Sage round 3, Maintainability) so CLI formatters and any
// future caller share the same list. The exported tuple is the single
// runtime source of truth; the `PaiDocsImportSubdir` type in
// `src/types.ts` mirrors its members.
export const PAI_DOCS_IMPORT_SUBDIRS = ["DOCUMENTATION", "TEMPLATES", "ALGORITHM"] as const satisfies readonly PaiDocsImportSubdir[];

const REQUIRED_SUBDIR: PaiDocsImportSubdir = "DOCUMENTATION";

const MANIFEST_FILENAME = ".import-manifest.json";
const MANIFEST_SCHEMA = "soma.pai-docs-import.v1";

function resolveHomes(options: PaiDocsImportOptions): { paiSourceDir: string; somaHome: string } {
  if (!options.paiSourceDir) {
    throw new Error("soma import pai-docs requires --pai-source-dir <dir>.");
  }
  const home = resolve(options.homeDir ?? homedir());
  return {
    paiSourceDir: resolve(options.paiSourceDir),
    somaHome: resolve(options.somaHome ?? join(home, ".soma")),
  };
}

function isWithinPath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    });
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

// Recursively collect files under `root`, refusing symlinks at any level
// (matches pai-pack-importer's stance and the symlink-realpath escape
// guard from `soma export --out`). Returns POSIX-style relative paths.
async function collectFiles(root: string): Promise<string[]> {
  const realRoot = await realpath(root);
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name.includes("\\")) {
        throw new Error(
          `PAI docs import refused ambiguous path separator: ${relative(root, fullPath).split(sep).join("/")}`,
        );
      }
      if (entry.isSymbolicLink()) {
        throw new Error(
          `PAI docs import refused symlink path: ${relative(root, fullPath).split(sep).join("/")}`,
        );
      }
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === ".hg" || entry.name === ".svn") {
          throw new Error(
            `PAI docs import refused VCS metadata directory: ${relative(root, fullPath).split(sep).join("/")}`,
          );
        }
        await visit(fullPath);
        continue;
      }
      if (entry.isFile()) {
        const realFile = await realpath(fullPath);
        if (!isWithinPath(realRoot, realFile)) {
          throw new Error(
            `PAI docs import refused path outside source root: ${relative(root, fullPath).split(sep).join("/")}`,
          );
        }
        // Sage round 3 (CodeQuality suggestion): the realpath check
        // above is the authoritative traversal guard. A `rel.startsWith("..")`
        // string filter both adds nothing and silently drops legitimate
        // filenames like `..notes.md`.
        files.push(relative(root, fullPath).split(sep).join("/"));
      }
    }
  }

  await visit(root);
  return files.sort();
}

// Infer release version from one of two sources, in order:
//   1. A `VERSION` file at the source dir root.
//   2. The path hint `Releases/<version>/` somewhere in the source dir
//      (matches the canonical PAI release layout
//      `~/work/PAI/Releases/v5.0.0/.claude/PAI`).
// Returns null when neither is present so the manifest is explicit
// about not knowing rather than guessing.
async function detectReleaseVersion(sourceDir: string): Promise<string | null> {
  const versionPath = join(sourceDir, "VERSION");
  if (await pathExists(versionPath)) {
    // Sage round 3 (Security, important): refuse symlinks here just
    // like everywhere else in the importer. A malicious source could
    // otherwise plant `VERSION -> /etc/hostname` and smuggle its
    // contents into CLI output + `.import-manifest.json`. Also
    // require a regular file — a directory at this path is a sign of
    // a malformed source, not a release marker.
    const versionStat = await lstat(versionPath);
    if (versionStat.isSymbolicLink()) {
      throw new Error("soma import pai-docs refused symlink path: VERSION");
    }
    if (!versionStat.isFile()) {
      throw new Error(
        `soma import pai-docs: VERSION at ${versionPath} is not a regular file.`,
      );
    }
    const raw = (await readFile(versionPath, "utf8")).trim();
    if (raw.length > 0) return raw;
  }
  const segments = sourceDir.split(sep);
  const releasesIndex = segments.lastIndexOf("Releases");
  if (releasesIndex !== -1 && releasesIndex + 1 < segments.length) {
    const candidate = segments[releasesIndex + 1];
    if (candidate && candidate.length > 0) return candidate;
  }
  return null;
}

async function assertPaiReleaseTree(sourceDir: string): Promise<void> {
  const requiredPath = join(sourceDir, REQUIRED_SUBDIR);
  if (!(await pathExists(requiredPath))) {
    throw new Error(
      `soma import pai-docs: ${sourceDir} does not look like a PAI release tree ` +
        `(missing required '${REQUIRED_SUBDIR}/' subdirectory).`,
    );
  }
  const statRequired = await lstat(requiredPath);
  if (statRequired.isSymbolicLink()) {
    throw new Error(
      `soma import pai-docs refused symlink path: ${REQUIRED_SUBDIR}/`,
    );
  }
  if (!statRequired.isDirectory()) {
    throw new Error(
      `soma import pai-docs: ${sourceDir}/${REQUIRED_SUBDIR} exists but is not a directory.`,
    );
  }
}

// Build a plan: collect every file under each in-scope subdir and
// pair it with its eventual target under ~/.soma/PAI/. By default the
// plan lists files without reading their bytes — dry-run callers only
// need paths and counts (Sage round 2 performance finding). Pass
// `withSha: true` to populate per-file SHA-256, which the apply path
// needs for the manifest and for idempotency comparisons against any
// prior manifest.
async function buildPlan(
  options: PaiDocsImportOptions,
  flags: { withSha: boolean },
): Promise<PaiDocsImportPlan> {
  const homes = resolveHomes(options);
  await assertPaiReleaseTree(homes.paiSourceDir);

  const releaseVersion = await detectReleaseVersion(homes.paiSourceDir);
  const files: PaiDocsImportFile[] = [];

  for (const subdir of PAI_DOCS_IMPORT_SUBDIRS) {
    const subdirPath = join(homes.paiSourceDir, subdir);
    if (!(await pathExists(subdirPath))) continue;
    // Sage round 1 (Security, important): `collectFiles` lstat-checks
    // every child entry but never its own root. Without this guard, a
    // PAI source with `TEMPLATES/` or `ALGORITHM/` planted as a
    // symlink would be followed and imported — violating the
    // documented refusal for symlinks inside the source tree. Refuse
    // here at the subtree boundary, before `collectFiles` recurses
    // into anything.
    const subdirStat = await lstat(subdirPath);
    if (subdirStat.isSymbolicLink()) {
      throw new Error(
        `soma import pai-docs refused symlink path: ${subdir}/`,
      );
    }
    if (!subdirStat.isDirectory()) {
      throw new Error(
        `soma import pai-docs: ${subdirPath} exists but is not a directory.`,
      );
    }
    const relPaths = await collectFiles(subdirPath);
    for (const rel of relPaths) {
      const source = join(subdirPath, ...rel.split("/"));
      const target = join(homes.somaHome, "PAI", subdir, ...rel.split("/"));
      const file: PaiDocsImportFile = {
        source,
        target,
        relativePath: `${subdir}/${rel}`,
        subdir,
      };
      if (flags.withSha) {
        file.sha256 = sha256(await readFile(source));
      }
      files.push(file);
    }
  }

  files.sort((a, b) => a.target.localeCompare(b.target));

  return {
    apply: false,
    paiSourceDir: homes.paiSourceDir,
    somaHome: homes.somaHome,
    releaseVersion,
    files,
  };
}

export async function planPaiDocsImport(
  options: PaiDocsImportOptions = {},
): Promise<PaiDocsImportPlan> {
  // Dry-run callers only need paths + counts — skip the per-file
  // read + hash. The apply path computes SHAs as part of its own
  // (re-checked) source-read pass.
  return buildPlan(options, { withSha: false });
}

// Sage round 4 (Maintainability nit): the prior `ExistingManifestEntry`
// shape stored `target` twice — once as the map key and once as a
// field never read again. A `Map<target, sha256>` carries exactly the
// state idempotency needs.
async function readExistingManifest(
  somaHome: string,
): Promise<Map<string, string> | null> {
  const manifestPath = join(somaHome, "PAI", MANIFEST_FILENAME);
  if (!(await pathExists(manifestPath))) return null;
  const raw = await readFile(manifestPath, "utf8");
  try {
    const parsed = JSON.parse(raw) as PaiDocsImportManifest;
    if (parsed.schema !== MANIFEST_SCHEMA || !Array.isArray(parsed.files)) return null;
    const map = new Map<string, string>();
    for (const entry of parsed.files) {
      map.set(entry.target, entry.sha256);
    }
    return map;
  } catch {
    return null;
  }
}

// Lexical + symlink-realpath escape guard, mirroring
// `writeProjectionExportFile` in src/cli.ts. The realpath of the
// resolved Soma home is computed once and reused for every file write.
//
// Sage round 1 (Maintainability suggestion): both write paths
// (manifest write and source-copy) need exactly the same target-side
// hardening. Centralizing the guard here means future tightening
// happens in one place instead of two.
async function prepareSafeTargetParent(
  realSomaHomeRoot: string,
  somaHomeRoot: string,
  targetAbs: string,
): Promise<string> {
  // Lexical: the target must resolve inside somaHomeRoot before any IO.
  const resolved = resolve(targetAbs);
  if (
    resolved !== somaHomeRoot &&
    !resolved.startsWith(somaHomeRoot + sep)
  ) {
    throw new Error(
      `soma import pai-docs refused to write outside Soma home (path: ${targetAbs}).`,
    );
  }
  const parent = dirname(resolved);
  await mkdir(parent, { recursive: true });
  // Symlink-realpath: after mkdir, the parent's realpath must still be
  // under the soma home's realpath. A symlink anywhere on the path
  // (e.g. somaHome/PAI/DOCUMENTATION -> ~/.ssh) would otherwise let
  // the write land outside the home even though the lexical check
  // passed.
  const realParent = await realpath(parent);
  if (
    realParent !== realSomaHomeRoot &&
    !realParent.startsWith(realSomaHomeRoot + sep)
  ) {
    throw new Error(
      `soma import pai-docs refused to follow a symlink that escapes Soma home (path: ${targetAbs}).`,
    );
  }
  return resolved;
}

async function writeFileSafely(
  realSomaHomeRoot: string,
  somaHomeRoot: string,
  targetAbs: string,
  content: Buffer,
): Promise<void> {
  const resolved = await prepareSafeTargetParent(realSomaHomeRoot, somaHomeRoot, targetAbs);
  await writeFile(resolved, content);
}

async function copyFileSafely(
  realSourceRoot: string,
  realSomaHomeRoot: string,
  somaHomeRoot: string,
  sourceAbs: string,
  targetAbs: string,
): Promise<void> {
  // Re-check the source the same way `collectFiles` did before reading
  // its bytes: lstat then realpath. We refused symlinks at scan time;
  // re-verify here so a TOCTOU swap between plan and apply can't
  // sneak one through.
  const sourceStat = await lstat(sourceAbs);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`PAI docs import refused symlink source during apply: ${sourceAbs}`);
  }
  const realSource = await realpath(sourceAbs);
  if (!isWithinPath(realSourceRoot, realSource)) {
    throw new Error(
      `PAI docs import refused source outside source root during apply: ${sourceAbs}`,
    );
  }
  const resolved = await prepareSafeTargetParent(realSomaHomeRoot, somaHomeRoot, targetAbs);
  await copyFile(realSource, resolved);
}

function manifestRelativeTarget(file: PaiDocsImportFile): string {
  // POSIX-style relative path under ~/.soma/PAI/, e.g.
  // "DOCUMENTATION/Skills/SkillSystem.md". This is what `target` means
  // in the manifest — paths are written relative to the PAI root so
  // moving the soma home doesn't invalidate them.
  return file.relativePath;
}

function manifestRelativeSource(file: PaiDocsImportFile, paiSourceDir: string): string {
  return relative(paiSourceDir, file.source).split(sep).join("/");
}

function renderManifest(
  plan: PaiDocsImportPlan,
  importedAt: string,
): string {
  const manifest: PaiDocsImportManifest = {
    schema: MANIFEST_SCHEMA,
    paiSourceDir: plan.paiSourceDir,
    releaseVersion: plan.releaseVersion,
    importedAt,
    files: plan.files.map((file) => {
      // Manifest is only rendered on the apply path, where every plan
      // file is guaranteed to carry a SHA. Defensive guard so a future
      // refactor that calls render-manifest off the dry-run plan fails
      // loud instead of writing `sha256: undefined`.
      if (!file.sha256) {
        throw new Error(
          `soma import pai-docs: manifest renderer expected file.sha256 to be populated (file: ${file.relativePath}).`,
        );
      }
      return {
        target: manifestRelativeTarget(file),
        source: manifestRelativeSource(file, plan.paiSourceDir),
        sha256: file.sha256,
      };
    }),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function importPaiDocs(
  options: PaiDocsImportOptions = {},
): Promise<PaiDocsImportResult> {
  // Apply path needs per-file SHAs for both the manifest (AC-5) and
  // idempotency comparison against any prior manifest. Plan-only
  // callers go through `planPaiDocsImport` and skip the read+hash —
  // Sage round 2 performance finding.
  const plan = await buildPlan(options, { withSha: true });

  await mkdir(plan.somaHome, { recursive: true });
  const realSomaHome = await realpath(plan.somaHome);
  const somaHomeAbs = resolve(plan.somaHome);

  // Source-side realpath, computed once per import. Re-used by every
  // copy so a symlink that swaps in between plan and apply still gets
  // refused by the per-file guard below.
  const realSourceRoot = await realpath(plan.paiSourceDir);

  // Idempotency: compare per-file SHA against any prior manifest.
  // Files whose target SHA matches the new SHA are skipped.
  const previous = await readExistingManifest(plan.somaHome);
  let writtenCount = 0;

  // Sage round 2 (Maintainability suggestion): drop the redundant
  // pre-flight `nearestExistingAncestor` check. `copyFileSafely` calls
  // `prepareSafeTargetParent`, which lexically checks the target,
  // `mkdir`s the parent, and re-resolves `realpath(parent)` against
  // the Soma home root — the same symlink-escape behavior the
  // pre-flight check provided, in one place.
  for (const file of plan.files) {
    const manifestKey = manifestRelativeTarget(file);
    const priorSha = previous?.get(manifestKey);
    if (priorSha && priorSha === file.sha256 && (await pathExists(file.target))) {
      // Same source bytes, target still on disk — nothing to do.
      continue;
    }
    await copyFileSafely(realSourceRoot, realSomaHome, somaHomeAbs, file.source, file.target);
    writtenCount += 1;
  }

  const importedAt = new Date().toISOString();
  const manifestPath = join(plan.somaHome, "PAI", MANIFEST_FILENAME);
  await writeFileSafely(
    realSomaHome,
    somaHomeAbs,
    manifestPath,
    Buffer.from(renderManifest(plan, importedAt), "utf8"),
  );

  return {
    applied: true,
    paiSourceDir: plan.paiSourceDir,
    somaHome: plan.somaHome,
    releaseVersion: plan.releaseVersion,
    importedAt,
    writtenCount,
    unchanged: writtenCount === 0,
    files: plan.files.map((file) => file.target),
  };
}
