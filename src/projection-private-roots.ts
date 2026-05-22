import { resolve } from "node:path";
import { allInstallSpecs, installSpecFor } from "./install-spec-registry";
import type { InstallSubstrate } from "./install-spec";
import type { SubstrateId } from "./types";

const INSTALL_SUBSTRATES = ["codex", "pi-dev", "claude-code", "cursor"] as const satisfies readonly InstallSubstrate[];

function isInstallSubstrate(substrate: SubstrateId | undefined): substrate is InstallSubstrate {
  return substrate !== undefined && (INSTALL_SUBSTRATES as readonly string[]).includes(substrate);
}

export function somaProjectionPrivateRoots(options: { homeDir?: string; substrate?: SubstrateId } = {}): string[] {
  const specs = isInstallSubstrate(options.substrate) ? [installSpecFor(options.substrate)] : allInstallSpecs();
  return specs.flatMap((spec) => spec.privateRoots?.projection?.(options) ?? []).map((path) => resolve(path));
}

export function somaMemoryPrivateRoots(options: { homeDir?: string; substrate?: SubstrateId } = {}): string[] {
  const specs = isInstallSubstrate(options.substrate) ? [installSpecFor(options.substrate)] : allInstallSpecs();
  return specs.flatMap((spec) => spec.privateRoots?.memory?.(options) ?? []).map((path) => resolve(path));
}
