import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SubstrateId } from "./types";

export function somaProjectionPrivateRoots(options: { homeDir?: string; substrate?: SubstrateId } = {}): string[] {
  const home = resolve(options.homeDir ?? homedir());
  const codexRoots = [join(home, ".codex", "memories", "soma"), join(home, ".codex", "skills", "soma")];
  const piDevRoots = [join(home, ".pi", "agent", "soma"), join(home, ".pi", "agent", "skills", "soma")];

  if (options.substrate === "codex") return codexRoots.map((path) => resolve(path));
  if (options.substrate === "pi-dev") return piDevRoots.map((path) => resolve(path));

  return [...codexRoots, ...piDevRoots].map((path) => resolve(path));
}
