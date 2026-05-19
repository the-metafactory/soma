import type { InferenceBackend, InferenceLevel, InferenceMode, InferenceRequest } from "../types";

const CLAUDE_MODEL_BY_LEVEL: Record<InferenceLevel, string> = {
  fast: "haiku",
  standard: "sonnet",
  smart: "opus",
};

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;

const ALLOWED_ENV = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "CLAUDE_CONFIG_DIR",
]);

export interface ClaudeCodeBackendOptions {
  binary?: string;
  spawn?: typeof Bun.spawn;
  env?: NodeJS.ProcessEnv;
}

function allowedSubprocessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => ALLOWED_ENV.has(key)),
  ) as NodeJS.ProcessEnv;
}

function promptStream(prompt: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prompt));
      controller.close();
    },
  });
}

async function readStreamWithLimit(stream: ReadableStream<Uint8Array>, limit: number, label: string): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        throw new Error(`claude inference ${label} exceeded ${limit} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString("utf8");
}

export class ClaudeCodeBackend implements InferenceBackend {
  readonly kind = "claude-code" as const;
  private readonly binary: string;
  private readonly spawn: typeof Bun.spawn;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ClaudeCodeBackendOptions = {}) {
    this.binary = options.binary ?? "claude";
    this.spawn = options.spawn ?? Bun.spawn;
    this.env = allowedSubprocessEnv(options.env);
  }

  resolveModel(level: InferenceLevel, mode: InferenceMode): string {
    return mode === "advisor" ? CLAUDE_MODEL_BY_LEVEL.smart : CLAUDE_MODEL_BY_LEVEL[level];
  }

  async invoke(prompt: string, request: InferenceRequest): Promise<string> {
    const model = this.resolveModel(request.level, request.mode);
    const proc = this.spawn([
      this.binary,
      "-p",
      "--model",
      model,
      "--allowedTools",
      "",
      "--hookTimeout",
      "1",
    ], {
      stdin: promptStream(prompt),
      stdout: "pipe",
      stderr: "pipe",
      env: this.env,
    });

    const killTimer = setTimeout(() => {
      proc.kill();
    }, request.timeoutMs);

    try {
      const stdoutText = readStreamWithLimit(proc.stdout, MAX_STDOUT_BYTES, "stdout").catch((error: unknown) => {
        proc.kill();
        throw error;
      });
      const stderrText = readStreamWithLimit(proc.stderr, MAX_STDERR_BYTES, "stderr").catch((error: unknown) => {
        proc.kill();
        throw error;
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        stdoutText,
        stderrText,
        proc.exited,
      ]);

      if (exitCode !== 0) {
        throw new Error(`claude inference exited ${exitCode}: ${stderr.slice(-512).trim()}`);
      }

      return stdout.trim();
    } finally {
      clearTimeout(killTimer);
    }
  }
}

export function createClaudeCodeBackend(options: ClaudeCodeBackendOptions = {}): ClaudeCodeBackend {
  return new ClaudeCodeBackend(options);
}
