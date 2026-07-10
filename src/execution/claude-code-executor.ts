import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS } from "./conformance";
import type { RegisteredSubstrateExecutor } from "./registry";
import type { ExecuteOptions, ExecutionCapabilities, ExecutionProbeOptions, PreparedExecution, SomaExecutionEvent, SomaExecutionRequest, SubstrateExecutor } from "./types";

export interface ClaudeCodeCommandResult { exitCode: number; stdout: string; stderr: string }
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
  private readonly cancellations = new Set<string>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly temporaryRoots = new Map<string, string>();

  constructor(private readonly options: ClaudeCodeExecutorOptions) {}

  async probe(_options?: ExecutionProbeOptions): Promise<ExecutionCapabilities> {
    const version = await this.options.runner.run(["claude", "--version"]);
    const help = await this.options.runner.run(["claude", "--help"]);
    const available = version.exitCode === 0 && help.exitCode === 0 && ["-p, --print", "--output-format", "stream-json"].every((term) => help.stdout.includes(term));
    return {
      substrate: "claude-code", available, hostVersion: version.stdout.trim() || undefined, executorVersion: "soma-claude-code-e4",
      streaming: true, cancellation: "best-effort", approvals: "native", sandbox: "native", sessionLifecycle: [], artifactReporting: false,
      limitations: available ? ["Stream JSON is reduced to bounded progress events; artifact and policy parsing are deferred."] : ["Claude Code noninteractive stream-json flags are unavailable."],
    };
  }

  async prepare(request: SomaExecutionRequest): Promise<PreparedExecution> {
    const capabilities = await this.probe();
    if (!capabilities.available) throw Object.assign(new Error("Claude Code is unavailable."), { code: "host-unavailable", summary: "Claude Code is unavailable.", retryable: true });
    const executionId = `claude-code-${request.taskId}`;
    const temporaryRoot = await mkdtemp(join(this.options.temporaryRoot ?? tmpdir(), "soma-claude-code-execution-"));
    await writeFile(join(temporaryRoot, "SOMA_EXECUTION.md"), `# Soma Execution\n\nProjection: ${request.projectionFingerprint}\n`, "utf8");
    this.temporaryRoots.set(executionId, temporaryRoot);
    return { executionId, request, capabilitySnapshot: capabilities, redactedInvocation: "claude -p --output-format stream-json" };
  }

  async *execute(prepared: PreparedExecution, options?: ExecuteOptions): AsyncIterable<SomaExecutionEvent> {
    yield { kind: "execution.started", executionId: prepared.executionId, timestamp: new Date().toISOString() };
    const controller = new AbortController();
    const abort = () => { controller.abort(); };
    options?.signal?.addEventListener("abort", abort, { once: true });
    this.activeControllers.set(prepared.executionId, controller);
    let result: ClaudeCodeCommandResult;
    try {
      if (this.cancellations.has(prepared.executionId)) {
        await this.cleanupTemporaryState(prepared.executionId);
        yield cancelled(prepared.executionId);
        return;
      }
      result = await this.options.runner.run(["claude", "-p", "--output-format", "stream-json"], { cwd: prepared.request.cwd, input: prepared.request.prompt, signal: controller.signal });
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        await this.cleanupTemporaryState(prepared.executionId);
        yield cancelled(prepared.executionId);
        return;
      }
      throw error;
    } finally {
      options?.signal?.removeEventListener("abort", abort);
      this.activeControllers.delete(prepared.executionId);
      await this.cleanupTemporaryState(prepared.executionId);
      this.cancellations.delete(prepared.executionId);
    }
    if (controller.signal.aborted) {
      yield cancelled(prepared.executionId);
      return;
    }
    for (const summary of streamProgressSummaries(result.stdout)) yield { kind: "execution.progress", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary };
    if (result.exitCode !== 0) yield { kind: "execution.failed", executionId: prepared.executionId, timestamp: new Date().toISOString(), code: "host-exit", summary: "Claude Code exited unsuccessfully.", retryable: false };
    else yield { kind: "execution.completed", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary: "Claude Code execution completed." };
  }

  async cancel(executionId: string): Promise<void> {
    this.cancellations.add(executionId);
    this.activeControllers.get(executionId)?.abort();
    await this.cleanupTemporaryState(executionId);
  }

  private async cleanupTemporaryState(executionId: string): Promise<void> {
    const root = this.temporaryRoots.get(executionId);
    this.temporaryRoots.delete(executionId);
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
}

function cancelled(executionId: string): SomaExecutionEvent {
  return { kind: "execution.cancelled", executionId, timestamp: new Date().toISOString(), summary: "Claude Code execution cancelled." };
}

function* streamProgressSummaries(stdout: string): Iterable<string> {
  let offset = 0;
  let records = 0;
  while (offset < stdout.length && records < MAX_STREAM_RECORDS) {
    const newline = stdout.indexOf("\n", offset);
    const end = newline === -1 ? stdout.length : newline;
    let line = stdout.slice(offset, end);
    offset = newline === -1 ? stdout.length : newline + 1;
    records += 1;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) continue;
    if (line.length > MAX_STREAM_RECORD_LENGTH) { yield "Claude Code emitted an oversized stream record."; continue; }
    try { yield `Claude Code event: ${(JSON.parse(line) as { type?: string }).type ?? "json"}`; }
    catch { yield "Claude Code emitted non-JSON output."; }
  }
  if (offset < stdout.length) yield `Claude Code output was truncated after ${MAX_STREAM_RECORDS} stream records.`;
}

export function registerClaudeCodeExecutor(registry: { register(entry: RegisteredSubstrateExecutor): void }, executor: ClaudeCodeExecutor): void {
  registry.register({ executor, conformanceScenarios: REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS });
}
