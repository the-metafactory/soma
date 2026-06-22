import { expect, test } from "bun:test";
import {
  projectClaudeCode,
  projectCodex,
  projectCursor,
  projectGrok,
  projectPiDev,
  claudeCodeAdapter,
  cursorAdapter,
  piDevAdapter,
} from "../src/index";
import { expectPortableSemantics, portableProjectionInput } from "./fixtures";

test("pi.dev adapter builds an extension-shaped context bundle", () => {
  const bundle = projectPiDev(portableProjectionInput);

  expect(bundle.substrate).toBe("pi-dev");
  expect(bundle.files.map((file) => file.path)).toContain(".pi/extensions/soma-core/extension.json");
  expect(bundle.files.map((file) => file.path)).toContain(".pi/extensions/soma-core/tools.md");
  expect(bundle.files.find((file) => file.path.endsWith("extension.json"))?.content).toContain("memory_search");
  expectPortableSemantics(bundle);
});

test("pi.dev adapter requires HOME when SOMA_HOME is unset", () => {
  const originalHome = process.env.HOME;
  const originalSomaHome = process.env.SOMA_HOME;

  try {
    delete process.env.HOME;
    delete process.env.SOMA_HOME;
    expect(() => projectPiDev(portableProjectionInput)).toThrow("HOME must be set");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSomaHome === undefined) delete process.env.SOMA_HOME;
    else process.env.SOMA_HOME = originalSomaHome;
  }
});

test("claude code adapter builds a claude-shaped context bundle", () => {
  const bundle = projectClaudeCode(portableProjectionInput);

  expect(bundle.substrate).toBe("claude-code");
  expect(bundle.files.map((file) => file.path)).toContain("CLAUDE.md");
  expect(bundle.files.map((file) => file.path)).toContain(".claude/soma/hooks.md");
  expect(bundle.files.find((file) => file.path === "CLAUDE.md")?.content).toContain("portable source of truth is Soma");
  expectPortableSemantics(bundle);
});

test("cursor adapter builds a Cursor rules-shaped context bundle", () => {
  const bundle = projectCursor(portableProjectionInput);

  expect(bundle.substrate).toBe("cursor");
  expect(bundle.files.map((file) => file.path)).toContain(".cursorrules");
  expect(bundle.files.map((file) => file.path)).toContain(".cursor/rules/soma/CONTEXT.md");
  expect(bundle.files.map((file) => file.path)).toContain(".cursor/rules/soma/MCP.md");
  expect(bundle.files.find((file) => file.path === ".cursorrules")?.content).toContain(".cursor/rules/soma/CONTEXT.md");
  expectPortableSemantics(bundle);
});

test("codex, pi.dev, claude code, cursor, and grok preserve portable semantics from one input", () => {
  const bundles = [
    projectCodex(portableProjectionInput),
    projectPiDev(portableProjectionInput),
    projectClaudeCode(portableProjectionInput),
    projectCursor(portableProjectionInput),
    projectGrok(portableProjectionInput),
  ];

  for (const bundle of bundles) {
    expectPortableSemantics(bundle);
  }
});

test("pi.dev, claude code, and cursor adapters expose context build before execution", async () => {
  await expect(piDevAdapter.project(portableProjectionInput)).resolves.toMatchObject({
    substrate: "pi-dev",
  });

  await expect(claudeCodeAdapter.project(portableProjectionInput)).resolves.toMatchObject({
    substrate: "claude-code",
  });

  await expect(cursorAdapter.project(portableProjectionInput)).resolves.toMatchObject({
    substrate: "cursor",
  });

  await expect(piDevAdapter.run({ id: "task-1", substrate: "pi-dev", prompt: "run" })).resolves.toMatchObject({
    status: "failed",
    summary: expect.stringContaining("not implemented"),
  });

  await expect(claudeCodeAdapter.run({ id: "task-2", substrate: "claude-code", prompt: "run" })).resolves.toMatchObject({
    status: "failed",
    summary: expect.stringContaining("not implemented"),
  });

  await expect(cursorAdapter.run({ id: "task-3", substrate: "cursor", prompt: "run" })).resolves.toMatchObject({
    status: "failed",
    summary: expect.stringContaining("not implemented"),
  });
});
