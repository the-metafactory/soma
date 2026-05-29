import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendSomaMemoryEvent } from "./memory";
import { createPaths } from "./paths";
import type {
  RuntimePolicyDecision,
  RuntimePolicyFinding,
  RuntimePolicyInspectAudit,
  RuntimePolicyInspectOptions,
  RuntimePolicyInspectResult,
  RuntimePolicySurface,
} from "./types";

const PROMPT_INSPECTOR_ID = "soma-deterministic-prompt-v0";
const COMMAND_INSPECTOR_ID = "soma-deterministic-command-v0";
const INPUT_INSPECTOR_ID = "soma-runtime-input-v0";

export function runtimePolicyTraceRoot(options: Pick<RuntimePolicyInspectOptions, "homeDir" | "somaHome"> = {}): string {
  return createPaths(options).resolve("memory", "SECURITY", "runtime-policy");
}

function inputHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function finding(kind: string, severity: RuntimePolicyFinding["severity"], detail: string, inspector: string): RuntimePolicyFinding {
  return { kind, severity, detail, inspector };
}

function inspectPrompt(prompt: string): RuntimePolicyFinding[] {
  const findings: RuntimePolicyFinding[] = [];
  const normalized = prompt.toLowerCase();

  if (/\b(disable|turn off|bypass|remove)\b.{0,60}\b(soma\s+)?(security|policy|guard|hook)s?\b/u.test(normalized)) {
    findings.push(finding("security-disable-request", "high", "Prompt asks to disable or bypass Soma runtime policy.", PROMPT_INSPECTOR_ID));
  }
  if (/\b(ignore|override)\s+(all\s+)?(previous|prior|system|developer)\s+instructions\b/u.test(normalized)) {
    findings.push(finding("instruction-override", "high", "Prompt attempts to override higher-priority instructions.", PROMPT_INSPECTOR_ID));
  }
  if (/\b(reveal|print|dump|exfiltrate|leak|steal)\b.{0,80}\b(private memory|memory|secret|token|credential|private key)\b/u.test(normalized)) {
    findings.push(finding("data-exfiltration-intent", "high", "Prompt requests private memory or credential disclosure.", PROMPT_INSPECTOR_ID));
  }
  if (/\b(jailbreak|do anything now|roleplay as|pretend to be unrestricted)\b/u.test(normalized)) {
    findings.push(finding("jailbreak-language", "medium", "Prompt contains ambiguous jailbreak language.", PROMPT_INSPECTOR_ID));
  }

  return findings;
}

function commandFromToolCall(options: RuntimePolicyInspectOptions): string | undefined {
  const input = options.toolCall?.input;
  if (!input) return undefined;
  const candidate = input.command ?? input.cmd ?? input.script;
  return typeof candidate === "string" ? candidate : undefined;
}

function inspectToolCall(options: RuntimePolicyInspectOptions): RuntimePolicyFinding[] {
  if (!options.toolCall || typeof options.toolCall.toolName !== "string") {
    return [finding("malformed-tool-call", "critical", "Tool-call inspection requires a toolName.", INPUT_INSPECTOR_ID)];
  }

  const toolName = options.toolCall.toolName.toLowerCase();
  if (!/\b(bash|shell|exec_command)\b/u.test(toolName)) return [];

  const command = commandFromToolCall(options);
  if (!command) return [];

  const findings: RuntimePolicyFinding[] = [];
  const normalized = command.toLowerCase();
  const hasOutboundIntent = /\b(curl|wget|nc|netcat|scp|sftp|ssh|fetch)\b|https?:\/\//u.test(normalized);
  const hasEnvDump = /\b(printenv|env|export|set)\b/u.test(normalized);
  const hasCredentialTerm = /\b(secret|token|credential|api[_-]?key|private[_ -]?key|password)\b/u.test(normalized);

  if (hasEnvDump && hasOutboundIntent) {
    findings.push(finding("env-egress", "critical", "Command appears to send environment data to an outbound destination.", COMMAND_INSPECTOR_ID));
  }
  if (hasCredentialTerm && hasOutboundIntent) {
    findings.push(finding("credential-egress", "critical", "Command appears to send credential-like data to an outbound destination.", COMMAND_INSPECTOR_ID));
  }
  if (/\b(curl|wget)\b[^|]{0,200}\|\s*(?:sh|bash|zsh|fish|python|ruby|perl|node|bun)\b/u.test(normalized)) {
    findings.push(finding("pipe-to-shell", "medium", "Command pipes remotely fetched content into an interpreter.", COMMAND_INSPECTOR_ID));
  }
  if (/\b(?:python|python3|node|ruby|perl|bun)\s+-(?:c|e)\b/u.test(normalized)) {
    findings.push(finding("inline-interpreter", "low", "Command executes inline interpreter code.", COMMAND_INSPECTOR_ID));
  }

  return findings;
}

function decisionForFindings(findings: RuntimePolicyFinding[]): RuntimePolicyDecision {
  if (findings.some((item) => item.severity === "critical" || item.kind === "security-disable-request" || item.kind === "instruction-override" || item.kind === "data-exfiltration-intent")) {
    return "deny";
  }
  if (findings.some((item) => item.kind === "pipe-to-shell")) return "ask";
  if (findings.length > 0) return "alert";
  return "allow";
}

function reasonForDecision(decision: RuntimePolicyDecision, findings: RuntimePolicyFinding[]): string {
  if (decision === "allow") return "No deterministic runtime-policy findings.";
  const kinds = findings.map((item) => item.kind).join(", ");
  if (decision === "deny") return `Runtime policy denied this action: ${kinds}.`;
  if (decision === "ask") return `Runtime policy requires principal approval: ${kinds}.`;
  return `Runtime policy advisory alert: ${kinds}.`;
}

function eventRecordAllowed(record: RuntimePolicyInspectOptions["record"], decision: RuntimePolicyDecision): boolean {
  const mode = record ?? "all";
  return mode === "all" || (mode === "deny" && decision !== "allow");
}

function inspectFindings(options: RuntimePolicyInspectOptions): RuntimePolicyFinding[] {
  if (options.surface === "prompt") {
    if (typeof options.prompt !== "string") {
      return [finding("malformed-prompt", "critical", "Prompt inspection requires prompt text.", INPUT_INSPECTOR_ID)];
    }
    return inspectPrompt(options.prompt);
  }

  if (options.surface === "tool_call") return inspectToolCall(options);

  return [];
}

function inspectedInputRef(options: RuntimePolicyInspectOptions): { kind: string; hash?: string; toolName?: string } {
  if (options.surface === "prompt") {
    return {
      kind: "prompt",
      hash: inputHash(options.prompt ?? ""),
    };
  }

  if (options.surface === "tool_call") {
    const command = commandFromToolCall(options);
    return {
      kind: "tool_call",
      toolName: options.toolCall?.toolName,
      hash: command ? inputHash(command) : undefined,
    };
  }

  return { kind: options.surface };
}

async function writeRuntimePolicyTrace(result: RuntimePolicyInspectResult, options: RuntimePolicyInspectOptions): Promise<string> {
  const traceRoot = runtimePolicyTraceRoot({ somaHome: result.somaHome });
  const timestamp = options.timestamp ?? new Date().toISOString();
  const safeTimestamp = timestamp.replace(/[:.]/gu, "-");
  const inputRef = inspectedInputRef(options);
  const tracePath = join(traceRoot, `${safeTimestamp}-${result.surface}-${(inputRef.hash ?? "no-input").slice(0, 16)}.json`);
  const payload = {
    timestamp,
    surface: result.surface,
    decision: result.decision,
    reason: result.reason,
    findings: result.findings,
    inputRef,
  };

  await mkdir(dirname(tracePath), { recursive: true });
  await writeFile(tracePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return tracePath;
}

async function auditRuntimePolicy(result: RuntimePolicyInspectResult, options: RuntimePolicyInspectOptions): Promise<RuntimePolicyInspectAudit | undefined> {
  if (!eventRecordAllowed(options.record, result.decision)) return undefined;

  const tracePath = await writeRuntimePolicyTrace(result, options);
  const event = await appendSomaMemoryEvent(result.somaHome, {
    timestamp: options.timestamp,
    substrate: options.substrate ?? "custom",
    kind: "runtime_policy.inspect",
    summary: `${result.decision}: ${result.reason}`,
    artifactPaths: [tracePath],
    metadata: {
      surface: result.surface,
      decision: result.decision,
      findings: result.findings,
      inputRef: inspectedInputRef(options),
    },
  });

  return { event, tracePath };
}

export async function inspectRuntimePolicy(options: RuntimePolicyInspectOptions): Promise<RuntimePolicyInspectResult> {
  const somaHome = createPaths(options).root();
  const surface = options.surface;
  const findings = inspectFindings(options);
  const decision = decisionForFindings(findings);
  const result: RuntimePolicyInspectResult = {
    somaHome,
    surface,
    decision,
    reason: reasonForDecision(decision, findings),
    findings,
  };
  const audit = await auditRuntimePolicy(result, options);

  return audit ? { ...result, audit } : result;
}

export const RUNTIME_POLICY_SURFACES: readonly RuntimePolicySurface[] = [
  "prompt",
  "tool_call",
  "permission_request",
  "config_change",
  "governance_event",
];
