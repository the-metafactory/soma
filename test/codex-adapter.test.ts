import { expect, test } from "bun:test";
import { projectCodex, codexAdapter, projectCodexHome } from "../src/index";
import { portableProjectionInput } from "./fixtures";

const CODEX_MEMORY_INDEX = "memories/soma/memory-index.md";

test("codex adapter builds a portable context bundle", () => {
  const bundle = projectCodex(portableProjectionInput);

  expect(bundle.substrate).toBe("codex");
  expect(bundle.instructions).toContain("Soma Codex Context");
  expect(bundle.instructions).toContain("Keep personal assistant context portable across substrates.");
  expect(bundle.instructions).toContain("ISC-PORTABLE-1");
  expect(bundle.files.map((file) => file.path)).toEqual([
    ".codex/soma/context.md",
    ".codex/soma/memory-layout.md",
    ".codex/soma/skills.md",
    ".codex/soma/policy.md",
  ]);
});

test("codex home projects the durable memory INDEX as a static file when present", () => {
  const withIndex = {
    ...portableProjectionInput,
    memory: { indexContent: "# Soma Memory Index\n\n## Procedural\n- restart-gateway — how · principal, verified 2d ago\n" },
  };
  const bundle = projectCodexHome(withIndex, "/tmp/soma-home");
  const indexFile = bundle.files.find((file) => file.path === CODEX_MEMORY_INDEX);
  expect(indexFile?.content).toContain("# Soma Memory Index");
  expect(indexFile?.content).toContain("restart-gateway");
});

test("codex home OMITS the memory INDEX file when no index exists yet", () => {
  // portableProjectionInput has no top-level `memory.indexContent`.
  const bundle = projectCodexHome(portableProjectionInput, "/tmp/soma-home");
  expect(bundle.files.map((file) => file.path)).not.toContain(CODEX_MEMORY_INDEX);
});

test("codex home repoints durable-claim guidance to note-aware recall", () => {
  const bundle = projectCodexHome(portableProjectionInput, "/tmp/soma-home");
  const skill = bundle.files.find((file) => file.path === "skills/soma/SKILL.md")?.content ?? "";
  expect(skill).toContain("soma memory recall");
  const lifecycle = bundle.files.find((file) => file.path === "memories/soma/lifecycle.md")?.content ?? "";
  expect(lifecycle).toContain("soma memory recall");
  expect(lifecycle).toContain("soma memory digest");
  expect(lifecycle).toContain("Capture Limitation");
});

test("codex adapter exposes context build before execution", async () => {
  await expect(codexAdapter.project(portableProjectionInput)).resolves.toMatchObject({
    substrate: "codex",
  });

  await expect(codexAdapter.run({ id: "task-1", substrate: "codex", prompt: "run" })).resolves.toMatchObject({
    status: "failed",
    summary: expect.stringContaining("not implemented"),
  });
});
