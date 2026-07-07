import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  portableSkillManifestPath,
  portableSkillManifestSchema,
  readPortableSkillManifest,
  reconcilePortableSkillProjection,
  removePortableSkillProjection,
  writePortableSkillManifest,
} from "../src/adapters/shared/portable-skill-manifest";

async function withDirs(fn: (somaHome: string, substrateHome: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "soma-psm-"));
  const somaHome = join(root, ".soma");
  const substrateHome = join(root, ".sub");
  await mkdir(somaHome, { recursive: true });
  await mkdir(substrateHome, { recursive: true });
  try {
    await fn(somaHome, substrateHome);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const gone = (path: string) => stat(path).then(() => false, () => true);

async function project(substrateHome: string, files: { path: string; content: string }[]): Promise<void> {
  for (const file of files) {
    const target = join(substrateHome, file.path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

test("schema and path are substrate-scoped and byte-stable for grok", () => {
  expect(portableSkillManifestSchema("grok")).toBe("soma-grok-install-manifest-v1");
  expect(portableSkillManifestSchema("claude-code")).toBe("soma-claude-code-install-manifest-v1");
  expect(portableSkillManifestPath("/home/.soma", "grok")).toBe("/home/.soma/projections/grok/install-manifest.json");
});

test("write records path + content hash; read round-trips; a foreign schema reads as null", async () => {
  await withDirs(async (somaHome, substrateHome) => {
    const files = [{ path: "skills/Memory/SKILL.md", content: "memory body\n" }];
    await project(substrateHome, files);
    await writePortableSkillManifest({ somaHome, substrate: "claude-code", substrateHome, files });

    const manifest = await readPortableSkillManifest(somaHome, "claude-code");
    expect(manifest?.schema).toBe("soma-claude-code-install-manifest-v1");
    expect(manifest?.files.map((f) => f.path)).toEqual(["skills/Memory/SKILL.md"]);
    // Same manifest bytes, read under a DIFFERENT substrate → schema mismatch → null.
    expect(await readPortableSkillManifest(somaHome, "grok")).toBeNull();
  });
});

test("remove deletes recorded files, prunes emptied dirs, consumes the manifest", async () => {
  await withDirs(async (somaHome, substrateHome) => {
    const files = [
      { path: "skills/Memory/SKILL.md", content: "a\n" },
      { path: "skills/Memory/Workflows/Recall.md", content: "b\n" },
    ];
    await project(substrateHome, files);
    await writePortableSkillManifest({ somaHome, substrate: "claude-code", substrateHome, files });

    const removed = await removePortableSkillProjection({ somaHome, substrate: "claude-code", substrateHome });

    expect(removed).toContain(resolve(substrateHome, "skills/Memory/SKILL.md"));
    expect(removed).toContain(resolve(substrateHome, "skills/Memory/Workflows/Recall.md"));
    expect(await gone(join(substrateHome, "skills/Memory"))).toBe(true);
    // The manifest is consumed so a second uninstall is a no-op.
    expect(await gone(portableSkillManifestPath(somaHome, "claude-code"))).toBe(true);
    expect(await removePortableSkillProjection({ somaHome, substrate: "claude-code", substrateHome })).toEqual([]);
  });
});

test("remove preserves user-edited files and user-added files (and keeps their dir)", async () => {
  await withDirs(async (somaHome, substrateHome) => {
    const files = [
      { path: "skills/Memory/SKILL.md", content: "original\n" },
      { path: "skills/Memory/Workflows/Recall.md", content: "recall\n" },
    ];
    await project(substrateHome, files);
    await writePortableSkillManifest({ somaHome, substrate: "grok", substrateHome, files });

    // The principal edits one projected file and adds an unmanaged one.
    await writeFile(join(substrateHome, "skills/Memory/SKILL.md"), "hand-tuned\n", "utf8");
    await writeFile(join(substrateHome, "skills/Memory/extra.md"), "user-added\n", "utf8");

    await removePortableSkillProjection({ somaHome, substrate: "grok", substrateHome });

    // Edited file survives (hash guard); unmanaged file survives; dir kept.
    expect(await readFile(join(substrateHome, "skills/Memory/SKILL.md"), "utf8")).toBe("hand-tuned\n");
    expect(await readFile(join(substrateHome, "skills/Memory/extra.md"), "utf8")).toBe("user-added\n");
    // The unedited managed file was removed, its now-empty subdir pruned.
    expect(await gone(join(substrateHome, "skills/Memory/Workflows"))).toBe(true);
  });
});

test("remove ignores a manifest describing a different substrate home", async () => {
  await withDirs(async (somaHome, substrateHome) => {
    const files = [{ path: "skills/Memory/SKILL.md", content: "a\n" }];
    await project(substrateHome, files);
    await writePortableSkillManifest({ somaHome, substrate: "grok", substrateHome: "/some/other/home", files });

    const removed = await removePortableSkillProjection({ somaHome, substrate: "grok", substrateHome });
    expect(removed).toEqual([]);
    // Neither the file nor the (foreign-home) manifest is touched.
    expect(await gone(join(substrateHome, "skills/Memory/SKILL.md"))).toBe(false);
    expect(await gone(portableSkillManifestPath(somaHome, "grok"))).toBe(false);
  });
});

test("reconcile removes only files the current projection dropped, keeping the manifest", async () => {
  await withDirs(async (somaHome, substrateHome) => {
    const files = [
      { path: "skills/Memory/SKILL.md", content: "m\n" },
      { path: "skills/Gone/SKILL.md", content: "g\n" },
    ];
    await project(substrateHome, files);
    await writePortableSkillManifest({ somaHome, substrate: "claude-code", substrateHome, files });

    // Next install no longer projects skills/Gone (a bundled skill removed
    // across soma versions). Reconcile drops it; Memory stays; manifest kept
    // (the caller overwrites it right after).
    const removed = await reconcilePortableSkillProjection({
      somaHome,
      substrate: "claude-code",
      substrateHome,
      currentPaths: ["skills/Memory/SKILL.md"],
    });

    expect(removed).toContain(resolve(substrateHome, "skills/Gone/SKILL.md"));
    expect(await gone(join(substrateHome, "skills/Gone"))).toBe(true);
    expect(await gone(join(substrateHome, "skills/Memory/SKILL.md"))).toBe(false);
    expect(await gone(portableSkillManifestPath(somaHome, "claude-code"))).toBe(false);
  });
});
