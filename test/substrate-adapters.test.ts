import { expect, test } from "bun:test";
import {
  projectClaudeCode,
  projectCodex,
  projectCursor,
  projectGrok,
  projectPiDev,
  projectPiDevHome,
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
  const manifest = bundle.files.find((file) => file.path.endsWith("extension.json"))?.content ?? "";
  expect(manifest).toContain("memory_search");
  // Note-based memory kernel surfaced on Pi (M0–M7 substrate wiring).
  expect(manifest).toContain("memory_recall");
  expect(manifest).toContain("memory_index");
  expectPortableSemantics(bundle);
});

test("pi.dev home extension wires note-aware recall, live INDEX, and a digest wrap-up rule", () => {
  const bundle = projectPiDevHome(portableProjectionInput, "/tmp/soma-home");
  const extension = bundle.files.find((file) => file.path === "agent/extensions/soma.ts")?.content ?? "";
  // Both new soma_context actions and their routing exist in the rendered extension.
  expect(extension).toContain('"memory_recall"');
  expect(extension).toContain('"memory_index"');
  expect(extension).toContain("memoryRecallArgs");
  expect(extension).toContain("memory/INDEX.md");
  // memory_index distinguishes not-built (ENOENT) from a genuine read error,
  // rather than collapsing every blank read into a rebuild hint.
  expect(extension).toContain("ENOENT");
  expect(extension).toContain("Error reading Soma memory INDEX.md");
  // Digest capture is agent-invoked (Pi has no SessionEnd digest hook).
  expect(extension).toContain("soma memory digest");
  // Back-compat: legacy line-grep search is not removed.
  expect(extension).toContain("memorySearchArgs");
  // Regression (#402): the rendered extension must be syntactically valid TS.
  // A backtick-wrapped shell command was embedded RAW inside the `somaPrompt`
  // template literal, closing it early → Pi refused to load with
  // "ParseError: Missing semicolon" at the digest line. A string-contains check
  // (above) passes on broken syntax; transpiling is what actually guards it.
  expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(extension)).not.toThrow();
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

test("pi.dev, claude code, and cursor adapters remain projection-only", async () => {
  await expect(piDevAdapter.project(portableProjectionInput)).resolves.toMatchObject({
    substrate: "pi-dev",
  });

  await expect(claudeCodeAdapter.project(portableProjectionInput)).resolves.toMatchObject({
    substrate: "claude-code",
  });

  await expect(cursorAdapter.project(portableProjectionInput)).resolves.toMatchObject({
    substrate: "cursor",
  });

  expect("run" in piDevAdapter).toBe(false);
  expect("run" in claudeCodeAdapter).toBe(false);
  expect("run" in cursorAdapter).toBe(false);
});
