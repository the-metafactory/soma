import { mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { isEnoent } from "./fs-errors";

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else {
        out.push(child);
      }
    }
  }
  await walk(root);
  return out;
}

async function statOrEnoent(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error; // never let a transient stat error route a file to deletion
  }
}

async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([statOrEnoent(a), statOrEnoent(b)]);
  if (sa === undefined || sb === undefined) return false;
  return sa.ino === sb.ino && sa.dev === sb.dev;
}

async function removeEmptyDirs(root: string, protectedAbs: readonly string[] = []): Promise<void> {
  // Never descend into or prune an excluded (edit-preserving) subtree, even if
  // it is transiently empty.
  if (protectedAbs.some((p) => isUnderOrEqual(root, p))) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirs(join(root, entry.name), protectedAbs);
  }
  // A dir that contains (is an ancestor of) an excluded path must survive too.
  if (protectedAbs.some((p) => isUnderOrEqual(p, root))) return;
  // rmdir (not recursive rm) so a dir that became non-empty after the recursion
  // errors with ENOTEMPTY instead of cascading a delete (TOCTOU-safe).
  try {
    await rmdir(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}

export interface ReconcileResult {
  /** Relative paths removed (their on-disk/old name). */
  removed: string[];
  /** Relative paths case-normalized (their new canonical name). */
  renamed: string[];
}

/** True when `path` equals `base` or is nested under it. Separator-agnostic. */
export function isUnderOrEqual(path: string, base: string): boolean {
  const rel = relative(base, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// (The `.soma-case.*.tmp` hop name can only collide with a leftover from a crashed
// prior run — never a user file, since owned subtrees are Soma-exclusive — and the
// rename simply overwrites it.)
// Case-insensitive FS: `abs` and `canonicalAbs` are the same file (already holding
// the projected content); fix only the casing. Crash-safe — if the final rename
// throws, the original name is restored so the file is never stranded at the temp.
async function caseNormalizeRename(abs: string, canonicalAbs: string): Promise<void> {
  const tmp = join(dirname(canonicalAbs), `.soma-case.${basename(canonicalAbs)}.tmp`);
  await rename(abs, tmp);
  try {
    await mkdir(dirname(canonicalAbs), { recursive: true });
    await rename(tmp, canonicalAbs);
  } catch (error) {
    await rename(tmp, abs).catch(() => undefined);
    throw error;
  }
}

/**
 * Reconcile a soma-OWNED directory so its contents exactly equal `desiredRelPaths`
 * (relative to `root`) — identically on case-sensitive and case-insensitive
 * filesystems. The caller must have ALREADY written the desired files.
 *
 * For every file currently under `root`:
 * - exact match to a desired path → keep;
 * - case-insensitive match to a desired path but different case → it is the same
 *   file on a case-insensitive FS (rename to the canonical case via a temp hop),
 *   or a distinct stale wrong-case file on a case-sensitive FS (remove);
 * - otherwise → stale, remove.
 * Newly-empty directories are then pruned.
 *
 * Scope/preconditions: case-normalization applies to FILE basenames, not to
 * intermediate DIRECTORY segments (a recased parent dir keeps its on-disk case on
 * a case-insensitive FS). `desiredRelPaths` must contain no two paths differing
 * only by case (last-write-wins on the lookup would otherwise pick an arbitrary
 * canonical target).
 *
 * This makes projection self-cleaning: any renamed/recased/removed source file
 * leaves no orphan, with no per-rename bookkeeping.
 *
 * SAFETY / fail-open caveat: this DELETES. It is sound only for fully
 * Soma-generated, exclusively-owned dirs (no user files), because a file under
 * `root` that isn't in `desiredRelPaths` is treated as stale and removed with no
 * backup. A projection bug that drops a file from the desired set would silently
 * delete it — recoverable only via `soma snapshot`. Callers must pass the COMPLETE
 * projected set, never list a shared dir, and guard against an empty desired set.
 */
export async function reconcileOwnedDir(
  root: string,
  desiredRelPaths: readonly string[],
  options: { excludeRelPrefixes?: readonly string[] } = {},
): Promise<ReconcileResult> {
  const desired = new Set(desiredRelPaths);
  const desiredByLower = new Map<string, string>();
  for (const rel of desiredRelPaths) desiredByLower.set(rel.toLowerCase(), rel);
  const excluded = options.excludeRelPrefixes ?? [];

  const result: ReconcileResult = { removed: [], renamed: [] };

  for (const abs of await listFilesRecursive(root)) {
    const rel = relative(root, abs);
    if (desired.has(rel)) continue;
    // Subtrees managed by another installer (e.g. the edit-preserving VSA skill
    // projection nested under cursor's rules/soma) are left untouched.
    if (excluded.some((prefix) => isUnderOrEqual(rel, prefix))) continue;

    // Same file as a desired path under a different case (case-insensitive FS) →
    // normalize. Everything else — no canonical match, or a distinct wrong-case
    // file on a case-sensitive FS — is stale and removed.
    const canonical = desiredByLower.get(rel.toLowerCase());
    if (canonical !== undefined && (await sameFile(abs, join(root, canonical)))) {
      await caseNormalizeRename(abs, join(root, canonical));
      result.renamed.push(canonical);
      continue;
    }

    await rm(abs, { force: true });
    result.removed.push(rel);
  }

  await removeEmptyDirs(root, excluded.map((prefix) => join(root, prefix)));
  return result;
}
