import { advisor, inference } from "./index";
import { createAutoInferenceBackend } from "./factory";
import { createAnthropicApiBackend } from "./backends/anthropic-api";
import { createClaudeCodeBackend } from "./backends/claude-code";
import type { InferenceBackend, InferenceLevel, InferenceMode, InferenceOptions } from "./types";

type InferenceCliBackendKind = "auto" | "claude-code" | "anthropic-api";

export interface InferenceCliOptions extends InferenceOptions {
  prompt?: string;
  autoState?: boolean;
  allowNetwork?: boolean;
  backendKind?: InferenceCliBackendKind;
}

export interface InferenceCliDeps {
  backend?: InferenceBackend;
  readStdin?: () => string | Promise<string>;
}

const LEVELS = new Set(["fast", "standard", "smart"]);

function parseLevel(value: string): InferenceLevel {
  if (LEVELS.has(value)) {
    return value as InferenceLevel;
  }
  throw new Error("--level must be one of fast, standard, or smart.");
}

function parseMode(value: string): InferenceMode {
  if (value === "advisor") {
    return "advisor";
  }
  if (value === "inference") {
    return "inference";
  }
  throw new Error("--mode must be one of inference or advisor.");
}

function parseBackend(value: string): InferenceCliBackendKind {
  if (value === "auto" || value === "claude-code" || value === "anthropic-api") {
    return value;
  }
  throw new Error("--backend must be one of auto, claude-code, or anthropic-api.");
}

function readOption(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function parseInferenceCliArgs(args: string[]): InferenceCliOptions {
  const options: InferenceCliOptions = {};
  const promptParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--level":
        options.level = parseLevel(readOption(args, index, arg));
        index += 1;
        break;
      case "--mode":
        options.mode = parseMode(readOption(args, index, arg));
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--timeout":
        options.timeoutMs = Number(readOption(args, index, arg));
        if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
          throw new Error("--timeout must be a positive integer number of milliseconds.");
        }
        index += 1;
        break;
      case "--home-dir":
        options.homeDir = readOption(args, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(args, index, arg);
        index += 1;
        break;
      case "--auto-state":
        options.autoState = true;
        break;
      case "--allow-network":
        options.allowNetwork = true;
        break;
      case "--backend":
        options.backendKind = parseBackend(readOption(args, index, arg));
        index += 1;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        promptParts.push(arg);
        break;
    }
  }

  options.prompt = promptParts.join(" ").trim();
  return options;
}

async function readNodeStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

async function resolveCliBackend(options: InferenceCliOptions, deps: InferenceCliDeps): Promise<InferenceBackend> {
  if (deps.backend) {
    return deps.backend;
  }
  if (options.backend) {
    return options.backend;
  }

  switch (options.backendKind ?? "auto") {
    case "claude-code":
      return createClaudeCodeBackend();
    case "anthropic-api":
      if (options.mode === "advisor" && options.autoState === true && options.allowNetwork !== true) {
        throw new Error("Advisor auto-state requires Claude Code or explicit network opt-in via --allow-network.");
      }
      return createAnthropicApiBackend();
    case "auto":
      return createAutoInferenceBackend({
        allowNetwork: options.allowNetwork === true,
        includesAutoState: options.mode === "advisor" && options.autoState === true,
      });
  }
}

export async function runInferenceCli(args: string[], deps: InferenceCliDeps = {}): Promise<string> {
  const options = parseInferenceCliArgs(args);
  const prompt = options.prompt && options.prompt.length > 0
    ? options.prompt
    : (options.mode === "advisor" && options.autoState ? "" : (await (deps.readStdin ?? readNodeStdin)()).trim());
  if (!prompt && !(options.mode === "advisor" && options.autoState)) {
    throw new Error("soma inference requires a prompt argument or stdin input.");
  }

  const common = {
    ...options,
    backend: await resolveCliBackend(options, deps),
  };
  const result = options.mode === "advisor"
    ? await advisor(prompt, common)
    : await inference(prompt, common);

  if (options.json) {
    return `${JSON.stringify(result.json, null, 2)}\n`;
  }

  return `${result.text}\n`;
}
