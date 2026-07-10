import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS } from "./conformance";
import type { RegisteredSubstrateExecutor } from "./registry";
import type { ExecuteOptions, ExecutionCapabilities, ExecutionProbeOptions, PreparedExecution, SomaExecutionEvent, SomaExecutionRequest, SubstrateExecutor } from "./types";

export interface CodexCommandResult { exitCode: number; stdout: string; stderr: string }
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
  private readonly cancellations = new Set<string>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly temporaryRoots = new Map<string, string>();
  constructor(private readonly options: CodexExecutorOptions) {}
  async probe(_options?: ExecutionProbeOptions): Promise<ExecutionCapabilities> {
    const version = await this.options.runner.run(["codex", "--version"]);
    const help = await this.options.runner.run(["codex", "exec", "--help"]);
    const available = version.exitCode === 0 && help.exitCode === 0 && ["--ephemeral", "--json", "--sandbox", "--cd"].every((flag) => help.stdout.includes(flag));
    return { substrate: "codex", available, hostVersion: version.stdout.trim() || undefined, executorVersion: "soma-codex-e3", streaming: true, cancellation: "best-effort", approvals: "native", sandbox: "native", sessionLifecycle: [], artifactReporting: false, limitations: available ? ["JSONL is reduced to bounded progress events; artifact parsing is deferred."] : ["Codex exec noninteractive flags are unavailable."] };
  }
  async prepare(request: SomaExecutionRequest): Promise<PreparedExecution> {
    const capabilities = await this.probe();
    if (!capabilities.available) throw Object.assign(new Error("Codex is unavailable."), { code: "host-unavailable", summary: "Codex is unavailable.", retryable: true });
    const executionId = `codex-${request.taskId}`;
    const temporaryRoot = await mkdtemp(join(this.options.temporaryRoot ?? tmpdir(), "soma-codex-execution-"));
    await writeFile(join(temporaryRoot, "SOMA_EXECUTION.md"), `# Soma Execution\n\nProjection: ${request.projectionFingerprint}\n`, "utf8");
    this.temporaryRoots.set(executionId, temporaryRoot);
    return { executionId, request, capabilitySnapshot: capabilities, redactedInvocation: "codex exec --ephemeral --json --sandbox workspace-write --cd <cwd> -" };
  }
  async *execute(prepared: PreparedExecution, options?: ExecuteOptions): AsyncIterable<SomaExecutionEvent> {
    const timestamp = new Date().toISOString();
    yield { kind: "execution.started", executionId: prepared.executionId, timestamp };
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    options?.signal?.addEventListener("abort", abort, { once: true });
    this.activeControllers.set(prepared.executionId, controller);
    let result: CodexCommandResult;
    try {
      if (this.cancellations.has(prepared.executionId)) {
        await this.cleanupTemporaryState(prepared.executionId);
        yield { kind: "execution.cancelled", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary: "Codex execution cancelled." };
        return;
      }
      result = await this.options.runner.run(["codex", "exec", "--ephemeral", "--json", "--sandbox", "workspace-write", "--cd", prepared.request.cwd, "-"], { cwd: prepared.request.cwd, input: prepared.request.prompt, signal: controller.signal });
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        await this.cleanupTemporaryState(prepared.executionId);
        yield { kind: "execution.cancelled", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary: "Codex execution cancelled." };
        return;
      }
      throw error;
    } finally {
      options?.signal?.removeEventListener("abort", abort);
      this.activeControllers.delete(prepared.executionId);
      await this.cleanupTemporaryState(prepared.executionId);
      this.cancellations.delete(prepared.executionId);
    }
    if (controller.signal.aborted || this.cancellations.has(prepared.executionId)) {
      yield { kind: "execution.cancelled", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary: "Codex execution cancelled." };
      return;
    }
    for (const summary of jsonlProgressSummaries(result.stdout)) {
      yield { kind: "execution.progress", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary };
    }
    if (result.exitCode !== 0) yield { kind: "execution.failed", executionId: prepared.executionId, timestamp: new Date().toISOString(), code: "host-exit", summary: "Codex exited unsuccessfully.", retryable: false };
    else yield { kind: "execution.completed", executionId: prepared.executionId, timestamp: new Date().toISOString(), summary: "Codex execution completed." };
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

/** Reduces only a fixed number of bounded JSONL records; raw output remains executor-local. */
function* jsonlProgressSummaries(stdout: string): Iterable<string> {
  let offset = 0;
  let records = 0;
  while (offset < stdout.length && records < MAX_JSONL_RECORDS) {
    const newline = stdout.indexOf("\n", offset);
    const end = newline === -1 ? stdout.length : newline;
    let line = stdout.slice(offset, end);
    offset = newline === -1 ? stdout.length : newline + 1;
    records += 1;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) continue;
    if (line.length > MAX_JSONL_RECORD_LENGTH) {
      yield "Codex emitted an oversized JSONL record.";
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { type?: string };
      yield `Codex event: ${parsed.type ?? "json"}`;
    } catch {
      yield "Codex emitted non-JSON output.";
    }
  }
  if (offset < stdout.length) yield `Codex output was truncated after ${MAX_JSONL_RECORDS} JSONL records.`;
}

/** The Codex vertical slice declares every shared scenario before registration. */
export function registerCodexExecutor(registry: { register(entry: RegisteredSubstrateExecutor): void }, executor: CodexExecutor): void {
  registry.register({ executor, conformanceScenarios: REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS });
}
