import { runSubstrateExecution, type SubstrateExecutionRun } from "./kernel";
import type { SomaExecutionEvent, SomaExecutionRequest, SubstrateExecutor } from "./types";

export const REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS = [
  "identity-context",
  "memory-recall",
  "skill-selection",
  "policy-denial",
  "artifact-declaration",
  "cancellation",
  "continuation-token",
] as const;

export type ExecutionConformanceScenarioId = (typeof REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS)[number];

export interface ExecutionConformanceScenario {
  id: ExecutionConformanceScenarioId;
  request: SomaExecutionRequest;
  expectedStatus: SubstrateExecutionRun["result"]["status"];
  expectedPromptTerms: string[];
  expectedCapabilities?: string[];
  expectedEventKinds?: SomaExecutionEvent["kind"][];
  expectedArtifact?: string;
  expectedAlgorithmRunId?: string;
  expectedSessionId?: string;
  abortAfterMs?: number;
}

export interface ExecutionConformanceResult {
  id: ExecutionConformanceScenarioId;
  passed: boolean;
  failures: string[];
}

export interface ExecutionConformanceReport {
  passed: boolean;
  results: ExecutionConformanceResult[];
}

export async function runExecutionConformance(
  executor: SubstrateExecutor,
  scenarios: readonly ExecutionConformanceScenario[],
): Promise<ExecutionConformanceReport> {
  const results: ExecutionConformanceResult[] = [];
  for (const scenario of scenarios) {
    const failures: string[] = [];
    for (const term of scenario.expectedPromptTerms) {
      if (!scenario.request.prompt.includes(term)) failures.push(`prompt missing ${term}`);
    }
    if (scenario.expectedCapabilities?.some((capability) => !scenario.request.requiredCapabilities.includes(capability)) === true) {
      failures.push("required capabilities differ");
    }
    if (scenario.expectedAlgorithmRunId !== undefined && scenario.request.algorithmRunId !== scenario.expectedAlgorithmRunId) failures.push("algorithm run id differs");
    if (scenario.expectedSessionId !== undefined && scenario.request.sessionId !== scenario.expectedSessionId) failures.push("session id differs");
    const controller = new AbortController();
    const timer = scenario.abortAfterMs === undefined ? undefined : setTimeout(() => {
      controller.abort();
    }, scenario.abortAfterMs);
    const run = await runSubstrateExecution(executor, scenario.request, { signal: controller.signal });
    if (timer !== undefined) clearTimeout(timer);
    if (run.result.status !== scenario.expectedStatus) failures.push(`status ${run.result.status}`);
    if (scenario.expectedEventKinds !== undefined && JSON.stringify(run.events.map((event) => event.kind)) !== JSON.stringify(scenario.expectedEventKinds)) {
      failures.push("event kinds differ");
    }
    if (scenario.expectedArtifact !== undefined && !run.result.artifacts.includes(scenario.expectedArtifact)) failures.push("artifact missing");
    results.push({ id: scenario.id, passed: failures.length === 0, failures });
  }
  return { passed: results.every((result) => result.passed), results };
}
