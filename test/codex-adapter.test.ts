import { expect, test } from "bun:test";
import { buildCodexContext, codexAdapter } from "../src/index";
import { portableContextInput } from "./fixtures";

test("codex adapter builds a portable context bundle", () => {
  const bundle = buildCodexContext(portableContextInput);

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

test("codex adapter exposes context build before execution", async () => {
  await expect(codexAdapter.buildContext(portableContextInput)).resolves.toMatchObject({
    substrate: "codex",
  });

  await expect(codexAdapter.run({ id: "task-1", substrate: "codex", prompt: "run" })).resolves.toMatchObject({
    status: "failed",
    summary: expect.stringContaining("not implemented"),
  });
});
