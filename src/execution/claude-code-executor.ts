import { randomUUID } from "node:crypto";
import { boundedJsonlSummaries, collectProbeOutput, type CommandOutput } from "./command-output";
import { RequestScopedExecutionLifecycle } from "./request-lifecycle";
import { REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS } from "./conformance";
import type { RegisteredSubstrateExecutor } from "./registry";
import type { ExecuteOptions, ExecutionCapabilities, ExecutionProbeOptions, PreparedExecution, SomaExecutionEvent, SomaExecutionRequest, SubstrateExecutor } from "./types";

export interface ClaudeCodeCommandResult { exitCode: number; stdout: CommandOutput; stderr: string }
export interface ClaudeCodeCommandRunner { run(args: string[], options?: { cwd?: string; input?: string; signal?: AbortSignal }): Promise<ClaudeCodeCommandResult> }
export interface ClaudeCodeExecutorOptions {
  runner: ClaudeCodeCommandRunner;
  /** Parent directory for request-scoped state; injectable only for deterministic tests. */
  temporaryRoot?: string;
}

const MAX_STREAM_RECORDS = 64;
const MAX_STREAM_RECORD_LENGTH = 16_384;

/** Claude Code-specific executor; only uses flags confirmed by `claude --help`. */
export class ClaudeCodeExecutor implements SubstrateExecutor {
  readonly substrate = "claude-code" as const;
  private readonly lifecycle = new RequestScopedExecutionLifecycle();

  constructor(private readonly options: ClaudeCodeExecutorOptions) {}

  async probe(options?: ExecutionProbeOptions): Promise<ExecutionCapabilities> {
    const runnerOptions = { cwd: options?.cwd, signal: options?.signal };
    const version = await this.options.runner.run(["claude", "--version"], runnerOptions);
    const help = await this.options.runner.run(["claude", "--help"], runnerOptions);
    const [versionOutput, helpOutput] = await Promise.all([collectProbeOutput(version.stdout), collectProbeOutput(help.stdout)]);
    const available = version.exitCode === 0 && help.exitCode === 0 && ["-p, --print", "--output-format", "stream-json"].every((term) => helpOutput.includes(term));
    return {
      substrate: "claude-code", available, substrateVersion: versionOutput.trim() || undefined, executorVersion: "soma-claude-code-e4", supportedCapabilities: [],
      streaming: true, cancellation: "best-effort", approvals: "native", sandbox: "native", sessionLifecycle: [], artifactReporting: false,
      limitations: available ? ["Stream JSON is reduced from a bounded chunked stream; artifact and policy parsing are deferred."] : ["Claude Code noninteractive stream-json flags are unavailable."],
    };
  }

  async prepare(request: SomaExecutionRequest, options?: ExecuteOptions): Promise<PreparedExecution> {
    const capabilities = await this.probe({ cwd: request.cwd, signal: options?.signal });
    if (!capabilities.available) throw Object.assign(new Error("Claude Code is unavailable."), { code: "substrate-unavailable", summary: "Claude Code is unavailable.", retryable: true });
    const executionId = `claude-code-${request.taskId}-${randomUUID()}`;
    return this.lifecycle.prepare(executionId, request, capabilities, this.options.temporaryRoot, "soma-claude-code-execution-");
  }

  async *execute(prepared: PreparedExecution, options?: ExecuteOptions): AsyncIterable<SomaExecutionEvent> {
    yield { kind: "execution.started", executionId: prepared.executionId, timestamp: new Date().toISOString() };
    const invocation = this.lifecycle.begin(prepared.executionId, options);
    let result: ClaudeCodeCommandResult;
    try {
      if (invocation.cancelled()) {
        yield cancelled(prepared.executionId);
        return;
      }
      result = await this.options.runner.run(["claude", "-p", "--output-format", "stream-json"], { cwd: prepared.request.cwd, input: prepared.request.prompt, signal: invocation.signal });
    } catch (error: unknown) {
      if (invocation.cancelled()) {
        yield cancelled(prepared.executionId);
        return;
      }
      throw error;
    } finally {
      await invocation.finish();
    }
    if (invocation.cancelled()) {
      yield cancelled(prepared.executionId);
      return;
    }
    for await (const summary of streamProgressSummaries(result.stdout)) yield { kind: "execution.progress", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary };
    if (result.exitCode !== 0) yield { kind: "execution.failed", executionId: prepared.executionId, timestamp: new Date().toISOString(), code: "substrate-exit", summary: "Claude Code exited unsuccessfully.", retryable: false };
    else yield { kind: "execution.completed", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary: "Claude Code execution completed." };
  }

  async cancel(executionId: string): Promise<void> {
    await this.lifecycle.cancel(executionId);
  }
}

function cancelled(executionId: string): SomaExecutionEvent {
  return { kind: "execution.cancelled", executionId, timestamp: new Date().toISOString(), summary: "Claude Code execution cancelled." };
}

function streamProgressSummaries(stdout: CommandOutput): AsyncIterable<string> {
  return boundedJsonlSummaries(stdout, {
    maxRecords: MAX_STREAM_RECORDS,
    maxRecordLength: MAX_STREAM_RECORD_LENGTH,
    eventPrefix: "Claude Code event",
    oversizedSummary: "Claude Code emitted an oversized stream record.",
    malformedSummary: "Claude Code emitted non-JSON output.",
    truncatedSummary: `Claude Code output was truncated after ${MAX_STREAM_RECORDS} stream records.`,
  });
}

export function registerClaudeCodeExecutor(registry: { register(entry: RegisteredSubstrateExecutor): void }, executor: ClaudeCodeExecutor): void {
  registry.register({ executor, conformanceScenarios: REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS });
}
