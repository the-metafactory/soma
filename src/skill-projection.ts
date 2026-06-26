import { lstat, mkdir, readFile, readlink, rm, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { renderSkills } from "./adapters/shared";
import { buildSubstrateHomeProjection } from "./home-projection";
import type { InstallSubstrate } from "./install-spec";
import { installSpecFor } from "./install-spec-registry";
import { writeProjection } from "./projection";
import { loadSomaHome } from "./soma-home";
import type { ProjectionInput, SomaHomeProjectionOptions } from "./types";

/**
 * soma#354 slice 1 — the projection primitive.
 *
 * Materialises an invocable skill directory into one or more substrate skill
 * loaders (e.g. `~/.claude/skills/<Name>`) and refreshes the Soma skill catalog
 * (`rules/soma/SKILLS.md`) so the skill is both loadable AND listed. This is the
 * primitive `soma install --skills` and arc will delegate to in later #354 /
 * arc#251 slices, so soma can be the single projection truth (ADR 0002); this
 * slice ships the primitive only and does not yet wire those callers.
 *
 * Skills are linked, not copied: `~/.soma/skills/<Name>` (the registry the
 * catalog scans) and each substrate loader point at the source dir, so edits to
 * the source propagate with no re-sync. Reconciliation is scoped to the single
 * `<name>` slot: a differently-named skill is never touched. At that exact name,
 * an existing symlink is replaced unconditionally (a link loses no data), while a
 * real directory — a hand-made copy or a same-named user skill — is preserved
 * unless `force` is set. So a same-named user *symlink* is replaced; only a
 * same-named real *directory* is protected without `force`.
 */

export interface ProjectSkillOptions {
  /** Path to the source skill directory (must contain a SKILL.md). */
  skillDir: string;
  /** Substrates to project into. */
  substrates: InstallSubstrate[];
  homeDir?: string;
  somaHome?: string;
  /** Only valid with a single substrate. */
  substrateHome?: string;
  /**
   * Replace a real (non-symlink) directory occupying the skill's slot. Off by
   * default: a symlink Soma owns is always replaced, but a real dir we did not
   * create (a hand-authored skill, or a same-named user skill) is left intact
   * unless this is set — guarding against silent data loss on name collision.
   */
  force?: boolean;
}

export interface UnprojectSkillOptions {
  /** Source skill dir, or a bare skill name. */
  skill: string;
  substrates: InstallSubstrate[];
  homeDir?: string;
  somaHome?: string;
  substrateHome?: string;
  /** Remove a real (non-symlink) directory at the slot; off by default. */
  force?: boolean;
}

export type SkillLinkStatus = "linked" | "unchanged" | "replaced" | "removed" | "absent" | "preserved";

export interface SkillLink {
  scope: "registry" | "substrate";
  substrate?: InstallSubstrate;
  path: string;
  target?: string;
  status: SkillLinkStatus;
}

/** The registry + per-substrate loader symlinks created for one skill (no catalog). */
export interface LinkedSkillResult {
  skill: string;
  skillDir: string;
  links: SkillLink[];
}

export interface SkillProjectionResult extends LinkedSkillResult {
  catalogFiles: { substrate: InstallSubstrate; path: string }[];
  /** Set by unprojectSkill: whether a Soma-created registry symlink was removed. */
  registryRemoved?: boolean;
}

export interface SkillProjectionPlan {
  skill: string;
  skillDir: string;
  links: { scope: "registry" | "substrate"; substrate?: InstallSubstrate; path: string; target: string }[];
  catalogRefresh: InstallSubstrate[];
}

class SkillProjectionError extends Error {}

function resolveSomaHome(options: { homeDir?: string; somaHome?: string }): string {
  if (options.somaHome) return resolve(options.somaHome);
  return resolve(options.homeDir ?? homedir(), ".soma");
}

function registrySkillsDir(somaHome: string): string {
  return join(somaHome, "skills");
}

/** Per-substrate invocable skill loader root — owned by the adapter spec (soma#356). */
function substrateSkillsRoot(substrate: InstallSubstrate, substrateHome: string): string {
  return installSpecFor(substrate).skillsLoaderDir(substrateHome);
}

/**
 * The filesystem slots a skill occupies: the soma registry entry and one loader
 * entry per substrate. Single source of these paths so plan and apply can never
 * drift on how a loader root or registry slot is computed.
 */
function skillSlots(
  name: string,
  somaHome: string,
  substrates: InstallSubstrate[],
  options: { homeDir?: string; substrateHome?: string },
): { registry: string; substrates: { substrate: InstallSubstrate; path: string }[] } {
  return {
    registry: join(registrySkillsDir(somaHome), name),
    substrates: substrates.map((substrate) => ({
      substrate,
      path: join(substrateSkillsRoot(substrate, resolveSubstrateHome(substrate, options)), name),
    })),
  };
}

function resolveSubstrateHome(
  substrate: InstallSubstrate,
  options: { homeDir?: string; substrateHome?: string },
): string {
  if (options.substrateHome) return resolve(options.substrateHome);
  const homeDir = resolve(options.homeDir ?? homedir());
  return resolve(homeDir, installSpecFor(substrate).defaultHome);
}

function assertSafeSkillName(name: string): void {
  if (name.length === 0 || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new SkillProjectionError(`Unsafe skill name derived from frontmatter/dir: "${name}".`);
  }
}

/** Skill identity = frontmatter `name`, falling back to the dir basename. */
async function readSkillName(skillDir: string): Promise<string> {
  const skillMdPath = join(skillDir, "SKILL.md");
  let content: string;
  try {
    content = await readFile(skillMdPath, "utf8");
  } catch {
    throw new SkillProjectionError(`No SKILL.md found in skill dir: ${skillDir}`);
  }
  const match = /^name:\s*["']?(.+?)["']?\s*$/m.exec(content);
  const name = (match?.[1] ?? basename(skillDir)).trim();
  assertSafeSkillName(name);
  return name;
}

function assertSingleSubstrateForHome(options: { substrates: InstallSubstrate[]; substrateHome?: string }): void {
  if (options.substrateHome && options.substrates.length > 1) {
    throw new SkillProjectionError("--substrate-home is only valid with a single substrate.");
  }
}

async function ensureSymlink(
  linkPath: string,
  targetPath: string,
  force: boolean,
): Promise<"linked" | "unchanged" | "replaced"> {
  const target = resolve(targetPath);
  await mkdir(dirname(linkPath), { recursive: true });

  let existed = false;
  try {
    const stat = await lstat(linkPath);
    existed = true;
    if (stat.isSymbolicLink()) {
      const current = await readlink(linkPath);
      if (resolve(dirname(linkPath), current) === target) return "unchanged";
      // Any symlink in the slot is replaced without a provenance check — including
      // a user-created one pointing elsewhere. This is intentional: project-skill
      // owns the `<skillsRoot>/<name>` slot, and replacing a link loses no data
      // (its target dir is untouched). Real directories ARE the data-loss risk and
      // are guarded below by `force`.
    } else if (!force) {
      // A real dir/file we did not create: a hand-authored skill, or a same-named
      // user skill. Refuse to delete it silently — that is the data-loss path.
      throw new SkillProjectionError(
        `Refusing to replace non-symlink path at ${linkPath} (not a Soma-created symlink). ` +
          `Pass force to overwrite it.`,
      );
    }
    // Scoped to this single named path — unrelated skills are never touched.
    await rm(linkPath, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof SkillProjectionError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await symlink(target, linkPath);
  return existed ? "replaced" : "linked";
}

/**
 * Find the catalog file (SKILLS.md) within a substrate bundle without hard-coding
 * its per-substrate path: it is the file whose content equals `renderSkills(input)`.
 */
function findCatalogFile(
  substrate: InstallSubstrate,
  input: ProjectionInput,
  options: SomaHomeProjectionOptions,
): { path: string; content: string } | undefined {
  const expected = renderSkills(input);
  const bundle = buildSubstrateHomeProjection(substrate, input, options).bundle;
  return bundle.files.find((file) => file.content === expected);
}

export async function projectSkill(options: ProjectSkillOptions): Promise<SkillProjectionResult> {
  assertSingleSubstrateForHome(options);
  const somaHome = resolveSomaHome(options);
  const linked = await linkSkill(resolve(options.skillDir), somaHome, options.substrates, options.force ?? false, options);

  // Refresh the catalog once — reload so the registry scan reflects the new skill,
  // then rewrite only the SKILLS.md file.
  const catalogFiles = await refreshSkillCatalogs(somaHome, options.substrates, options);

  return { ...linked, catalogFiles };
}

/**
 * Project multiple skills into the same substrate(s) and refresh the catalog
 * ONCE (soma#358). Used by `install --skills` so an N-skill install pays the
 * catalog-rebuild cost a single time instead of per skill.
 */
export async function projectSkills(options: {
  skillDirs: string[];
  substrates: InstallSubstrate[];
  homeDir?: string;
  somaHome?: string;
  substrateHome?: string;
  force?: boolean;
}): Promise<{ skills: LinkedSkillResult[]; catalogFiles: { substrate: InstallSubstrate; path: string }[] }> {
  assertSingleSubstrateForHome(options);
  const somaHome = resolveSomaHome(options);
  const force = options.force ?? false;

  const skills: LinkedSkillResult[] = [];
  let catalogFiles: { substrate: InstallSubstrate; path: string }[];
  try {
    for (const dir of options.skillDirs) {
      skills.push(await linkSkill(resolve(dir), somaHome, options.substrates, force, options));
    }
  } finally {
    // Refresh once, in a finally: a mid-batch linkSkill failure still leaves the
    // catalog consistent with whatever was linked (the registry-scan reflects the
    // symlinks that succeeded), so a partial batch never strands a stale catalog.
    catalogFiles = await refreshSkillCatalogs(somaHome, options.substrates, options);
  }
  return { skills, catalogFiles };
}

/**
 * Create the registry + per-substrate loader symlinks for one skill, WITHOUT
 * refreshing the catalog. Callers refresh the catalog once after linking one or
 * many skills (single-skill: projectSkill; batch: projectSkills).
 */
async function linkSkill(
  skillDir: string,
  somaHome: string,
  substrates: InstallSubstrate[],
  force: boolean,
  options: { homeDir?: string; substrateHome?: string },
): Promise<LinkedSkillResult> {
  const name = await readSkillName(skillDir);
  const slots = skillSlots(name, somaHome, substrates, options);
  const links: SkillLink[] = [];

  // 1. Registry symlink in the soma home — the scan source the catalog reads.
  //    Skipped when the source already lives under the registry (authored in place).
  const sourceAlreadyInRegistry = dirname(skillDir) === resolve(registrySkillsDir(somaHome));
  if (!sourceAlreadyInRegistry) {
    const status = await ensureSymlink(slots.registry, skillDir, force);
    links.push({ scope: "registry", path: slots.registry, target: skillDir, status });
  }

  // 2. Loader symlink in each substrate.
  for (const { substrate, path } of slots.substrates) {
    const status = await ensureSymlink(path, skillDir, force);
    links.push({ scope: "substrate", substrate, path, target: skillDir, status });
  }

  return { skill: name, skillDir, links };
}

/**
 * Reload the soma home (so the registry scan reflects the current skill set) and
 * rewrite each substrate's SKILLS.md catalog in place. Shared by project and
 * unproject — a catalog-format change has a single site to track.
 */
async function refreshSkillCatalogs(
  somaHome: string,
  substrates: InstallSubstrate[],
  options: { homeDir?: string; substrateHome?: string },
): Promise<{ substrate: InstallSubstrate; path: string }[]> {
  const input = await loadSomaHome(somaHome);
  const catalogFiles: { substrate: InstallSubstrate; path: string }[] = [];
  for (const substrate of substrates) {
    const substrateHome = resolveSubstrateHome(substrate, options);
    const projectionOptions: SomaHomeProjectionOptions = { homeDir: options.homeDir, somaHome, substrateHome };
    const catalog = findCatalogFile(substrate, input, projectionOptions);
    if (!catalog) {
      // Every adapter emits a file byte-equal to renderSkills(input), so a miss
      // means the projection format drifted — surface it rather than silently
      // skipping the catalog refresh.
      process.stderr.write(`Warning: no SKILLS catalog file found for substrate ${substrate}; catalog not refreshed.\n`);
      continue;
    }
    const written = await writeProjection({ substrate, instructions: "", files: [catalog] }, substrateHome);
    catalogFiles.push({ substrate, path: written.files[0] ?? join(substrateHome, catalog.path) });
  }
  return catalogFiles;
}

export async function planProjectSkill(options: ProjectSkillOptions): Promise<SkillProjectionPlan> {
  assertSingleSubstrateForHome(options);
  const skillDir = resolve(options.skillDir);
  const name = await readSkillName(skillDir);
  const somaHome = resolveSomaHome(options);

  const slots = skillSlots(name, somaHome, options.substrates, options);
  const links: SkillProjectionPlan["links"] = [];
  if (dirname(skillDir) !== resolve(registrySkillsDir(somaHome))) {
    links.push({ scope: "registry", path: slots.registry, target: skillDir });
  }
  for (const { substrate, path } of slots.substrates) {
    links.push({ scope: "substrate", substrate, path, target: skillDir });
  }

  return { skill: name, skillDir, links, catalogRefresh: [...options.substrates] };
}

/**
 * Resolve an unproject arg to a skill name. Only probe the filesystem when the
 * arg looks path-like — otherwise a bare name like "MyTool" run from a dir that
 * happens to contain a "MyTool/" subdir would be misread as that local dir. Uses
 * `stat` (not `lstat`) so a registry symlink-to-dir resolves to a skill name
 * rather than falling through to a slash-bearing path.
 */
async function resolveSkillArg(arg: string): Promise<{ name: string; skillDir: string }> {
  let name = arg;
  let skillDir = "";
  const looksLikePath = arg.includes("/") || arg.includes("\\") || arg.startsWith(".") || isAbsolute(arg);
  if (looksLikePath) {
    const candidate = resolve(arg);
    try {
      const st = await stat(candidate);
      if (st.isDirectory()) {
        name = await readSkillName(candidate);
        skillDir = candidate;
      }
    } catch {
      // Path-like but absent — fall back to treating it as a bare name.
    }
  }
  assertSafeSkillName(name);
  return { name, skillDir };
}

export async function planUnprojectSkill(options: UnprojectSkillOptions): Promise<SkillProjectionPlan> {
  assertSingleSubstrateForHome(options);
  const somaHome = resolveSomaHome(options);
  const { name, skillDir } = await resolveSkillArg(options.skill);
  const force = options.force ?? false;
  const slots = skillSlots(name, somaHome, options.substrates, options);

  const links: SkillProjectionPlan["links"] = [];
  for (const { substrate, path } of slots.substrates) {
    links.push({ scope: "substrate", substrate, path, target: "" });
  }
  // List the registry only when it would actually be removed — a symlink Soma
  // owns, or (with --force) a real dir. An authored real dir left intact must
  // not appear as a removal.
  if (await registryWouldBeRemoved(slots.registry, force)) {
    links.push({ scope: "registry", path: slots.registry, target: "" });
  }

  return { skill: name, skillDir, links, catalogRefresh: [...options.substrates] };
}

/** True when unproject would remove the registry entry: a symlink, or a real dir under --force. */
async function registryWouldBeRemoved(registryDest: string, force: boolean): Promise<boolean> {
  try {
    const entry = await lstat(registryDest);
    return entry.isSymbolicLink() || force;
  } catch {
    return false;
  }
}

export async function unprojectSkill(options: UnprojectSkillOptions): Promise<SkillProjectionResult> {
  assertSingleSubstrateForHome(options);
  const somaHome = resolveSomaHome(options);
  const { name, skillDir } = await resolveSkillArg(options.skill);

  const force = options.force ?? false;
  const slots = skillSlots(name, somaHome, options.substrates, options);
  const links: SkillLink[] = [];

  // 1. Remove each substrate loader link.
  for (const { substrate, path } of slots.substrates) {
    const status = await removeLink(path, force);
    links.push({ scope: "substrate", substrate, path, status });
  }

  // 2. Remove the registry entry — a symlink Soma created always; a real
  //    authored dir (source of truth) only under --force, else preserved.
  let registryRemoved = false;
  try {
    const entry = await lstat(slots.registry);
    if (entry.isSymbolicLink() || force) {
      await rm(slots.registry, { recursive: true, force: true });
      registryRemoved = true;
      links.push({ scope: "registry", path: slots.registry, status: "removed" });
    } else {
      links.push({ scope: "registry", path: slots.registry, status: "preserved" });
    }
  } catch {
    links.push({ scope: "registry", path: slots.registry, status: "absent" });
  }

  // 3. Refresh the catalog — drops the skill only if the registry no longer has it.
  const catalogFiles = await refreshSkillCatalogs(somaHome, options.substrates, options);

  return { skill: name, skillDir, links, catalogFiles, registryRemoved };
}

async function removeLink(linkPath: string, force: boolean): Promise<"removed" | "absent"> {
  let stat;
  try {
    stat = await lstat(linkPath);
  } catch {
    return "absent";
  }
  if (!stat.isSymbolicLink() && !force) {
    // A real dir we did not create (not our symlink) — don't recurse-delete it.
    throw new SkillProjectionError(
      `Refusing to remove non-symlink path at ${linkPath} (not a Soma-created symlink). Pass force to override.`,
    );
  }
  await rm(linkPath, { recursive: true, force: true });
  return "removed";
}
