import { createPaths } from "../../paths";
import type { SomaPaths } from "../../types";
import type { WisdomToolOptions } from "./types";

export function pathsForWisdomOptions(options: WisdomToolOptions = {}): SomaPaths {
  return createPaths(options.somaHome ? { somaHome: options.somaHome } : { homeDir: options.homeDir });
}

export function safeDomain(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("Wisdom domain is required.");
  return safe;
}
