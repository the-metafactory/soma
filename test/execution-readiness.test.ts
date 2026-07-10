import { expect, test } from "bun:test";
import { diagnoseExecutionReadiness, ExecutorRegistry, MockSubstrateExecutor, REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS } from "../src";

test("execution readiness probes registered executors without preparing or executing", async () => {
  const registry = new ExecutorRegistry();
  const executor = new MockSubstrateExecutor("codex", {});
  registry.register({ executor, conformanceScenarios: REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS });
  expect(await diagnoseExecutionReadiness(registry, "codex")).toMatchObject({ status: "ready", substrate: "codex" });
  expect(executor.calls).toEqual(["probe"]);
});

test("execution readiness leaves projection-only and unavailable substrates distinct", async () => {
  const registry = new ExecutorRegistry();
  expect(await diagnoseExecutionReadiness(registry, "cursor")).toEqual({ substrate: "cursor", status: "projection-only", reason: "projection-only" });
  const unavailable = new MockSubstrateExecutor("claude-code", {});
  unavailable.probe = async () => {
    unavailable.calls.push("probe");
    return { substrate: "claude-code", available: false, executorVersion: "mock", streaming: false, cancellation: "unsupported", approvals: "unsupported", sandbox: "none", sessionLifecycle: [], artifactReporting: false, limitations: ["fixture"] };
  };
  registry.register({ executor: unavailable, conformanceScenarios: REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS });
  expect(await diagnoseExecutionReadiness(registry, "claude-code")).toMatchObject({ status: "unavailable", substrate: "claude-code" });
  expect(unavailable.calls).toEqual(["probe"]);
});
