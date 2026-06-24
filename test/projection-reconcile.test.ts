import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileOwnedDir } from "../src/projection-reconcile";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soma-reconcile-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("removes stale files absent from the desired set, keeps desired (both FS)", async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, "PURPOSE.md"), "new", "utf8");
    await writeFile(join(root, "TELOS.md"), "stale", "utf8"); // renamed away
    const result = await reconcileOwnedDir(root, ["PURPOSE.md"]);
    expect(await exists(join(root, "PURPOSE.md"))).toBe(true);
    expect(await exists(join(root, "TELOS.md"))).toBe(false);
    expect(result.removed).toContain("TELOS.md");
  });
});

test("prunes a stale nested subdir once emptied (renamed-away skill dir analogue, both FS)", async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, "ISA"), { recursive: true });
    await writeFile(join(root, "ISA", "SKILL.md"), "stale", "utf8");
    await writeFile(join(root, "INDEX.md"), "keep", "utf8");
    await reconcileOwnedDir(root, ["INDEX.md"]);
    expect(await exists(join(root, "INDEX.md"))).toBe(true);
    expect(await exists(join(root, "ISA"))).toBe(false); // emptied → pruned
  });
});

test("keeps a desired nested file, removes a sibling stale file (both FS)", async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "keep.md"), "k", "utf8");
    await writeFile(join(root, "sub", "drop.md"), "d", "utf8");
    await reconcileOwnedDir(root, ["sub/keep.md"]);
    expect(await exists(join(root, "sub", "keep.md"))).toBe(true);
    expect(await exists(join(root, "sub", "drop.md"))).toBe(false);
    expect(await exists(join(root, "sub"))).toBe(true);
  });
});

test("no-op when contents already equal the desired set (idempotent)", async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, "a.md"), "a", "utf8");
    const result = await reconcileOwnedDir(root, ["a.md"]);
    expect(result.removed).toEqual([]);
    expect(result.renamed).toEqual([]);
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("a");
  });
});

// Case-normalization: a file whose name differs from the canonical desired path
// only by case. On a case-INSENSITIVE FS (macOS dev/APFS) it is the same file as
// the just-projected canonical one and must be renamed to canonical case; on a
// case-SENSITIVE FS it is a distinct stale file and is removed. Either way the
// post-state contains exactly the canonical name — never the wrong-case one.
test("normalizes/removes a case-variant so only the canonical name survives", async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, "Purpose.md"), "content", "utf8");
    const caseInsensitive = await exists(join(root, "purpose.md")); // true on APFS
    await reconcileOwnedDir(root, ["purpose.md"]);
    const names = await readdir(root);
    expect(names).not.toContain("Purpose.md");
    if (caseInsensitive) {
      expect(names).toContain("purpose.md");
      expect(await readFile(join(root, "purpose.md"), "utf8")).toBe("content");
    }
  });
});
