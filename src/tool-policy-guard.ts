/**
 * Composite tool-call policy guard — the full three-check PreToolUse decision
 * that codex runs hook-side, lifted into ONE portable core entry so every
 * substrate (claude-code, pi.dev, …) gets identical enforcement without
 * reimplementing extraction/decision logic in projected hook code.
 *
 * The three checks, in order, fail-closed at the first block:
 *   1. Runtime-policy inspection — dangerous commands, outbound exfiltration,
 *      credential-path access (deny/ask → block).
 *   2. Write-target private-context check — writes/edits/destructive shell ops
 *      that touch Soma private markers (deny → block).
 *   3. Inbound content scan — reads pulling content from an untrusted root are
 *      TOFU-scanned (BLOCKED / HUMAN_REVIEW → block).
 *
 * Returns a single substrate-neutral decision; the hook layer maps it to each
 * substrate's deny/block shape.
 */
import { isAbsolute, resolve } from "node:path";
import { checkSomaPolicyBatch } from "./policy-audit";
import { somaPolicyPrivateMarkers } from "./policy";
import {
  extractEditPolicyTargets,
  extractMultiEditPolicyTargets,
  extractShellPolicyTargets,
  extractWritePolicyTargets,
  shouldCheckSomaPolicyTarget,
  somaPolicyActionForToolAction,
  type SomaPolicyTargetConfig,
  type SomaPolicyToolInvocation,
  type SomaToolPolicyAction,
} from "./policy-targets";
import { defaultInboundContentSecurityConfig, scanInboundContent } from "./inbound-security";
import { inspectRuntimePolicy } from "./runtime-policy";
import type { RuntimePolicyDecision, SubstrateId } from "./types";

export interface ToolCallPolicyGuardOptions {
  substrate: SubstrateId;
  somaHome?: string;
  homeDir?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  rawToolInput?: unknown;
  cwd?: string;
  privateRoots?: string[];
  record?: "all" | "deny" | "none";
  timestamp?: string;
}

// The guard's decision domain is exactly the runtime-policy decision domain
// (allow | deny | ask | alert). `alert` is advisory: it does not block, but it
// is surfaced so callers/telemetry never lose the signal. Only deny/ask block.
export type ToolCallPolicyGuardDecision = RuntimePolicyDecision;

export interface ToolCallPolicyGuardResult {
  decision: ToolCallPolicyGuardDecision;
  reason: string;
  stage: "runtime" | "write-target" | "inbound" | "none";
}

function stringInput(toolInput: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = toolInput[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function toolActionFor(normalizedToolName: string): SomaToolPolicyAction {
  switch (normalizedToolName) {
    case "read":
      return "read";
    case "write":
    case "notebookedit":
      return "write";
    default:
      // edit, multiedit, bash/shell — all mutate.
      return "modify";
  }
}

function buildInvocation(options: ToolCallPolicyGuardOptions, action: SomaToolPolicyAction): SomaPolicyToolInvocation {
  const cwd = options.cwd ?? process.cwd();
  const filePath = stringInput(options.toolInput, "file_path", "notebook_path", "path");
  return {
    toolName: options.toolName,
    rawToolInput: options.rawToolInput ?? options.toolInput,
    toolInput: options.toolInput,
    cwd,
    filePath: filePath ? (isAbsolute(filePath) ? filePath : resolve(cwd, filePath)) : "",
    sourcePath: stringInput(options.toolInput, "source_path", "sourcePath") || undefined,
    command: stringInput(options.toolInput, "command", "cmd", "script"),
    // NotebookEdit carries its body under new_source; surface it as content so
    // the write extractor sees private markers added via a notebook cell.
    ...(action === "write" && !options.toolInput.content && options.toolInput.new_source
      ? { toolInput: { ...options.toolInput, content: options.toolInput.new_source } }
      : {}),
  };
}

function extractWriteTargets(config: SomaPolicyTargetConfig, normalizedToolName: string, invocation: SomaPolicyToolInvocation) {
  switch (normalizedToolName) {
    case "write":
    case "notebookedit":
      return extractWritePolicyTargets(config, invocation);
    case "edit":
      return extractEditPolicyTargets(config, invocation);
    case "multiedit":
      return extractMultiEditPolicyTargets(config, invocation);
    case "bash":
    case "shell":
      return extractShellPolicyTargets(config, invocation);
    default:
      return [];
  }
}

function isUnderUntrustedRoot(filePath: string, untrustedRoots: readonly string[]): boolean {
  if (!filePath) return false;
  const resolved = resolve(filePath);
  return untrustedRoots.some((root) => {
    const normalizedRoot = resolve(root);
    return resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}/`);
  });
}

/**
 * Run the full three-check guard. Resolves to the first blocking decision, or
 * `{ decision: "allow" }` when every check passes. Callers (hooks) decide how a
 * thrown error maps to fail-closed; this function only throws on genuine engine
 * faults so the hook can deny on them.
 */
export async function evaluateToolCallPolicyGuard(options: ToolCallPolicyGuardOptions): Promise<ToolCallPolicyGuardResult> {
  const record = options.record ?? "deny";

  // 1. Runtime-policy inspection.
  const runtime = await inspectRuntimePolicy({
    substrate: options.substrate,
    surface: "tool_call",
    somaHome: options.somaHome,
    homeDir: options.homeDir,
    toolCall: { toolName: options.toolName, input: options.toolInput },
    record,
    timestamp: options.timestamp,
  });
  if (runtime.decision === "deny" || runtime.decision === "ask") {
    return { decision: runtime.decision, reason: runtime.reason, stage: "runtime" };
  }
  // `alert` is advisory (does not block) but must not be silently lost: hold it
  // and surface it as the final decision if no later stage hard-blocks.
  const runtimeAlert = runtime.decision === "alert" ? runtime : undefined;

  const normalizedToolName = options.toolName.toLowerCase();
  const action = toolActionFor(normalizedToolName);
  const markers = somaPolicyPrivateMarkers(options.somaHome ?? "", options.homeDir, options.privateRoots ?? []);
  const inbound = defaultInboundContentSecurityConfig({ somaHome: options.somaHome, homeDir: options.homeDir });
  const targetConfig: SomaPolicyTargetConfig = {
    somaHome: options.somaHome ?? "",
    policyMarkers: markers,
    inboundSecurity: { untrustedRoots: inbound.untrustedRoots },
  };

  // 2. Write-target private-context check.
  const invocation = buildInvocation(options, action);
  const writeTargets = extractWriteTargets(targetConfig, normalizedToolName, invocation).filter((target) =>
    shouldCheckSomaPolicyTarget(targetConfig, target),
  );
  if (writeTargets.length > 0) {
    const batch = await checkSomaPolicyBatch({
      homeDir: options.homeDir,
      somaHome: options.somaHome,
      substrate: options.substrate,
      cwd: invocation.cwd,
      action: somaPolicyActionForToolAction(action),
      record,
      privateRoots: options.privateRoots,
      timestamp: options.timestamp,
      targets: writeTargets,
    });
    if (batch.decision === "deny") {
      return { decision: "deny", reason: batch.reason, stage: "write-target" };
    }
  }

  // 3. Inbound content scan — reads that pull content from an untrusted root.
  if (action === "read" && isUnderUntrustedRoot(invocation.filePath, inbound.untrustedRoots)) {
    const scan = await scanInboundContent({
      homeDir: options.homeDir,
      somaHome: options.somaHome,
      substrate: options.substrate,
      sourcePath: invocation.filePath,
      record,
      timestamp: options.timestamp,
    });
    if (scan.decision === "BLOCKED" || scan.decision === "HUMAN_REVIEW") {
      return { decision: "deny", reason: `Soma inbound content ${scan.decision}: ${scan.reason}`, stage: "inbound" };
    }
  }

  if (runtimeAlert) {
    return { decision: "alert", reason: runtimeAlert.reason, stage: "runtime" };
  }
  return { decision: "allow", reason: "No policy guard findings.", stage: "none" };
}
