import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  runSubstrateExecution,
  type ExecutionCapabilities,
  type SomaExecutionEvent,
  type SomaExecutionRequest,
  type SubstrateExecutor,
} from "../src/index";

const timestamp = "2026-07-10T12:00:00.000Z";

function request(overrides: Partial<SomaExecutionRequest> = {}): SomaExecutionRequest {
  return {
    taskId: "task-1",
    substrate: "codex",
    prompt: "Update the fixture",
    cwd: "/tmp/soma-execution-fixture",
    projectionFingerprint: "projection-1",
    requiredCapabilities: [],
    ...overrides,
  };
}

function capabilities(overrides: Partial<ExecutionCapabilities> = {}): ExecutionCapabilities {
  return {
    substrate: "codex",
    available: true,
    executorVersion: "test",
    supportedCapabilities: [],
    streaming: true,
    cancellation: "hard",
    approvals: "native",
    sandbox: "none",
    sessionLifecycle: [],
    artifactReporting: true,
    limitations: [],
    ...overrides,
  };
}

function events(...items: SomaExecutionEvent[]): AsyncIterable<SomaExecutionEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

function fakeExecutor(options: {
  events?: AsyncIterable<SomaExecutionEvent>;
  capabilities?: ExecutionCapabilities;
  prepareError?: Error;
  calls?: string[];
  onCancel?: () => void;
} = {}): SubstrateExecutor {
  const calls = options.calls ?? [];
  return {
    substrate: "codex",
    async probe() {
      calls.push("probe");
      return options.capabilities ?? capabilities();
    },
    async prepare(input) {
      calls.push("prepare");
      if (options.prepareError !== undefined) throw options.prepareError;
      return {
        executionId: "execution-1",
        request: input,
        capabilitySnapshot: options.capabilities ?? capabilities(),
      };
    },
    execute() {
      calls.push("execute");
      return options.events ?? events();
    },
    async cancel() {
      calls.push("cancel");
      options.onCancel?.();
    },
  };
}

function run(executor: SubstrateExecutor, input: SomaExecutionRequest, options: Omit<Parameters<typeof runSubstrateExecution>[2], "authorizedWorkspaceRoot"> = {}) {
  return runSubstrateExecution(executor, input, { authorizedWorkspaceRoot: "/tmp", ...options });
}

const started: SomaExecutionEvent = { kind: "execution.started", executionId: "execution-1", timestamp };
const completed: SomaExecutionEvent = { kind: "execution.completed", executionId: "execution-1", timestamp, summary: "done" };

test("runs probe, prepare, and execute in order, then reduces a valid event stream", async () => {
  const calls: string[] = [];
  const result = await run(
    fakeExecutor({
      calls,
      events: events(
        started,
        { kind: "execution.progress", executionId: "execution-1", timestamp, summary: "working" },
        { kind: "execution.artifact", executionId: "execution-1", timestamp, path: "/tmp/soma-execution-fixture/ledger.md", change: "modified" },
        completed,
      ),
    }),
    request(),
  );

  expect(calls).toEqual(["probe", "prepare", "execute"]);
  expect(result.result).toMatchObject({ status: "completed", summary: "done", artifacts: ["/tmp/soma-execution-fixture/ledger.md"] });
  expect(result.events.map((event) => event.kind)).toEqual(["execution.started", "execution.progress", "execution.artifact", "execution.completed"]);
});

test("normalizes unavailable substrates and typed preparation refusals", async () => {
  const unavailable = await run(fakeExecutor({ capabilities: capabilities({ available: false }) }), request());
  expect(unavailable.result).toMatchObject({ status: "failed", summary: "Substrate is unavailable." });
  expect(unavailable.events).toHaveLength(1);
  expect(unavailable.events[0]).toMatchObject({ kind: "execution.failed", code: "substrate-unavailable" });

  const refusal = Object.assign(new Error("memory-recall is unavailable"), { code: "capability-unsupported", summary: "memory-recall is unavailable", retryable: false });
  const refused = await run(
    fakeExecutor({ capabilities: capabilities({ supportedCapabilities: ["memory-recall"] }), prepareError: refusal }),
    request({ requiredCapabilities: ["memory-recall"] }),
  );
  expect(refused.events[0]).toMatchObject({ kind: "execution.failed", code: "capability-unsupported", summary: "memory-recall is unavailable" });
});

test("fails closed before preparation for unauthorized workspaces and unsupported capabilities", async () => {
  const unauthorizedCalls: string[] = [];
  const unauthorized = await run(fakeExecutor({ calls: unauthorizedCalls }), request({ cwd: "/private" }));
  expect(unauthorized.events[0]).toMatchObject({ kind: "execution.failed", code: "invalid-request" });
  expect(unauthorizedCalls).toEqual([]);

  const capabilityCalls: string[] = [];
  const unsupported = await run(fakeExecutor({ calls: capabilityCalls }), request({ requiredCapabilities: ["memory-recall"] }));
  expect(unsupported.events[0]).toMatchObject({ kind: "execution.failed", code: "capability-unsupported" });
  expect(capabilityCalls).toEqual(["probe"]);
});

test("returns an already-aborted request without probing or preparing", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls: string[] = [];
  const cancelled = await run(fakeExecutor({ calls }), request(), { signal: controller.signal });
  expect(cancelled.events).toEqual([expect.objectContaining({ kind: "execution.cancelled", summary: "Execution was cancelled before preflight." })]);
  expect(calls).toEqual([]);
});

test("forwards timeout cancellation through preflight without preparing", async () => {
  const calls: string[] = [];
  const executor = fakeExecutor({ calls });
  executor.probe = async (options) => {
    calls.push("probe");
    return await new Promise<ExecutionCapabilities>((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("probe aborted")), { once: true }));
  };
  const timedOut = await run(executor, request({ timeoutMs: 5 }));
  expect(timedOut.events.at(-1)).toMatchObject({ kind: "execution.failed", code: "timeout" });
  expect(calls).toEqual(["probe"]);
});

test("rejects malformed streams and normalizes executor exceptions without leaking raw errors", async () => {
  const malformed = await run(fakeExecutor({ events: events(completed) }), request());
  expect(malformed.events[0]).toMatchObject({ kind: "execution.failed", code: "malformed-output" });

  const postTerminal = await run(
    fakeExecutor({ events: events(started, completed, { kind: "execution.progress", executionId: "execution-1", timestamp, summary: "too late" }) }),
    request(),
  );
  expect(postTerminal.events).toHaveLength(2);
  expect(postTerminal.events.at(-1)).toMatchObject({ kind: "execution.failed", code: "malformed-output" });

  const executor = fakeExecutor({ events: events(started) });
  executor.execute = () => {
    throw new Error("secret token must not escape");
  };
  const failed = await run(executor, request());
  expect(failed.events.at(-1)).toMatchObject({ kind: "execution.failed", code: "internal" });
  expect(JSON.stringify(failed)).not.toContain("secret token");
});

test("times out and cancels without consuming a later terminal event", async () => {
  const calls: string[] = [];
  const slow = {
    async *[Symbol.asyncIterator](): AsyncGenerator<SomaExecutionEvent> {
      yield started;
      await Bun.sleep(30);
      yield completed;
    },
  };
  const result = await run(fakeExecutor({ calls, events: slow }), request({ timeoutMs: 5 }));

  expect(calls).toContain("cancel");
  expect(result.events.at(-1)).toMatchObject({ kind: "execution.failed", code: "timeout" });
  expect(result.events.map((event) => event.kind)).not.toContain("execution.completed");
});

test("cancels an externally aborted execution and rejects artifact escapes", async () => {
  const controller = new AbortController();
  const delayed = {
    async *[Symbol.asyncIterator](): AsyncGenerator<SomaExecutionEvent> {
      yield started;
      await Bun.sleep(30);
      yield completed;
    },
  };
  setTimeout(() => controller.abort(), 5);
  const cancelled = await run(fakeExecutor({ events: delayed }), request(), { signal: controller.signal });
  expect(cancelled.events.at(-1)).toMatchObject({ kind: "execution.cancelled" });

  const escaped = await run(
    fakeExecutor({ events: events(started, { kind: "execution.artifact", executionId: "execution-1", timestamp, path: "/tmp/escaped.md", change: "created" }) }),
    request(),
  );
  expect(escaped.events.at(-1)).toMatchObject({ kind: "execution.failed", code: "artifact-escape" });
});

test("caps retained event history while preserving a truncation marker and terminal event", async () => {
  const progress = Array.from({ length: 300 }, (_, index): SomaExecutionEvent => ({ kind: "execution.progress", executionId: "execution-1", timestamp, summary: `progress ${index}` }));
  const bounded = await run(fakeExecutor({ events: events(started, ...progress, completed) }), request());
  expect(bounded.result).toMatchObject({ status: "completed", summary: "done" });
  expect(bounded.events).toHaveLength(256);
  expect(bounded.events.at(-2)).toMatchObject({ kind: "execution.progress", summary: "Execution event history was truncated." });
  expect(bounded.events.at(-1)).toMatchObject({ kind: "execution.completed" });
});

test("bounds retained artifact paths and rejects oversized event payloads", async () => {
  const artifacts = Array.from({ length: 140 }, (_, index): SomaExecutionEvent => ({ kind: "execution.artifact", executionId: "execution-1", timestamp, path: `/tmp/soma-execution-fixture/${index}.md`, change: "modified" }));
  const bounded = await run(fakeExecutor({ events: events(started, ...artifacts, completed) }), request());
  expect(bounded.result.artifacts).toHaveLength(128);
  expect(bounded.events.some((event) => event.kind === "execution.progress" && event.summary === "Execution artifact history was truncated.")).toBe(true);

  const oversized = await run(fakeExecutor({ events: events(started, { kind: "execution.progress", executionId: "execution-1", timestamp, summary: "x".repeat(4_097) }) }), request());
  expect(oversized.events.at(-1)).toMatchObject({ kind: "execution.failed", code: "malformed-output", summary: "Execution event summary is too long." });
});

test("kernel is substrate-neutral and does not import a memory write surface", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "execution", "kernel.ts"), "utf8");
  expect(source).not.toContain("memory-write");
  expect(source).not.toMatch(/from\s+["'][^"']*memory/);
  expect(source).not.toContain("child_process");
});
