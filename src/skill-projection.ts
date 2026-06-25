import { lstat, mkdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { renderSkills } from "./adapters/shared";
import {
  buildClaudeCodeHomeProjection,
  buildCodexHomeProjection,
  buildCursorHomeProjection,
  buildGrokHomeProjection,
  buildPiDevHomeProjection,
} from "./home-projection";
import type { InstallSubstrate } from "./install-spec";
import { installSpecFor } from "./install-spec-registry";
import { writeProjection } from "./projection";
import { loadSomaHome } from "./soma-home";
import type { ProjectionInput, SomaHomeProjection, SomaHomeProjectionOptions } from "./types";

/**
 * soma#354 slice 1 — the projection primitive.
 *
 * Materialises an invocable skill directory into one or more substrate skill
 * loaders (e.g. `~/.claude/skills/<Name>`) and refreshes the Soma skill catalog
 * (`rules/soma/SKILLS.md`) so the skill is both loadable AND listed. The unit
 * `soma install --skills`, and arc, both delegate to this — soma stays the
 * single projection truth (ADR 0002).
 *
 * Skills are linked, not copied: `~/.soma/skills/<Name>` (the registry the
 * catalog scans) and each substrate loader point at the source dir, so edits to
 * the source propagate with no re-sync. Reconciliation is scoped to the skill's
 * own name — a pre-existing copy at that name (e.g. the hand-made VSA/Interview
 * dirs) is replaced; unrelated user skills are never touched.
 */

const projectionBuilders: Record<
  InstallSubstrate,
  (input: ProjectionInput, options: SomaHomeProjectionOptions) => SomaHomeProjection
> = {
  codex: buildCodexHomeProjection,
  "pi-dev": buildPiDevHomeProjection,
  "claude-code": buildClaudeCodeHomeProjection,
  cursor: buildCursorHomeProjection,
  grok: buildGrokHomeProjection,
};

export interface ProjectSkillOptions {
  /** Path to the source skill directory (must contain a SKILL.md). */
  skillDir: string;
  /** Substrates to project into. */
  substrates: InstallSubstrate[];
  homeDir?: string;
  somaHome?: string;
  /** Only valid with a single substrate. */
  substrateHome?: string;
}

export interface UnprojectSkillOptions {
  /** Source skill dir, or a bare skill name. */
  skill: string;
  substrates: InstallSubstrate[];
  homeDir?: string;
  somaHome?: string;
  substrateHome?: string;
}

export type SkillLinkStatus = "linked" | "unchanged" | "replaced" | "removed" | "absent";

export interface SkillLink {
  scope: "registry" | "substrate";
  substrate?: InstallSubstrate;
  path: string;
  target?: string;
  status: SkillLinkStatus;
}

export interface SkillProjectionResult {
  skill: string;
  skillDir: string;
  links: SkillLink[];
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

/** Per-substrate invocable skill loader root (parent of the VSA skill dir). */
function substrateSkillsRoot(substrate: InstallSubstrate, substrateHome: string): string {
  return dirname(installSpecFor(substrate).vsaSkillProjection.destinationDir(substrateHome));
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

async function ensureSymlink(linkPath: string, targetPath: string): Promise<"linked" | "unchanged" | "replaced"> {
  const target = resolve(targetPath);
  await mkdir(dirname(linkPath), { recursive: true });

  let existed = false;
  try {
    const stat = await lstat(linkPath);
    existed = true;
    if (stat.isSymbolicLink()) {
      const current = await readlink(linkPath);
      if (resolve(dirname(linkPath), current) === target) return "unchanged";
    }
    // Our skill name, our slot: a stale symlink or a hand-made copy is replaced.
    // Reconciliation is scoped to this single path — unrelated skills untouched.
    await rm(linkPath, { recursive: true, force: true });
  } catch (error) {
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
  const bundle = projectionBuilders[substrate](input, options).bundle;
  return bundle.files.find((file) => file.content === expected);
}

export async function projectSkill(options: ProjectSkillOptions): Promise<SkillProjectionResult> {
  assertSingleSubstrateForHome(options);
  const skillDir = resolve(options.skillDir);
  const name = await readSkillName(skillDir);
  const somaHome = resolveSomaHome(options);

  const links: SkillLink[] = [];

  // 1. Registry symlink in the soma home — the scan source the catalog reads.
  //    Skipped when the source already lives under the registry (authored in place).
  const registryDir = registrySkillsDir(somaHome);
  const registryDest = join(registryDir, name);
  const sourceAlreadyInRegistry = dirname(skillDir) === resolve(registryDir);
  if (!sourceAlreadyInRegistry) {
    const status = await ensureSymlink(registryDest, skillDir);
    links.push({ scope: "registry", path: registryDest, target: skillDir, status });
  }

  // 2. Loader symlink in each substrate.
  for (const substrate of options.substrates) {
    const substrateHome = resolveSubstrateHome(substrate, options);
    const dest = join(substrateSkillsRoot(substrate, substrateHome), name);
    const status = await ensureSymlink(dest, skillDir);
    links.push({ scope: "substrate", substrate, path: dest, target: skillDir, status });
  }

  // 3. Refresh the catalog per substrate — reload so the registry scan now
  //    includes the new skill, then rewrite only the SKILLS.md file.
  const input = await loadSomaHome(somaHome);
  const catalogFiles: { substrate: InstallSubstrate; path: string }[] = [];
  for (const substrate of options.substrates) {
    const substrateHome = resolveSubstrateHome(substrate, options);
    const projectionOptions: SomaHomeProjectionOptions = { homeDir: options.homeDir, somaHome, substrateHome };
    const catalog = findCatalogFile(substrate, input, projectionOptions);
    if (!catalog) continue;
    const written = await writeProjection({ substrate, instructions: "", files: [catalog] }, substrateHome);
    catalogFiles.push({ substrate, path: written.files[0] ?? join(substrateHome, catalog.path) });
  }

  return { skill: name, skillDir, links, catalogFiles };
}

export async function planProjectSkill(options: ProjectSkillOptions): Promise<SkillProjectionPlan> {
  assertSingleSubstrateForHome(options);
  const skillDir = resolve(options.skillDir);
  const name = await readSkillName(skillDir);
  const somaHome = resolveSomaHome(options);

  const links: SkillProjectionPlan["links"] = [];
  const registryDir = registrySkillsDir(somaHome);
  if (dirname(skillDir) !== resolve(registryDir)) {
    links.push({ scope: "registry", path: join(registryDir, name), target: skillDir });
  }
  for (const substrate of options.substrates) {
    const substrateHome = resolveSubstrateHome(substrate, options);
    links.push({
      scope: "substrate",
      substrate,
      path: join(substrateSkillsRoot(substrate, substrateHome), name),
      target: skillDir,
    });
  }

  return { skill: name, skillDir, links, catalogRefresh: [...options.substrates] };
}

export async function unprojectSkill(options: UnprojectSkillOptions): Promise<SkillProjectionResult> {
  assertSingleSubstrateForHome(options);
  const somaHome = resolveSomaHome(options);

  // Resolve the skill name: from a source dir if the arg is one, else verbatim.
  let name = options.skill;
  let skillDir = "";
  const candidate = resolve(options.skill);
  try {
    const stat = await lstat(candidate);
    if (stat.isDirectory()) {
      name = await readSkillName(candidate);
      skillDir = candidate;
    }
  } catch {
    // Not a path — treat as a bare skill name.
  }
  assertSafeSkillName(name);

  const links: SkillLink[] = [];

  // 1. Remove each substrate loader link.
  for (const substrate of options.substrates) {
    const substrateHome = resolveSubstrateHome(substrate, options);
    const dest = join(substrateSkillsRoot(substrate, substrateHome), name);
    const status = await removeLink(dest);
    links.push({ scope: "substrate", substrate, path: dest, status });
  }

  // 2. Remove the registry symlink — only if it IS a symlink Soma created.
  //    An authored real dir (source of truth) is left intact.
  const registryDest = join(registrySkillsDir(somaHome), name);
  let registryRemoved = false;
  try {
    const stat = await lstat(registryDest);
    if (stat.isSymbolicLink()) {
      await rm(registryDest, { force: true });
      registryRemoved = true;
      links.push({ scope: "registry", path: registryDest, status: "removed" });
    } else {
      links.push({ scope: "registry", path: registryDest, status: "absent" });
    }
  } catch {
    links.push({ scope: "registry", path: registryDest, status: "absent" });
  }

  // 3. Refresh the catalog — drops the skill only if the registry no longer has it.
  const input = await loadSomaHome(somaHome);
  const catalogFiles: { substrate: InstallSubstrate; path: string }[] = [];
  for (const substrate of options.substrates) {
    const substrateHome = resolveSubstrateHome(substrate, options);
    const projectionOptions: SomaHomeProjectionOptions = { homeDir: options.homeDir, somaHome, substrateHome };
    const catalog = findCatalogFile(substrate, input, projectionOptions);
    if (!catalog) continue;
    const written = await writeProjection({ substrate, instructions: "", files: [catalog] }, substrateHome);
    catalogFiles.push({ substrate, path: written.files[0] ?? join(substrateHome, catalog.path) });
  }

  return { skill: name, skillDir, links, catalogFiles, registryRemoved };
}

async function removeLink(linkPath: string): Promise<"removed" | "absent"> {
  try {
    await lstat(linkPath);
  } catch {
    return "absent";
  }
  await rm(linkPath, { recursive: true, force: true });
  return "removed";
}
