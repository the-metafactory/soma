import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  advisor,
  inference,
  parseInferenceJson,
  synthesizeAdvisorState,
  type InferenceBackend,
  type InferenceRequest,
} from "../src/index";
import { createClaudeCodeBackend } from "../src/tools/inference/backends/claude-code";
import { createAnthropicApiBackend } from "../src/tools/inference/backends/anthropic-api";
import { createAutoInferenceBackend } from "../src/tools/inference/factory";
import { parseInferenceCliArgs, runInferenceCli } from "../src/tools/inference/cli";

class MockBackend implements InferenceBackend {
  readonly kind = "claude-code" as const;
  requests: { prompt: string; request: InferenceRequest }[] = [];

  constructor(private readonly response: string) {}

  resolveModel(level: InferenceRequest["level"], mode: InferenceRequest["mode"]): string {
    if (mode === "advisor") return "opus";
    return level === "fast" ? "haiku" : level === "standard" ? "sonnet" : "opus";
  }

  async invoke(prompt: string, request: InferenceRequest): Promise<string> {
    this.requests.push({ prompt, request });
    return this.response;
  }
}

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-inference-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

test("parseInferenceJson greedily extracts object and array payloads", () => {
  expect(parseInferenceJson("prefix {\"a\":{\"b\":1}} suffix")).toEqual({ a: { b: 1 } });
  expect(parseInferenceJson("notes\n[{\"a\":1},{\"b\":[2,3]}]\ntrailer")).toEqual([{ a: 1 }, { b: [2, 3] }]);
  expect(parseInferenceJson("nested [{\"a\":[1,{\"b\":2}]}] done")).toEqual([{ a: [1, { b: 2 }] }]);
  expect(parseInferenceJson("prose [not json] then {\"usable\":true} trailing [noise]")).toEqual({ usable: true });
  expect(parseInferenceJson("prose {\"brace\":\"}\"} trailing")).toEqual({ brace: "}" });
  expect(() => parseInferenceJson("no structured payload")).toThrow("JSON object or array");
});

test("inference maps levels to backend model capabilities and parses JSON", async () => {
  const backend = new MockBackend("```json\n{\"label\":\"ok\"}\n```");
  const result = await inference<{ label: string }>("classify this", {
    level: "fast",
    json: true,
    backend,
  });

  expect(result.backend).toBe("claude-code");
  expect(result.model).toBe("haiku");
  expect(result.json?.label).toBe("ok");
  expect(backend.requests[0]?.request.timeoutMs).toBe(15_000);
});

test("advisor auto-state reads Soma state through createPaths", async () => {
  await withTempHome(async (homeDir) => {
    const stateDir = join(homeDir, ".soma/memory/STATE");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "work.json"), JSON.stringify({ active: "issue-129" }), "utf8");

    const statePrompt = await synthesizeAdvisorState({ homeDir });
    expect(statePrompt).toContain(join(homeDir, ".soma/memory/STATE/work.json"));
    expect(statePrompt).toContain("issue-129");

    const backend = new MockBackend("advisor response");
    await advisor("what next?", { homeDir, autoState: true, backend });
    expect(backend.requests[0]?.prompt).toContain("State JSON:");
    expect(backend.requests[0]?.prompt).toContain("Advisor request:");
    expect(backend.requests[0]?.request.timeoutMs).toBe(120_000);
  });
});

test("runInferenceCli supports prompt args, JSON output, and stdin", async () => {
  const jsonBackend = new MockBackend("{\"ok\":true}");
  const jsonOutput = await runInferenceCli(["--level", "smart", "--json", "analyze", "this"], {
    backend: jsonBackend,
  });

  expect(JSON.parse(jsonOutput)).toEqual({ ok: true });
  expect(jsonBackend.requests[0]?.prompt).toBe("analyze this");
  expect(jsonBackend.requests[0]?.request.level).toBe("smart");

  const stdinBackend = new MockBackend("standard response");
  const stdinOutput = await runInferenceCli(["--level", "standard"], {
    backend: stdinBackend,
    readStdin: () => "large prompt from stdin",
  });

  expect(stdinOutput).toBe("standard response\n");
  expect(stdinBackend.requests[0]?.prompt).toBe("large prompt from stdin");
});

test("runInferenceCli rejects partial timeout values", async () => {
  await expect(
    runInferenceCli(["--timeout", "1000abc", "classify"], { backend: new MockBackend("ok") }),
  ).rejects.toThrow("--timeout must be a positive integer");
});

test("runInferenceCli advisor auto-state does not require stdin", async () => {
  await withTempHome(async (homeDir) => {
    const backend = new MockBackend("advisor response");
    const output = await runInferenceCli(["--mode", "advisor", "--auto-state", "--home-dir", homeDir], {
      backend,
      readStdin: () => {
        throw new Error("stdin should not be read");
      },
    });

    expect(output).toBe("advisor response\n");
    expect(backend.requests[0]?.prompt).toContain("State JSON:");
  });
});

test("createAutoInferenceBackend prefers Claude Code when detected", async () => {
  const claude = await createAutoInferenceBackend({ commandExists: async (command) => command === "claude" });
  const fallback = await createAutoInferenceBackend({ commandExists: async () => false });

  expect(claude.kind).toBe("claude-code");
  expect(fallback.kind).toBe("anthropic-api");
});

test("auto backend blocks advisor state network fallback without opt-in", async () => {
  await expect(
    createAutoInferenceBackend({
      commandExists: async () => false,
      includesAutoState: true,
    }),
  ).rejects.toThrow("explicit network opt-in");

  const fallback = await createAutoInferenceBackend({
    commandExists: async () => false,
    includesAutoState: true,
    allowNetwork: true,
  });

  expect(fallback.kind).toBe("anthropic-api");
  expect(parseInferenceCliArgs(["--backend", "anthropic-api", "--allow-network", "prompt"])).toMatchObject({
    backendKind: "anthropic-api",
    allowNetwork: true,
  });

  await expect(
    runInferenceCli(["--mode", "advisor", "--auto-state", "--backend", "anthropic-api"]),
  ).rejects.toThrow("explicit network opt-in");
});

test("Anthropic API backend maps levels to valid Messages API model ids", () => {
  const backend = createAnthropicApiBackend({ apiKey: "test-key" });

  expect(backend.resolveModel("fast", "inference")).toBe("claude-3-5-haiku-20241022");
  expect(backend.resolveModel("standard", "inference")).toBe("claude-sonnet-4-20250514");
  expect(backend.resolveModel("smart", "inference")).toBe("claude-opus-4-1-20250805");
  expect(backend.resolveModel("fast", "advisor")).toBe("claude-opus-4-1-20250805");
});

test("Claude Code backend scrubs Anthropic env, writes prompt to stdin, and times out", async () => {
  const launches: {
    command: string[];
    env?: Record<string, string | undefined>;
    prompt: string;
    promptRead: Promise<void>;
    killed: boolean;
  }[] = [];
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const spawn = ((command: string[], options: { env?: Record<string, string | undefined>; stdin?: ReadableStream<Uint8Array> }) => {
    const launch = {
      command,
      env: options.env,
      prompt: "",
      promptRead: Promise.resolve(),
      killed: false,
    };
    if (options.stdin) {
      launch.promptRead = new Response(options.stdin).text().then((text) => {
        launch.prompt = text;
      });
    }
    launches.push(launch);
    return {
      stdout: textStream(""),
      stderr: textStream("timed out"),
      exited,
      kill: () => {
        launch.killed = true;
        resolveExit(1);
      },
    };
  }) as unknown as typeof Bun.spawn;

  const backend = createClaudeCodeBackend({
    spawn,
    env: {
      ANTHROPIC_API_KEY: "secret",
      ANTHROPIC_AUTH_TOKEN: "secret-token",
      KEEP_ME: "yes",
      PATH: "/usr/bin",
    },
  });

  await expect(
    backend.invoke("large prompt", {
      level: "standard",
      mode: "inference",
      json: false,
      timeoutMs: 1,
    }),
  ).rejects.toThrow("claude inference exited 1");

  await launches[0]?.promptRead;
  expect(launches[0]?.command).toEqual([
    "claude",
    "-p",
    "--model",
    "sonnet",
    "--allowedTools",
    "",
    "--hookTimeout",
    "1",
  ]);
  expect(launches[0]?.env?.ANTHROPIC_API_KEY).toBeUndefined();
  expect(launches[0]?.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(launches[0]?.env?.KEEP_ME).toBeUndefined();
  expect(launches[0]?.env?.PATH).toBe("/usr/bin");
  expect(launches[0]?.prompt).toBe("large prompt");
  expect(launches[0]?.killed).toBe(true);

  await expect(readFile(join(import.meta.dir, "..", "src/tools/inference/index.ts"), "utf8")).resolves.not.toContain(".claude");
});
