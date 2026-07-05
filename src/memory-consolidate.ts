import { mkdir, readdir, readFile, rename, lstat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { createPaths } from "./paths";
import { isEnoent } from "./fs-utils";
import { listMemoryNotes } from "./memory-fs";
import { appendSomaMemoryEvent } from "./memory";
import { parseMemoryNote, serializeMemoryNote, MemoryNoteError, NOTE_ID_PATTERN, NOTE_ID_MAX_LEN } from "./memory-note";
import { renderDigestPointer } from "./episodic-digest";
import { collectDurableNotes } from "./memory-write";
import { runBoundedConcurrent } from "./internal-concurrency";
import { memoryTermSet } from "./memory-terms";
import { jaccard, ageDays, NEAR_DUPLICATE_JACCARD_THRESHOLD } from "./memory-corpus";
import { rebuildMemoryIndex, memoryIndexPath } from "./memory-index";
import type {
  SomaMemoryConsolidateOptions,
  SomaMemoryConsolidateResult,
  SomaMemoryArchivePlan,
  SomaMemorySimilarPair,
  SomaMemoryNote,
  SomaPaths,
} from "./types";

/**
 * Deterministic consolidation (subsystem M6). A no-LLM maintenance pass. Every op
 * is computed into an immutable PLAN first (`planConsolidation`), so a `--dry-run`
 * reports the SAME set of file operations (which notes archive, which are marked
 * stale, which state files are deleted, which pairs are lexically similar) that a
 * real run applies — the dry-run plan equals the real run's plan. (It does NOT
 * reproduce byte-level digest/INDEX content; it enumerates the operations, not
 * their diffs.) A real run separately applies that plan (`applyConsolidationPlan`)
 * and returns what ACTUALLY happened as its own delta — the same `plan()` /
 * `apply(plan)` split `runMemoryBackfill` uses (M8), never one mutable result
 * object patched across the dry-run boundary. Ops, in apply order:
 *
 * 1. **Prune aged episodic** — session notes older than 90d and action notes older
 *    than 180d (by `created`) are folded into a monthly digest (`episodic/digests/
 *    YYYY-MM.md`, a deterministic pointer list) and MOVED to `archive/`, mirroring
 *    the source's FULL relative path. The move OUT of the active episodic tree is
 *    itself the invalidation (recall/index no longer see it); the raw note is
 *    relocated, never deleted, and no `valid_until` field is stamped (that marker
 *    belongs to the semantic/procedural supersede path, not episodic archival).
 * 2. **Mark stale** — active semantic notes unverified >180d AND never resurfaced
 *    get frontmatter `review: stale`. NEVER auto-archived — the principal reviews.
 * 3. **List similar pairs** — active durable notes with high LEXICAL similarity
 *    (Jaccard ≥ 0.6) are surfaced for principal review as near-duplicates (which a
 *    reviewer may find to be duplicates OR contradictions) — the overlap is lexical,
 *    NOT a semantic check, and nothing is auto-merged (the write path already
 *    refuses near-duplicates).
 * 4. **GC state** — ONLY under the explicit `--gc-state` override (default: off),
 *    `current-work-*.json` files older than 7d are DELETED. This is the pass's only
 *    destructive mutation of protected state, and its only file deletion — notes
 *    (also in the Memory compartment) are archived, never deleted.
 * 5. **Rebuild INDEX** to reflect the archived/stale changes.
 *
 * A real run that mutated anything appends one governed `memory.consolidate` event
 * to the journal (the consolidation counterpart of M1's one-mutation-one-event); a
 * no-op run writes none and skips the INDEX rebuild.
 * Idempotent on MUTATIONS: a second run finds the aged notes already archived, the
 * stale notes already marked, the old state already gone → no archive/stale/GC ops
 * and an unchanged INDEX. (The similar-pairs list is a read-only REPORT, not a
 * mutation, so it recurs every run — it does not make the run non-idempotent.)
 */

const EPISODIC_SESSION_TTL_DAYS = 90;
const EPISODIC_ACTION_TTL_DAYS = 180;
const SEMANTIC_STALE_DAYS = 180;
const STATE_GC_DAYS = 7;
// Cap on the similar-pair report (highest-scored kept) — a duplicated corpus could
// otherwise surface n(n-1)/2 pairs.
const MAX_SIMILAR_PAIRS = 50;

// Used directly against raw file mtimes (state GC) — not an ISO-date age, so it
// stays local rather than routing through the shared `ageDays` (#410).
const MS_PER_DAY = 86_400_000;

/** A real `YYYY-MM-DD` CALENDAR date (the M0 parser already enforces this; this is a
 *  defensive re-check before age/month math). Round-trips through UTC so impossible
 *  dates like `2026-02-31` are rejected — shape alone would let `Date.UTC` normalize
 *  them into a valid-looking but wrong day. */
function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === s;
}

/** True iff `path` is a real (non-symlink) entry of the wanted kind. */
async function isRealEntry(path: string, kind: "dir" | "file"): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined); // lstat: does NOT follow a symlink
  if (info === undefined || info.isSymbolicLink()) return false;
  return kind === "dir" ? info.isDirectory() : info.isFile();
}

/**
 * `*.md` note files in a STRICT two-level `<base>/<month>/` tree: enumerate the
 * real (non-symlink) month dirs directly under `base`, then list the `.md`
 * files directly inside each via the shared `listMemoryNotes` seam (#408) —
 * NON-recursive, so consolidation never descends BELOW a month dir (an episodic
 * note lives at `<base>/<month>/<note>.md`, never deeper; a nested file is not
 * an episodic note and must not be parsed/moved). SYMLINKS are skipped at every
 * level (a symlinked month dir or note file could point outside the memory
 * root, so consolidation would otherwise parse/move foreign files across the
 * trust boundary). `[]` if `base` is absent, a symlink, or not a directory.
 */
async function listEpisodicNotes(base: string): Promise<string[]> {
  if (!(await isRealEntry(base, "dir"))) return []; // absent, a symlink, or not a dir
  const files: string[] = [];
  for (const month of (await readdir(base)).sort()) {
    const monthDir = join(base, month);
    if (!(await isRealEntry(monthDir, "dir"))) continue; // skip symlinked/non-dir month
    files.push(...(await listMemoryNotes(monthDir, { onSymlink: "skip" }))); // direct .md files only
  }
  return files;
}

/** Read + parse notes with bounded concurrency; each result pairs its path with the
 *  parsed note or `undefined` when unreadable/unparseable (surfaced, never dropped). */
function parseNotesBounded(paths: string[]): Promise<{ path: string; note: SomaMemoryNote | undefined }[]> {
  return runBoundedConcurrent(
    paths,
    async (path) => ({ path, note: await readFile(path, "utf8").then(parseMemoryNote).catch(() => undefined) }),
    16,
  );
}

/**
 * Archive target that MIRRORS the source's path relative to the memory root, under
 * `memory/archive/` (`memory/episodic/…/x.md` → `memory/archive/episodic/…/x.md`),
 * so the tombstone preserves the original location AND stays under the single
 * lowercase `memory/` root (architecture.md) rather than creating a second root.
 * `paths.archive` asserts the result stays inside the Soma root — combined with the
 * id-slug validation upstream, no crafted frontmatter can redirect a rename out.
 */
function archiveTargetFor(paths: SomaPaths, sourcePath: string): string {
  const relSegments = relative(paths.memory(), sourcePath).split(sep);
  return paths.archive(...relSegments);
}

interface EpisodicArchive {
  plan: SomaMemoryArchivePlan;
  from: string;
  to: string;
  note: SomaMemoryNote;
  digestPath: string;
}

/**
 * Assert every EXISTING ancestor directory of `target` under the memory root is a
 * real directory — not a symlink that could redirect a governed write/move outside
 * the root. A not-yet-existing ancestor is fine; `mkdir` creates real dirs. Used for
 * BOTH the archive move and the digest write (any consolidation destination).
 */
async function assertRealParentChain(memoryRoot: string, target: string, verified?: Set<string>): Promise<void> {
  let cur = memoryRoot;
  for (const seg of relative(memoryRoot, dirname(target)).split(sep)) {
    cur = join(cur, seg);
    if (verified?.has(cur)) continue; // an ancestor already proven real this run — skip the re-lstat
    const info = await lstat(cur).catch(() => undefined);
    if (info === undefined) break; // this and deeper segments don't exist yet
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new MemoryNoteError(`consolidation destination parent "${cur}" is a symlink or non-directory — refusing to write outside the memory root.`, "id");
    }
    verified?.add(cur); // most archive targets share the sessions/actions ancestors
  }
}

/**
 * Archive destination safety: real parent chain (escape guard) AND the target file
 * does not already exist in ANY form (no-clobber — a lone `isRealEntry` check would
 * miss a symlinked tombstone).
 */
async function assertSafeArchiveDest(memoryRoot: string, target: string, verified?: Set<string>): Promise<void> {
  await assertRealParentChain(memoryRoot, target, verified);
  if ((await lstat(target).catch(() => undefined)) !== undefined) {
    throw new MemoryNoteError(`archive target already exists: ${target} — refusing to overwrite the tombstone.`, "id");
  }
}

/** Plan the episodic prune → digest → archive for one kind, oldest first. */
async function planEpisodicArchive(
  paths: SomaPaths,
  kind: "sessions" | "actions",
  ttlDays: number,
  now: Date,
): Promise<{ archives: EpisodicArchive[]; unreadable: string[] }> {
  const root = paths.root();
  const base = paths.episodic(kind);
  const parsedFiles = await parseNotesBounded(await listEpisodicNotes(base));
  const archives: EpisodicArchive[] = [];
  const unreadable: string[] = [];
  for (const { path, note: parsed } of parsedFiles) {
    if (parsed === undefined) {
      unreadable.push(relative(root, path)); // surfaced, not silently dropped
      continue;
    }
    if (!NOTE_ID_PATTERN.test(parsed.id) || parsed.id.length > NOTE_ID_MAX_LEN) {
      // Defense in depth: an id that isn't a plain slug could form a traversal path.
      throw new MemoryNoteError(`episodic note ${path} has an unsafe id "${parsed.id}".`, "id");
    }
    if (!isIsoDate(parsed.created)) {
      unreadable.push(relative(root, path)); // malformed date → classify, never NaN-age it
      continue;
    }
    if (ageDays(parsed.created, now) <= ttlDays) continue;
    const month = parsed.created.slice(0, 7);
    // The note MUST live in its created-month dir — the archive mirrors the source
    // path, and the digest is regenerated by scanning the created-month archive dir,
    // so a mis-placed note (dir month ≠ created month) would archive somewhere the
    // digest scan never looks. Refuse to move it; surface it for the audit instead.
    if (basename(dirname(path)) !== month) {
      unreadable.push(relative(root, path));
      continue;
    }
    const to = archiveTargetFor(paths, path);
    archives.push({
      plan: { from: relative(root, path), to: relative(root, to), reason: `${kind} note older than ${ttlDays}d` },
      from: path,
      to,
      note: parsed,
      digestPath: paths.episodic("digests", `${month}.md`),
    });
  }
  return { archives, unreadable };
}

/** Plan the `review: stale` marks for aged-unverified semantic notes. */
async function planStaleMarks(
  notes: { path: string; note: SomaMemoryNote }[],
  root: string,
  now: Date,
): Promise<{ path: string; rel: string; note: SomaMemoryNote }[]> {
  const out: { path: string; rel: string; note: SomaMemoryNote }[] = [];
  for (const { path, note } of notes) {
    if (note.type !== "semantic") continue;
    if (note.valid_until !== null) continue; // superseded already
    if (note.review === "stale") continue; // already marked
    if (note.resurface_count !== 0) continue; // used → not stale
    if (!isIsoDate(note.last_verified)) continue; // malformed date → don't NaN-age; leave for the audit
    if (ageDays(note.last_verified, now) <= SEMANTIC_STALE_DAYS) continue;
    // The stale mark REWRITES the file, so never write through a symlink — a
    // symlinked memory/semantic/*.md could point outside Soma. lstat + require a
    // real regular file before planning the mutation.
    if (!(await isRealEntry(path, "file"))) continue;
    out.push({ path, rel: relative(root, path), note });
  }
  return out;
}

/**
 * Plan lexically-similar (near-duplicate) pairs among ACTIVE durable notes (listing
 * only — no semantic contradiction check). A token→notes
 * inverted index prefilters candidates so only pairs that SHARE at least one term
 * are Jaccard-scored — pairs with zero overlap (score 0) can never clear the
 * threshold, so skipping them changes nothing but avoids the full O(n²) product.
 */
function planSimilarPairs(notes: { note: SomaMemoryNote }[]): SomaMemorySimilarPair[] {
  const active = notes.map((n) => n.note).filter((note) => note.valid_until === null);
  const tokens = active.map((note) => memoryTermSet(note.body.toLowerCase()));

  const postings = new Map<string, number[]>();
  for (let i = 0; i < active.length; i += 1) {
    for (const token of tokens[i]) {
      const list = postings.get(token);
      if (list) list.push(i);
      else postings.set(token, [i]);
    }
  }

  const compare = (l: SomaMemorySimilarPair, r: SomaMemorySimilarPair) =>
    r.score - l.score || l.a.localeCompare(r.a) || l.b.localeCompare(r.b);
  // Bounded collection that still yields the exact deterministic top-N. The working
  // array is sorted-and-truncated to the cap whenever it grows to 4×, so memory stays
  // O(cap), not O(n²). This CANNOT drop a true top-N pair: a pair is only removed by a
  // truncation, which happens right after a sort — so a pair is dropped only if ≥cap
  // OTHER real pairs currently outrank it, which means it was never in the true
  // top-N. Every surviving pair meets the final sort, so the result is the true top-N.
  const pairs: SomaMemorySimilarPair[] = [];
  const flushAt = MAX_SIMILAR_PAIRS * 4;
  for (let i = 0; i < active.length; i += 1) {
    const candidates = new Set<number>(); // keyed by j, only j > i → each pair once
    for (const token of tokens[i]) {
      for (const j of postings.get(token)!) if (j > i) candidates.add(j);
    }
    for (const j of candidates) {
      const score = jaccard(tokens[i], tokens[j]);
      if (score >= NEAR_DUPLICATE_JACCARD_THRESHOLD) {
        const [a, b] = [active[i].id, active[j].id].sort();
        pairs.push({ a, b, score });
        if (pairs.length >= flushAt) {
          pairs.sort(compare);
          pairs.length = MAX_SIMILAR_PAIRS;
        }
      }
    }
  }
  pairs.sort(compare);
  return pairs.slice(0, MAX_SIMILAR_PAIRS);
}

/** Plan the state GC: `current-work-*.json` files older than 7d. */
async function planStateGc(paths: SomaPaths, now: Date): Promise<string[]> {
  const stateDir = paths.state();
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const out: string[] = [];
  for (const entry of entries.sort()) {
    if (!/^current-work-.*\.json$/.test(entry)) continue;
    const full = join(stateDir, entry);
    // lstat (not stat): a symlinked current-work file must NOT be followed or
    // deleted — only a real, regular state file is a GC candidate.
    const info = await lstat(full).catch(() => undefined);
    if (info === undefined || info.isSymbolicLink() || !info.isFile()) continue;
    if ((now.getTime() - info.mtimeMs) / MS_PER_DAY > STATE_GC_DAYS) {
      out.push(relative(paths.root(), full));
    }
  }
  return out;
}

/**
 * Regenerate the monthly digest files for `months`, deterministically from the
 * ARCHIVE. The digest is a pure function of the archived notes for that created-
 * month (header + id-sorted pointer lines), so it is idempotent AND recoverable: a
 * digest pointer lost to a crash between an archive move and a digest write is
 * restored on the next run, because the archived note (the durable record) is
 * re-scanned. Notes still live in their raw archived form regardless.
 */
async function regenerateMonthlyDigests(paths: SomaPaths, months: Set<string>): Promise<string[]> {
  const omitted: string[] = []; // unreadable archived notes, RETURNED (core stays IO-channel-free)
  for (const month of [...months].sort()) {
    // Episodic notes are stored under their created month (`YYYY-MM/`), and the
    // archive mirrors that, so only the affected month's archive dirs need reading —
    // NOT the whole growing archive.
    const monthFiles = [
      ...(await listArchivedMonthNotes(paths, "sessions", month)),
      ...(await listArchivedMonthNotes(paths, "actions", month)),
    ];
    const parsed = await parseNotesBounded(monthFiles);
    // An unparseable ARCHIVED note is a corrupt durable record — return it (the
    // caller surfaces it in the result) so the digest is not silently regenerated as
    // an incomplete recovery artifact. It is not thrown, so one corrupt tombstone
    // can't block maintenance of the rest (the M7 audit, forthcoming, is ground truth).
    for (const entry of parsed) {
      if (entry.note === undefined) omitted.push(relative(paths.root(), entry.path));
    }
    const notes = parsed
      .map((entry) => entry.note)
      .filter((n): n is SomaMemoryNote => n !== undefined && n.created.slice(0, 7) === month)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (notes.length === 0) continue;
    const digestPath = paths.episodic("digests", `${month}.md`);
    const body = notes.map(renderDigestPointer).join("\n");
    // The digests-dir parent chain was preflighted in the plan phase (before any
    // move), so no symlinked-parent refusal can strike here after notes have moved.
    await mkdir(dirname(digestPath), { recursive: true });
    await writeFile(digestPath, `# Episodic digest ${month}\n\n${body}\n`, "utf8");
  }
  return omitted;
}

/** Real `.md` files directly under one archived-episodic `<kind>/<month>/` dir. */
function listArchivedMonthNotes(paths: SomaPaths, kind: "sessions" | "actions", month: string): Promise<string[]> {
  return listMemoryNotes(paths.archive("episodic", kind, month), { onSymlink: "skip" });
}

/**
 * Apply the episodic prune: MOVE each note into the archive, then regenerate the
 * affected monthly digests from the archive. Move-then-regenerate is crash-tolerant
 * — the archived raw note is the durable record, and the digest is a recoverable,
 * idempotent derivation of it (never the source of truth).
 */
async function applyEpisodicArchive(paths: SomaPaths, episodic: EpisodicArchive[]): Promise<string[]> {
  const months = new Set<string>();
  // Destinations were all preflighted in the plan phase, so no per-note REFUSAL
  // (unsafe/colliding target) can abort mid-loop and strand earlier moves. This is
  // not crash-atomic, though: a raw filesystem I/O failure during a later mkdir/rename
  // can still leave the archive partially applied — a re-run reconciles (idempotent).
  for (const e of episodic.slice().sort((a, b) => a.note.id.localeCompare(b.note.id))) {
    await mkdir(dirname(e.to), { recursive: true });
    await rename(e.from, e.to);
    months.add(e.note.created.slice(0, 7));
  }
  return regenerateMonthlyDigests(paths, months); // unreadable archived notes, for the caller to surface
}

/**
 * Apply the `review: stale` marks. Re-lstat immediately before writing (planning
 * lstat'd too, but a TOCTOU swap could turn the path into a symlink), then write via
 * a temp file + `rename` OVER the path: `rename` replaces the entry itself, so even
 * if the target were swapped to a symlink after the re-check, the write lands on a
 * real file in the memory tree, never through the symlink to somewhere outside.
 */
async function applyStaleMarks(marks: { path: string; rel: string; note: SomaMemoryNote }[]): Promise<{ skipped: string[] }> {
  const skipped: string[] = [];
  for (const { path, rel, note } of marks) {
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined || info.isSymbolicLink() || !info.isFile()) {
      skipped.push(rel); // swapped away since planning — NOT marked; caller drops it from the result
      continue;
    }
    // Unique temp path (so concurrent/leftover temps don't collide), cleaned up on
    // any failure so a crash can't strand a `.soma-stale-tmp` that blocks a later run.
    const tmp = `${path}.soma-stale-tmp-${staleTmpSeq++}`;
    try {
      await writeFile(tmp, serializeMemoryNote({ ...note, review: "stale" }), { encoding: "utf8", flag: "wx" });
      await rename(tmp, path); // atomic replace of the real file (not a follow-through write)
    } catch (error) {
      await unlink(tmp).catch(() => undefined); // best-effort cleanup; re-surface the original error
      throw error;
    }
  }
  return { skipped };
}

// Monotonic counter for unique stale-mark temp filenames within a process.
let staleTmpSeq = 0;

/**
 * Apply the state GC — the only deletion. Reported `stateGced` must be TRUE. Returns
 * the paths it actually deleted (a candidate swapped since planning is skipped, so
 * the caller can correct the result). Re-lstat + re-check age immediately before
 * unlink so a same-name replacement (now a symlink, a dir, or a fresh file) is NOT
 * deleted just because an old file sat there at plan time.
 */
async function applyStateGc(root: string, stateGc: string[], now: Date): Promise<string[]> {
  const deleted: string[] = [];
  for (const rel of stateGc) {
    const full = join(root, rel);
    const info = await lstat(full).catch(() => undefined);
    if (info === undefined) continue; // already gone
    if (info.isSymbolicLink() || !info.isFile()) continue; // swapped to symlink/dir — refuse
    if ((now.getTime() - info.mtimeMs) / MS_PER_DAY <= STATE_GC_DAYS) continue; // replaced with a fresh file
    try {
      await unlink(full);
      deleted.push(rel);
    } catch (error) {
      if (!isEnoent(error)) throw error; // a real failure is NOT swallowed (no phantom deletion)
    }
  }
  return deleted;
}

/**
 * The pure-read output of the plan phase: every file operation consolidation
 * WOULD perform, computed once from the tree + `now`. SHALLOW-frozen (the
 * top-level object and every array field, NOT the nested note/archive entries)
 * before it is returned — enough that `applyConsolidationPlan` cannot repoint,
 * grow, or replace the plan's arrays (an accidental structural mutation throws
 * in strict mode); it does not deep-freeze individual note contents. That is
 * the property the plan/apply split needs: the set of ops can't drift between a
 * dry-run's reported plan and a real run's applied result. This
 * is the same `plan()` / `apply(plan)` split `runMemoryBackfill` uses (M8) —
 * a `SomaMemoryConsolidateResult` for a real run is built by COMBINING this
 * plan with the separately-returned `ConsolidationApplied` delta, never by
 * patching one shared mutable object across the dry-run boundary.
 *
 * Exported (with `planConsolidation`/`applyConsolidationPlan`/`ConsolidationApplied`)
 * for the plan-immutability acceptance test — not public index API; `consolidateMemory`
 * remains the only production caller.
 */
export interface ConsolidationPlan {
  somaHome: string;
  indexPath: string;
  episodic: EpisodicArchive[];
  /** Relative digest paths the archive move would (re)write — identical for dry-run and real. */
  digestsWritten: string[];
  staleMarks: { path: string; rel: string; note: SomaMemoryNote }[];
  similarPairs: SomaMemorySimilarPair[];
  /** `current-work-*.json` relative paths planned for deletion (empty unless `--gc-state`). */
  stateGc: string[];
  /** Files surfaced as unscanned/unsafe at PLAN time (episodic + durable-corpus blind spots). */
  unreadable: string[];
  /** Whether this plan, if applied verbatim (no TOCTOU race), would mutate anything. */
  mutated: boolean;
}

/**
 * The delta a real run actually produced applying a `ConsolidationPlan` —
 * separate from the plan, never folded back into it. Differs from the plan
 * only under a TOCTOU race (a planned candidate swapped away before it could
 * be applied): `markedStale`/`stateGced` drop any swapped-away candidate, and
 * `unreadable`/`mutated` are recomputed from what actually happened.
 */
export interface ConsolidationApplied {
  markedStale: string[];
  stateGced: string[];
  unreadable: string[];
  mutated: boolean;
}

/**
 * Plan phase: compute every file operation consolidation would perform,
 * touching nothing on disk. See the module docstring for the ops and
 * ordering. Given the same tree + `now`, this is identical whether or not it
 * is subsequently applied — so a `--dry-run` reports exactly the plan a real
 * run would apply.
 */
export async function planConsolidation(paths: SomaPaths, options: SomaMemoryConsolidateOptions, now: Date): Promise<ConsolidationPlan> {
  const somaHome = paths.root();

  const sessionPlan = await planEpisodicArchive(paths, "sessions", EPISODIC_SESSION_TTL_DAYS, now);
  const actionPlan = await planEpisodicArchive(paths, "actions", EPISODIC_ACTION_TTL_DAYS, now);
  const episodic = [...sessionPlan.archives, ...actionPlan.archives];
  // Preflight the ARCHIVE-MOVE destinations (per-note targets + the shared digests
  // dir) in the plan phase — before ANY note is moved — so an unsafe/colliding
  // archive target never strands earlier moves, and a dry-run refuses exactly what
  // the real run would. The other two mutating paths carry their OWN inline symlink
  // guards at write time instead: stale-mark re-lstats + writes via temp+rename, and
  // state-GC lstat-filters — those are not part of this archive preflight.
  const memoryRoot = paths.memory();
  const verifiedDirs = new Set<string>(); // archive targets share ancestors — verify each real dir once
  for (const e of episodic) await assertSafeArchiveDest(memoryRoot, e.to, verifiedDirs);
  if (episodic.length > 0) {
    await assertRealParentChain(memoryRoot, paths.episodic("digests", "any.md"), verifiedDirs);
  }

  const durable = await collectDurableNotes(somaHome);
  const staleMarks = await planStaleMarks(durable.notes, somaHome, now);
  const similarPairs = planSimilarPairs(durable.notes);
  // State GC deletes protected state, so it only runs under the explicit --gc-state
  // override (CONTEXT.md: protected data needs a deliberate destructive flag).
  const stateGc = options.gcState === true ? await planStateGc(paths, now) : [];
  // Unreadable files (episodic + durable) are surfaced, never silently skipped —
  // otherwise a run could report success while known notes went unchecked.
  const unreadable = [...sessionPlan.unreadable, ...actionPlan.unreadable, ...durable.unreadable].sort();
  const mutated = episodic.length > 0 || staleMarks.length > 0 || stateGc.length > 0;

  const plan: ConsolidationPlan = {
    somaHome,
    indexPath: memoryIndexPath(somaHome),
    episodic,
    digestsWritten: Array.from(new Set(episodic.map((e) => relative(somaHome, e.digestPath)))).sort(),
    staleMarks,
    similarPairs,
    stateGc,
    unreadable,
    mutated,
  };
  Object.freeze(plan.episodic);
  Object.freeze(plan.digestsWritten);
  Object.freeze(plan.staleMarks);
  Object.freeze(plan.similarPairs);
  Object.freeze(plan.stateGc);
  Object.freeze(plan.unreadable);
  return Object.freeze(plan);
}

/**
 * Apply phase: perform every mutation `plan` describes — move aged episodic
 * notes to the archive (regenerating affected digests), mark stale semantic
 * notes, GC old state files — then rebuild the INDEX and append the governed
 * `memory.consolidate` event, but ONLY if something actually changed. Returns
 * the applied delta as a fresh object; `plan` is read, never written.
 *
 * NOT rollback-coupled — consolidation is idempotent and safe to repeat, so a
 * failed event append leaves the already-applied, re-runnable mutations
 * rather than attempting a multi-file rollback (the guarantee is
 * repeatability, not atomicity; see architecture.md). The M1 write/verify
 * rollback (`writeNotesAtomically`, memory-write.ts) is a different,
 * single-mutation path.
 */
export async function applyConsolidationPlan(
  paths: SomaPaths,
  plan: ConsolidationPlan,
  now: Date,
  substrate: SomaMemoryConsolidateOptions["substrate"],
): Promise<ConsolidationApplied> {
  const somaHome = paths.root();

  const archivedOmissions = await applyEpisodicArchive(paths, plan.episodic);
  const { skipped: staleSkipped } = await applyStaleMarks(plan.staleMarks);
  const stateGced = await applyStateGc(somaHome, plan.stateGc, now);

  // A stale mark skipped by a TOCTOU swap was NOT applied — drop it so
  // `markedStale` reflects what actually happened, and surface the swapped path.
  const skippedSet = new Set(staleSkipped);
  const markedStale = plan.staleMarks.map((s) => s.rel).filter((rel) => !skippedSet.has(rel)).sort();
  const unreadable = Array.from(new Set([...plan.unreadable, ...archivedOmissions, ...staleSkipped])).sort();
  // Recompute `mutated` from what ACTUALLY happened (post-skip markedStale + actual
  // deletions), so a run whose planned mutations were all TOCTOU-skipped does NOT
  // rebuild the INDEX or append an event as if it changed something.
  const mutated = plan.episodic.length > 0 || markedStale.length > 0 || stateGced.length > 0;

  // Only rebuild the INDEX when something actually changed — a no-op maintenance
  // run must not do corpus-scale work for an unchanged corpus.
  if (mutated) await rebuildMemoryIndex({ somaHome, now });

  // Governed event: a post-hoc RECORD of the pass (only when it mutated something).
  if (mutated) {
    await appendSomaMemoryEvent(somaHome, {
      timestamp: now.toISOString(),
      substrate: substrate ?? "custom",
      kind: "memory.consolidate",
      summary: `Consolidation: ${plan.episodic.length} archived, ${markedStale.length} marked stale, ${stateGced.length} state GC'd.`,
      artifactPaths: [plan.indexPath],
      metadata: {
        archived: plan.episodic.length,
        markedStale: markedStale.length, // actual, after any TOCTOU skips
        stateGced: stateGced.length, // actual deletions, not the plan
        similarPairs: plan.similarPairs.length,
        unreadableCount: unreadable.length,
        unreadablePaths: unreadable, // the actual files (incl. archived omissions), so the journal identifies them
      },
    });
  }

  return { markedStale, stateGced, unreadable, mutated };
}

/** Combine a plan with its (optional) applied delta into the public result shape. */
function planToResult(plan: ConsolidationPlan, dryRun: boolean, applied?: ConsolidationApplied): SomaMemoryConsolidateResult {
  return {
    somaHome: plan.somaHome,
    dryRun,
    archived: plan.episodic.map((e) => e.plan),
    // Copy the plan-owned (frozen) arrays so the public result stays mutable —
    // dry-run callers previously got fresh mutable arrays and some mutate them.
    digestsWritten: [...plan.digestsWritten],
    markedStale: applied ? applied.markedStale : plan.staleMarks.map((s) => s.rel).sort(),
    stateGced: applied ? applied.stateGced : [...plan.stateGc],
    similarPairs: [...plan.similarPairs],
    unreadable: applied ? applied.unreadable : [...plan.unreadable],
    mutated: applied ? applied.mutated : plan.mutated,
    indexPath: plan.indexPath,
  };
}

/**
 * Run (or plan, under `dryRun`) the deterministic consolidation pass. See the
 * module docstring for the ops and ordering, and `planConsolidation` /
 * `applyConsolidationPlan` for the plan/apply split (mirrors `runMemoryBackfill`,
 * M8 — a pure plan, and a separately-returned applied delta, never one mutable
 * result patched across the dry-run boundary). Given the same tree + `now`, the
 * plan is identical whether or not it is applied — so a dry-run's reported ops
 * match the real run's.
 */
export async function consolidateMemory(options: SomaMemoryConsolidateOptions = {}): Promise<SomaMemoryConsolidateResult> {
  const paths = createPaths(options);
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;

  const plan = await planConsolidation(paths, options, now);
  if (dryRun) return planToResult(plan, true);

  const applied = await applyConsolidationPlan(paths, plan, now, options.substrate);
  return planToResult(plan, false, applied);
}
