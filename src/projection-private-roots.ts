import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { codexInstallSpec } from "./adapters/codex/install";
import type { SubstrateId } from "./types";

export function somaProjectionPrivateRoots(options: { homeDir?: string; substrate?: SubstrateId } = {}): string[] {
  const home = resolve(options.homeDir ?? homedir());
  const codexRoots = codexInstallSpec.privateRoots?.projection?.(options) ?? [];
  const piDevRoots = [join(home, ".pi", "agent", "soma"), join(home, ".pi", "agent", "skills", "soma")];

  if (options.substrate === "codex") return codexRoots.map((path) => resolve(path));
  if (options.substrate === "pi-dev") return piDevRoots.map((path) => resolve(path));

  return [...codexRoots, ...piDevRoots].map((path) => resolve(path));
}

export function somaMemoryPrivateRoots(options: { homeDir?: string; substrate?: SubstrateId } = {}): string[] {
  const codexMemoryRoots = codexInstallSpec.privateRoots?.memory?.(options) ?? [];

  if (options.substrate === undefined || options.substrate === "codex") return codexMemoryRoots.map((path) => resolve(path));

  return [];
}
