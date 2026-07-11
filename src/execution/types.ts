import type { ProjectionSubstrate } from "../types";

/** Immutable input for preparing one substrate execution. */
export interface SomaExecutionRequest {
  taskId: string;
  substrate: ProjectionSubstrate;
  prompt: string;
  cwd: string;
  algorithmRunId?: string;
  sessionId?: string;
  projectionFingerprint: string;
  requiredCapabilities: string[];
  expectedArtifacts?: string[];
  timeoutMs?: number;
}

/** A substrate capability probe request. Providers may add executor-local options later. */
export interface ExecutionProbeOptions {
  cwd?: string;
  signal?: AbortSignal;
}

/** A probed, current execution capability snapshot. */
export interface ExecutionCapabilities {
  substrate: ProjectionSubstrate;
  available: boolean;
  /** Version reported by the selected substrate executable. */
  substrateVersion?: string;
  executorVersion: string;
  /** Capabilities the executor can prove it supports for this invocation. */
  supportedCapabilities: string[];
  streaming: boolean;
  cancellation: "hard" | "best-effort" | "unsupported";
  approvals: "native" | "soma" | "advisory" | "unsupported";
  sandbox: "native" | "spawn" | "none";
  sessionLifecycle: string[];
  artifactReporting: boolean;
  limitations: string[];
}

/** Deterministic preflight output; provider command details stay executor-local. */
export interface PreparedExecution {
  executionId: string;
  request: SomaExecutionRequest;
  capabilitySnapshot: ExecutionCapabilities;
}

/** Options for consuming one already-prepared execution. */
export interface ExecuteOptions {
  signal?: AbortSignal;
}

/** Preflight facts passed from the kernel to avoid duplicate substrate probes. */
export interface PrepareOptions extends ExecuteOptions {
  capabilitySnapshot?: ExecutionCapabilities;
}

/** Lets the kernel release request-scoped cancellation state when execution ends. */
export interface CancelOptions {
  release?: boolean;
}

/** Stable failures emitted by the core execution boundary. */
export type SomaExecutionFailureCode =
  | "invalid-request"
  | "substrate-unavailable"
  | "substrate-version-unsupported"
  | "projection-stale"
  | "capability-unsupported"
  | "policy-denied"
  | "approval-required"
  | "timeout"
  | "substrate-exit"
  | "malformed-output"
  | "artifact-escape"
  | "writeback-failed"
  | "internal";

/** Bounded, provider-neutral execution telemetry. */
export type SomaExecutionEvent =
  | { kind: "execution.started"; executionId: string; timestamp: string }
  | { kind: "execution.progress"; executionId: string; timestamp: string; summary: string }
  | { kind: "execution.artifact"; executionId: string; timestamp: string; path: string; change: "created" | "modified" | "deleted" }
  | { kind: "execution.policy"; executionId: string; timestamp: string; decision: "allow" | "ask" | "deny" | "alert" }
  | { kind: "execution.completed"; executionId: string; timestamp: string; summary: string }
  | { kind: "execution.failed"; executionId: string; timestamp: string; code: SomaExecutionFailureCode; summary: string; retryable: boolean }
  | { kind: "execution.cancelled"; executionId: string; timestamp: string; summary: string };

/** A normalized terminal result reduced from a bounded event stream. */
export interface SomaExecutionResult {
  taskId: string;
  executionId: string;
  substrate: ProjectionSubstrate;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  artifacts: string[];
  startedAt: string;
  completedAt: string;
  capabilitySnapshot: ExecutionCapabilities;
  projectionFingerprint: string;
  transcriptRef?: string;
}

/** Optional substrate invocation, intentionally separate from projection adapters. */
export interface SubstrateExecutor {
  substrate: ProjectionSubstrate;
  probe(options?: ExecutionProbeOptions): Promise<ExecutionCapabilities>;
  prepare(request: SomaExecutionRequest, options?: PrepareOptions): Promise<PreparedExecution>;
  execute(prepared: PreparedExecution, options?: ExecuteOptions): AsyncIterable<SomaExecutionEvent>;
  cancel(executionId: string, options?: CancelOptions): Promise<void>;
}
