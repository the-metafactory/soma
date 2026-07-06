import { resolve } from "node:path";
import { allInstallSpecs, installSpecFor, isRegisteredInstallSubstrate } from "./install-spec-registry";
import type { PrivateRootOptions } from "./install-spec";

export function somaProjectionPrivateRoots(options: PrivateRootOptions = {}): string[] {
  const specs = isRegisteredInstallSubstrate(options.substrate) ? [installSpecFor(options.substrate)] : allInstallSpecs();
  return specs.flatMap((spec) => spec.privateRoots?.projection?.(options) ?? []).map((path) => resolve(path));
}

export function somaMemoryPrivateRoots(options: PrivateRootOptions = {}): string[] {
  const specs = isRegisteredInstallSubstrate(options.substrate) ? [installSpecFor(options.substrate)] : allInstallSpecs();
  return specs.flatMap((spec) => spec.privateRoots?.memory?.(options) ?? []).map((path) => resolve(path));
}
