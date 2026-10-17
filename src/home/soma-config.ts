import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isEnoent, defaultSomaHome, type SomaPathsOptions } from "../core/index";

export interface SomaConfig {
  goals?: { activations_dir?: string };
  /**
   * Landing maps an Errata proposal may file against (soma#903 D11): `owner/repo` to
   * that map's root node id. The registry is the router; a ripe cluster whose repo is not
   * registered is reported instead of proposed. The key and value grammar is checked where
   * the registry is read, against the `soma graph file-proposal` front-matter schema.
   */
  errata?: { landing?: Record<string, number> };
}

/** Missing configuration uses defaults; unreadable or invalid configuration is an error. */
export async function loadSomaConfig(options: SomaPathsOptions = {}): Promise<SomaConfig> {
  const path = join(defaultSomaHome(options), "config.yaml");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return {};
    throw new Error(`Cannot read Soma config: ${path}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(content) ?? {};
  } catch {
    throw new Error(`Invalid Soma config YAML: ${path}`);
  }
  const { z } = await import("zod");
  const result = z.object({
    goals: z.object({
      activations_dir: z.string().refine((value) => value.trim().length > 0).optional(),
    }).optional(),
    errata: z.object({
      landing: z.record(z.string().refine((value) => value.trim().length > 0), z.number().int().positive()).optional(),
    }).optional(),
  }).safeParse(raw);
  if (!result.success) {
    // Config values may be private; report field paths without their contents.
    const fields = result.error.issues.map((issue) => issue.path.join(".") || "root").join(", ");
    throw new Error(`Invalid Soma config (${fields}): ${path}`);
  }
  return result.data;
}
