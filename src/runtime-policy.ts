import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendSomaMemoryEvent } from "./memory";
import { createPaths } from "./paths";
import { hasSomaPolicyPrivateMarker, somaPolicyPrivateMarkers } from "./policy";
import type {
  RuntimePolicyCommandInspectionConfig,
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

const DEFAULT_OUTBOUND_TOOLS = [
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "lftp",
  "fetch",
  "aria2c",
  "http",
  "https",
  "xh",
] as const;

const DEFAULT_CREDENTIAL_PATH_PATTERNS = [
  "(^|/)\\.env(\\.|$|/)?",
  "(^|/)id_(rsa|dsa|ecdsa|ed25519)$",
  "\\.(pem|p12|pfx|key)$",
  "(^|/)\\.aws/credentials$",
  "(^|/)\\.docker/config\\.json$",
  "(^|/)\\.kube/config$",
  "(^|/)credentials(\\.json)?$",
  "private[_-]?key",
] as const;

const INLINE_INTERPRETER_PATTERN = /\b(?:python|python3|node|ruby|perl|bun)\s+-(?:c|e)\b/u;

export function runtimePolicyTraceRoot(options: Pick<RuntimePolicyInspectOptions, "homeDir" | "somaHome"> = {}): string {
  return createPaths(options).resolve("memory", "SECURITY", "runtime-policy");
}

function inputHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function finding(kind: string, severity: RuntimePolicyFinding["severity"], detail: string, inspector: string, decision?: RuntimePolicyFinding["decision"]): RuntimePolicyFinding {
  return { kind, severity, detail, inspector, ...(decision ? { decision } : {}) };
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
  if (/\b(reveal|print|dump|exfiltrate|leak|steal)\b.{0,60}\b(private memory|secret|token|credential|private key)\b/u.test(normalized)) {
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

function cleanShellToken(token: string): string {
  // Bounded token cleanup for policy signals, not full shell syntax. This may
  // simplify process-substitution tokens; docs keep that outside guarantees.
  return token.replace(/^[<>"']+|[>"']+$/g, "");
}

function tokenizeCommand(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|&&|\|\||[|;<>]{1,2}|[^\s|;<>]+/gu)]
    .map((match) => cleanShellToken(match[1] || match[2] || match[0]))
    .filter(Boolean);
}

function isShellOperator(token: string): boolean {
  return token === "&&" || token === "||" || token === "|" || token === ";";
}

function shellSegments(tokens: string[]): { tokens: string[]; operatorAfter?: string }[] {
  const segments: { tokens: string[]; operatorAfter?: string }[] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (isShellOperator(token)) {
      if (current.length > 0) segments.push({ tokens: current, operatorAfter: token });
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segments.push({ tokens: current });
  return segments;
}

function shellCommandName(token: string | undefined): string {
  return (token ?? "").split("/").pop()?.toLowerCase() ?? "";
}

function skipCommandPrefixes(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token) || ["command", "exec", "time", "nice", "nohup"].includes(token)) {
      index += 1;
      continue;
    }
    if (token === "sudo") {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith("-")) index += 1;
      continue;
    }
    if (token === "env") {
      index += 1;
      while (index < tokens.length && (tokens[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(tokens[index]))) {
        index += 1;
      }
      continue;
    }
    break;
  }
  return index;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matchesPattern(value: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, "iu").test(value);
  } catch (_err) {
    // Keep invalid operator-supplied patterns deterministic and non-throwing.
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
}

function commandConfig(options: RuntimePolicyInspectOptions): RuntimePolicyCommandInspectionConfig {
  return options.runtimePolicy?.command ?? {};
}

function configuredOutboundTools(config: RuntimePolicyCommandInspectionConfig): string[] {
  return Array.from(new Set([...DEFAULT_OUTBOUND_TOOLS, ...(config.outboundTools ?? [])].map((tool) => tool.toLowerCase())));
}

function commandHasOutboundIntent(command: string, config: RuntimePolicyCommandInspectionConfig): boolean {
  // Config is per inspection, so the regex is intentionally built from the
  // current Soma-owned command config rather than cached globally.
  const toolPattern = new RegExp(`\\b(?:${configuredOutboundTools(config).map(escapeRegExp).join("|")})\\b`, "iu");
  return toolPattern.test(command) || /https?:\/\//iu.test(command);
}

function segmentHasOutboundIntent(segment: string[], config: RuntimePolicyCommandInspectionConfig): boolean {
  const commandIndex = skipCommandPrefixes(segment);
  const command = shellCommandName(segment[commandIndex]);
  if (configuredOutboundTools(config).includes(command)) return true;
  return segment.some((token) => /^https?:\/\//iu.test(token));
}

function normalizePathLikeToken(token: string): string {
  const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
  return value.replace(/^@/u, "");
}

function tokenMatchesAnyPattern(token: string, patterns: readonly string[]): boolean {
  const normalized = normalizePathLikeToken(token);
  return patterns.some((pattern) => matchesPattern(normalized, pattern));
}

function isCredentialPathToken(token: string, config: RuntimePolicyCommandInspectionConfig): boolean {
  return tokenMatchesAnyPattern(token, [...DEFAULT_CREDENTIAL_PATH_PATTERNS, ...(config.credentialPathPatterns ?? [])]);
}

function isPrivatePathToken(token: string, options: RuntimePolicyInspectOptions, somaHome: string, config: RuntimePolicyCommandInspectionConfig): boolean {
  const normalized = normalizePathLikeToken(token);
  if (tokenMatchesAnyPattern(normalized, config.privatePathPatterns ?? [])) return true;
  return somaPolicyPrivateMarkers(somaHome, options.homeDir, [...(options.runtimePolicy?.privateRoots ?? [])]).some((marker) => hasSomaPolicyPrivateMarker(normalized, marker));
}

function inspectConfiguredPatternRules(command: string, config: RuntimePolicyCommandInspectionConfig): RuntimePolicyFinding[] {
  return (config.patternRules ?? [])
    .filter((rule) => matchesPattern(command, rule.pattern))
    .map((rule) => finding(rule.kind, rule.severity ?? (rule.decision === "deny" ? "high" : rule.decision === "ask" ? "medium" : "low"), rule.detail, COMMAND_INSPECTOR_ID, rule.decision));
}

function inspectSegmentedCommand(command: string, options: RuntimePolicyInspectOptions, somaHome: string, config: RuntimePolicyCommandInspectionConfig): RuntimePolicyFinding[] {
  const findings: RuntimePolicyFinding[] = [];
  const segments = shellSegments(tokenizeCommand(command));
  let pipedPrivateSource = false;
  let pipedCredentialSource = false;

  for (const segment of segments) {
    const hasPrivatePath = segment.tokens.some((token) => isPrivatePathToken(token, options, somaHome, config));
    const hasCredentialPath = segment.tokens.some((token) => isCredentialPathToken(token, config));
    const hasOutbound = segmentHasOutboundIntent(segment.tokens, config);

    if ((hasPrivatePath || pipedPrivateSource) && hasOutbound) {
      findings.push(finding("private-path-egress", "critical", "Command appears to send private Soma path content to an outbound destination.", COMMAND_INSPECTOR_ID));
    }
    if ((hasCredentialPath || pipedCredentialSource) && hasOutbound) {
      findings.push(finding("credential-file-egress", "critical", "Command appears to send credential-file content to an outbound destination.", COMMAND_INSPECTOR_ID));
    }

    // Only pipes propagate source context. Command separators and boolean
    // operators reset it to avoid pretending we do full shell data-flow.
    pipedPrivateSource = segment.operatorAfter === "|" && (pipedPrivateSource || hasPrivatePath);
    pipedCredentialSource = segment.operatorAfter === "|" && (pipedCredentialSource || hasCredentialPath);
  }

  return findings;
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
  const somaHome = createPaths(options).root();
  const config = commandConfig(options);
  const normalized = command.toLowerCase();
  const hasOutboundIntent = commandHasOutboundIntent(command, config);
  const hasEnvDump = /\b(printenv|env|export|set)\b/u.test(normalized);
  const hasCredentialTerm = /\b(secret|token|credential|api[_-]?key|private[_ -]?key|password)\b/u.test(normalized);

  findings.push(...inspectConfiguredPatternRules(command, config));
  findings.push(...inspectSegmentedCommand(command, options, somaHome, config));
  const hasCredentialFileEgress = findings.some((item) => item.kind === "credential-file-egress");

  if (hasEnvDump && hasOutboundIntent && !hasCredentialFileEgress) {
    findings.push(finding("env-egress", "critical", "Command appears to send environment data to an outbound destination.", COMMAND_INSPECTOR_ID));
  }
  if (hasCredentialTerm && hasOutboundIntent && !hasCredentialFileEgress) {
    findings.push(finding("credential-egress", "critical", "Command appears to send credential-like data to an outbound destination.", COMMAND_INSPECTOR_ID));
  }
  if (/\b(curl|wget)\b[^|]{0,200}\|\s*(?:sh|bash|zsh|fish|python|ruby|perl|node|bun)\b/u.test(normalized)) {
    findings.push(finding("pipe-to-shell", "medium", "Command pipes remotely fetched content into an interpreter.", COMMAND_INSPECTOR_ID));
  }
  if (INLINE_INTERPRETER_PATTERN.test(normalized)) {
    const inlineDecision = config.inlineInterpreterDecision ?? "alert";
    findings.push(finding("inline-interpreter", inlineDecision === "deny" ? "high" : inlineDecision === "ask" ? "medium" : "low", "Command executes inline interpreter code.", COMMAND_INSPECTOR_ID, inlineDecision));
  }

  return findings;
}

function decisionForFindings(findings: RuntimePolicyFinding[]): RuntimePolicyDecision {
  if (findings.some((item) => item.decision === "deny")) return "deny";
  // Critical command findings deny by severity; prompt-integrity findings deny
  // by kind because they are high-confidence policy bypass/exfiltration intents.
  if (findings.some((item) => item.severity === "critical" || item.kind === "security-disable-request" || item.kind === "instruction-override" || item.kind === "data-exfiltration-intent")) {
    return "deny";
  }
  if (findings.some((item) => item.decision === "ask")) return "ask";
  if (findings.some((item) => item.kind === "pipe-to-shell")) return "ask";
  if (findings.some((item) => item.decision === "alert")) return "alert";
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
