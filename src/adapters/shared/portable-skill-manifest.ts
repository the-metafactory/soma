import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isEnoent } from "../../fs-errors";

/**
 * The substrates this manifest serves: ONLY those whose skills land in a SHARED
 * skills dir (see the module doc). cursor/pi-dev project into an owned subtree
 * and codex's uninstall is reserved — none use this manifest, so narrowing the
 * type stops a future caller from wiring the manifest to a substrate whose
 * lifecycle it does not fit.
 */
export type PortableSkillManifestSubstrate = "grok" | "claude-code";

/**
 * Portable Soma skills project under dynamic `skills/<name>/` paths (inside a
 * SHARED skills dir that may also hold principal-authored skills), so a substrate's
 * static uninstall `remove` list cannot name them and the owned-subtree
 * reconcile cannot own their dir. Install records what it wrote — paths plus
 * content hashes — in a manifest on the SOMA side (`<somaHome>/projections/
 * <substrate>/<substrateHomeHash>/`), and uninstall consumes it to round-trip
 * the portable skills. The path is keyed by a short hash of the resolved
 * substrate home (soma#438) so two homes of the same substrate installed
 * from one soma home get independent manifests instead of silently sharing
 * (and clobbering) one.
 *
 * The manifest lives outside the substrate home on purpose: every Soma-owned
 * directory under the substrate home is itself removed during uninstall, and
 * `postRemove` (the only dynamic uninstall hook) runs after those removals — a
 * manifest stored among them would already be gone.
 *
 * Substrates whose skills land INSIDE an owned subtree (e.g. cursor's
 * `.cursor/rules/soma/skills/`) do not need this: the install-time
 * `reconcileOwnedSubtrees` prunes their stale skills and the subtree's
 * uninstall `remove` entry covers them. This module is for substrates with a
 * shared skills dir (grok, claude-code).
 */
export function portableSkillManifestSchema(substrate: PortableSkillManifestSubstrate): string {
  return `soma-${substrate}-install-manifest-v1`;
}

export interface PortableSkillManifest {
  schema: string;
  /** Absolute substrate home the manifest describes — uninstall ignores the manifest when homes differ. */
  substrateHome: string;
  files: { path: string; sha256: string }[];
}

/**
 * A stable short hash of the RESOLVED substrate home, used to scope the
 * manifest path per home (soma#438): two homes of the same substrate
 * installed from one soma home (e.g. `--substrate-home ~/.claude` and
 * `--substrate-home ~/claude-fresh`) must not share one manifest file, or
 * uninstalling one silently orphans the other's projected skill dirs.
 */
function substrateHomeSegment(substrateHome: string): string {
  return createHash("sha256").update(resolve(substrateHome), "utf8").digest("hex").slice(0, 12);
}

export function portableSkillManifestPath(
  somaHome: string,
  substrate: PortableSkillManifestSubstrate,
  substrateHome: string,
): string {
  return join(somaHome, "projections", substrate, substrateHomeSegment(substrateHome), "install-manifest.json");
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function writePortableSkillManifest(options: {
  somaHome: string;
  substrate: PortableSkillManifestSubstrate;
  substrateHome: string;
  files: readonly { path: string; content: string }[];
}): Promise<string> {
  const manifest: PortableSkillManifest = {
    schema: portableSkillManifestSchema(options.substrate),
    substrateHome: resolve(options.substrateHome),
    // writeProjection writes bundle content verbatim, so hashing the
    // bundle content here equals hashing the on-disk bytes.
    files: options.files.map((file) => ({ path: file.path, sha256: contentHash(file.content) })),
  };
  const path = portableSkillManifestPath(options.somaHome, options.substrate, options.substrateHome);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

function parseManifest(raw: string, substrate: PortableSkillManifestSubstrate): PortableSkillManifest | null {
  const schema = portableSkillManifestSchema(substrate);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schema !== schema || typeof record.substrateHome !== "string" || !Array.isArray(record.files)) {
    return null;
  }
  const files = record.files.filter(
    (entry): entry is { path: string; sha256: string } =>
      typeof entry === "object" && entry !== null &&
      typeof (entry as Record<string, unknown>).path === "string" &&
      typeof (entry as Record<string, unknown>).sha256 === "string",
  );
  return { schema, substrateHome: record.substrateHome, files };
}

function isInsideRoot(root: string, target: string): boolean {
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target !== root && target.startsWith(rootPrefix);
}

interface SymlinkIdentity {
  path: string;
  dev: number;
  ino: number;
}

/** Find a directory symlink above a manifest-recorded file without following it. */
async function symlinkAncestor(root: string, target: string): Promise<SymlinkIdentity | undefined> {
  for (let dir = dirname(target); isInsideRoot(root, dir); dir = dirname(dir)) {
    try {
      const entry = await lstat(dir);
      if (entry.isSymbolicLink()) return { path: dir, dev: entry.dev, ino: entry.ino };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A missing path or a non-directory ancestor can be the result of another
      // manifest entry already removing the same migrated slot. Keep walking so
      // a higher symlink ancestor can still be identified.
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return undefined;
}

/** A migrated loader slot is owned only when it still points into Soma's skill registry. */
async function isSomaRegistryLink(linkPath: string, somaHome: string): Promise<boolean> {
  const registryRoot = join(resolve(somaHome), "skills");
  const target = resolve(dirname(linkPath), await readlink(linkPath));
  return target !== registryRoot && target.startsWith(`${registryRoot}${sep}`);
}

export async function readPortableSkillManifest(
  somaHome: string,
  substrate: PortableSkillManifestSubstrate,
  substrateHome: string,
): Promise<PortableSkillManifest | null> {
  let raw: string;
  try {
    raw = await readFile(portableSkillManifestPath(somaHome, substrate, substrateHome), "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  return parseManifest(raw, substrate);
}

/**
 * Shared guarded-removal core for uninstall and install-time
 * reconciliation: remove the listed files from the substrate home,
 * skipping anything outside the root (tampered manifest), anything
 * missing, and anything whose bytes no longer match the install-time
 * hash (principal-edited). Emptied directories are pruned deepest-first with
 * a non-recursive rmdir, so principal-added files keep their dirs alive.
 */
async function removeListedProjectionFiles(
  somaHome: string,
  substrateHome: string,
  files: readonly { path: string; sha256: string }[],
): Promise<string[]> {
  const removed: string[] = [];
  const candidateDirs = new Set<string>();
  for (const file of files) {
    const target = resolve(substrateHome, file.path);
    if (!isInsideRoot(substrateHome, target)) continue;

    // Copy-era manifests name files below skill directories. Loader-mode
    // migration may have replaced such a directory with a symlink. Reading the
    // recorded file first would follow that link and rm() would delete registry
    // content. Remove the slot link itself before touching any recorded child.
    const linkedDir = await symlinkAncestor(substrateHome, target);
    if (linkedDir !== undefined) {
      // The substrate's top-level directories are shared surfaces, not
      // manifest-owned skill slots. A nested symlink is also principal state
      // unless its target proves it is the loader link Soma projected.
      if (dirname(linkedDir.path) === substrateHome || !(await isSomaRegistryLink(linkedDir.path, somaHome))) continue;
      try {
        // Narrow the lstat→unlink race: only unlink the same symlink inode we
        // classified. A swapped regular file or replacement link is user state,
        // so this manifest entry fails open instead of deleting it.
        const current = await lstat(linkedDir.path);
        if (!current.isSymbolicLink() || current.dev !== linkedDir.dev || current.ino !== linkedDir.ino) continue;
        await unlink(linkedDir.path);
        removed.push(linkedDir.path);
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      for (let dir = dirname(linkedDir.path); isInsideRoot(substrateHome, dir); dir = dirname(dir)) {
        candidateDirs.add(dir);
      }
      continue;
    }

    let content: string;
    try {
      content = await readFile(target, "utf8");
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    if (contentHash(content) !== file.sha256) continue;
    await rm(target, { force: true });
    removed.push(target);
    for (let dir = dirname(target); isInsideRoot(substrateHome, dir); dir = dirname(dir)) {
      candidateDirs.add(dir);
    }
  }

  // Deepest-first so nested dirs empty out before their parents.
  for (const dir of [...candidateDirs].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(dir);
      removed.push(dir);
    } catch (error) {
      // ENOTEMPTY (unmanaged/principal content still present) and ENOENT (already
      // gone) are expected — keep the dir and continue. Anything else
      // (EACCES/EPERM/EBUSY/…) is a real filesystem fault and must surface,
      // not be silently masked as a keep.
      const code = (error as { code?: string } | null)?.code;
      if (code !== "ENOTEMPTY" && code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return removed;
}

/**
 * Install-time reconciliation: remove projected portable-skill files the
 * PREVIOUS install recorded that the CURRENT projection no longer
 * contains (a skill removed or renamed in the Soma profile would
 * otherwise stay orphaned in the substrate home until uninstall). Same
 * guards as uninstall; the caller overwrites the manifest right after, so
 * this does not consume it.
 */
export async function reconcilePortableSkillProjection(options: {
  somaHome: string;
  substrate: PortableSkillManifestSubstrate;
  substrateHome: string;
  currentPaths: readonly string[];
}): Promise<string[]> {
  const manifest = await readPortableSkillManifest(options.somaHome, options.substrate, options.substrateHome);
  if (manifest === null) return [];
  const substrateHome = resolve(options.substrateHome);
  if (resolve(manifest.substrateHome) !== substrateHome) return [];
  const current = new Set(options.currentPaths);
  const stale = manifest.files.filter((file) => !current.has(file.path));
  return removeListedProjectionFiles(options.somaHome, substrateHome, stale);
}

/**
 * Remove the manifest-listed portable-skill files from the substrate
 * home, then consume the manifest. Safety properties, in order:
 *   - no manifest / malformed manifest → no-op (pre-manifest installs).
 *   - manifest for a DIFFERENT substrate home → no-op, manifest kept
 *     (e.g. a workspace uninstall must not consume the home install's
 *     record).
 *   - a listed path resolving outside the substrate home (tampered
 *     manifest) → skipped.
 *   - on-disk bytes differing from the install-time hash (principal-edited
 *     file) → preserved, mirroring the local-edits-preserved contract.
 *   - principal files ADDED inside a portable skill dir survive: only listed
 *     files are removed, and emptied directories are pruned with a
 *     non-recursive rmdir that fails closed on ENOTEMPTY.
 */
export async function removePortableSkillProjection(options: {
  somaHome: string;
  substrate: PortableSkillManifestSubstrate;
  substrateHome: string;
}): Promise<string[]> {
  const manifest = await readPortableSkillManifest(options.somaHome, options.substrate, options.substrateHome);
  if (manifest === null) return [];
  const substrateHome = resolve(options.substrateHome);
  if (resolve(manifest.substrateHome) !== substrateHome) return [];

  const removed = await removeListedProjectionFiles(options.somaHome, substrateHome, manifest.files);
  const manifestPath = portableSkillManifestPath(options.somaHome, options.substrate, options.substrateHome);
  await rm(manifestPath, { force: true });
  removed.push(manifestPath);
  return removed;
}
