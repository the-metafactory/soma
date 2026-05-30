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
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeCodexToolInvocation(input: Record<string, unknown>): SomaPolicyToolInvocation {
  const toolName = stringValue(input.tool_name) ?? stringValue(input.toolName) ?? "";
  const rawToolInput = input.tool_input ?? input.toolInput;
  const toolInput = rawToolInput && typeof rawToolInput === "object" && !Array.isArray(rawToolInput) ? rawToolInput as Record<string, unknown> : {};
  const cwd = stringValue(input.cwd) ?? process.cwd();
  const fileCandidate = stringValue(toolInput.file_path) ?? stringValue(toolInput.filePath) ?? cwd;
  const filePath = resolveToolPath(fileCandidate, cwd);
  const rawSourcePath = stringValue(toolInput.source_path) ?? stringValue(toolInput.sourcePath);
  const commandCandidate = typeof rawToolInput === "string" ? rawToolInput : stringValue(toolInput.command) ?? stringValue(toolInput.cmd) ?? "";

  return {
    toolName,
    rawToolInput,
    toolInput,
    cwd,
    filePath,
    sourcePath: rawSourcePath ? resolveToolPath(rawSourcePath, cwd) : undefined,
    command: commandCandidate,
  };
}

const codexTargetExtractors: Partial<Record<string, (config: SomaPolicyTargetConfig, context: SomaPolicyToolInvocation) => SomaPolicyBatchTarget[]>> = {
  Write: extractWritePolicyTargets,
  Edit: extractEditPolicyTargets,
  MultiEdit: extractMultiEditPolicyTargets,
  apply_patch: extractApplyPatchPolicyTargets,
  Bash: extractShellPolicyTargets,
  Shell: extractShellPolicyTargets,
  exec_command: extractShellPolicyTargets,
};

function isInsideInboundRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

function extractReadInboundContentTargets(config: SomaPolicyTargetConfig, context: SomaPolicyToolInvocation): SomaPolicyBatchTarget[] {
  const roots = config.inboundSecurity?.untrustedRoots ?? [];
  return roots.some((root) => isInsideInboundRoot(context.filePath, root)) ? [{ filePath: context.filePath }] : [];
}

const codexInboundTargetExtractors: Partial<Record<string, (config: SomaPolicyTargetConfig, context: SomaPolicyToolInvocation) => SomaPolicyBatchTarget[]>> = {
  Read: extractReadInboundContentTargets,
};

export function extractCodexPolicyTargets(config: SomaPolicyTargetConfig, input: Record<string, unknown>): SomaPolicyBatchTarget[] {
  const context = normalizeCodexToolInvocation(input);
  const extractor = codexTargetExtractors[context.toolName];
  return extractor ? extractor(config, context) : [];
}

export function extractCodexInboundContentTargets(config: SomaPolicyTargetConfig, input: Record<string, unknown>): SomaPolicyBatchTarget[] {
  const context = normalizeCodexToolInvocation(input);
  const extractor = codexInboundTargetExtractors[context.toolName];
  return extractor ? extractor(config, context) : [];
}
