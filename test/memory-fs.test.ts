/**
 * The shared symlink-safe memory-traversal seam (#408) — `src/memory-fs.ts`.
 *
 * "Enumerate the note files under a memory subtree without letting a symlink
 * escape the memory root" was re-derived four times (memory-consolidate.ts,
 * memory-audit.ts, memory-backfill.ts, memory-write.ts) with disagreeing
 * policy. This is the seam-level test for that one invariant — the four
 * callers keep their own integration tests (their specific error messages,
 * specific stances), but the invariant itself now has one canonical proof.
 */
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { listMemoryNotes, MemoryTraversalError } from "../src/memory-fs";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soma-memory-fs-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("traversal never follows a symlink out of the memory root — skip mode omits it", async () => {
  await withTempDir(async (root) => {
    const memoryRoot = join(root, "memory");
    const outside = join(root, "outside");
    await mkdir(join(memoryRoot, "semantic"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(memoryRoot, "semantic", "real.md"), "a real note", "utf8");
    await writeFile(join(outside, "secret.md"), "content that must never be reachable from the memory root", "utf8");

    // A symlinked FILE and a symlinked DIRECTORY, both pointing outside the root.
    await symlink(join(outside, "secret.md"), join(memoryRoot, "semantic", "leak.md"));
    await symlink(outside, join(memoryRoot, "semantic", "escape-dir"));

    const files = await listMemoryNotes(join(memoryRoot, "semantic"), { recursive: true, onSymlink: "skip" });

    expect(files).toEqual([join(memoryRoot, "semantic", "real.md")]);
    // No path under `outside` was ever returned — the walk never followed either symlink.
    expect(files.some((f) => f.startsWith(outside))).toBe(false);
  });
});

test("traversal never follows a symlink out of the memory root — throw mode refuses loudly instead", async () => {
  await withTempDir(async (root) => {
    const memoryRoot = join(root, "memory");
    const outside = join(root, "outside");
    await mkdir(join(memoryRoot, "semantic"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.md"), "must never be read", "utf8");
    await symlink(join(outside, "secret.md"), join(memoryRoot, "semantic", "leak.md"));

    await expect(listMemoryNotes(join(memoryRoot, "semantic"), { onSymlink: "throw" })).rejects.toThrow(
      MemoryTraversalError,
    );
  });
});

test("a symlinked root itself yields [] (not an error) — an abnormal root is the caller's own precondition", async () => {
  await withTempDir(async (root) => {
    const real = join(root, "real");
    const link = join(root, "link");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "n.md"), "n", "utf8");
    await symlink(real, link);

    expect(await listMemoryNotes(link, { recursive: true, onSymlink: "skip" })).toEqual([]);
    expect(await listMemoryNotes(link, { recursive: true, onSymlink: "throw" })).toEqual([]);
  });
});

test("a missing directory yields [], not an error", async () => {
  await withTempDir(async (root) => {
    expect(await listMemoryNotes(join(root, "does-not-exist"), { recursive: true })).toEqual([]);
  });
});

test("non-recursive: a symlinked subdirectory is never descended into even without `recursive`", async () => {
  await withTempDir(async (root) => {
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "foreign.md"), "foreign", "utf8");
    await mkdir(join(root, "dir"), { recursive: true });
    await writeFile(join(root, "dir", "real.md"), "real", "utf8");
    await symlink(outside, join(root, "dir", "linked"));

    const files = await listMemoryNotes(join(root, "dir"), { onSymlink: "skip" });
    expect(files).toEqual([join(root, "dir", "real.md")]);
  });
});

test("extensions filter defaults to .md and is case-sensitive", async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, "a.md"), "a", "utf8");
    await writeFile(join(root, "b.MD"), "b", "utf8");
    await writeFile(join(root, "c.txt"), "c", "utf8");

    expect(await listMemoryNotes(root)).toEqual([join(root, "a.md")]);
  });
});

test("`include` can exclude entries and prevent descending into a directory (business filtering, not a symlink violation)", async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, "STATE"), { recursive: true });
    await writeFile(join(root, "STATE", "hidden.md"), "should never surface", "utf8");
    await writeFile(join(root, "kept.md"), "kept", "utf8");

    const files = await listMemoryNotes(root, {
      recursive: true,
      include: (entry) => !(entry.depth === 0 && entry.isDirectory && entry.name === "STATE"),
    });

    expect(files).toEqual([join(root, "kept.md")]);
  });
});

test("leaf guard: a symlinked file leaf is never returned, and every returned path is a real regular file", async () => {
  await withTempDir(async (root) => {
    const outside = join(root, "outside");
    await mkdir(join(root, "notes"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, "notes", "real.md"), "a real note", "utf8");
    await writeFile(join(outside, "secret.md"), "outside content", "utf8");
    await symlink(join(outside, "secret.md"), join(root, "notes", "leak.md"));

    const files = await listMemoryNotes(join(root, "notes"));
    expect(files).toEqual([join(root, "notes", "real.md")]);
    // The seam re-lstats each leaf before returning it — independently confirm
    // every returned path is a real regular file, never a symlink.
    for (const f of files) {
      const st = await lstat(f);
      expect(st.isSymbolicLink()).toBe(false);
      expect(st.isFile()).toBe(true);
    }
  });
});

test("leaf swapped to a symlink after enumeration is not followed at read (O_NOFOLLOW boundary)", async () => {
  await withTempDir(async (root) => {
    const outside = join(root, "outside");
    await mkdir(join(root, "notes"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, "notes", "note.md"), "the real in-tree content", "utf8");
    await writeFile(join(outside, "secret.md"), "SECRET content outside the memory root", "utf8");

    // 1. Enumerate — the seam returns the real leaf path.
    const [leaf] = await listMemoryNotes(join(root, "notes"));
    expect(leaf).toBe(join(root, "notes", "note.md"));

    // 2. Swap the leaf for a symlink pointing outside the root — the exact
    //    TOCTOU an attacker races between enumeration and a caller's read.
    await rm(leaf);
    await symlink(join(outside, "secret.md"), leaf);

    // 3. Read it the way the durable-corpus scan (collectDurableNotes) now does
    //    — O_NOFOLLOW — and confirm the outside content is never followed: the
    //    open fails with ELOOP rather than returning the secret.
    await expect(
      readFile(leaf, { encoding: "utf8", flag: FS.O_RDONLY | FS.O_NOFOLLOW }),
    ).rejects.toThrow(/ELOOP/);
  });
});
