import type { ExperimentalScaffoldSubstrate, ProjectionSubstrate, SubstrateId } from "../core/types";
import type { SomaMemoryEvent } from "../events/index";
import type { InferenceBackend, InferenceLevel } from "../tools/inference";
export type { BehaviorPolicy } from "./behavior-policy";

export type InstallSubstrate = ShippedSubstrate | ExperimentalScaffoldSubstrate;

export interface PrivateRootOptions {
  homeDir?: string;
  substrate?: ProjectionSubstrate;
  substrateHome?: string;
}

export type SomaPolicyAction = "write" | "delete" | "modify";

export type SomaPolicyDecision = "allow" | "deny";

export type InboundContentDecision = "ALLOWED" | "BLOCKED" | "HUMAN_REVIEW";

export interface InboundContentFinding {
  kind: string;
  detail: string;
}

export interface InboundContentScanInput {
  content: string;
  sourcePath?: string;
  sourceUri?: string;
}

export interface InboundContentScanResult {
  decision: InboundContentDecision;
  reason: string;
  scanner: string;
  contentHash: string;
  findings: InboundContentFinding[];
}

export interface InboundContentScanner {
  id: string;
  scan(input: InboundContentScanInput): Promise<Omit<InboundContentScanResult, "scanner" | "contentHash">> | Omit<InboundContentScanResult, "scanner" | "contentHash">;
}

export interface InboundContentSecurityConfig {
  untrustedRoots: string[];
  traceRoot: string;
}

export interface InboundContentScanOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  content?: string;
  sourcePath?: string;
  sourceUri?: string;
  scanner?: InboundContentScanner;
  record?: "all" | "deny" | "none";
  timestamp?: string;
}

export interface InboundContentScanAudit {
  event?: SomaMemoryEvent;
  tracePath?: string;
}

export interface InboundContentScanOutput extends InboundContentScanResult {
  somaHome: string;
  sourcePath?: string;
  sourceUri?: string;
  audit?: InboundContentScanAudit;
}

export interface InboundContentPromotionResult {
  somaHome: string;
  sourcePath: string;
  contentRef: {
    hash: string;
    algorithm: "sha256";
  };
  scan: InboundContentScanOutput;
}

export type RuntimePolicySurface = "prompt" | "tool_call" | "permission_request" | "config_change" | "governance_event";

export type RuntimePolicyDecision = "allow" | "deny" | "ask" | "alert";

export type RuntimePolicyFindingSeverity = "low" | "medium" | "high" | "critical";

export interface RuntimePolicyFinding {
  kind: string;
  severity: RuntimePolicyFindingSeverity;
  detail: string;
  inspector: string;
  decision?: Exclude<RuntimePolicyDecision, "allow">;
  /** How to do the same thing safely; appended to the decision reason the model sees. */
  hint?: string;
}

export interface RuntimePolicyToolCall {
  toolName: string;
  input?: Record<string, unknown>;
}

export interface RuntimePolicyCommandPatternRule {
  kind: string;
  pattern: string;
  detail: string;
  decision: Exclude<RuntimePolicyDecision, "allow">;
  severity?: RuntimePolicyFindingSeverity;
}

export interface RuntimePolicyCommandInspectionConfig {
  outboundTools?: readonly string[];
  privatePathPatterns?: readonly string[];
  credentialPathPatterns?: readonly string[];
  /** Extra path regexes for `secret-read`, on top of the defaults (soma#716). */
  secretReadPathPatterns?: readonly string[];
  patternRules?: readonly RuntimePolicyCommandPatternRule[];
  inlineInterpreterDecision?: Exclude<RuntimePolicyDecision, "allow">;
}

export type RuntimePolicyPermissionAction = "read" | "write" | "delete" | "execute" | "network" | "unknown";

export interface RuntimePolicyTrustedRoot {
  path: string;
  actions: readonly RuntimePolicyPermissionAction[];
  description?: string;
}

export interface RuntimePolicyApprovalCacheEntry {
  cacheKey: string;
  action: RuntimePolicyPermissionAction;
  targetPath?: string;
  expiresAt?: string;
}

export interface RuntimePolicyPermissionConfig {
  trustedRoots?: readonly RuntimePolicyTrustedRoot[];
  approvalCache?: readonly RuntimePolicyApprovalCacheEntry[];
}

export interface RuntimePolicyModelRule {
  id: string;
  description: string;
  surfaces?: readonly RuntimePolicySurface[];
  decision?: Exclude<RuntimePolicyDecision, "allow" | "deny">;
  severity?: RuntimePolicyFindingSeverity;
}

export interface RuntimePolicyModelInspectorConfig {
  enabled?: boolean;
  rules?: readonly RuntimePolicyModelRule[];
  level?: InferenceLevel;
  timeoutMs?: number;
}

export interface RuntimePolicyConfig {
  command?: RuntimePolicyCommandInspectionConfig;
  permission?: RuntimePolicyPermissionConfig;
  model?: RuntimePolicyModelInspectorConfig;
  privateRoots?: readonly string[];
}

export type RuntimePolicyConfigChangeErrorKind = "unreadable" | "malformed";

export interface RuntimePolicyConfigChangeError {
  kind: RuntimePolicyConfigChangeErrorKind;
  detail?: string;
}

export interface RuntimePolicyConfigChange {
  configSurface: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  error?: RuntimePolicyConfigChangeError;
  securityRelevantKeys?: readonly string[];
}

export interface RuntimePolicyPermissionRequest {
  requestId: string;
  action: RuntimePolicyPermissionAction;
  targetPath?: string;
  toolName?: string;
  cacheKey?: string;
  substrateSupportsAsk?: boolean;
}

export interface RuntimePolicyInspectOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  surface: RuntimePolicySurface;
  prompt?: string;
  toolCall?: RuntimePolicyToolCall;
  configChange?: RuntimePolicyConfigChange;
  permissionRequest?: RuntimePolicyPermissionRequest;
  runtimePolicy?: RuntimePolicyConfig;
  modelInspectorBackend?: InferenceBackend;
  record?: "all" | "deny" | "none";
  timestamp?: string;
}

export interface RuntimePolicyInspectAudit {
  event?: SomaMemoryEvent;
  tracePath?: string;
}

export interface RuntimePolicyInspectResult {
  somaHome: string;
  surface: RuntimePolicySurface;
  decision: RuntimePolicyDecision;
  /**
   * What the substrate relays to the model and the principal. A prompt denial
   * quotes the input span that tripped it, so this may contain raw input:
   * relay it, never persist it. Traces and events store a span-free reason.
   */
  reason: string;
  findings: RuntimePolicyFinding[];
  audit?: RuntimePolicyInspectAudit;
}

export interface SomaProtectedPath {
  path: string;
  description: string;
  guardDelete?: boolean;
  guardModify?: boolean;
  /**
   * Subpaths (relative to `path`) where `modify` is permitted even though the
   * surrounding root is otherwise modify-guarded. Has no effect on `delete`;
   * destructive operations against any descendant of `path` remain blocked.
   *
   * Used to declare known memory/VSA destinations under a private root so that
   * legitimate Soma writes (e.g. `~/.soma/vsa/*.md`, `~/.soma/memory/...`)
   * pass while overwrites of the private root itself (`~/.soma/profile/...`)
   * stay denied.
   */
  allowedSubpaths?: string[];
}

export interface SomaPolicyCheckOptions {
  homeDir?: string;
  somaHome?: string;
  cwd?: string;
  privateRoots?: string[];
  protectedPaths?: SomaProtectedPath[];
  substrate?: SubstrateId;
  action: SomaPolicyAction;
  destinationPath: string;
  content?: string;
  sourcePath?: string;
  record?: "all" | "deny" | "none";
  timestamp?: string;
}

export interface SomaPolicyBatchTarget {
  filePath: string;
  action?: SomaPolicyAction;
  content?: string;
  sourcePath?: string;
}

export interface SomaPolicyBatchCheckOptions extends Pick<SomaPolicyCheckOptions, "homeDir" | "somaHome" | "cwd" | "substrate" | "action" | "record" | "timestamp" | "protectedPaths"> {
  privateRoots?: string[];
  targets: SomaPolicyBatchTarget[];
}

export type SomaPolicyFindingKind = "private-source" | "private-marker" | "protected-path";

export interface SomaPolicyFinding {
  kind: SomaPolicyFindingKind;
  detail: string;
}

export interface SomaPolicyCheckResult {
  somaHome: string;
  decision: SomaPolicyDecision;
  reason: string;
  findings: SomaPolicyFinding[];
  event?: SomaMemoryEvent;
}

export interface SomaPolicyBatchCheckResult {
  decision: SomaPolicyDecision;
  reason: string;
  results: SomaPolicyCheckResult[];
}

/**
 * The substrates with a shipped adapter. Install, reproject, `soma doctor` and
 * content-compare all cover exactly these; add a substrate here, not per command.
 */
export const SHIPPED_SUBSTRATES = ["codex", "pi-dev", "claude-code", "cursor", "grok", "dsh"] as const satisfies readonly SubstrateId[];
export type ShippedSubstrate = (typeof SHIPPED_SUBSTRATES)[number];
