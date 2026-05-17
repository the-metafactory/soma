import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildClaudeCodeHomeContext, buildCodexHomeContext, buildPiDevHomeContext } from "./adapters";
import { writeContextBundle } from "./context-bundle";
import { defaultSomaRepoPath } from "./repo-path";
import type { SomaContextInput, SomaHomeProjection, SomaHomeProjectionOptions, SubstrateId, WrittenContextBundle } from "./types";

const DEFAULT_SUBSTRATE_HOMES: Record<"codex" | "pi-dev" | "claude-code", string> = {
  codex: ".codex",
  "pi-dev": ".pi",
  "claude-code": ".claude",
};

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

export function buildCodexHomeProjection(input: SomaContextInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  const paths = resolveHomeProjectionPaths("codex", options);
  const homeDir = resolve(options.homeDir ?? homedir());
  const somaRepoPath = resolve(options.somaRepoPath ?? defaultSomaRepoPath());

  return {
    ...paths,
    bundle: buildCodexHomeContext(input, paths.somaHome, homeDir, somaRepoPath),
  };
}

export async function installCodexHomeProjection(
  input: SomaContextInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenContextBundle> {
  const projection = buildCodexHomeProjection(input, options);
  return writeContextBundle(projection.bundle, projection.substrateHome);
}

export function buildPiDevHomeProjection(input: SomaContextInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  const paths = resolveHomeProjectionPaths("pi-dev", options);

  return {
    ...paths,
    bundle: buildPiDevHomeContext(input, paths.somaHome),
  };
}

export async function installPiDevHomeProjection(
  input: SomaContextInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenContextBundle> {
  const projection = buildPiDevHomeProjection(input, options);
  return writeContextBundle(projection.bundle, projection.substrateHome);
}

/**
 * Claude Code home projection (#37 minimal). For now this bundle is
 * just the active-ISA file at `PAI/ACTIVE_ISA.md`; the full home
 * install lands in #29 with the `.claude/rules/` pivot.
 */
export function buildClaudeCodeHomeProjection(
  input: SomaContextInput,
  options: SomaHomeProjectionOptions = {},
): SomaHomeProjection {
  const paths = resolveHomeProjectionPaths("claude-code", options);

  return {
    ...paths,
    bundle: buildClaudeCodeHomeContext(input),
  };
}

export async function installClaudeCodeHomeProjection(
  input: SomaContextInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenContextBundle> {
  const projection = buildClaudeCodeHomeProjection(input, options);
  return writeContextBundle(projection.bundle, projection.substrateHome);
}
