import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isEnoent } from "./fs-errors";
import { defaultSomaHome, type SomaPathsOptions } from "./paths";

export interface SomaConfig {
  goals?: { activations_dir?: string };
}

/** Missing configuration uses defaults; unreadable or invalid configuration is an error. */
export async function loadSomaConfig(options: SomaPathsOptions = {}): Promise<SomaConfig> {
  const path = join(defaultSomaHome(options), "config.yaml");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return {};
    throw new Error(`Cannot read Soma config: ${path}`);
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
  }).safeParse(raw);
  if (!result.success) {
    // Config values may be private; report field paths without their contents.
    const fields = result.error.issues.map((issue) => issue.path.join(".") || "root").join(", ");
    throw new Error(`Invalid Soma config (${fields}): ${path}`);
  }
  return result.data;
}
