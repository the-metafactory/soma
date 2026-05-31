import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const designDoc = readFileSync("docs/mcp-server.md", "utf8");
const adapterDoc = readFileSync("docs/substrate-adapters.md", "utf8");
const decisions = readFileSync("design/design-decisions.md", "utf8");

const firstSliceTools = [
  "soma_identity_context",
  "soma_skill_registry",
  "soma_skill_route",
  "soma_skill_load",
  "soma_isa_active",
  "soma_isa_check",
  "soma_algorithm_classify",
  "soma_memory_search",
  "soma_memory_read",
] as const;

const deferredWriteTools = [
  "soma_memory_promote",
  "soma_isa_scaffold",
  "soma_algorithm_new",
  "soma_algorithm_advance",
] as const;

test("MCP design records the canonical read-only first slice", () => {
  expect(designDoc).toContain("The first implementation slice should be read-only");
  const defaultTools = /- default tools:([\s\S]*?)- deferred tools:/.exec(designDoc)?.[1] ?? "";
  for (const tool of firstSliceTools) {
    expect(designDoc).toContain(tool);
    expect(decisions).toContain(tool);
    expect(defaultTools).toContain(tool);
  }
});

test("MCP design keeps mutating tools behind confirmation", () => {
  expect(designDoc).toContain("two-step confirmation protocol");
  expect(decisions).toContain("short-lived confirmation token");
  expect(designDoc).toContain("single-use and bound to the requesting principal");
  expect(decisions).toContain("single-use and bound to the requesting principal");
  expect(designDoc).toContain("MCP client session");
  for (const tool of deferredWriteTools) {
    expect(designDoc).toContain(tool);
    expect(decisions).toContain(tool);
  }
});

test("MCP design preserves adapter and writeback boundaries", () => {
  expect(designDoc).toContain("not a substrate adapter replacement");
  expect(adapterDoc).toContain("The optional MCP server is a shared library/daemon surface, not an adapter.");
  expect(designDoc).toMatch(/no raw prompt, transcript, full tool input, or command output is written\s+by default/);
});

test("MCP read tools require authorization scope", () => {
  expect(designDoc).toContain("Every read tool must validate the requesting principal");
  expect(designDoc).toContain("MCP client session");
  expect(designDoc).toContain("allowed scope");
  expect(decisions).toContain("Read tools must validate the requesting principal");
  expect(decisions).toContain("fail closed");
});
