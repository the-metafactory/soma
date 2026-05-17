import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  projectClaudeCode,
  projectCodex,
  projectPiDev,
  type Projection,
  writeProjection,
} from "../src/index";
import { portableProjectionInput } from "./fixtures";

async function withTempDir<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "soma-context-"));

  try {
    return await fn(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("writes a codex context bundle to disk", async () => {
  await withTempDir(async (rootDir) => {
    const bundle = projectCodex(portableProjectionInput);
    const result = await writeProjection(bundle, rootDir);

    expect(result.substrate).toBe("codex");
    expect(result.rootDir).toBe(rootDir);
    expect(result.files).toHaveLength(bundle.files.length);

    const context = await readFile(join(rootDir, ".codex/soma/context.md"), "utf8");
    expect(context).toContain("Soma Codex Context");
    expect(context).toContain("ISC-PORTABLE-1");
  });
});

test("writes pi.dev and claude code bundles to substrate-shaped paths", async () => {
  await withTempDir(async (rootDir) => {
    const piResult = await writeProjection(projectPiDev(portableProjectionInput), rootDir);
    const claudeResult = await writeProjection(projectClaudeCode(portableProjectionInput), rootDir);

    expect(piResult.files.some((file) => file.endsWith(".pi/extensions/soma-core/extension.json"))).toBe(true);
    expect(claudeResult.files.some((file) => file.endsWith("CLAUDE.md"))).toBe(true);

    const piManifest = await readFile(join(rootDir, ".pi/extensions/soma-core/extension.json"), "utf8");
    const claudeContext = await readFile(join(rootDir, ".claude/soma/context.md"), "utf8");

    expect(piManifest).toContain("memory_search");
    expect(claudeContext).toContain("Soma Claude Code Context");
  });
});

test("rejects context bundle paths that escape the root", async () => {
  await withTempDir(async (rootDir) => {
    const bundle: Projection = {
      substrate: "custom",
      instructions: "",
      files: [
        {
          path: "../escape.md",
          content: "no",
        },
      ],
    };

    await expect(writeProjection(bundle, rootDir)).rejects.toThrow("escapes root");
  });
});

test("rejects absolute context bundle paths", async () => {
  await withTempDir(async (rootDir) => {
    const bundle: Projection = {
      substrate: "custom",
      instructions: "",
      files: [
        {
          path: join(rootDir, "absolute.md"),
          content: "no",
        },
      ],
    };

    await expect(writeProjection(bundle, rootDir)).rejects.toThrow("must be relative");
  });
});
