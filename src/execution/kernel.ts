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
  "host-unavailable",
  "host-version-unsupported",
  "projection-stale",
  "capability-unsupported",
  "policy-denied",
  "approval-required",
  "timeout",
  "host-exit",
  "malformed-output",
  "artifact-escape",
  "writeback-failed",
  "internal",
]);

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
  if (!["execution.started", "execution.progress", "execution.artifact", "execution.policy", "execution.completed", "execution.failed", "execution.cancelled"].includes(event.kind)) {
    return "Execution event kind is invalid.";
  }
  if (["execution.progress", "execution.completed", "execution.cancelled"].includes(event.kind) && typeof event.summary !== "string") {
    return "Execution event summary is invalid.";
  }
  if (event.kind === "execution.artifact" && (typeof event.path !== "string" || !["created", "modified", "deleted"].includes(String(event.change)))) {
    return "Execution artifact event is invalid.";
  }
  if (event.kind === "execution.policy" && !["allow", "ask", "deny", "alert"].includes(String(event.decision))) {
    return "Execution policy event is invalid.";
  }
  if (event.kind === "execution.failed" && (typeof event.code !== "string" || !FAILURE_CODES.has(event.code as SomaExecutionFailureCode) || typeof event.summary !== "string" || typeof event.retryable !== "boolean")) {
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
 * Runs one already-registered executor without invoking a process or writing
 * durable state. Executors own host details; this kernel validates the common
 * event boundary and returns only bounded result metadata.
 */
export async function runSubstrateExecution(
  executor: SubstrateExecutor,
  request: SomaExecutionRequest,
  options: ExecutionKernelOptions = {},
): Promise<SubstrateExecutionRun> {
  const beganAt = now();
  const events: SomaExecutionEvent[] = [];
  const controller = new AbortController();
  const timeout = { triggered: false };
  const abort = () => {
    controller.abort();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
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
  const finish = (event: SomaExecutionEvent, result: SomaExecutionResult, appendEvent = true): SubstrateExecutionRun => {
    if (appendEvent) events.push(event);
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    return { events, result };
  };
  const fail = (failure: NormalizedFailure): SubstrateExecutionRun => {
    const activeCapabilities = capabilities ?? {
      substrate: request.substrate,
      available: false,
      executorVersion: "unavailable",
      streaming: false,
      cancellation: "unsupported" as const,
      approvals: "unsupported" as const,
      sandbox: "none" as const,
      sessionLifecycle: [],
      artifactReporting: false,
      limitations: [],
    };
    const event = failedEvent(executionId, failure);
    return finish(event, resultFor(request, executionId, activeCapabilities, "failed", failure.summary, [], beganAt));
  };

  try {
    if (!isAbsolute(request.cwd) || request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) {
      return fail({ code: "invalid-request", summary: "Execution request is invalid.", retryable: false });
    }
    capabilities = await executor.probe({ cwd: request.cwd, signal: controller.signal });
    if (capabilities.substrate !== request.substrate || executor.substrate !== request.substrate) {
      return fail({ code: "invalid-request", summary: "Executor substrate does not match the request.", retryable: false });
    }
    if (!capabilities.available) return fail({ code: "host-unavailable", summary: "Substrate host is unavailable.", retryable: true });

    const prepared = await executor.prepare(request);
    executionId = prepared.executionId;
    if (prepared.request !== request || prepared.capabilitySnapshot.substrate !== request.substrate) {
      return fail({ code: "invalid-request", summary: "Prepared execution does not match the request.", retryable: false });
    }
    capabilities = prepared.capabilitySnapshot;
    if (controller.signal.aborted) {
      await cancel();
      const summary = timeout.triggered ? "Execution timed out." : "Execution was cancelled.";
      if (timeout.triggered) return fail({ code: "timeout", summary, retryable: true });
      const event: SomaExecutionEvent = { kind: "execution.cancelled", executionId, timestamp: now(), summary };
      return finish(event, resultFor(request, executionId, capabilities, "cancelled", summary, [], beganAt));
    }

    const iterator = executor.execute(prepared, { signal: controller.signal })[Symbol.asyncIterator]();
    const artifacts: string[] = [];
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
        artifacts.push(artifact);
      }
      events.push(event);
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
    return fail(normalizedFailure(error, { code: "internal", summary: "Executor failed unexpectedly.", retryable: false }));
  }
}
