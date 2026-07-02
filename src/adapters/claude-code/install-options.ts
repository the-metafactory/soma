import type { SomaInstallOptions } from "../../types";

export interface ClaudeCodeInstallOptions extends SomaInstallOptions {
  modeClassifier?: boolean;
  policyGuard?: boolean;
  /** soma#368: generate ~/.claude/CLAUDE.md as a projection (overlay-preserving). */
  claudeMd?: boolean;
}

export function isClaudeCodeInstallOptions(options: unknown): options is ClaudeCodeInstallOptions {
  return typeof options === "object" && options !== null && !Array.isArray(options);
}
