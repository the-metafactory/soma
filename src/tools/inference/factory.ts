import { createAnthropicApiBackend } from "./backends/anthropic-api";
import { createClaudeCodeBackend } from "./backends/claude-code";
import type { InferenceBackend } from "./types";

export interface BackendDetectionOptions {
  commandExists?: (command: string) => Promise<boolean>;
  allowNetwork?: boolean;
  includesAutoState?: boolean;
}

async function defaultCommandExists(command: string): Promise<boolean> {
  const proc = Bun.spawn(["which", command], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return await proc.exited === 0;
}

export async function createAutoInferenceBackend(options: BackendDetectionOptions = {}): Promise<InferenceBackend> {
  const commandExists = options.commandExists ?? defaultCommandExists;
  if (await commandExists("claude")) {
    return createClaudeCodeBackend();
  }
  if (options.includesAutoState && !options.allowNetwork) {
    throw new Error("Advisor auto-state requires Claude Code or explicit network opt-in via --allow-network.");
  }
  return createAnthropicApiBackend();
}
