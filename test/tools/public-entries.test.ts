import { expect, test } from "bun:test";
import * as tools from "../../src/tools/index";
import * as learning from "../../src/tools/learning";

test("the tools public entry runs inference with an injected backend", async () => {
  const result = await tools.inference<{ answer: number }>("Answer as JSON", {
    json: true,
    backend: {
      kind: "claude-code",
      resolveModel: () => "test-model",
      invoke: async () => '{"answer":42}',
    },
  });
  expect(result).toEqual({
    text: '{"answer":42}',
    json: { answer: 42 },
    backend: "claude-code",
    level: "standard",
    mode: "inference",
    model: "test-model",
  });
});

test("tools public entries do not expose the flows session harvester", () => {
  expect("harvestSessions" in tools).toBe(false);
  expect("harvestSessions" in learning).toBe(false);
});
