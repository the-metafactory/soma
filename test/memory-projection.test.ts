import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import {
  CLAUDE_CODE_RULES_FILES,
  memoryIndexBundleFile,
  projectClaudeCodeHome,
} from "../src/adapters/claude-code";
import { loadMemoryIndexForProjection, memoryIndexPath } from "../src/memory-index";
import type { ProjectionInput } from "../src/index";
import { portableProjectionInput } from "./fixtures";

const INDEX_SAMPLE = "# Soma Memory Index\n\n## Procedural\n- restart-gateway — how to restart · principal, verified 3d ago\n";

function withMemory(indexContent?: string): ProjectionInput {
  return indexContent === undefined
    ? portableProjectionInput
    : { ...portableProjectionInput, memory: { indexContent } };
}

async function withTempSoma<T>(fn: (somaHome: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soma-proj-"));
  const somaHome = join(dir, ".soma");
  try {
    return await fn(somaHome);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Restore env after any test that toggles the kill-switches.
afterEach(() => {
  delete process.env.SOMA_MEMORY_DISABLE;
  delete process.env.SOMA_MEMORY_DISABLE_PROJECT;
});

// --- bundle helper -----------------------------------------------------------

test("memoryIndexBundleFile projects MEMORY.md verbatim when an index is present", () => {
  const files = memoryIndexBundleFile(withMemory(INDEX_SAMPLE));
  expect(files).toEqual([{ path: "rules/soma/MEMORY.md", content: INDEX_SAMPLE }]);
});

test("memoryIndexBundleFile omits the file when there is no index (or it is blank)", () => {
  expect(memoryIndexBundleFile(withMemory(undefined))).toEqual([]);
  expect(memoryIndexBundleFile(withMemory("   \n  "))).toEqual([]);
});

// --- home projection ---------------------------------------------------------

test("projectClaudeCodeHome includes rules/soma/MEMORY.md (verbatim) when memory is set", () => {
  const projection = projectClaudeCodeHome(withMemory(INDEX_SAMPLE));
  const memoryFile = projection.files.find((f) => f.path === "rules/soma/MEMORY.md");
  expect(memoryFile).toBeDefined();
  // verbatim stored bytes — no provenance header, no wall clock
  expect(memoryFile!.content).toBe(INDEX_SAMPLE);
  expect(memoryFile!.content).not.toContain("Provenance");
});

test("projectClaudeCodeHome omits MEMORY.md when no memory index is set", () => {
  const projection = projectClaudeCodeHome(withMemory(undefined));
  expect(projection.files.some((f) => f.path === "rules/soma/MEMORY.md")).toBe(false);
});

test("MEMORY.md projection is idempotent — same input renders byte-identical content", () => {
  const first = projectClaudeCodeHome(withMemory(INDEX_SAMPLE));
  const second = projectClaudeCodeHome(withMemory(INDEX_SAMPLE));
  const pick = (p: ReturnType<typeof projectClaudeCodeHome>) =>
    p.files.find((f) => f.path === "rules/soma/MEMORY.md")!.content;
  expect(pick(second)).toBe(pick(first));
});

test("MEMORY.md is a declared rules file (planner / doctor / uninstall awareness)", () => {
  expect(CLAUDE_CODE_RULES_FILES).toContain("rules/soma/MEMORY.md");
});

// --- loader ------------------------------------------------------------------

test("loadMemoryIndexForProjection returns the verbatim INDEX.md bytes", async () => {
  await withTempSoma(async (somaHome) => {
    const path = memoryIndexPath(somaHome);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, INDEX_SAMPLE, "utf8");
    expect(await loadMemoryIndexForProjection({ somaHome })).toBe(INDEX_SAMPLE);
  });
});

test("loadMemoryIndexForProjection soft-fails to undefined when the index is absent or blank", async () => {
  await withTempSoma(async (somaHome) => {
    expect(await loadMemoryIndexForProjection({ somaHome })).toBeUndefined();
    const path = memoryIndexPath(somaHome);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "   \n", "utf8");
    expect(await loadMemoryIndexForProjection({ somaHome })).toBeUndefined();
  });
});

test("SOMA_MEMORY_DISABLE and SOMA_MEMORY_DISABLE_PROJECT both suppress the projection", async () => {
  await withTempSoma(async (somaHome) => {
    const path = memoryIndexPath(somaHome);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, INDEX_SAMPLE, "utf8");

    process.env.SOMA_MEMORY_DISABLE = "1";
    expect(await loadMemoryIndexForProjection({ somaHome })).toBeUndefined();
    delete process.env.SOMA_MEMORY_DISABLE;

    process.env.SOMA_MEMORY_DISABLE_PROJECT = "1";
    expect(await loadMemoryIndexForProjection({ somaHome })).toBeUndefined();
  });
});
