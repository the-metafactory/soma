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
// Single source of truth. The CLI formatter and the apply loop both
// iterate this tuple; the `PaiDocsImportSubdir` union in
// `src/types.ts` mirrors its members. Module-internal — not exported
// from the package root, since the in-scope subtree set is importer
// policy, not part of the public API.
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
        // The `isWithinPath(realRoot, realFile)` check above is the
        // authoritative traversal guard — no extra string filter on
        // the relative path is needed, and adding one would silently
        // drop legitimate filenames such as `..notes.md`.
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
    // Refuse symlinks at this path with the same bar as every other
    // file the importer reads. A malicious source could otherwise
    // plant `VERSION -> /etc/hostname` and smuggle its contents into
    // CLI output + `.import-manifest.json`. Require a regular file —
    // a directory at this path is a sign of a malformed source, not a
    // release marker.
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
// need paths and counts. Pass `withSha: true` to populate per-file
// SHA-256, which the apply path needs for both the manifest (AC-5)
// and idempotency comparisons against any prior manifest.
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
    // `collectFiles` lstat-checks every child entry but never its
    // own root. Without this guard, a PAI source with `TEMPLATES/` or
    // `ALGORITHM/` planted as a symlink would be followed and
    // imported — violating the documented refusal for symlinks inside
    // the source tree. lstat (not `pathExists`/`access`) is used so a
    // dangling symlink is refused, not silently treated as absent.
    let subdirStat;
    try {
      subdirStat = await lstat(subdirPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // Optional subtree genuinely missing — fine, skip.
        continue;
      }
      throw error;
    }
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

// Idempotency only needs `target -> sha256`. Returns null when the
// manifest is missing or unreadable (a missing manifest is a first
// import; an unreadable one falls through to a full re-copy).
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

// Centralized target-side escape guard for every write the importer
// performs (manifest write + per-file copy). The contract:
//   1. The target must lexically resolve inside `somaHomeRoot` before
//      any IO is attempted.
//   2. No directory creation may follow a symlink that escapes
//      `realSomaHomeRoot`. We walk the existing ancestors of the
//      target *before* `mkdir`, refuse if any ancestor is a symlink
//      that points outside the Soma home, and only create new
//      directories underneath a verified ancestor.
//   3. After mkdir completes, the parent's realpath is re-verified
//      against `realSomaHomeRoot` so any race between the walk and the
//      mkdir is still caught.
async function prepareSafeTargetParent(
  realSomaHomeRoot: string,
  somaHomeRoot: string,
  targetAbs: string,
): Promise<string> {
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

  // Walk the chain of existing ancestors from the parent up toward
  // the Soma home root, refusing symlinks that point outside the home.
  // Stop at the first ancestor that does not yet exist — that and
  // everything underneath it will be created by the targeted `mkdir`
  // below, so no symlink can pre-exist on those segments.
  const ancestors: string[] = [];
  let cursor = parent;
  while (true) {
    ancestors.push(cursor);
    if (cursor === somaHomeRoot) break;
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  // Top-down: verify the highest existing ancestor first.
  for (const ancestor of ancestors.reverse()) {
    if (!(await pathExists(ancestor))) continue;
    const stat = await lstat(ancestor);
    if (stat.isSymbolicLink()) {
      const realLink = await realpath(ancestor);
      if (
        realLink !== realSomaHomeRoot &&
        !realLink.startsWith(realSomaHomeRoot + sep)
      ) {
        throw new Error(
          `soma import pai-docs refused to follow a symlink that escapes Soma home (path: ${targetAbs}).`,
        );
      }
    }
  }

  await mkdir(parent, { recursive: true });
  // After mkdir, re-check the parent's realpath against the Soma
  // home's realpath. This re-catches both the standard
  // symlink-in-the-middle case (e.g. a regular dir replaced by a
  // symlink between walk and mkdir) and the case where the parent
  // itself is a symlink pointing inside the home (legal — caught by
  // the equality check).
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

// Refuse writing through a pre-existing symlink at the final path.
// All parent-side guards can pass while the leaf entry itself is a
// symlink to an outside file — `writeFile`/`copyFile` would then
// follow the link and overwrite an attacker-chosen target. Removing
// any existing symlink (or letting it through only when it points
// inside the Soma home) is the only way to keep `--apply` from
// becoming an arbitrary-overwrite primitive.
async function refuseFinalTargetSymlink(
  realSomaHomeRoot: string,
  targetAbs: string,
): Promise<void> {
  let existing;
  try {
    existing = await lstat(targetAbs);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (!existing.isSymbolicLink()) return;
  // The realpath of a symbolic link must still resolve inside the
  // Soma home root for the importer to overwrite it. Anything
  // pointing outside is rejected. (We do not silently `unlink` even
  // an inside-home symlink; the importer's contract is to write
  // regular files at these paths, so a pre-existing symlink is a
  // configuration smell either way.)
  const realTarget = await realpath(targetAbs);
  if (
    realTarget !== realSomaHomeRoot &&
    !realTarget.startsWith(realSomaHomeRoot + sep)
  ) {
    throw new Error(
      `soma import pai-docs refused to overwrite through a symlink that escapes Soma home (path: ${targetAbs}).`,
    );
  }
  throw new Error(
    `soma import pai-docs refused to overwrite an existing symlink at the target path (path: ${targetAbs}).`,
  );
}

async function writeFileSafely(
  realSomaHomeRoot: string,
  somaHomeRoot: string,
  targetAbs: string,
  content: Buffer,
): Promise<void> {
  const resolved = await prepareSafeTargetParent(realSomaHomeRoot, somaHomeRoot, targetAbs);
  await refuseFinalTargetSymlink(realSomaHomeRoot, resolved);
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
  await refuseFinalTargetSymlink(realSomaHomeRoot, resolved);
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
  // callers go through `planPaiDocsImport` and skip the read+hash.
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

  // Skip a copy only when both the prior manifest SHA matches the new
  // source SHA AND the target file's current bytes still hash to that
  // SHA. Trusting the manifest alone leaves a correctness gap: if a
  // user edits or corrupts an imported file, a re-run with unchanged
  // source bytes would otherwise report a no-op and leave the target
  // wrong. Re-hashing the target on idempotency-skip closes that.
  for (const file of plan.files) {
    const manifestKey = manifestRelativeTarget(file);
    const priorSha = previous?.get(manifestKey);
    if (priorSha && priorSha === file.sha256 && (await pathExists(file.target))) {
      // Idempotency-skip must apply the same target contract the
      // copy path enforces: existing symlinks are refused. A target
      // replaced by a symlink whose bytes happen to match (or could
      // be made to match) the source would otherwise be silently
      // accepted as "unchanged". `lstat` reveals the symlink before
      // `readFile` follows it.
      await refuseFinalTargetSymlink(realSomaHome, file.target);
      const targetStat = await lstat(file.target);
      if (targetStat.isFile()) {
        const targetSha = sha256(await readFile(file.target));
        if (targetSha === file.sha256) {
          // Source bytes unchanged AND target still matches — nothing to do.
          continue;
        }
      }
      // Target is not a regular file with the expected bytes (user
      // edit, partial-write corruption, replaced by a directory, …).
      // Fall through to re-copy the source over it — `copyFileSafely`
      // re-runs the full target-side guard.
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
