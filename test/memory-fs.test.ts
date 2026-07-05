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
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

    const files = await listMemoryNotes(join(memoryRoot, "semantic"), { recursive: true, onSwap: "skip" });

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

    await expect(listMemoryNotes(join(memoryRoot, "semantic"), { onSwap: "throw" })).rejects.toThrow(
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

    expect(await listMemoryNotes(link, { recursive: true, onSwap: "skip" })).toEqual([]);
    expect(await listMemoryNotes(link, { recursive: true, onSwap: "throw" })).toEqual([]);
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

    const files = await listMemoryNotes(join(root, "dir"), { onSwap: "skip" });
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
