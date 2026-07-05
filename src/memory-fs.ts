import { lstat, readdir } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { join } from "node:path";
import { isEnoent } from "./fs-utils";
import { runBoundedConcurrent } from "./internal-concurrency";

/**
 * The one symlink-safe directory walk for the Memory compartment (#408).
 *
 * "Enumerate the note files under a memory subtree without letting a symlink
 * escape the memory root" was re-derived four times — `memory-consolidate.ts`
 * (silent-skip), `memory-audit.ts` (loud-fail on a mid-walk inode swap),
 * `memory-backfill.ts` (throw on any symlink), and `memory-write.ts`
 * (no guard at all) — and had drifted into four disagreeing policies. This
 * module owns the `lstat` / TOCTOU mechanics ONCE; every caller states its
 * own stance through `onSymlink` instead of re-implementing the walk.
 *
 * Three distinct hazards this walk defends against:
 *
 * 1. **A symlinked entry** (a file or directory seen directly from
 *    `readdir`'s dirent type) — this walk NEVER follows it. `onSymlink: "skip"`
 *    (default) silently omits it and continues (consolidate's and the durable
 *    write-scan's stance: a symlinked note is invisible, not an error).
 *    `onSymlink: "throw"` raises a {@link MemoryTraversalError} naming the path
 *    instead (backfill's stance: an untrusted source tree must never import
 *    a symlink's target silently). This flag governs ONLY plain symlinked
 *    entries — the two races below are handled unconditionally.
 * 2. **A directory replaced between the pre- and post-`readdir` `lstat`** — a
 *    TOCTOU race (originally the M7 audit's `AuditTreeError`). This is
 *    ALWAYS a loud failure, regardless of `onSymlink`: a caller that asked
 *    only to "skip plain symlinked entries" never asked to trust a directory
 *    that provably changed identity out from under the read. No production
 *    caller has ever needed this to fail open, and detecting it costs one
 *    extra `lstat` per directory.
 * 3. **A file leaf swapped for a symlink between `readdir` and return** —
 *    `readdir`'s dirent type is a snapshot; an attacker can swap a listed
 *    regular file for a symlink before a caller reads the returned path. Each
 *    file candidate is therefore RE-`lstat`ed right before it is returned and
 *    must still be a real regular file, so this walk never hands back a path
 *    that now resolves through a symlink. (A caller reading with `O_NOFOLLOW`
 *    gets a second, atomic guarantee at read time; this closes the
 *    enumeration-side window for every caller regardless.)
 *
 * A missing, symlinked, or non-directory `dir` (including the ROOT passed
 * in) yields `[]` — every caller's existing stance is that an absent or
 * abnormal root is genuinely empty, not an error; a caller that wants a
 * symlinked ROOT specifically refused (backfill's `--from` precondition)
 * checks that itself before calling in, with its own message.
 */

export type MemorySymlinkPolicy = "skip" | "throw";

export interface ListMemoryNotesEntry {
  /** The entry's own name (not a path). */
  name: string;
  /** 0 for a direct child of the walked `dir`; N for an entry N levels deeper. */
  depth: number;
  isDirectory: boolean;
}

export interface ListMemoryNotesOptions {
  /** Recurse into real (non-symlink) subdirectories. Default: false (direct children of `dir` only). */
  recursive?: boolean;
  /** Policy for a plain symlinked entry found during the walk. See the module doc. Default: "skip". */
  onSymlink?: MemorySymlinkPolicy;
  /**
   * Filename suffixes a FILE must match (case-sensitive, checked with
   * `endsWith`), each including the leading dot. Default: `[".md"]`. Pass
   * `[]` to disable this stage entirely (every file entry passes it) — for a
   * caller (e.g. backfill) that needs case-insensitive or multi-extension
   * matching and does it itself via `include`.
   */
  extensions?: readonly string[];
  /**
   * Caller-side business filtering, evaluated AFTER the symlink check (a
   * symlinked entry never reaches this hook) and BEFORE the extension check.
   * Returning `false` for a directory excludes it AND prevents descending
   * into it (without being treated as a symlink violation); returning
   * `false` for a file excludes it from the result. Default: include
   * everything.
   */
  include?: (entry: ListMemoryNotesEntry) => boolean;
  /**
   * Sort the returned paths (lexicographically, absolute). Default: true —
   * callers rely on deterministic ordering. A caller that re-sorts by its own
   * key afterwards (e.g. backfill sorts its `SourceFile`s by POSIX relative
   * path) can pass `false` to skip this redundant sort.
   */
  sort?: boolean;
  /** Bounded concurrency for recursive fan-out and leaf re-`lstat`ing. Default: 16. */
  concurrency?: number;
}

/**
 * Raised when the walk finds a symlinked entry under `onSymlink: "throw"`, or
 * (regardless of `onSymlink`) when a directory is discovered to have been
 * replaced — a different inode/device, or no longer a real directory —
 * between the pre-read and post-read `lstat` of it.
 */
export class MemoryTraversalError extends Error {}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  return lstat(path).catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
}

/**
 * List file paths under `dir` matching `extensions` (default `.md`), never
 * following a symlink out of the tree. See the module doc for the full
 * `onSymlink` / TOCTOU contract.
 */
export async function listMemoryNotes(dir: string, options: ListMemoryNotesOptions = {}): Promise<string[]> {
  const recursive = options.recursive ?? false;
  const onSymlink: MemorySymlinkPolicy = options.onSymlink ?? "skip";
  const extensions = options.extensions ?? [".md"];
  const concurrency = options.concurrency ?? 16;
  const sort = options.sort ?? true;
  const include = options.include;

  async function walk(current: string, depth: number): Promise<string[]> {
    // lstat: does NOT follow a symlink. A missing/symlinked/non-directory
    // `current` is treated as genuinely empty — abnormal-ROOT refusal (if a
    // caller wants one) is the caller's own precondition, not this walk's.
    const before = await lstatOrUndefined(current);
    if (before === undefined || before.isSymbolicLink() || !before.isDirectory()) return [];

    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return []; // vanished between lstat and readdir — genuinely empty
      throw error; // any other failure is a real blind spot — surface it
    }

    // Close the lstat→readdir TOCTOU: re-lstat and require the SAME real
    // directory (inode+device unchanged, still not a symlink). Unconditional
    // — a provably-swapped directory is never trusted, whichever `onSymlink`
    // the caller chose for plain symlinked entries below.
    const after = await lstatOrUndefined(current);
    if (
      after === undefined ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    ) {
      throw new MemoryTraversalError(`directory ${current} was replaced during the memory walk — refusing to trust the read`);
    }

    const fileCandidates: string[] = [];
    const subdirs: string[] = [];
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        if (onSymlink === "throw") {
          throw new MemoryTraversalError(`refused symlink in the memory tree: ${full}`);
        }
        continue; // skip — never follow a symlink out of the memory root
      }
      if (entry.isDirectory()) {
        if (include && !include({ name: entry.name, depth, isDirectory: true })) continue;
        if (recursive) subdirs.push(full);
        continue;
      }
      if (entry.isFile()) {
        if (include && !include({ name: entry.name, depth, isDirectory: false })) continue;
        if (extensions.length === 0 || extensions.some((ext) => entry.name.endsWith(ext))) fileCandidates.push(full);
      }
      // Neither file, directory, nor symlink (a FIFO/socket/device): silently
      // ignored, matching every caller's existing stance.
    }

    // Leaf TOCTOU (hazard 3): the dirent said "regular file", but that was a
    // snapshot from `readdir`. Re-`lstat` each candidate right before returning
    // it and require it to STILL be a real regular file — a leaf swapped for a
    // symlink after enumeration is dropped here, so no caller is ever handed a
    // path that now resolves through a symlink out of the memory root.
    const verified = await runBoundedConcurrent(
      fileCandidates,
      async (full) => {
        const st = await lstatOrUndefined(full);
        return st !== undefined && !st.isSymbolicLink() && st.isFile() ? full : undefined;
      },
      concurrency,
    );
    const files = verified.filter((f): f is string => f !== undefined);

    if (subdirs.length === 0) return files;
    const nested = await runBoundedConcurrent(subdirs, (d) => walk(d, depth + 1), concurrency);
    return [...files, ...nested.flat()];
  }

  const result = await walk(dir, 0);
  return sort ? result.sort() : result;
}
