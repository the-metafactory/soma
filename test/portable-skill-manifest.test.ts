import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  portableSkillManifestPath,
  portableSkillManifestSchema,
  readPortableSkillManifest,
  reconcilePortableSkillProjection,
  removePortableSkillProjection,
  writePortableSkillManifest,
} from "../src/adapters/shared/portable-skill-manifest";

function substrateHomeSegment(substrateHome: string): string {
  return createHash("sha256").update(resolve(substrateHome), "utf8").digest("hex").slice(0, 12);
}

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

test("schema and path are substrate-scoped, per-substrate-home, and byte-stable for grok", () => {
  expect(portableSkillManifestSchema("grok")).toBe("soma-grok-install-manifest-v1");
  expect(portableSkillManifestSchema("claude-code")).toBe("soma-claude-code-install-manifest-v1");
  const hash = substrateHomeSegment("/home/.grok");
  expect(portableSkillManifestPath("/home/.soma", "grok", "/home/.grok")).toBe(
    `/home/.soma/projections/grok/${hash}/install-manifest.json`,
  );
  // Two different substrate homes get two different manifest paths.
  expect(portableSkillManifestPath("/home/.soma", "grok", "/home/.grok")).not.toBe(
    portableSkillManifestPath("/home/.soma", "grok", "/home/other-grok"),
  );
});

test("write records path + content hash; read round-trips; a foreign schema reads as null", async () => {
  await withDirs(async (somaHome, substrateHome) => {
    const files = [{ path: "skills/Memory/SKILL.md", content: "memory body\n" }];
    await project(substrateHome, files);
    await writePortableSkillManifest({ somaHome, substrate: "claude-code", substrateHome, files });

    const manifest = await readPortableSkillManifest(somaHome, "claude-code", substrateHome);
    expect(manifest?.schema).toBe("soma-claude-code-install-manifest-v1");
    expect(manifest?.files.map((f) => f.path)).toEqual(["skills/Memory/SKILL.md"]);
    // The claude-code manifest lives under projections/claude-code/<hash>/; reading
    // the same home as "grok" looks under a different per-substrate path → no file → null.
    expect(await readPortableSkillManifest(somaHome, "grok", substrateHome)).toBeNull();
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
    expect(await gone(portableSkillManifestPath(somaHome, "claude-code", substrateHome))).toBe(true);
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

test("remove ignores a manifest describing a different substrate home (defense-in-depth in-file guard)", async () => {
  await withDirs(async (somaHome, substrateHome) => {
    const files = [{ path: "skills/Memory/SKILL.md", content: "a\n" }];
    await project(substrateHome, files);
    // Manifest lives at the path keyed by the REAL substrate home (so remove
    // finds it), but its in-file `substrateHome` field names a different home
    // — the tampered/stale-content case the in-file guard defends against.
    const path = portableSkillManifestPath(somaHome, "grok", substrateHome);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({
        schema: "soma-grok-install-manifest-v1",
        substrateHome: "/some/other/home",
        files: [{ path: files[0].path, sha256: createHash("sha256").update(files[0].content, "utf8").digest("hex") }],
      })}\n`,
      "utf8",
    );

    const removed = await removePortableSkillProjection({ somaHome, substrate: "grok", substrateHome });
    expect(removed).toEqual([]);
    // Neither the file nor the (foreign-home) manifest is touched.
    expect(await gone(join(substrateHome, "skills/Memory/SKILL.md"))).toBe(false);
    expect(await gone(path)).toBe(false);
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
    expect(await gone(portableSkillManifestPath(somaHome, "claude-code", substrateHome))).toBe(false);
  });
});

test("two substrate homes of the same substrate, installed from one soma home, get independent manifests (#438)", async () => {
  const root = await mkdtemp(join(tmpdir(), "soma-psm-multi-home-"));
  try {
    const somaHome = join(root, ".soma");
    const substrateHomeA = join(root, "home-a", ".claude");
    const substrateHomeB = join(root, "home-b", ".claude");
    await mkdir(somaHome, { recursive: true });
    await mkdir(substrateHomeA, { recursive: true });
    await mkdir(substrateHomeB, { recursive: true });

    const filesA = [{ path: "skills/Memory/SKILL.md", content: "home-a memory\n" }];
    const filesB = [{ path: "skills/Memory/SKILL.md", content: "home-b memory\n" }];
    await project(substrateHomeA, filesA);
    await project(substrateHomeB, filesB);
    await writePortableSkillManifest({ somaHome, substrate: "claude-code", substrateHome: substrateHomeA, files: filesA });
    await writePortableSkillManifest({ somaHome, substrate: "claude-code", substrateHome: substrateHomeB, files: filesB });

    const pathA = portableSkillManifestPath(somaHome, "claude-code", substrateHomeA);
    const pathB = portableSkillManifestPath(somaHome, "claude-code", substrateHomeB);
    expect(pathA).not.toBe(pathB);
    expect(await gone(pathA)).toBe(false);
    expect(await gone(pathB)).toBe(false);

    // Uninstalling home A only consumes home A's manifest and round-trips
    // only home A's projected skill dir; home B's manifest and skill dir
    // are untouched.
    const removed = await removePortableSkillProjection({ somaHome, substrate: "claude-code", substrateHome: substrateHomeA });

    expect(removed).toContain(resolve(substrateHomeA, "skills/Memory/SKILL.md"));
    expect(await gone(join(substrateHomeA, "skills/Memory"))).toBe(true);
    expect(await gone(pathA)).toBe(true);

    // Home B is fully intact — the regression this test guards against is
    // home A's uninstall reading home B's (last-written-wins) manifest and
    // orphaning or deleting home B's projected files.
    expect(await gone(pathB)).toBe(false);
    expect(await readFile(join(substrateHomeB, "skills/Memory/SKILL.md"), "utf8")).toBe("home-b memory\n");
    const manifestB = await readPortableSkillManifest(somaHome, "claude-code", substrateHomeB);
    expect(manifestB?.files.map((f) => f.path)).toEqual(["skills/Memory/SKILL.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
