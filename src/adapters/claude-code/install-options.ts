import type { SomaInstallOptions } from "../../types";

export interface ClaudeCodeInstallOptions extends SomaInstallOptions {
  modeClassifier?: boolean;
}

export function isClaudeCodeInstallOptions(options: unknown): options is ClaudeCodeInstallOptions {
  return typeof options === "object" && options !== null && !Array.isArray(options);
}
