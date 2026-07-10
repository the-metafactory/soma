import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAlgorithmRun, MockSubstrateExecutor, recordAlgorithmLoopIterationResult, SubstrateExecutionAlgorithmLoopExecutor } from "../src";

const timestamp = "2026-07-11T09:00:00.000Z";

function event(kind: "execution.completed" | "execution.failed" | "execution.cancelled") {
  return kind === "execution.completed"
    ? [{ kind: "execution.started" as const, executionId: "$executionId", timestamp }, { kind, executionId: "$executionId", timestamp, summary: "done" }]
    : [{ kind: "execution.started" as const, executionId: "$executionId", timestamp }, kind === "execution.failed" ? { kind, executionId: "$executionId", timestamp, code: "host-exit" as const, summary: "failed", retryable: false } : { kind, executionId: "$executionId", timestamp, summary: "cancelled" }];
}

test("validated executions write bounded lifecycle evidence without advancing criteria", async () => {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-execution-loop-"));
  try {
    const base = createAlgorithmRun({ id: "bridge", timestamp, prompt: "Run", intent: "Bridge", currentState: "ready", goal: "record", criteria: [{ id: "C1", text: "unchanged" }] });
    const mock = new MockSubstrateExecutor("codex", { complete: { events: event("execution.completed") }, failed: { events: event("execution.failed") }, cancelled: { events: event("execution.cancelled") } });
    const bridge = new SubstrateExecutionAlgorithmLoopExecutor({ executor: mock, somaHome, timestamp: () => timestamp, request: (context) => ({ taskId: context.iteration === 1 ? "complete" : context.iteration === 2 ? "failed" : "cancelled", substrate: "codex", prompt: "private", cwd: "/tmp", projectionFingerprint: "projection", requiredCapabilities: [], algorithmRunId: context.run.id }) });
    const completed = await bridge.executeIteration({ run: base, iteration: 1 });
    expect(completed.run.vsa).toEqual(base.vsa);
    expect(completed.run.changelog.at(-1)?.text).toBe("Validated completed execution; 0 artifact(s).");
    const recorded = recordAlgorithmLoopIterationResult(completed, timestamp);
    expect(recorded.loop).toMatchObject({ iterationCount: 1, plateauCounter: 1 });
    const failed = await bridge.executeIteration({ run: base, iteration: 2 });
    expect(failed.run.vsa).toEqual(base.vsa);
    const cancelled = await bridge.executeIteration({ run: base, iteration: 3 });
    expect(cancelled.run.vsa).toEqual(base.vsa);
    const events = (await readFile(join(somaHome, "memory/STATE/events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind: string; summary: string; metadata: Record<string, unknown> });
    expect(events.map((item) => item.kind)).toEqual(["execution.completed", "execution.failed", "execution.cancelled"]);
    expect(events.every((item) => !JSON.stringify(item).includes("private"))).toBe(true);
  } finally { await rm(somaHome, { recursive: true, force: true }); }
});

test("writeback happens only after the kernel returns a validated terminal result", async () => {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-execution-loop-"));
  try {
    const run = createAlgorithmRun({ id: "refused", timestamp, prompt: "Run", intent: "Bridge", currentState: "ready", goal: "record", criteria: [{ id: "C1", text: "unchanged" }] });
    const refusal = Object.assign(new Error("refused"), { code: "capability-unsupported", summary: "refused", retryable: false });
    const mock = new MockSubstrateExecutor("codex", { refused: { events: [], prepareFailure: refusal } });
    const bridge = new SubstrateExecutionAlgorithmLoopExecutor({ executor: mock, somaHome, timestamp: () => timestamp, request: () => ({ taskId: "refused", substrate: "codex", prompt: "private", cwd: "/tmp", projectionFingerprint: "projection", requiredCapabilities: [] }) });
    const result = await bridge.executeIteration({ run, iteration: 1 });
    expect(result.summary).toBe("Validated failed execution; 0 artifact(s).");
    const events = (await readFile(join(somaHome, "memory/STATE/events.jsonl"), "utf8")).trim().split("\n");
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("execution.failed");
  } finally { await rm(somaHome, { recursive: true, force: true }); }
});
