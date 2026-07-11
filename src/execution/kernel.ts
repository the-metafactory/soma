import { isAbsolute, resolve } from "node:path";
import { isInsidePath } from "../path-utils";
import type {
  ExecutionCapabilities,
  SomaExecutionEvent,
  SomaExecutionFailureCode,
  SomaExecutionRequest,
  SomaExecutionResult,
  SubstrateExecutor,
} from "./types";

export interface ExecutionKernelOptions {
  /**
   * Root authorized by the trusted kernel caller. The request's cwd must stay
   * inside this directory; a request cannot broaden its own filesystem scope.
   */
  authorizedWorkspaceRoot?: string;
  signal?: AbortSignal;
}

export interface SubstrateExecutionRun {
  events: SomaExecutionEvent[];
  result: SomaExecutionResult;
}

interface NormalizedFailure {
  code: SomaExecutionFailureCode;
  summary: string;
  retryable: boolean;
}

const FAILURE_CODES = new Set<SomaExecutionFailureCode>([
  "invalid-request",
  "substrate-unavailable",
  "substrate-version-unsupported",
  "projection-stale",
  "capability-unsupported",
  "policy-denied",
  "approval-required",
  "timeout",
  "substrate-exit",
  "malformed-output",
  "artifact-escape",
  "writeback-failed",
  "internal",
]);
const MAX_RETAINED_EVENTS = 256;
const MAX_RETAINED_ARTIFACTS = 128;
const MAX_EVENT_SUMMARY_LENGTH = 4_096;
const MAX_ARTIFACT_PATH_LENGTH = 4_096;

function now(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizedFailure(error: unknown, fallback: NormalizedFailure): NormalizedFailure {
  if (!isRecord(error)) return fallback;
  const { code, summary, retryable } = error;
  if (typeof code !== "string" || !FAILURE_CODES.has(code as SomaExecutionFailureCode) || typeof summary !== "string") return fallback;
  return { code: code as SomaExecutionFailureCode, summary, retryable: retryable === true };
}

function failedEvent(executionId: string, failure: NormalizedFailure): SomaExecutionEvent {
  return { kind: "execution.failed", executionId, timestamp: now(), ...failure };
}

function invalidEvent(event: unknown): string | undefined {
  if (!isRecord(event) || typeof event.kind !== "string" || typeof event.executionId !== "string" || typeof event.timestamp !== "string") {
    return "Execution event has an invalid shape.";
  }
  if (Number.isNaN(Date.parse(event.timestamp))) return "Execution event timestamp is invalid.";
  if (event.executionId.length > 256) return "Execution event id is too long.";
  if (!["execution.started", "execution.progress", "execution.artifact", "execution.policy", "execution.completed", "execution.failed", "execution.cancelled"].includes(event.kind)) {
    return "Execution event kind is invalid.";
  }
  if (["execution.progress", "execution.completed", "execution.cancelled"].includes(event.kind) && typeof event.summary !== "string") {
    return "Execution event summary is invalid.";
  }
  if (["execution.progress", "execution.completed", "execution.cancelled"].includes(event.kind) && typeof event.summary === "string" && event.summary.length > MAX_EVENT_SUMMARY_LENGTH) {
    return "Execution event summary is too long.";
  }
  if (event.kind === "execution.artifact" && (typeof event.path !== "string" || event.path.length > MAX_ARTIFACT_PATH_LENGTH || !["created", "modified", "deleted"].includes(String(event.change)))) {
    return "Execution artifact event is invalid.";
  }
  if (event.kind === "execution.policy" && !["allow", "ask", "deny", "alert"].includes(String(event.decision))) {
    return "Execution policy event is invalid.";
  }
  if (event.kind === "execution.failed" && (typeof event.code !== "string" || !FAILURE_CODES.has(event.code as SomaExecutionFailureCode) || typeof event.summary !== "string" || event.summary.length > MAX_EVENT_SUMMARY_LENGTH || typeof event.retryable !== "boolean")) {
    return "Execution failure event is invalid.";
  }
  return undefined;
}

function terminal(event: SomaExecutionEvent): boolean {
  return event.kind === "execution.completed" || event.kind === "execution.failed" || event.kind === "execution.cancelled";
}

function resultFor(
  request: SomaExecutionRequest,
  executionId: string,
  capabilities: ExecutionCapabilities,
  status: SomaExecutionResult["status"],
  summary: string,
  artifacts: string[],
  startedAt: string,
): SomaExecutionResult {
  return {
    taskId: request.taskId,
    executionId,
    substrate: request.substrate,
    status,
    summary,
    artifacts,
    startedAt,
    completedAt: now(),
    capabilitySnapshot: capabilities,
    projectionFingerprint: request.projectionFingerprint,
  };
}

function unavailableCapabilities(substrate: SomaExecutionRequest["substrate"]): ExecutionCapabilities {
  return {
    substrate,
    available: false,
    executorVersion: "unavailable",
    supportedCapabilities: [],
    streaming: false,
    cancellation: "unsupported",
    approvals: "unsupported",
    sandbox: "none",
    sessionLifecycle: [],
    artifactReporting: false,
    limitations: [],
  };
}

function sameStringList(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function matchesRequest(prepared: SomaExecutionRequest, request: SomaExecutionRequest): boolean {
  return prepared.taskId === request.taskId
    && prepared.substrate === request.substrate
    && prepared.prompt === request.prompt
    && prepared.cwd === request.cwd
    && prepared.algorithmRunId === request.algorithmRunId
    && prepared.sessionId === request.sessionId
    && prepared.projectionFingerprint === request.projectionFingerprint
    && prepared.timeoutMs === request.timeoutMs
    && sameStringList(prepared.requiredCapabilities, request.requiredCapabilities)
    && sameStringList(prepared.expectedArtifacts, request.expectedArtifacts);
}

function abortableNext<T>(next: Promise<IteratorResult<T>>, signal: AbortSignal): Promise<{ kind: "next"; value: IteratorResult<T> } | { kind: "aborted" } | { kind: "error"; error: unknown }> {
  if (signal.aborted) return Promise.resolve({ kind: "aborted" });
  return new Promise((resolveResult) => {
    const onAbort = () => {
      resolveResult({ kind: "aborted" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    next.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolveResult({ kind: "next", value });
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        resolveResult({ kind: "error", error });
      },
    );
  });
}

/**
 * Runs one already-registered executor through the common event boundary. The
 * kernel invokes no command directly and writes no durable state; executors own
 * substrate invocation details and this kernel returns bounded result metadata.
 */
export async function runSubstrateExecution(
  executor: SubstrateExecutor,
  request: SomaExecutionRequest,
  options: ExecutionKernelOptions = {},
): Promise<SubstrateExecutionRun> {
  const beganAt = now();
  const events: SomaExecutionEvent[] = [];
  let eventHistoryTruncated = false;
  const controller = new AbortController();
  const timeout = { triggered: false };
  const abort = () => {
    controller.abort();
  };
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer = request.timeoutMs === undefined ? undefined : setTimeout(() => {
    timeout.triggered = true;
    controller.abort();
  }, request.timeoutMs);

  let capabilities: ExecutionCapabilities | undefined;
  let executionId = request.taskId;
  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    await executor.cancel(executionId);
  };
  const appendEvent = (event: SomaExecutionEvent): void => {
    if (terminal(event)) {
      events.push(event);
      return;
    }
    // Reserve one slot for a truncation marker and one for the terminal event.
    if (events.length < MAX_RETAINED_EVENTS - 2) {
      events.push(event);
      return;
    }
    if (!eventHistoryTruncated) {
      eventHistoryTruncated = true;
      events.push({
        kind: "execution.progress",
        executionId,
        timestamp: now(),
        summary: "Execution event history was truncated.",
      });
    }
  };
  const finish = (event: SomaExecutionEvent, result: SomaExecutionResult, appendEventToHistory = true): SubstrateExecutionRun => {
    if (appendEventToHistory) appendEvent(event);
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    return { events, result };
  };
  const fail = (failure: NormalizedFailure): SubstrateExecutionRun => {
    const activeCapabilities = capabilities ?? unavailableCapabilities(request.substrate);
    const event = failedEvent(executionId, failure);
    return finish(event, resultFor(request, executionId, activeCapabilities, "failed", failure.summary, [], beganAt));
  };

  try {
    const isAborted = () => controller.signal.aborted;
    if (isAborted()) {
      const summary = "Execution was cancelled before preflight.";
      const event: SomaExecutionEvent = { kind: "execution.cancelled", executionId, timestamp: now(), summary };
      return finish(event, resultFor(request, executionId, unavailableCapabilities(request.substrate), "cancelled", summary, [], beganAt));
    }
    const workspaceRoot = options.authorizedWorkspaceRoot;
    if (
      !isAbsolute(request.cwd)
      || typeof workspaceRoot !== "string"
      || !isAbsolute(workspaceRoot)
      || !isInsidePath(resolve(request.cwd), resolve(workspaceRoot))
      || request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)
      || !Array.isArray(request.requiredCapabilities)
      || request.requiredCapabilities.some((capability) => typeof capability !== "string" || capability.length === 0)
    ) {
      return fail({ code: "invalid-request", summary: "Execution request is invalid.", retryable: false });
    }
    const probedCapabilities = await executor.probe({ cwd: request.cwd, signal: controller.signal });
    if (isAborted()) {
      const summary = timeout.triggered ? "Execution timed out." : "Execution was cancelled.";
      if (timeout.triggered) return fail({ code: "timeout", summary, retryable: true });
      const event: SomaExecutionEvent = { kind: "execution.cancelled", executionId, timestamp: now(), summary };
      return finish(event, resultFor(request, executionId, unavailableCapabilities(request.substrate), "cancelled", summary, [], beganAt));
    }
    capabilities = probedCapabilities;
    if (probedCapabilities.substrate !== request.substrate || executor.substrate !== request.substrate) {
      return fail({ code: "invalid-request", summary: "Executor substrate does not match the request.", retryable: false });
    }
    if (!probedCapabilities.available) return fail({ code: "substrate-unavailable", summary: "Substrate is unavailable.", retryable: true });
    const unsupportedCapabilities = request.requiredCapabilities.filter((capability) => !probedCapabilities.supportedCapabilities.includes(capability));
    if (unsupportedCapabilities.length > 0) {
      return fail({ code: "capability-unsupported", summary: `Required capabilities are unavailable: ${unsupportedCapabilities.join(", ")}.`, retryable: false });
    }

    const prepared = await executor.prepare(request, { signal: controller.signal });
    executionId = prepared.executionId;
    if (!matchesRequest(prepared.request, request) || prepared.capabilitySnapshot.substrate !== request.substrate) {
      return fail({ code: "invalid-request", summary: "Prepared execution does not match the request.", retryable: false });
    }
    capabilities = prepared.capabilitySnapshot;
    if (isAborted()) {
      await cancel();
      const summary = timeout.triggered ? "Execution timed out." : "Execution was cancelled.";
      if (timeout.triggered) return fail({ code: "timeout", summary, retryable: true });
      const event: SomaExecutionEvent = { kind: "execution.cancelled", executionId, timestamp: now(), summary };
      return finish(event, resultFor(request, executionId, capabilities, "cancelled", summary, [], beganAt));
    }

    const iterator = executor.execute(prepared, { signal: controller.signal })[Symbol.asyncIterator]();
    const artifacts: string[] = [];
    let artifactsTruncated = false;
    let startedAt: string | undefined;
    let terminalEvent: SomaExecutionEvent | undefined;
    for (;;) {
      const next = iterator.next();
      const outcome = await abortableNext(next, controller.signal);
      if (outcome.kind === "aborted") {
        void next.catch(() => undefined);
        await cancel();
        const summary = timeout.triggered ? "Execution timed out." : "Execution was cancelled.";
        if (timeout.triggered) return fail({ code: "timeout", summary, retryable: true });
        const event: SomaExecutionEvent = { kind: "execution.cancelled", executionId, timestamp: now(), summary };
        return finish(event, resultFor(request, executionId, capabilities, "cancelled", summary, artifacts, startedAt ?? beganAt));
      }
      if (outcome.kind === "error") return fail(normalizedFailure(outcome.error, { code: "internal", summary: "Executor failed unexpectedly.", retryable: false }));
      if (outcome.value.done) break;

      const event = outcome.value.value;
      const shapeError = invalidEvent(event);
      if (shapeError !== undefined || event.executionId !== executionId) {
        return fail({ code: "malformed-output", summary: shapeError ?? "Execution event id does not match the prepared execution.", retryable: false });
      }
      if (startedAt === undefined && event.kind !== "execution.started") {
        return fail({ code: "malformed-output", summary: "Execution stream must start with execution.started.", retryable: false });
      }
      if (event.kind === "execution.started") {
        if (startedAt !== undefined) return fail({ code: "malformed-output", summary: "Execution stream has multiple start events.", retryable: false });
        startedAt = event.timestamp;
      }
      if (terminalEvent !== undefined) {
        events.pop();
        return fail({ code: "malformed-output", summary: "Execution stream emitted an event after termination.", retryable: false });
      }
      if (event.kind === "execution.artifact") {
        const artifact = resolve(request.cwd, event.path);
        if (!isInsidePath(artifact, resolve(request.cwd))) return fail({ code: "artifact-escape", summary: "Execution artifact escapes the request cwd.", retryable: false });
        if (artifacts.length < MAX_RETAINED_ARTIFACTS) {
          artifacts.push(artifact);
        } else if (!artifactsTruncated) {
          artifactsTruncated = true;
          appendEvent({ kind: "execution.progress", executionId, timestamp: now(), summary: "Execution artifact history was truncated." });
        }
      }
      appendEvent(event);
      if (terminal(event)) terminalEvent = event;
    }

    if (startedAt === undefined || terminalEvent === undefined) {
      return fail({ code: "malformed-output", summary: "Execution stream ended without one terminal event.", retryable: false });
    }
    switch (terminalEvent.kind) {
      case "execution.completed":
        return finish(terminalEvent, resultFor(request, executionId, capabilities, "completed", terminalEvent.summary, artifacts, startedAt), false);
      case "execution.cancelled":
        return finish(terminalEvent, resultFor(request, executionId, capabilities, "cancelled", terminalEvent.summary, artifacts, startedAt), false);
      case "execution.failed":
        return finish(terminalEvent, resultFor(request, executionId, capabilities, "failed", terminalEvent.summary, artifacts, startedAt), false);
      default:
        return fail({ code: "malformed-output", summary: "Execution stream terminal event is invalid.", retryable: false });
    }
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      const summary = timeout.triggered ? "Execution timed out." : "Execution was cancelled.";
      if (timeout.triggered) return fail({ code: "timeout", summary, retryable: true });
      const event: SomaExecutionEvent = { kind: "execution.cancelled", executionId, timestamp: now(), summary };
      return finish(event, resultFor(request, executionId, capabilities ?? unavailableCapabilities(request.substrate), "cancelled", summary, [], beganAt));
    }
    return fail(normalizedFailure(error, { code: "internal", summary: "Executor failed unexpectedly.", retryable: false }));
  }
}
