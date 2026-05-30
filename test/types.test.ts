import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SOMA_VERSION, type SomaAdapter } from "../src/index";

test("exports version (source of truth: package.json)", () => {
  // SOMA_VERSION is derived from package.json — bumping the version
  // requires touching one file only, not this test.
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
  expect(SOMA_VERSION).toBe(pkg.version);
  expect(/^\d+\.\d+\.\d+/.test(SOMA_VERSION)).toBe(true);
});

test("arc manifest version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
  const manifest = readFileSync(join(import.meta.dirname, "..", "arc-manifest.yaml"), "utf8");
  const version = (/^version:\s*(\S+)\s*$/m.exec(manifest))?.[1];
  expect(version).toBe(pkg.version);
});

test("adapter contract is structurally usable", async () => {
  const adapter: SomaAdapter = {
    name: "custom",
    async detect() {
      return true;
    },
    async project() {
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
