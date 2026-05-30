import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appendSomaMemoryEvent } from "./memory";
import { createPaths } from "./paths";
import { hasSomaPolicyPrivateMarker, somaPolicyPrivateMarkers } from "./policy";
import { inference } from "./tools/inference";
import type {
  RuntimePolicyCommandInspectionConfig,
  RuntimePolicyConfigChange,
  RuntimePolicyModelInspectorConfig,
  RuntimePolicyModelRule,
  RuntimePolicyPermissionConfig,
  RuntimePolicyPermissionRequest,
  RuntimePolicyDecision,
  RuntimePolicyFinding,
  RuntimePolicyInspectAudit,
  RuntimePolicyInspectOptions,
  RuntimePolicyInspectResult,
  RuntimePolicySurface,
} from "./types";

const PROMPT_INSPECTOR_ID = "soma-deterministic-prompt-v0";
const COMMAND_INSPECTOR_ID = "soma-deterministic-command-v0";
const CONFIG_INSPECTOR_ID = "soma-deterministic-config-v0";
const PERMISSION_INSPECTOR_ID = "soma-deterministic-permission-v0";
const MODEL_INSPECTOR_ID = "soma-model-backed-runtime-policy-v0";
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

const DEFAULT_PERMISSION_SENSITIVE_PATH_PATTERNS = [
  "(^|/)\\.env(\\.|$|/)?",
  "(^|/)\\.ssh($|/)",
  "(^|/)\\.aws/credentials$",
  "(^|/)\\.docker/config\\.json$",
  "(^|/)\\.kube/config$",
  "(^|/)id_(rsa|dsa|ecdsa|ed25519)$",
  "\\.(pem|p12|pfx|key)$",
] as const;

const INLINE_INTERPRETER_PATTERN = /\b(?:python|python3|node|ruby|perl|bun)\s+-(?:c|e)\b/u;

const COMMON_SECURITY_CONFIG_KEYS = [
  "hooks",
  "permissions",
  "env",
  "mcpServers",
  "runtimePolicy",
  "policy",
  "tools",
  "extensions",
] as const;

const SUBSTRATE_SECURITY_CONFIG_KEYS = {
  codex: ["hooks", "hooksJson", "config.hooks", "tools", "sandbox", "network", "approvalPolicy"],
  "claude-code": ["hooks", "permissions", "mcpServers", "env"],
  "pi-dev": ["extensions", "toolGuard", "policyCheck", "runtimePolicy"],
  cursor: ["rules", "mcpServers", "tools"],
  cortex: ["dispatcher", "artifactIngress", "taskRouting", "capabilities"],
  custom: [],
} as const;

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

function stableSummary(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSummary).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSummary(record[key])}`).join(",")}}`;
}

function flattenConfigKeys(value: Record<string, unknown> | undefined, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  if (!value) return result;

  for (const key of Object.keys(value).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const item = value[key];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const nested = flattenConfigKeys(item as Record<string, unknown>, path);
      if (nested.size > 0) {
        for (const [nestedKey, nestedValue] of nested) result.set(nestedKey, nestedValue);
      } else {
        result.set(path, stableSummary(item));
      }
    } else {
      result.set(path, stableSummary(item));
    }
  }

  return result;
}

function securityRelevantConfigKeys(options: RuntimePolicyInspectOptions, change: RuntimePolicyConfigChange): string[] {
  const substrate = options.substrate ?? "custom";
  return Array.from(new Set([...COMMON_SECURITY_CONFIG_KEYS, ...SUBSTRATE_SECURITY_CONFIG_KEYS[substrate], ...(change.securityRelevantKeys ?? [])]));
}

function isSecurityRelevantConfigKey(key: string, relevantKeys: readonly string[]): boolean {
  return relevantKeys.some((candidate) => key === candidate || key.startsWith(`${candidate}.`));
}

function inspectConfigChange(options: RuntimePolicyInspectOptions): RuntimePolicyFinding[] {
  const change = options.configChange;
  if (!change || typeof change.configSurface !== "string" || change.configSurface.length === 0) {
    return [finding("malformed-config-change", "critical", "Config-change inspection requires a configSurface.", INPUT_INSPECTOR_ID)];
  }

  if (change.error?.kind === "unreadable") {
    return [finding("config-unreadable", "high", `Could not read ${change.configSurface}: ${change.error.detail ?? "unreadable"}.`, CONFIG_INSPECTOR_ID, "alert")];
  }
  if (change.error?.kind === "malformed") {
    return [finding("config-malformed", "high", `Could not parse ${change.configSurface}: ${change.error.detail ?? "malformed"}.`, CONFIG_INSPECTOR_ID, "alert")];
  }

  const before = flattenConfigKeys(change.before);
  const after = flattenConfigKeys(change.after);
  const relevantKeys = securityRelevantConfigKeys(options, change);
  const findings: RuntimePolicyFinding[] = [];

  for (const key of Array.from(new Set([...before.keys(), ...after.keys()])).sort()) {
    if (!isSecurityRelevantConfigKey(key, relevantKeys)) continue;
    const beforeValue = before.get(key);
    const afterValue = after.get(key);
    if (beforeValue === afterValue) continue;

    const state = beforeValue === undefined ? "added" : afterValue === undefined ? "removed" : "changed";
    findings.push(
      finding(
        `config-security-key-${state}`,
        "medium",
        `Security-relevant config key ${key} ${state} on ${change.configSurface}.`,
        CONFIG_INSPECTOR_ID,
        "alert",
      ),
    );
  }

  return findings;
}

function permissionConfig(options: RuntimePolicyInspectOptions): RuntimePolicyPermissionConfig {
  return options.runtimePolicy?.permission ?? {};
}

function normalizePermissionPath(path: string, homeDir: string): string {
  const expanded = path === "~" ? homeDir : path.startsWith("~/") ? join(homeDir, path.slice(2)) : path;
  return resolve(expanded);
}

function isSameOrInsidePath(target: string, root: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function permissionApprovalCacheHit(request: RuntimePolicyPermissionRequest, config: RuntimePolicyPermissionConfig, homeDir: string, now: Date): boolean {
  if (!request.cacheKey) return false;

  return (config.approvalCache ?? []).some((entry) => {
    if (entry.cacheKey !== request.cacheKey || entry.action !== request.action) return false;
    if (entry.expiresAt) {
      const expiresAt = Date.parse(entry.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return false;
    }
    if (!entry.targetPath) return true;
    if (!request.targetPath) return false;
    return normalizePermissionPath(entry.targetPath, homeDir) === normalizePermissionPath(request.targetPath, homeDir);
  });
}

function permissionTrustedRootAllows(request: RuntimePolicyPermissionRequest, config: RuntimePolicyPermissionConfig, homeDir: string): boolean {
  if (!request.targetPath) return false;
  const target = normalizePermissionPath(request.targetPath, homeDir);

  return (config.trustedRoots ?? []).some((root) => {
    if (!root.actions.includes(request.action)) return false;
    return isSameOrInsidePath(target, normalizePermissionPath(root.path, homeDir));
  });
}

function permissionTargetsSensitivePath(request: RuntimePolicyPermissionRequest, options: RuntimePolicyInspectOptions, somaHome: string): boolean {
  if (!request.targetPath) return false;

  const targetPath = request.targetPath;
  if (DEFAULT_PERMISSION_SENSITIVE_PATH_PATTERNS.some((pattern) => matchesPattern(targetPath, pattern))) return true;

  return somaPolicyPrivateMarkers(somaHome, options.homeDir, [...(options.runtimePolicy?.privateRoots ?? [])]).some((marker) =>
    hasSomaPolicyPrivateMarker(targetPath, marker),
  );
}

function approvalUnavailableFinding(): RuntimePolicyFinding {
  return finding(
    "permission-approval-unavailable",
    "medium",
    "Permission request needs principal approval, but this substrate cannot synchronously ask.",
    PERMISSION_INSPECTOR_ID,
    "alert",
  );
}

function approvalRequiredFinding(): RuntimePolicyFinding {
  return finding("permission-approval-required", "medium", "Permission request requires explicit principal approval.", PERMISSION_INSPECTOR_ID, "ask");
}

function sensitivePathFinding(supportsAsk: boolean): RuntimePolicyFinding {
  return finding(
    "permission-sensitive-path",
    "high",
    "Permission request targets a sensitive or private path.",
    PERMISSION_INSPECTOR_ID,
    supportsAsk ? "ask" : "alert",
  );
}

function inspectPermissionRequest(options: RuntimePolicyInspectOptions, somaHome: string): RuntimePolicyFinding[] {
  const request = options.permissionRequest;
  if (!request || typeof request.requestId !== "string" || request.requestId.length === 0) {
    return [finding("malformed-permission-request", "critical", "Permission-request inspection requires a requestId.", INPUT_INSPECTOR_ID)];
  }

  const config = permissionConfig(options);
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  const now = new Date(options.timestamp ?? Date.now());
  const supportsAsk = request.substrateSupportsAsk !== false;
  const sensitivePath = permissionTargetsSensitivePath(request, options, somaHome);

  if (!sensitivePath && permissionApprovalCacheHit(request, config, homeDir, now)) return [];
  if (!sensitivePath && permissionTrustedRootAllows(request, config, homeDir)) return [];

  const findings: RuntimePolicyFinding[] = [];
  if (sensitivePath) findings.push(sensitivePathFinding(supportsAsk));
  findings.push(supportsAsk ? approvalRequiredFinding() : approvalUnavailableFinding());
  return findings;
}

interface ModelPolicyResponseFinding {
  ruleId?: unknown;
  decision?: unknown;
  severity?: unknown;
  detail?: unknown;
}

interface ModelPolicyResponse {
  findings?: unknown;
}

function modelConfig(options: RuntimePolicyInspectOptions): RuntimePolicyModelInspectorConfig {
  return options.runtimePolicy?.model ?? {};
}

function modelRulesForSurface(config: RuntimePolicyModelInspectorConfig, surface: RuntimePolicySurface): RuntimePolicyModelRule[] {
  return (config.rules ?? []).filter((rule) => !rule.surfaces || rule.surfaces.includes(surface));
}

function modelFailureFinding(kind: string, detail: string): RuntimePolicyFinding {
  return finding(kind, "medium", detail, MODEL_INSPECTOR_ID, "alert");
}

function runtimePolicyModelPrompt(options: RuntimePolicyInspectOptions, rules: readonly RuntimePolicyModelRule[]): string {
  const inputRef = inspectedInputRef(options);
  const payload = {
    surface: options.surface,
    prompt: options.surface === "prompt" ? options.prompt : undefined,
    toolCall: options.surface === "tool_call" ? options.toolCall : undefined,
    permissionRequest: options.surface === "permission_request" ? options.permissionRequest : undefined,
    configChange: options.surface === "config_change"
      ? {
        configSurface: options.configChange?.configSurface,
        changedKeys: changedConfigKeys(options.configChange),
        error: options.configChange?.error?.kind,
      }
      : undefined,
    inputRef,
  };

  return [
    "You are a Soma runtime policy evaluator.",
    "Evaluate only the listed principal-authored runtime policy rules.",
    "Return JSON only: {\"findings\":[{\"ruleId\":\"...\",\"decision\":\"alert|ask|allow\",\"severity\":\"low|medium|high\",\"detail\":\"one sentence\"}]}",
    "Do not return deny. Deterministic policy owns deny decisions.",
    "",
    "Rules:",
    JSON.stringify(rules, null, 2),
    "",
    "Runtime input:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function isModelDecision(value: unknown): value is "allow" | "alert" | "ask" {
  return value === "allow" || value === "alert" || value === "ask";
}

function isModelSeverity(value: unknown): value is RuntimePolicyFinding["severity"] {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function modelFindingFromResponse(item: ModelPolicyResponseFinding, rulesById: Map<string, RuntimePolicyModelRule>): RuntimePolicyFinding | undefined {
  if (typeof item.ruleId !== "string" || !rulesById.has(item.ruleId)) return undefined;
  if (!isModelDecision(item.decision)) return undefined;
  if (item.decision === "allow") return undefined;
  const rule = rulesById.get(item.ruleId);
  const decision = item.decision === "ask" && rule?.decision !== "alert" ? "ask" : "alert";
  const severity = isModelSeverity(item.severity) ? item.severity : rule?.severity ?? (decision === "ask" ? "medium" : "low");
  const detail = typeof item.detail === "string" && item.detail.trim().length > 0
    ? item.detail.trim()
    : `Model-backed runtime policy rule ${item.ruleId} matched.`;

  return finding("model-policy-rule", severity, detail, MODEL_INSPECTOR_ID, decision);
}

function parseModelPolicyResponse(response: unknown, rules: readonly RuntimePolicyModelRule[]): RuntimePolicyFinding[] | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const findings = (response as ModelPolicyResponse).findings;
  if (!Array.isArray(findings)) return undefined;

  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const parsed: RuntimePolicyFinding[] = [];
  for (const item of findings) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const modelFinding = modelFindingFromResponse(item as ModelPolicyResponseFinding, rulesById);
    if (!modelFinding && (item as ModelPolicyResponseFinding).decision !== "allow") return undefined;
    if (modelFinding) parsed.push(modelFinding);
  }
  return parsed;
}

async function inspectModelBackedPolicy(options: RuntimePolicyInspectOptions): Promise<RuntimePolicyFinding[]> {
  const config = modelConfig(options);
  if (config.enabled !== true) return [];

  const rules = modelRulesForSurface(config, options.surface);
  if (rules.length === 0) return [];
  if (!options.modelInspectorBackend) {
    return [modelFailureFinding("model-inspector-unavailable", "Model-backed runtime policy is enabled, but no inference backend was provided.")];
  }

  try {
    const result = await inference<ModelPolicyResponse>(runtimePolicyModelPrompt(options, rules), {
      backend: options.modelInspectorBackend,
      json: true,
      level: config.level ?? "fast",
      timeoutMs: config.timeoutMs ?? 3_000,
      homeDir: options.homeDir,
      somaHome: options.somaHome,
    });
    const findings = parseModelPolicyResponse(result.json, rules);
    return findings ?? [modelFailureFinding("model-inspector-malformed-response", "Model-backed runtime policy returned malformed findings.")];
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/time(?:d)?\s*out|timeout/iu.test(detail)) {
      return [modelFailureFinding("model-inspector-timeout", `Model-backed runtime policy timed out: ${detail}`)];
    }
    if (/json|parse/iu.test(detail)) {
      return [modelFailureFinding("model-inspector-parse-error", `Model-backed runtime policy returned unparsable output: ${detail}`)];
    }
    return [modelFailureFinding("model-inspector-error", `Model-backed runtime policy failed: ${detail}`)];
  }
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

function inspectFindings(options: RuntimePolicyInspectOptions, somaHome: string): RuntimePolicyFinding[] {
  if (options.surface === "prompt") {
    if (typeof options.prompt !== "string") {
      return [finding("malformed-prompt", "critical", "Prompt inspection requires prompt text.", INPUT_INSPECTOR_ID)];
    }
    return inspectPrompt(options.prompt);
  }

  if (options.surface === "tool_call") return inspectToolCall(options);
  if (options.surface === "permission_request") return inspectPermissionRequest(options, somaHome);
  if (options.surface === "config_change") return inspectConfigChange(options);

  return [];
}

async function inspectAllFindings(options: RuntimePolicyInspectOptions, somaHome: string): Promise<RuntimePolicyFinding[]> {
  const deterministicFindings = inspectFindings(options, somaHome);
  if (decisionForFindings(deterministicFindings) === "deny") return deterministicFindings;
  return [...deterministicFindings, ...await inspectModelBackedPolicy(options)];
}

function changedConfigKeys(change: RuntimePolicyConfigChange | undefined): string[] {
  if (!change) return [];
  const before = flattenConfigKeys(change.before);
  const after = flattenConfigKeys(change.after);
  return Array.from(new Set([...before.keys(), ...after.keys()]))
    .filter((key) => before.get(key) !== after.get(key))
    .sort();
}

function inspectedInputRef(options: RuntimePolicyInspectOptions): {
  kind: string;
  hash?: string;
  toolName?: string;
  requestId?: string;
  action?: string;
  cacheKey?: string;
  targetHash?: string;
  configSurface?: string;
  changedKeys?: string[];
  error?: string;
} {
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

  if (options.surface === "config_change") {
    return {
      kind: "config_change",
      configSurface: options.configChange?.configSurface,
      changedKeys: changedConfigKeys(options.configChange),
      error: options.configChange?.error?.kind,
    };
  }

  if (options.surface === "permission_request") {
    return {
      kind: "permission_request",
      requestId: options.permissionRequest?.requestId,
      action: options.permissionRequest?.action,
      cacheKey: options.permissionRequest?.cacheKey,
      targetHash: options.permissionRequest?.targetPath ? inputHash(options.permissionRequest.targetPath) : undefined,
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
  const findings = await inspectAllFindings(options, somaHome);
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
