import { randomUUID } from "node:crypto";
import { boundedJsonlSummaries, collectProbeOutput, type CommandOutput } from "./command-output";
import { RequestScopedExecutionLifecycle } from "./request-lifecycle";
import { REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS } from "./conformance";
import type { RegisteredSubstrateExecutor } from "./registry";
import type { ExecuteOptions, ExecutionCapabilities, ExecutionProbeOptions, PreparedExecution, SomaExecutionEvent, SomaExecutionRequest, SubstrateExecutor } from "./types";

export interface CodexCommandResult { exitCode: number; stdout: CommandOutput; stderr: string }
export interface CodexCommandRunner { run(args: string[], options?: { cwd?: string; input?: string; signal?: AbortSignal }): Promise<CodexCommandResult> }
export interface CodexExecutorOptions {
  runner: CodexCommandRunner;
  /** Parent directory for request-scoped state; injectable only for deterministic tests. */
  temporaryRoot?: string;
}

const MAX_JSONL_RECORDS = 64;
const MAX_JSONL_RECORD_LENGTH = 16_384;

/** Codex-specific executor; only uses flags confirmed by `codex exec --help`. */
export class CodexExecutor implements SubstrateExecutor {
  readonly substrate = "codex" as const;
  private readonly lifecycle = new RequestScopedExecutionLifecycle();
  constructor(private readonly options: CodexExecutorOptions) {}
  async probe(options?: ExecutionProbeOptions): Promise<ExecutionCapabilities> {
    const runnerOptions = { cwd: options?.cwd, signal: options?.signal };
    const version = await this.options.runner.run(["codex", "--version"], runnerOptions);
    const help = await this.options.runner.run(["codex", "exec", "--help"], runnerOptions);
    const [versionOutput, helpOutput] = await Promise.all([collectProbeOutput(version.stdout), collectProbeOutput(help.stdout)]);
    const available = version.exitCode === 0
      && help.exitCode === 0
      && ["--ephemeral", "--json", "--sandbox", "--cd", "workspace-write"].every((term) => helpOutput.includes(term))
      && /(?:^|\s)-(?:\s|$)/m.test(helpOutput);
    return { substrate: "codex", available, substrateVersion: versionOutput.trim() || undefined, executorVersion: "soma-codex-e3", supportedCapabilities: [], streaming: true, cancellation: "best-effort", approvals: "native", sandbox: "native", sessionLifecycle: [], artifactReporting: false, limitations: available ? ["JSONL is reduced from a bounded chunked stream; artifact parsing is deferred."] : ["Codex exec noninteractive flags are unavailable."] };
  }
  async prepare(request: SomaExecutionRequest, options?: ExecuteOptions): Promise<PreparedExecution> {
    const capabilities = await this.probe({ cwd: request.cwd, signal: options?.signal });
    if (!capabilities.available) throw Object.assign(new Error("Codex is unavailable."), { code: "substrate-unavailable", summary: "Codex is unavailable.", retryable: true });
    const executionId = `codex-${request.taskId}-${randomUUID()}`;
    return this.lifecycle.prepare(executionId, request, capabilities, this.options.temporaryRoot, "soma-codex-execution-");
  }
  async *execute(prepared: PreparedExecution, options?: ExecuteOptions): AsyncIterable<SomaExecutionEvent> {
    const timestamp = new Date().toISOString();
    yield { kind: "execution.started", executionId: prepared.executionId, timestamp };
    const invocation = this.lifecycle.begin(prepared.executionId, options);
    let result: CodexCommandResult;
    try {
      if (invocation.cancelled()) {
        yield { kind: "execution.cancelled", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary: "Codex execution cancelled." };
        return;
      }
      result = await this.options.runner.run(["codex", "exec", "--ephemeral", "--json", "--sandbox", "workspace-write", "--cd", prepared.request.cwd, "-"], { cwd: prepared.request.cwd, input: prepared.request.prompt, signal: invocation.signal });
    } catch (error: unknown) {
      if (invocation.cancelled()) {
        yield { kind: "execution.cancelled", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary: "Codex execution cancelled." };
        return;
      }
      throw error;
    } finally {
      await invocation.finish();
    }
    if (invocation.cancelled()) {
      yield { kind: "execution.cancelled", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary: "Codex execution cancelled." };
      return;
    }
    for await (const summary of jsonlProgressSummaries(result.stdout)) {
      yield { kind: "execution.progress", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary };
    }
    if (result.exitCode !== 0) yield { kind: "execution.failed", executionId: prepared.executionId, timestamp: new Date().toISOString(), code: "substrate-exit", summary: "Codex exited unsuccessfully.", retryable: false };
    else yield { kind: "execution.completed", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary: "Codex execution completed." };
  }
  async cancel(executionId: string): Promise<void> {
    await this.lifecycle.cancel(executionId);
  }
}

/** Reduces only a fixed number of bounded JSONL records; raw output remains executor-local. */
function jsonlProgressSummaries(stdout: CommandOutput): AsyncIterable<string> {
  return boundedJsonlSummaries(stdout, {
    maxRecords: MAX_JSONL_RECORDS,
    maxRecordLength: MAX_JSONL_RECORD_LENGTH,
    eventPrefix: "Codex event",
    oversizedSummary: "Codex emitted an oversized JSONL record.",
    malformedSummary: "Codex emitted non-JSON output.",
    truncatedSummary: `Codex output was truncated after ${MAX_JSONL_RECORDS} JSONL records.`,
  });
}

/** The Codex vertical slice declares every shared scenario before registration. */
export function registerCodexExecutor(registry: { register(entry: RegisteredSubstrateExecutor): void }, executor: CodexExecutor): void {
  registry.register({ executor, conformanceScenarios: REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS });
}
