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

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
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
 */
export async function reconcileOwnedDir(root: string, desiredRelPaths: readonly string[]): Promise<ReconcileResult> {
  const desired = new Set(desiredRelPaths);
  const desiredByLower = new Map<string, string>();
  for (const rel of desiredRelPaths) desiredByLower.set(rel.toLowerCase(), rel);

  const result: ReconcileResult = { removed: [], renamed: [] };

  for (const abs of await listFilesRecursive(root)) {
    const rel = relative(root, abs);
    if (desired.has(rel)) continue;

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
