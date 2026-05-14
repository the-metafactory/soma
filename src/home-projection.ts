import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildCodexHomeContext, buildPiDevHomeContext } from "./adapters";
import { writeContextBundle } from "./context-bundle";
import type { SomaContextInput, SomaHomeProjection, SomaHomeProjectionOptions, SubstrateId, WrittenContextBundle } from "./types";

export function resolveHomeProjectionPaths(
  substrate: SubstrateId,
  options: SomaHomeProjectionOptions = {},
): Omit<SomaHomeProjection, "bundle"> {
  if (substrate !== "codex" && substrate !== "pi-dev") {
    throw new Error(`Home projection is not implemented for substrate: ${substrate}`);
  }

  const homeDir = resolve(options.homeDir ?? homedir());
  const defaultSubstrateHome = substrate === "codex" ? ".codex" : ".pi";

  return {
    substrate,
    somaHome: resolve(options.somaHome ?? join(homeDir, ".soma")),
    substrateHome: resolve(options.substrateHome ?? join(homeDir, defaultSubstrateHome)),
  };
}

export function buildCodexHomeProjection(input: SomaContextInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  const paths = resolveHomeProjectionPaths("codex", options);

  return {
    ...paths,
    bundle: buildCodexHomeContext(input, paths.somaHome),
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
