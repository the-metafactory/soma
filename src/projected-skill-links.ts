import { readdir, readlink, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Removal of the loader symlinks an install projected — kept in its own module,
 * importing nothing from the adapter registry.
 *
 * soma#638: uninstall needs this, so the callers are `SubstrateInstallSpec`
 * definitions. Those specs ARE the registry's members, so anything they import
 * must not import the registry back: `src/skill-projection.ts` does (for
 * `installSpecFor`), and importing it from a spec closes a cycle that TDZ-errors
 * at module init — silently, for whichever spec the registry happens to
 * initialise second. Taking `loaderDir` as a parameter removes the need for the
 * lookup: a spec already computes its own loader dir via `skillsLoaderUnder()`.
 */
export async function removeProjectedSkillLinks(options: {
  /** The substrate's invocable skill-loader root — `spec.skillsLoaderDir(substrateHome)`. */
  loaderDir: string;
  /** Soma home whose `skills/` registry the projected links point into. */
  somaHome: string;
}): Promise<string[]> {
  const loaderDir = resolve(options.loaderDir);
  const registryRoot = join(resolve(options.somaHome), "skills");
  let entries;
  try {
    entries = await readdir(loaderDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const linkPath = join(loaderDir, entry.name);
    const target = resolve(dirname(linkPath), await readlink(linkPath).catch(() => ""));
    // Identified by TARGET, not by the install manifest: the manifest only records
    // files the projection WROTE, and these are symlinks the projection primitive
    // created, so uninstall had nothing to consume and orphaned them. A loader
    // symlink pointing into the soma skills registry is unambiguously ours, which
    // holds even when a manifest is missing or stale.
    //
    // The `sep` guard matters: without it `<somaHome>/skills-backup` would read as
    // inside `<somaHome>/skills` and a user's own link would be removed.
    if (target !== registryRoot && !target.startsWith(`${registryRoot}${sep}`)) continue;
    await rm(linkPath, { force: true });
    removed.push(linkPath);
  }
  return removed;
}
