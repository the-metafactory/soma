import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeExecutor, ExecutorRegistry, outputFromText, registerClaudeCodeExecutor, REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS, runExecutionConformance, runSubstrateExecution, type ExecutionConformanceScenario } from "../src/index";

function result(exitCode: number, stdout: string, stderr = "") {
  return { exitCode, stdout: outputFromText(stdout), stderr };
}

function runner(run: (options?: { input?: string; signal?: AbortSignal }) => Promise<ReturnType<typeof result>>) {
  return { run: async (args: string[], options?: { input?: string; signal?: AbortSignal }) => {
    if (args.includes("--version")) return result(0, "2.1.206 (Claude Code)");
    if (args.includes("--help")) return result(0, "-p, --print --output-format stream-json");
    return run(options);
  } };
}

test("Claude Code executor uses probed print stream-json flags and bounds output", async () => {
  let invocation: { input?: string } | undefined;
  const executor = new ClaudeCodeExecutor({ runner: runner(async (options) => {
    invocation = { input: options?.input };
    return result(0, Array.from({ length: 80 }, (_, i) => JSON.stringify({ type: i })).join("\n"));
  }) });
  expect(await executor.probe()).toMatchObject({ substrate: "claude-code", available: true, approvals: "native", artifactReporting: false });
  const prepared = await executor.prepare({ taskId: "bounded", substrate: "claude-code", prompt: "private", cwd: "/tmp", projectionFingerprint: "p", requiredCapabilities: [] });
  const events = [];
  for await (const event of executor.execute(prepared)) events.push(event);
  expect(invocation).toEqual({ input: "private" });
  expect(events.at(-2)).toMatchObject({ summary: "Claude Code output was truncated after 64 stream records." });
  const unavailable = new ClaudeCodeExecutor({ runner: { run: async () => result(127, "") } });
  expect(await unavailable.probe()).toMatchObject({ available: false });
});

test("Claude Code cancellation and timeout abort injected runners and clean temporary state", async () => {
  let start!: () => void;
  const active = new Promise<void>((resolve) => { start = resolve; });
  let aborted = false;
  const executor = new ClaudeCodeExecutor({ runner: runner(async (options) => {
    start();
    return await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }));
  }) });
  const prepared = await executor.prepare({ taskId: "cancel", substrate: "claude-code", prompt: "x", cwd: "/tmp", projectionFingerprint: "p", requiredCapabilities: [] });
  const iterator = executor.execute(prepared)[Symbol.asyncIterator]();
  await iterator.next();
  const terminal = iterator.next();
  await active;
  await executor.cancel(prepared.executionId);
  expect((await terminal).value).toMatchObject({ kind: "execution.cancelled" });
  expect(aborted).toBe(true);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "soma-claude-code-executor-test-"));
  try {
    const timed = new ClaudeCodeExecutor({ temporaryRoot, runner: runner(async (options) => await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }))) });
    const run = await runSubstrateExecution(timed, { taskId: "timeout", substrate: "claude-code", prompt: "x", cwd: "/tmp", projectionFingerprint: "p", requiredCapabilities: [], timeoutMs: 20 }, { authorizedWorkspaceRoot: "/tmp" });
    await Bun.sleep(0);
    expect(run.result).toMatchObject({ status: "failed", summary: "Execution timed out." });
    expect(await readdir(temporaryRoot)).toEqual([]);
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});

test("Claude Code registers and passes shared runner-backed conformance fixtures", async () => {
  const executor = new ClaudeCodeExecutor({ runner: runner(async (options) => {
    if (options?.input === "cancel") return await new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(new Error("cancel")), { once: true }));
    return options?.input === "deny" ? result(7, '{"type":"policy_denied"}\n') : result(0, '{"type":"result"}\n');
  }) });
  const registry = new ExecutorRegistry();
  registerClaudeCodeExecutor(registry, executor);
  expect(registry.resolve("claude-code")).toMatchObject({ status: "ready", executor });
  const scenarios = REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS.map((id): ExecutionConformanceScenario => ({
    id, request: { taskId: id, substrate: "claude-code", prompt: id === "policy-denial" ? "deny" : id === "cancellation" ? "cancel" : id, cwd: "/tmp", projectionFingerprint: "p", requiredCapabilities: [] }, expectedStatus: id === "policy-denial" ? "failed" : id === "cancellation" ? "cancelled" : "completed", expectedPromptTerms: [id === "policy-denial" ? "deny" : id === "cancellation" ? "cancel" : id], abortAfterMs: id === "cancellation" ? 20 : undefined,
  }));
  expect((await runExecutionConformance(executor, scenarios)).passed).toBe(true);
});
