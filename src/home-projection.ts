import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installSpecFor, isRegisteredInstallSubstrate } from "./install-spec-registry";
import type { HomeProjectionBuildContext } from "./install-spec";
import { writeProjection } from "./projection";
import { defaultSomaRepoPath } from "./repo-path";
import type { InstallSubstrate, Projection, ProjectionInput, ProjectionSubstrate, SomaHomeProjection, SomaHomeProjectionOptions, WrittenProjection } from "./types";

export function resolveHomeProjectionPaths(
  substrate: ProjectionSubstrate,
  options: SomaHomeProjectionOptions = {},
): Omit<SomaHomeProjection, "bundle"> {
  if (!isRegisteredInstallSubstrate(substrate)) {
    throw new Error(`Home projection is not implemented for substrate: ${substrate}`);
  }

  const homeDir = resolve(options.homeDir ?? homedir());
  const spec = installSpecFor(substrate);

  return {
    substrate,
    somaHome: resolve(options.somaHome ?? join(homeDir, ".soma")),
    substrateHome: resolve(options.substrateHome ?? join(homeDir, spec.defaultHome)),
  };
}

function maybeCodeOnlyProjection(
  projection: Projection,
  options: SomaHomeProjectionOptions,
  isSkillProjectionPath: (path: string) => boolean,
): Projection {
  if (options.codeOnly !== true) return projection;
  return { ...projection, files: projection.files.filter((file) => !isSkillProjectionPath(file.path)) };
}

function buildHomeProjectionFor<S extends InstallSubstrate>(
  substrate: S,
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): SomaHomeProjection {
  const paths = resolveHomeProjectionPaths(substrate, options);
  const homeDir = resolve(options.homeDir ?? homedir());
  const context: HomeProjectionBuildContext<S> = {
    substrate,
    homeDir,
    somaHome: paths.somaHome,
    substrateHome: paths.substrateHome,
    somaRepoPath: resolve(options.somaRepoPath ?? defaultSomaRepoPath()),
  };
  const spec = installSpecFor(substrate);

  return {
    ...paths,
    bundle: maybeCodeOnlyProjection(spec.homeProjection.build(input, context), options, spec.homeProjection.isSkillProjectionPath),
  };
}

async function installHomeProjectionFor<S extends InstallSubstrate>(
  substrate: S,
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenProjection> {
  const projection = buildHomeProjectionFor(substrate, input, options);
  return (await installSpecFor(substrate).homeProjection.write?.(projection, options)) ?? writeProjection(projection.bundle, projection.substrateHome);
}

// Public compatibility interfaces. Native build/write facts live with the adapter install specs.
export function buildCodexHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  return buildHomeProjectionFor("codex", input, options);
}

export async function installCodexHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): Promise<WrittenProjection> {
  return installHomeProjectionFor("codex", input, options);
}

export function buildPiDevHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  return buildHomeProjectionFor("pi-dev", input, options);
}

export async function installPiDevHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): Promise<WrittenProjection> {
  return installHomeProjectionFor("pi-dev", input, options);
}

export function buildClaudeCodeHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  return buildHomeProjectionFor("claude-code", input, options);
}

export async function installClaudeCodeHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): Promise<WrittenProjection> {
  return installHomeProjectionFor("claude-code", input, options);
}

export function buildCursorHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  return buildHomeProjectionFor("cursor", input, options);
}

export async function installCursorHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): Promise<WrittenProjection> {
  return installHomeProjectionFor("cursor", input, options);
}

export function buildGrokHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  return buildHomeProjectionFor("grok", input, options);
}

export async function installGrokHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): Promise<WrittenProjection> {
  return installHomeProjectionFor("grok", input, options);
}

export function buildDshHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  return buildHomeProjectionFor("dsh", input, options);
}

export async function installDshHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): Promise<WrittenProjection> {
  return installHomeProjectionFor("dsh", input, options);
}

export function buildAnthropicCoworkHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  return buildHomeProjectionFor("anthropic-cowork", input, options);
}

export async function installAnthropicCoworkHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): Promise<WrittenProjection> {
  return installHomeProjectionFor("anthropic-cowork", input, options);
}

/** Generic caller surface; lookup is through adapter-owned install facts. */
export function buildSubstrateHomeProjection(
  substrate: InstallSubstrate,
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): SomaHomeProjection {
  return buildHomeProjectionFor(substrate, input, options);
}
