import { createPaths } from "../../paths";
import type { SomaPaths } from "../../types";
import type { LearningToolOptions } from "./types";

export function pathsForLearningOptions(options: LearningToolOptions): SomaPaths {
  return createPaths(options.somaHome ? { somaHome: options.somaHome } : { homeDir: options.homeDir });
}

export function isoTimestamp(value: string | undefined, fallback = new Date(0)): string {
  if (!value) return fallback.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return parsed.toISOString();
}

export function safeFileToken(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "unknown";
}
