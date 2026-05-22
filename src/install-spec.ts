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
}

export interface InstallPostProjectionStep {
  name: string;
  run(context: InstallPostProjectionContext): Promise<string[]>;
}

export interface ReservedUninstallSpec {
  kind: "reserved";
  reason: string;
}

export interface ImplementedUninstallSpec {
  kind: "implemented";
  remove: readonly string[];
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
  lifecycleProjection?: LifecycleProjectionSpec;
  postProjection?: readonly InstallPostProjectionStep[];
  privateRoots?: PrivateRootSpec;
  uninstall: UninstallSpec;
}
