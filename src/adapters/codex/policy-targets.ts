import { isAbsolute, resolve } from "node:path";
import {
  extractApplyPatchPolicyTargets,
  extractEditPolicyTargets,
  extractMultiEditPolicyTargets,
  extractShellPolicyTargets,
  extractWritePolicyTargets,
  type SomaPolicyTargetConfig,
  type SomaPolicyToolInvocation,
} from "../../policy-targets";
import type { SomaPolicyBatchTarget } from "../../types";

function resolveToolPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd || process.cwd(), path);
}

function normalizeCodexToolInvocation(input: Record<string, unknown>): SomaPolicyToolInvocation {
  const toolName = String(input.tool_name || input.toolName || "");
  const rawToolInput = input.tool_input ?? input.toolInput;
  const toolInput = rawToolInput && typeof rawToolInput === "object" && !Array.isArray(rawToolInput) ? rawToolInput as Record<string, unknown> : {};
  const cwd = String(input.cwd || process.cwd());
  const fileCandidate = toolInput.file_path || toolInput.filePath || cwd;
  const filePath = resolveToolPath(String(fileCandidate), cwd);
  const rawSourcePath = toolInput.source_path || toolInput.sourcePath;
  const commandCandidate = typeof rawToolInput === "string" ? rawToolInput : toolInput.command || toolInput.cmd || "";

  return {
    toolName,
    rawToolInput,
    toolInput,
    cwd,
    filePath,
    sourcePath: rawSourcePath ? resolveToolPath(String(rawSourcePath), cwd) : undefined,
    command: String(commandCandidate),
  };
}

const codexTargetExtractors: Record<string, (config: SomaPolicyTargetConfig, context: SomaPolicyToolInvocation) => SomaPolicyBatchTarget[]> = {
  Write: extractWritePolicyTargets,
  Edit: extractEditPolicyTargets,
  MultiEdit: extractMultiEditPolicyTargets,
  apply_patch: extractApplyPatchPolicyTargets,
  Bash: extractShellPolicyTargets,
  Shell: extractShellPolicyTargets,
  exec_command: extractShellPolicyTargets,
};

export function extractCodexPolicyTargets(config: SomaPolicyTargetConfig, input: Record<string, unknown>): SomaPolicyBatchTarget[] {
  const context = normalizeCodexToolInvocation(input);
  const extractor = codexTargetExtractors[context.toolName];
  return extractor ? extractor(config, context) : [];
}
