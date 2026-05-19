export type InferenceLevel = "fast" | "standard" | "smart";
export type InferenceMode = "inference" | "advisor";
export type InferenceBackendKind = "claude-code" | "anthropic-api";

export interface InferenceOptions {
  level?: InferenceLevel;
  mode?: InferenceMode;
  json?: boolean;
  timeoutMs?: number;
  somaHome?: string;
  homeDir?: string;
  backend?: InferenceBackend;
}

export interface InferenceRequest {
  level: InferenceLevel;
  mode: InferenceMode;
  json: boolean;
  timeoutMs: number;
}

export interface InferenceResult<T = unknown> {
  text: string;
  json?: T;
  backend: InferenceBackendKind;
  level: InferenceLevel;
  mode: InferenceMode;
  model: string;
}

export interface InferenceBackend {
  readonly kind: InferenceBackendKind;
  resolveModel(level: InferenceLevel, mode: InferenceMode): string;
  invoke(prompt: string, request: InferenceRequest): Promise<string>;
}

export interface AdvisorStateOptions {
  somaHome?: string;
  homeDir?: string;
}
