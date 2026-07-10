import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  SOMA_VERSION,
  type ExecutionCapabilities,
  type PreparedExecution,
  type SomaAdapter,
  type SomaExecutionEvent,
  type SomaExecutionRequest,
  type SubstrateExecutor,
} from "../src/index";

test("exports version (source of truth: package.json)", () => {
  // SOMA_VERSION is derived from package.json — bumping the version
  // requires touching one file only, not this test.
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
  expect(SOMA_VERSION).toBe(pkg.version);
  expect(/^\d+\.\d+\.\d+/.test(SOMA_VERSION)).toBe(true);
});

test("arc manifest version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
  const manifest = readFileSync(join(import.meta.dirname, "..", "arc-manifest.yaml"), "utf8");
  const version = (/^version:\s*(\S+)\s*$/m.exec(manifest))?.[1];
  expect(version).toBe(pkg.version);
});

test("arc manifest exposes the soma CLI shim", () => {
  const manifest = readFileSync(join(import.meta.dirname, "..", "arc-manifest.yaml"), "utf8");
  expect(manifest).toContain("  cli:\n    - name: soma\n      command: bun src/cli.ts");
});

test("arc bundle excludes local runtime directories", () => {
  const manifest = readFileSync(join(import.meta.dirname, "..", "arc-manifest.yaml"), "utf8");
  expect(manifest).toContain("    - .tmp-tests");
  expect(manifest).toContain("    - .specflow");
});

test("adapter contract is structurally usable", async () => {
  const adapter: SomaAdapter = {
    name: "custom",
    async detect() {
      return true;
    },
    async project() {
      return { substrate: "custom", instructions: "", files: [] };
    },
  };

  await expect(adapter.detect()).resolves.toBe(true);
  expect("run" in adapter).toBe(false);
});

test("execution has a separate public contract", () => {
  const request: SomaExecutionRequest = {
    taskId: "task-1",
    substrate: "custom",
    prompt: "Do bounded work",
    cwd: "/tmp/soma-work",
    projectionFingerprint: "projection-1",
    requiredCapabilities: ["memory-recall"],
  };
  const capabilities: ExecutionCapabilities = {
    substrate: "custom",
    available: true,
    executorVersion: "test",
    streaming: true,
    cancellation: "hard",
    approvals: "native",
    sandbox: "none",
    sessionLifecycle: [],
    artifactReporting: true,
    limitations: [],
  };
  const prepared: PreparedExecution = {
    executionId: "execution-1",
    request,
    capabilitySnapshot: capabilities,
    redactedInvocation: "custom executor",
  };
  const event: SomaExecutionEvent = {
    kind: "execution.completed",
    executionId: prepared.executionId,
    timestamp: "2026-07-10T00:00:00.000Z",
    summary: "completed",
  };
  const executor: SubstrateExecutor = {
    substrate: "custom",
    async probe() {
      return capabilities;
    },
    async prepare() {
      return prepared;
    },
    async *execute() {
      yield event;
    },
    async cancel() {},
  };

  expect(executor.substrate).toBe(request.substrate);
  expect(event.kind).toBe("execution.completed");
});
