import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error; // never let a transient stat error route a file to deletion
  }
}

async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([statOrEnoent(a), statOrEnoent(b)]);
  return sa !== undefined && sb !== undefined && sa.ino === sb.ino && sa.dev === sb.dev;
}

async function removeEmptyDirs(root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirs(join(root, entry.name));
  }
  try {
    if ((await readdir(root)).length === 0) await rm(root, { force: true, recursive: true });
  } catch {
    // best-effort cleanup
  }
}

export interface ReconcileResult {
  removed: string[];
  renamed: string[];
}

/** True when `path` equals `base` or is nested under it (path-segment aware). */
export function isUnderOrEqual(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
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

    const canonical = desiredByLower.get(rel.toLowerCase());
    if (canonical !== undefined) {
      const canonicalAbs = join(root, canonical);
      if (await sameFile(abs, canonicalAbs)) {
        // Case-insensitive FS: `abs` and the canonical path are the same file,
        // already holding the freshly-projected content — just fix the casing.
        const tmp = join(dirname(canonicalAbs), `.soma-case.${basename(canonicalAbs)}.tmp`);
        await rename(abs, tmp);
        await mkdir(dirname(canonicalAbs), { recursive: true });
        await rename(tmp, canonicalAbs);
        result.renamed.push(canonical);
      } else {
        // Case-sensitive FS: a distinct stale wrong-case file → remove it.
        await rm(abs, { force: true });
        result.removed.push(rel);
      }
      continue;
    }

    await rm(abs, { force: true });
    result.removed.push(rel);
  }

  await removeEmptyDirs(root);
  return result;
}
