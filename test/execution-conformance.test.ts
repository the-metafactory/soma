import { expect, test } from "bun:test";
import {
  ExecutorRegistry,
  MockSubstrateExecutor,
  REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS,
  runExecutionConformance,
  type ExecutionConformanceScenario,
} from "../src/index";

const cwd = "/tmp/soma-conformance";
const timestamp = "2026-07-10T12:00:00.000Z";

function completedScenario(id: string, prompt: string, overrides: Partial<ExecutionConformanceScenario> = {}): ExecutionConformanceScenario {
  return {
    id: id as ExecutionConformanceScenario["id"],
    request: {
      taskId: id,
      substrate: "codex",
      prompt,
      cwd,
      projectionFingerprint: "fixture-projection",
      requiredCapabilities: [],
    },
    expectedStatus: "completed",
    expectedPromptTerms: [prompt],
    ...overrides,
  };
}

function terminalEvents(kind: "execution.completed" | "execution.failed" = "execution.completed") {
  return [
    { kind: "execution.started" as const, executionId: "$executionId", timestamp },
    kind === "execution.completed"
      ? { kind, executionId: "$executionId", timestamp, summary: "done" }
      : { kind, executionId: "$executionId", timestamp, code: "policy-denied" as const, summary: "denied", retryable: false },
  ];
}

test("registry distinguishes registered, projection-only, and unknown substrates", () => {
  const registry = new ExecutorRegistry();
  expect(registry.resolve("cursor")).toEqual({ status: "unsupported", reason: "projection-only", substrate: "cursor" });
  expect(registry.resolve("not-a-substrate")).toEqual({ status: "unsupported", reason: "unknown-substrate", substrate: "not-a-substrate" });

  const mock = new MockSubstrateExecutor("codex", {});
  expect(() => registry.register({ executor: mock, conformanceScenarios: REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS.slice(1) })).toThrow("missing required conformance scenarios");
  registry.register({ executor: mock, conformanceScenarios: REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS });
  expect(registry.resolve("codex")).toMatchObject({ status: "ready", executor: mock });
});

test("deterministic mock executes every shared conformance scenario through the pure kernel", async () => {
  const scenarios = [
    completedScenario("identity-context", "Identity: Ivy; Principal: Jens-Christian"),
    completedScenario("memory-recall", "Recall durable note memory-001"),
    completedScenario("skill-selection", "Select ledger-update", { request: { ...completedScenario("skill-selection", "Select ledger-update").request, requiredCapabilities: ["ledger-update"] }, expectedCapabilities: ["ledger-update"] }),
    completedScenario("policy-denial", "Attempt protected write", { expectedStatus: "failed", expectedEventKinds: ["execution.started", "execution.policy", "execution.failed"] }),
    completedScenario("artifact-declaration", "Create ledger artifact", { expectedArtifact: `${cwd}/ledger.md` }),
    completedScenario("cancellation", "Cancel slow fixture", { expectedStatus: "cancelled", abortAfterMs: 2 }),
    completedScenario("continuation-token", "Resume work", { request: { ...completedScenario("continuation-token", "Resume work").request, algorithmRunId: "run-1", sessionId: "session-1" }, expectedAlgorithmRunId: "run-1", expectedSessionId: "session-1" }),
  ];
  const mock = new MockSubstrateExecutor("codex", {
    "identity-context": { events: terminalEvents() },
    "memory-recall": { events: terminalEvents() },
    "skill-selection": { events: terminalEvents(), capabilities: { supportedCapabilities: ["ledger-update"] } },
    "policy-denial": { events: [{ kind: "execution.started", executionId: "$executionId", timestamp }, { kind: "execution.policy", executionId: "$executionId", timestamp, decision: "deny" }, ...terminalEvents("execution.failed").slice(1)] },
    "artifact-declaration": { events: [{ kind: "execution.started", executionId: "$executionId", timestamp }, { kind: "execution.artifact", executionId: "$executionId", timestamp, path: `${cwd}/ledger.md`, change: "created" }, ...terminalEvents().slice(1)] },
    cancellation: { events: terminalEvents(), delayMs: 20 },
    "continuation-token": { events: terminalEvents() },
  });

  const report = await runExecutionConformance(mock, scenarios);
  expect(report.passed).toBe(true);
  expect(report.results.map((result) => result.id)).toEqual([...REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS]);
  expect(mock.calls).not.toContain("process");
  expect(mock.calls).not.toContain("network");
});
