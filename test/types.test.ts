import { expect, test } from "bun:test";
import { SOMA_VERSION, type SomaAdapter } from "../src/index";

test("exports version", () => {
  expect(SOMA_VERSION).toBe("0.1.2");
});

test("adapter contract is structurally usable", async () => {
  const adapter: SomaAdapter = {
    name: "custom",
    async detect() {
      return true;
    },
    async buildContext() {
      return { substrate: "custom", instructions: "", files: [] };
    },
    async run(task) {
      return {
        taskId: task.id,
        substrate: task.substrate,
        status: "completed",
        summary: "ok",
      };
    },
  };

  await expect(adapter.detect()).resolves.toBe(true);
});
