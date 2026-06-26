import { resolve } from "node:path";
import type { SubstrateId } from "./types";

export type InstallSubstrate = Extract<SubstrateId, "codex" | "pi-dev" | "claude-code" | "cursor" | "grok">;

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

export interface PrivateRootSpec {
  projection?(options?: { homeDir?: string; substrate?: SubstrateId }): string[];
  memory?(options?: { homeDir?: string; substrate?: SubstrateId }): string[];
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
  validator?: InstallValidator;
  lifecycleProjection?: LifecycleProjectionSpec;
  postProjection?: readonly InstallPostProjectionStep[];
  privateRoots?: PrivateRootSpec;
  uninstall: UninstallSpec;
}
