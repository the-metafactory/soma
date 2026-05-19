import { readFile } from "node:fs/promises";
import { createPaths } from "../../paths";
import type {
  AdvisorStateOptions,
  InferenceBackend,
  InferenceLevel,
  InferenceMode,
  InferenceOptions,
  InferenceRequest,
  InferenceResult,
} from "./types";

const DEFAULT_TIMEOUT_MS: Record<InferenceLevel | "advisor", number> = {
  fast: 15_000,
  standard: 30_000,
  smart: 90_000,
  advisor: 120_000,
};

export type {
  AdvisorStateOptions,
  InferenceBackend,
  InferenceBackendKind,
  InferenceLevel,
  InferenceMode,
  InferenceOptions,
  InferenceRequest,
  InferenceResult,
} from "./types";
function normalizeLevel(level: InferenceLevel | undefined, mode: InferenceMode): InferenceLevel {
  return level ?? (mode === "advisor" ? "smart" : "standard");
}

function normalizeRequest(options: InferenceOptions = {}): InferenceRequest {
  const mode = options.mode ?? "inference";
  const level = normalizeLevel(options.level, mode);
  return {
    level,
    mode,
    json: options.json === true,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS[mode === "advisor" ? "advisor" : level],
  };
}

export function parseInferenceJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("Inference response did not contain JSON.");
  }

  for (const candidate of balancedJsonCandidates(trimmed)) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  throw new Error("Inference response did not contain a JSON object or array.");
}

function* balancedJsonCandidates(text: string): Generator<string> {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let start: number | undefined;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start === undefined && char !== "{" && char !== "[") {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      if (start === undefined) {
        start = index;
      }
      stack.push(char === "{" ? "}" : "]");
      continue;
    }

    if (char === "}" || char === "]") {
      if (stack.pop() !== char) {
        stack.length = 0;
        start = undefined;
        inString = false;
        escaped = false;
        continue;
      }
      if (stack.length === 0 && start !== undefined) {
        yield text.slice(start, index + 1);
        start = undefined;
      }
    }
  }
}

export async function inference<T = unknown>(
  prompt: string,
  options: InferenceOptions = {},
): Promise<InferenceResult<T>> {
  const request = normalizeRequest(options);
  const backend = options.backend;
  if (!backend) {
    throw new Error("Inference backend is required. Use the CLI or inject an InferenceBackend.");
  }
  const text = await backend.invoke(prompt, request);
  return {
    text,
    json: request.json ? parseInferenceJson(text) as T : undefined,
    backend: backend.kind,
    level: request.level,
    mode: request.mode,
    model: backend.resolveModel(request.level, request.mode),
  };
}

export async function synthesizeAdvisorState(options: AdvisorStateOptions = {}): Promise<string> {
  const paths = createPaths(options.somaHome ? { somaHome: options.somaHome } : { homeDir: options.homeDir });
  const statePath = paths.resolve("memory", "STATE", "work.json");
  const state = await readFile(statePath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "{}";
    }
    throw error;
  });

  return [
    "Synthesize current working state from Soma memory.",
    "",
    "State file:",
    statePath,
    "",
    "State JSON:",
    state.trim() || "{}",
  ].join("\n");
}

export async function advisor<T = unknown>(
  prompt: string,
  options: InferenceOptions & { autoState?: boolean } = {},
): Promise<InferenceResult<T>> {
  const statePrompt = options.autoState
    ? `${await synthesizeAdvisorState(options)}\n\nAdvisor request:\n${prompt}`
    : prompt;
  return inference<T>(statePrompt, { ...options, mode: "advisor", level: options.level ?? "smart" });
}
