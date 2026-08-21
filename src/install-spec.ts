import { resolve } from "node:path";
import type { InstallSubstrate, ProjectionSubstrate } from "./types";

export type { InstallSubstrate } from "./types";

export interface LifecycleProjectionSpec {
  startupContextPath: string;
  somaRepoPathPath?: string;
}

export interface InstallPostProjectionContext {
  homeDir?: string;
  somaHome: string;
  somaRepoPath: string;
  substrateHome: string;
  options?: unknown;
}

export interface InstallPostProjectionStep {
  name: string;
  run(context: InstallPostProjectionContext): Promise<string[]>;
}

export interface VsaSkillProjectionSpec {
  destinationDir(substrateHome: string): string;
  skillNameOverride?: string;
  prepare?(substrateHome: string): Promise<void>;
}

export function vsaSkillUnder(...pathSegments: string[]): (substrateHome: string) => string {
  return (substrateHome) => resolve(substrateHome, ...pathSegments, "skills/VSA");
}

/**
 * Builds a substrate's invocable skill-loader root resolver — the directory a
 * substrate scans for skill dirs (parent of where any one skill is projected).
 * soma#356: `project-skill` asks the adapter spec for this rather than deriving
 * it from the VSA skill destination, keeping the loader-path contract owned by
 * the adapter.
 */
export function skillsLoaderUnder(...pathSegments: string[]): (substrateHome: string) => string {
  return (substrateHome) => resolve(substrateHome, ...pathSegments, "skills");
}

/**
 * How a substrate's skill loader pulls a projected skill into model context.
 *
 * - `on-demand` — the loader keeps a skill's body out of context until the skill
 *   is invoked (Claude Code's Skill tool; Codex's route-time load). Bodies are
 *   projected as symlinks: the loader reads the real file only when it needs it.
 * - `eager` — the loader reads every projected `SKILL.md` at session start.
 *   Symlinking N bodies there costs N bodies of context before the first turn
 *   (~200K tokens across the current 114-skill home), so projection writes a
 *   frontmatter-only stub instead and the substrate resolves the body on trigger.
 *
 * soma#542: this is a property of the substrate's *loader*, not of any skill,
 * which is why it lives on the adapter spec and not in skill frontmatter. A
 * `scope`-style field per skill would encode one substrate's limitation into
 * every portable skill file, and would need re-curating whenever a substrate
 * changed its loader.
 */
export type SkillsLoadingMode = "on-demand" | "eager";

/**
 * How a substrate discovers *which* skills exist — distinct from
 * {@link SkillsLoadingMode}, which is about when a discovered skill's BODY enters
 * context.
 *
 * - `loader` — the harness advertises the contents of
 *   {@link SubstrateInstallSpec.skillsLoaderDir} itself (Claude Code's Skill tool
 *   lists every `~/.claude/skills/<name>/SKILL.md` by name + description). Soma emits
 *   NO catalog: a second list is paid for on every turn, and — because the
 *   catalog names skills by their `~/.soma/skills` dir while the harness
 *   registers the loader dir name — it advertises names the harness cannot
 *   resolve (`red-team` vs `RedTeam`).
 * - `catalog` — the loader does not advertise what it holds, so the projected
 *   catalog IS the discovery mechanism rather than a duplicate of one.
 *
 * soma#638: a property of the substrate's loader, like `skillsLoading`, so it
 * lives on the adapter spec. Default to `catalog` for a substrate whose native
 * discovery has not been verified — an extra list is wasteful, a missing one is
 * a capability regression.
 */
export type SkillsDiscoveryMode = "loader" | "catalog";

export type InstallValidator = (substrateRoot: string) => Promise<void>;

export interface UninstallContext {
  homeDir?: string;
  /** Explicit soma home override; adapters fall back to `<homeDir>/.soma` when absent. */
  somaHome?: string;
  substrateHome: string;
}

export interface ReservedUninstallSpec {
  kind: "reserved";
  reason: string;
}

export interface ImplementedUninstallSpec {
  kind: "implemented";
  remove: readonly string[];
  shouldRemove?(target: string, context: UninstallContext): Promise<boolean>;
  postRemove?(context: UninstallContext): Promise<string[]>;
}

export type UninstallSpec = ReservedUninstallSpec | ImplementedUninstallSpec;

export interface PrivateRootOptions {
  homeDir?: string;
  substrate?: ProjectionSubstrate;
  substrateHome?: string;
}

export interface PrivateRootSpec {
  projection?(options?: PrivateRootOptions): string[];
  memory?(options?: PrivateRootOptions): string[];
}

export interface SubstrateInstallSpec<S extends InstallSubstrate = InstallSubstrate> {
  substrate: S;
  defaultHome: string;
  homeFiles: readonly string[];
  /**
   * Files this substrate used to manage but no longer writes (e.g. a renamed
   * projection). Removed under the substrate home on every install/reproject/
   * upgrade so a stale, auto-loaded copy can't survive a rename. Paths are
   * relative to the substrate home, same as `homeFiles`.
   */
  obsoleteHomeFiles?: readonly string[];
  /**
   * Directories under the substrate home that Soma OWNS exclusively (every file
   * inside is a Soma projection). After projecting, each owned subtree is
   * reconciled to exactly the projected file set — any file Soma no longer emits
   * is removed and case is normalized — so a renamed/recased/removed projection
   * leaves no orphan, identically on case-sensitive and case-insensitive
   * filesystems. Do NOT list shared dirs (those holding non-Soma files). Paths
   * are relative to the substrate home, same as `homeFiles`.
   */
  ownedSubtrees?: readonly string[];
  optionalHomeFiles?(options: unknown): readonly string[];
  vsaSkillProjection: VsaSkillProjectionSpec;
  /**
   * The substrate's invocable skill-loader root (parent of where individual
   * skills are projected). Owned by the adapter so `project-skill` (soma#356)
   * does not derive loader paths from the VSA skill destination.
   */
  skillsLoaderDir(substrateHome: string): string;
  /**
   * Whether this substrate's loader keeps skill bodies out of context until a
   * skill is invoked. Drives how `project-skill` materialises a skill into
   * {@link SubstrateInstallSpec.skillsLoaderDir}: `on-demand` symlinks the body,
   * `eager` writes a frontmatter-only stub pointing at it (soma#542).
   */
  skillsLoading: SkillsLoadingMode;
  /**
   * Whether this substrate needs Soma to project an eager skill catalog, or its
   * own loader already advertises what it holds (soma#638). See
   * {@link SkillsDiscoveryMode}.
   */
  skillsDiscovery: SkillsDiscoveryMode;
  validator?: InstallValidator;
  lifecycleProjection?: LifecycleProjectionSpec;
  postProjection?: readonly InstallPostProjectionStep[];
  privateRoots?: PrivateRootSpec;
  uninstall: UninstallSpec;
}
