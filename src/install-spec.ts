import { resolve } from "node:path";
import type { SubstrateId } from "./types";

export type InstallSubstrate = Extract<SubstrateId, "codex" | "pi-dev" | "claude-code" | "cursor">;

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

export interface IsaSkillProjectionSpec {
  destinationDir(substrateHome: string): string;
  skillNameOverride?: string;
  prepare?(substrateHome: string): Promise<void>;
}

export function isaSkillUnder(...pathSegments: string[]): (substrateHome: string) => string {
  return (substrateHome) => resolve(substrateHome, ...pathSegments, "skills/ISA");
}

export type InstallValidator = (substrateRoot: string) => Promise<void>;

export interface UninstallContext {
  homeDir?: string;
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
  optionalHomeFiles?(options: unknown): readonly string[];
  isaSkillProjection: IsaSkillProjectionSpec;
  validator?: InstallValidator;
  lifecycleProjection?: LifecycleProjectionSpec;
  postProjection?: readonly InstallPostProjectionStep[];
  privateRoots?: PrivateRootSpec;
  uninstall: UninstallSpec;
}
