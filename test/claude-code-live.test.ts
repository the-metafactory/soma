import { expect, test } from "bun:test";
import { createClaudeCodeBackend } from "../src/tools/inference/backends/claude-code";

test.skipIf(process.env.SOMA_TEST_CLAUDE_LIVE !== "1")("installed Claude CLI accepts the inference adapter and returns a response", async () => {
  const result = await createClaudeCodeBackend().invoke(
    "Return exactly SOMA_INFERENCE_OK. Do not use tools.",
    { level: "standard", mode: "inference", json: false, timeoutMs: 60_000 },
  );
  expect(result).toBe("SOMA_INFERENCE_OK");
}, 65_000);
