import { expect, test } from "bun:test";
import {
  buildClaudeCodeContext,
  buildCodexContext,
  buildPiDevContext,
  claudeCodeAdapter,
  piDevAdapter,
  type SomaContextBundle,
} from "../src/index";
import { portableContextInput } from "./fixtures";

function expectPortableSemantics(bundle: SomaContextBundle) {
  expect(bundle.instructions).toContain("Soma");
  expect(bundle.instructions).toContain("Keep personal assistant context portable across substrates.");
  expect(bundle.instructions).toContain("Substrate adapters translate; they do not own core concepts");
  expect(bundle.instructions).toContain("ISC-PORTABLE-1");
  expect(bundle.files.some((file) => file.content.includes("MEMORY/LEARNING"))).toBe(true);
  expect(bundle.files.some((file) => file.content.includes("Ledger Update"))).toBe(true);
  expect(bundle.files.some((file) => file.content.includes("Policy Projection"))).toBe(true);
}

test("pi.dev adapter builds an extension-shaped context bundle", () => {
  const bundle = buildPiDevContext(portableContextInput);

  expect(bundle.substrate).toBe("pi-dev");
  expect(bundle.files.map((file) => file.path)).toContain(".pi/extensions/soma-core/extension.json");
  expect(bundle.files.map((file) => file.path)).toContain(".pi/extensions/soma-core/tools.md");
  expect(bundle.files.find((file) => file.path.endsWith("extension.json"))?.content).toContain("memory_search");
  expectPortableSemantics(bundle);
});

test("claude code adapter builds a claude-shaped context bundle", () => {
  const bundle = buildClaudeCodeContext(portableContextInput);

  expect(bundle.substrate).toBe("claude-code");
  expect(bundle.files.map((file) => file.path)).toContain("CLAUDE.md");
  expect(bundle.files.map((file) => file.path)).toContain(".claude/soma/hooks.md");
  expect(bundle.files.find((file) => file.path === "CLAUDE.md")?.content).toContain("portable source of truth is Soma");
  expectPortableSemantics(bundle);
});

test("codex, pi.dev, and claude code preserve portable semantics from one input", () => {
  const bundles = [
    buildCodexContext(portableContextInput),
    buildPiDevContext(portableContextInput),
    buildClaudeCodeContext(portableContextInput),
  ];

  for (const bundle of bundles) {
    expectPortableSemantics(bundle);
  }
});

test("pi.dev and claude code adapters expose context build before execution", async () => {
  await expect(piDevAdapter.buildContext(portableContextInput)).resolves.toMatchObject({
    substrate: "pi-dev",
  });

  await expect(claudeCodeAdapter.buildContext(portableContextInput)).resolves.toMatchObject({
    substrate: "claude-code",
  });

  await expect(piDevAdapter.run({ id: "task-1", substrate: "pi-dev", prompt: "run" })).resolves.toMatchObject({
    status: "failed",
    summary: expect.stringContaining("not implemented"),
  });

  await expect(claudeCodeAdapter.run({ id: "task-2", substrate: "claude-code", prompt: "run" })).resolves.toMatchObject({
    status: "failed",
    summary: expect.stringContaining("not implemented"),
  });
});
