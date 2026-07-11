import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexExecutor, ExecutorRegistry, outputFromText, registerCodexExecutor, runExecutionConformance, REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS, type ExecutionConformanceScenario } from "../src/index";
import { runSubstrateExecution } from "../src/index";

function result(exitCode: number, stdout: string, stderr = "") {
  return { exitCode, stdout: outputFromText(stdout), stderr };
}

test("Codex executor uses only the probed ephemeral JSONL invocation", async () => {
  const calls: string[][] = [];
  const executor = new CodexExecutor({ runner: {
    run: async (args) => {
      calls.push(args);
      return result(0, args.includes("--help") ? "--ephemeral --json --sandbox --cd workspace-write\n -" : "codex-cli test");
    },
  } });
  const capabilities = await executor.probe();
  expect(capabilities).toMatchObject({ substrate: "codex", available: true, streaming: true, cancellation: "best-effort" });
  expect(calls[0]).toEqual(["codex", "--version"]);
  expect(calls[1]).toEqual(["codex", "exec", "--help"]);
});

test("Codex executor passes prompt by stdin and reduces JSONL plus non-zero exits", async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const executor = new CodexExecutor({ runner: { run: async (args, options) => {
    calls.push({ args, input: options?.input });
    if (args.includes("--version")) return result(0, "codex-cli test");
    if (args.includes("--help")) return result(0, "--ephemeral --json --sandbox --cd workspace-write\n -");
    return result(7, '{"type":"item.completed"}\n', "private stderr");
  } } });
  const request = { taskId: "t", substrate: "codex" as const, prompt: "private prompt", cwd: "/tmp", projectionFingerprint: "p", requiredCapabilities: [] };
  const prepared = await executor.prepare(request);
  const events = [];
  for await (const event of executor.execute(prepared)) events.push(event);
  expect(calls.at(-1)).toMatchObject({ args: ["codex", "exec", "--ephemeral", "--json", "--sandbox", "workspace-write", "--cd", "/tmp", "-"], input: "private prompt" });
  expect(events.map((event) => event.kind)).toEqual(["execution.started", "execution.progress", "execution.failed"]);
  expect(events.at(-1)).toMatchObject({ code: "substrate-exit" });
});

test("Codex executor reports a missing binary and emits cancellation", async () => {
  const unavailable = new CodexExecutor({ runner: { run: async () => result(127, "", "not found") } });
  await expect(unavailable.probe()).resolves.toMatchObject({ available: false, limitations: ["Codex exec noninteractive flags are unavailable."] });
  const executor = new CodexExecutor({ runner: { run: async (args) => args.includes("--help") ? result(0, "--ephemeral --json --sandbox --cd workspace-write\n -") : args.includes("--version") ? result(0, "codex-cli test") : result(0, "") } });
  const request = { taskId: "cancel", substrate: "codex" as const, prompt: "x", cwd: "/tmp", projectionFingerprint: "p", requiredCapabilities: [] };
  const prepared = await executor.prepare(request);
  await executor.cancel(prepared.executionId);
  const events = [];
  for await (const event of executor.execute(prepared)) events.push(event);
  expect(events.at(-1)).toMatchObject({ kind: "execution.cancelled" });
});

test("Codex executor cancellation aborts the active injected runner", async () => {
  let runnerStarted!: () => void;
  const started = new Promise<void>((resolve) => { runnerStarted = resolve; });
  let runnerAborted = false;
  const executor = new CodexExecutor({ runner: { run: async (args, options) => {
    if (args.includes("--version")) return result(0, "codex-cli test");
    if (args.includes("--help")) return result(0, "--ephemeral --json --sandbox --cd workspace-write\n -");
    runnerStarted();
    return await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => {
      runnerAborted = true;
      reject(new Error("runner aborted"));
    }, { once: true }));
  } } });
  const prepared = await executor.prepare({ taskId: "cancel-active", substrate: "codex", prompt: "x", cwd: "/tmp", projectionFingerprint: "p", requiredCapabilities: [] });
  const iterator = executor.execute(prepared)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ kind: "execution.started" });
  const terminal = iterator.next();
  await started;
  await executor.cancel(prepared.executionId);
  expect((await terminal).value).toMatchObject({ kind: "execution.cancelled" });
  expect(runnerAborted).toBe(true);
});

test("Codex executor cleans request-scoped temporary state after success", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "soma-codex-executor-test-"));
  try {
    const executor = new CodexExecutor({ temporaryRoot, runner: { run: async (args) => args.includes("--help") ? result(0, "--ephemeral --json --sandbox --cd workspace-write\n -") : args.includes("--version") ? result(0, "codex-cli test") : result(0, "") } });
    const prepared = await executor.prepare({ taskId: "cleanup", substrate: "codex", prompt: "x", cwd: "/tmp", projectionFingerprint: "p", requiredCapabilities: [] });
    expect((await readdir(temporaryRoot)).length).toBe(1);
    for await (const _event of executor.execute(prepared)) { /* consume */ }
    expect(await readdir(temporaryRoot)).toEqual([]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Codex executor forwards kernel timeout through the injected runner and cleans temporary state", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "soma-codex-executor-test-"));
  let runnerAborted = false;
  try {
    const executor = new CodexExecutor({ temporaryRoot, runner: { run: async (args, options) => {
      if (args.includes("--version")) return result(0, "codex-cli test");
      if (args.includes("--help")) return result(0, "--ephemeral --json --sandbox --cd workspace-write\n -");
      return await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => {
        runnerAborted = true;
        reject(new Error("runner timed out"));
      }, { once: true }));
    } } });
    const run = await runSubstrateExecution(executor, { taskId: "timeout", substrate: "codex", prompt: "x", cwd: "/tmp", projectionFingerprint: "p", requiredCapabilities: [], timeoutMs: 20 }, { authorizedWorkspaceRoot: "/tmp" });
    await Bun.sleep(0);
    expect(run.result).toMatchObject({ status: "failed", summary: "Execution timed out." });
    expect(run.events.at(-1)).toMatchObject({ kind: "execution.failed", code: "timeout" });
    expect(runnerAborted).toBe(true);
    expect(await readdir(temporaryRoot)).toEqual([]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Codex executor bounds JSONL reduction", async () => {
  const stdout = Array.from({ length: 80 }, (_, index) => JSON.stringify({ type: `event-${index}` })).join("\n");
  const executor = new CodexExecutor({ runner: { run: async (args) => args.includes("--help") ? result(0, "--ephemeral --json --sandbox --cd workspace-write\n -") : args.includes("--version") ? result(0, "codex-cli test") : result(0, stdout) } });
  const prepared = await executor.prepare({ taskId: "bounded", substrate: "codex", prompt: "x", cwd: "/tmp", projectionFingerprint: "p", requiredCapabilities: [] });
  const events = [];
  for await (const event of executor.execute(prepared)) events.push(event);
  expect(events).toHaveLength(67);
  expect(events.at(-2)).toMatchObject({ kind: "execution.progress", summary: "Codex output was truncated after 64 JSONL records." });
});

test("Codex executor registers with the complete shared conformance declaration", () => {
  const executor = new CodexExecutor({ runner: { run: async () => result(0, "--ephemeral --json --sandbox --cd workspace-write\n -") } });
  const registry = new ExecutorRegistry();
  registerCodexExecutor(registry, executor);
  expect(registry.resolve("codex")).toMatchObject({ status: "ready", executor });
});

test("Codex executor runs the shared scenario IDs through the injected runner", async () => {
  const executor = new CodexExecutor({ runner: { run: async (args, options) => {
    if (args.includes("--version")) return result(0, "codex-cli test");
    if (args.includes("--help")) return result(0, "--ephemeral --json --sandbox --cd workspace-write\n -");
    if (options?.input === "cancellation") {
      return await new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(new Error("cancelled by fixture")), { once: true }));
    }
    return options?.input?.includes("deny") ? result(7, '{"type":"policy.denied"}\n') : result(0, '{"type":"turn.completed"}\n');
  } } });
  const scenarios = REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS.map((id): ExecutionConformanceScenario => ({
    id,
    request: { taskId: id, substrate: "codex", prompt: id === "policy-denial" ? "deny" : id === "cancellation" ? "cancellation" : id, cwd: "/tmp", projectionFingerprint: "p", requiredCapabilities: [] },
    expectedStatus: id === "policy-denial" ? "failed" : id === "cancellation" ? "cancelled" : "completed",
    expectedPromptTerms: [id === "policy-denial" ? "deny" : id],
    expectedEventKinds: id === "policy-denial" ? ["execution.started", "execution.progress", "execution.failed"] : id === "cancellation" ? ["execution.started", "execution.cancelled"] : ["execution.started", "execution.progress", "execution.completed"],
    abortAfterMs: id === "cancellation" ? 20 : undefined,
  }));
  const report = await runExecutionConformance(executor, scenarios);
  expect(report.passed).toBe(true);
  expect((await executor.probe()).artifactReporting).toBe(false);
});
