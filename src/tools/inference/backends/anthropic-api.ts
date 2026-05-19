import type { InferenceBackend, InferenceLevel, InferenceMode, InferenceRequest } from "../types";

const ANTHROPIC_MODEL_BY_LEVEL: Record<InferenceLevel, string> = {
  fast: "claude-3-5-haiku-20241022",
  standard: "claude-sonnet-4-20250514",
  smart: "claude-opus-4-1-20250805",
};

export interface AnthropicApiBackendOptions {
  apiKey?: string;
  fetch?: typeof fetch;
}

export class AnthropicApiBackend implements InferenceBackend {
  readonly kind = "anthropic-api" as const;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicApiBackendOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.fetchImpl = options.fetch ?? fetch;
  }

  resolveModel(level: InferenceLevel, mode: InferenceMode): string {
    return mode === "advisor" ? ANTHROPIC_MODEL_BY_LEVEL.smart : ANTHROPIC_MODEL_BY_LEVEL[level];
  }

  async invoke(prompt: string, request: InferenceRequest): Promise<string> {
    if (!this.apiKey) {
      throw new Error("Anthropic API backend requires ANTHROPIC_API_KEY.");
    }

    const response = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.resolveModel(request.level, request.mode),
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API inference failed: ${response.status} ${await response.text()}`);
    }

    const payload = await response.json() as { content?: { type?: string; text?: string }[] };
    return payload.content
      ?.filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
      .trim() ?? "";
  }
}

export function createAnthropicApiBackend(options: AnthropicApiBackendOptions = {}): AnthropicApiBackend {
  return new AnthropicApiBackend(options);
}
