import type { ExecuteOptions, ExecutionCapabilities, ExecutionProbeOptions, PreparedExecution, SomaExecutionEvent, SomaExecutionRequest, SubstrateExecutor } from "./types";

export interface MockExecutionScript {
  events: SomaExecutionEvent[];
  delayMs?: number;
  prepareFailure?: Error;
  capabilities?: Partial<ExecutionCapabilities>;
}

export class MockSubstrateExecutor implements SubstrateExecutor {
  readonly calls: string[] = [];

  constructor(
    readonly substrate: SubstrateExecutor["substrate"],
    private readonly scripts: Record<string, MockExecutionScript>,
  ) {}

  probe(_options?: ExecutionProbeOptions): Promise<ExecutionCapabilities> {
    this.calls.push("probe");
    return Promise.resolve({
      substrate: this.substrate,
      available: true,
      executorVersion: "mock",
      streaming: true,
      cancellation: "hard",
      approvals: "native",
      sandbox: "none",
      sessionLifecycle: [],
      artifactReporting: true,
      limitations: ["deterministic test executor"],
    });
  }

  async prepare(request: SomaExecutionRequest): Promise<PreparedExecution> {
    this.calls.push("prepare");
    const script = this.scripts[request.taskId];
    if (script.prepareFailure !== undefined) throw script.prepareFailure;
    return {
      executionId: `${request.taskId}-execution`,
      request,
      capabilitySnapshot: { ...(await this.probe()), ...script.capabilities },
      redactedInvocation: "mock executor",
    };
  }

  async *execute(prepared: PreparedExecution, _options?: ExecuteOptions): AsyncIterable<SomaExecutionEvent> {
    this.calls.push("execute");
    const script = this.scripts[prepared.request.taskId];
    for (const event of script.events) {
      if (script.delayMs !== undefined) await Bun.sleep(script.delayMs);
      yield { ...event, executionId: event.executionId === "$executionId" ? prepared.executionId : event.executionId };
    }
  }

  cancel(_executionId: string): Promise<void> {
    this.calls.push("cancel");
    return Promise.resolve();
  }
}
