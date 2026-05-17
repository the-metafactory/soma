import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { projectClaudeCodeHome, projectCodexHome, projectPiDevHome } from "./adapters";
import { writeProjection } from "./projection";
import { defaultSomaRepoPath } from "./repo-path";
import { DEFAULT_SUBSTRATE_HOMES } from "./adapter-active-isa";
import type { ProjectionInput, SomaHomeProjection, SomaHomeProjectionOptions, SubstrateId, WrittenProjection } from "./types";

export function resolveHomeProjectionPaths(
  substrate: SubstrateId,
  options: SomaHomeProjectionOptions = {},
): Omit<SomaHomeProjection, "bundle"> {
  if (substrate !== "codex" && substrate !== "pi-dev" && substrate !== "claude-code") {
    throw new Error(`Home projection is not implemented for substrate: ${substrate}`);
  }

  const homeDir = resolve(options.homeDir ?? homedir());
  const defaultSubstrateHome = DEFAULT_SUBSTRATE_HOMES[substrate];

  return {
    substrate,
    somaHome: resolve(options.somaHome ?? join(homeDir, ".soma")),
    substrateHome: resolve(options.substrateHome ?? join(homeDir, defaultSubstrateHome)),
  };
}

export function buildCodexHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  const paths = resolveHomeProjectionPaths("codex", options);
  const homeDir = resolve(options.homeDir ?? homedir());
  const somaRepoPath = resolve(options.somaRepoPath ?? defaultSomaRepoPath());

  return {
    ...paths,
    bundle: projectCodexHome(input, paths.somaHome, homeDir, somaRepoPath),
  };
}

export async function installCodexHomeProjection(
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenProjection> {
  const projection = buildCodexHomeProjection(input, options);
  return writeProjection(projection.bundle, projection.substrateHome);
}

export function buildPiDevHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  const paths = resolveHomeProjectionPaths("pi-dev", options);

  return {
    ...paths,
    bundle: projectPiDevHome(input, paths.somaHome),
  };
}

export async function installPiDevHomeProjection(
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenProjection> {
  const projection = buildPiDevHomeProjection(input, options);
  return writeProjection(projection.bundle, projection.substrateHome);
}

/**
 * Claude Code home projection (#37 minimal). For now this bundle is
 * just the active-ISA file at `PAI/ACTIVE_ISA.md`; the full home
 * install lands in #29 with the `.claude/rules/` pivot.
 */
export function buildClaudeCodeHomeProjection(
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): SomaHomeProjection {
  const paths = resolveHomeProjectionPaths("claude-code", options);

  return {
    ...paths,
    bundle: projectClaudeCodeHome(input),
  };
}

export async function installClaudeCodeHomeProjection(
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenProjection> {
  const projection = buildClaudeCodeHomeProjection(input, options);
  return writeProjection(projection.bundle, projection.substrateHome);
}
