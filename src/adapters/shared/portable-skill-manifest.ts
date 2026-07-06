import { createHash } from "node:crypto";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isEnoent } from "../../fs-errors";
import type { InstallSubstrate } from "../../install-spec";

/**
 * Portable Soma skills project under dynamic `skills/<name>/` paths (inside a
 * SHARED skills dir that may also hold user-authored skills), so a substrate's
 * static uninstall `remove` list cannot name them and the owned-subtree
 * reconcile cannot own their dir. Install records what it wrote — paths plus
 * content hashes — in a manifest on the SOMA side (`<somaHome>/projections/
 * <substrate>/`), and uninstall consumes it to round-trip the portable skills.
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
export function portableSkillManifestSchema(substrate: InstallSubstrate): string {
  return `soma-${substrate}-install-manifest-v1`;
}

export interface PortableSkillManifest {
  schema: string;
  /** Absolute substrate home the manifest describes — uninstall ignores the manifest when homes differ. */
  substrateHome: string;
  files: { path: string; sha256: string }[];
}

export function portableSkillManifestPath(somaHome: string, substrate: InstallSubstrate): string {
  return join(somaHome, "projections", substrate, "install-manifest.json");
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function writePortableSkillManifest(options: {
  somaHome: string;
  substrate: InstallSubstrate;
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
  const path = portableSkillManifestPath(options.somaHome, options.substrate);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

function parseManifest(raw: string, substrate: InstallSubstrate): PortableSkillManifest | null {
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

export async function readPortableSkillManifest(
  somaHome: string,
  substrate: InstallSubstrate,
): Promise<PortableSkillManifest | null> {
  let raw: string;
  try {
    raw = await readFile(portableSkillManifestPath(somaHome, substrate), "utf8");
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
 * hash (user-edited). Emptied directories are pruned deepest-first with
 * a non-recursive rmdir, so user-added files keep their dirs alive.
 */
async function removeListedProjectionFiles(
  substrateHome: string,
  files: readonly { path: string; sha256: string }[],
): Promise<string[]> {
  const removed: string[] = [];
  const candidateDirs = new Set<string>();
  for (const file of files) {
    const target = resolve(substrateHome, file.path);
    if (!isInsideRoot(substrateHome, target)) continue;
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
    } catch {
      // ENOTEMPTY (user content), ENOENT, or anything else: keep the dir.
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
  substrate: InstallSubstrate;
  substrateHome: string;
  currentPaths: readonly string[];
}): Promise<string[]> {
  const manifest = await readPortableSkillManifest(options.somaHome, options.substrate);
  if (manifest === null) return [];
  const substrateHome = resolve(options.substrateHome);
  if (resolve(manifest.substrateHome) !== substrateHome) return [];
  const current = new Set(options.currentPaths);
  const stale = manifest.files.filter((file) => !current.has(file.path));
  return removeListedProjectionFiles(substrateHome, stale);
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
 *   - on-disk bytes differing from the install-time hash (user-edited
 *     file) → preserved, mirroring the local-edits-preserved contract.
 *   - user files ADDED inside a portable skill dir survive: only listed
 *     files are removed, and emptied directories are pruned with a
 *     non-recursive rmdir that fails closed on ENOTEMPTY.
 */
export async function removePortableSkillProjection(options: {
  somaHome: string;
  substrate: InstallSubstrate;
  substrateHome: string;
}): Promise<string[]> {
  const manifest = await readPortableSkillManifest(options.somaHome, options.substrate);
  if (manifest === null) return [];
  const substrateHome = resolve(options.substrateHome);
  if (resolve(manifest.substrateHome) !== substrateHome) return [];

  const removed = await removeListedProjectionFiles(substrateHome, manifest.files);
  const manifestPath = portableSkillManifestPath(options.somaHome, options.substrate);
  await rm(manifestPath, { force: true });
  removed.push(manifestPath);
  return removed;
}
