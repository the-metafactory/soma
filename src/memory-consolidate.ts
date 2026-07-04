import { mkdir, readdir, readFile, rename, lstat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { createPaths } from "./paths";
import { isEnoent } from "./fs-utils";
import { appendSomaMemoryEvent } from "./memory";
import { parseMemoryNote, serializeMemoryNote, MemoryNoteError } from "./memory-note";
import { collectDurableNotes } from "./memory-write";
import { runBoundedConcurrent } from "./internal-concurrency";
import { memoryTermSet } from "./memory-terms";
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
 * is computed into a PLAN first, so a `--dry-run` reports the SAME set of file
 * operations (which notes archive, which are marked stale, which state files are
 * deleted, which pairs contradict) that the real run applies — the dry-run plan
 * equals the real run's plan. (It does NOT reproduce byte-level digest/INDEX
 * content; it enumerates the operations, not their diffs.) Ops, in apply order:
 *
 * 1. **Prune aged episodic** — session notes older than 90d and action notes older
 *    than 180d (by `created`) are folded into a monthly digest (`episodic/digests/
 *    YYYY-MM.md`, a deterministic pointer list) and MOVED to `archive/`, mirroring
 *    the source's FULL relative path. The move OUT of the active episodic tree is
 *    itself the invalidation (recall/index no longer see it); the raw note is
 *    relocated, never deleted, and no `valid_until` field is stamped (that marker
 *    belongs to the semantic/procedural supersede path, not episodic archival).
 * 2. **Mark stale** — active semantic notes unverified >180d AND never resurfaced
 *    get frontmatter `review: stale`. NEVER auto-archived — a human reviews.
 * 3. **List similar pairs** — active durable notes with high LEXICAL similarity
 *    (Jaccard ≥ 0.6) are surfaced for human review as CANDIDATE duplicates/
 *    contradictions — the overlap is lexical, not a proven semantic contradiction,
 *    and nothing is auto-merged (the write path already refuses near-duplicates).
 * 4. **GC state** — ONLY under the explicit `--gc-state` override (default: off),
 *    `current-work-*.json` files older than 7d are DELETED. This is the only file
 *    DELETION this pass performs (state is not memory; notes are only archived).
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
// Same near-duplicate floor as the M1 write-path dedup gate.
const CONTRADICTION_JACCARD = 0.6;
// Cap on the similar-pair report (highest-scored kept) — a duplicated corpus could
// otherwise surface n(n-1)/2 pairs.
const MAX_SIMILAR_PAIRS = 50;

const MS_PER_DAY = 86_400_000;
const NOTE_ID_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function dateMs(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days between a `YYYY-MM-DD` date and `now` (negative if the date is future). */
function ageDays(isoDate: string, now: Date): number {
  return Math.floor((now.getTime() - dateMs(isoDate)) / MS_PER_DAY);
}

/** True iff `path` is a real (non-symlink) entry of the wanted kind. */
async function isRealEntry(path: string, kind: "dir" | "file"): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined); // lstat: does NOT follow a symlink
  if (info === undefined || info.isSymbolicLink()) return false;
  return kind === "dir" ? info.isDirectory() : info.isFile();
}

/** Real (non-symlink) `.md` files directly in `dir`; [] if `dir` is absent/symlink/not-a-dir. */
async function listRealMarkdownFiles(dir: string): Promise<string[]> {
  if (!(await isRealEntry(dir, "dir"))) return [];
  const out: string[] = [];
  for (const entry of (await readdir(dir)).sort()) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    if (await isRealEntry(filePath, "file")) out.push(filePath); // skip symlinked notes
  }
  return out;
}

/**
 * List `*.md` note files under a two-level `<base>/<month>/` tree; [] if base absent.
 * SYMLINKS are rejected at every level (a symlinked month dir or note file could
 * point outside the memory root, so consolidation would parse/move foreign files
 * across the trust boundary). Only real directories and real files are followed.
 */
async function listEpisodicNotes(base: string): Promise<string[]> {
  if (!(await isRealEntry(base, "dir"))) return []; // absent, a symlink, or not a dir
  const files: string[] = [];
  for (const month of (await readdir(base)).sort()) {
    if (!(await isRealEntry(join(base, month), "dir"))) continue; // skip symlinked/non-dir month
    files.push(...(await listRealMarkdownFiles(join(base, month))));
  }
  return files;
}

/** First non-empty body line, control-stripped + truncated — the digest pointer text. */
function firstBodyLine(note: SomaMemoryNote): string {
  const line = note.body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").slice(0, 120);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Archive target that MIRRORS the source's path relative to the memory root, under
 * `memory/archive/` (`memory/episodic/…/x.md` → `memory/archive/episodic/…/x.md`),
 * so the tombstone preserves the original location AND stays under the single
 * lowercase `memory/` root (architecture.md) rather than creating a second root.
 * `paths.resolve` asserts the result stays inside the Soma root — combined with the
 * id-slug validation upstream, no crafted frontmatter can redirect a rename out.
 */
function archiveTargetFor(paths: SomaPaths, sourcePath: string): string {
  const relSegments = relative(paths.memory(), sourcePath).split(sep);
  return paths.resolve("memory", "archive", ...relSegments);
}

interface EpisodicArchive {
  plan: SomaMemoryArchivePlan;
  from: string;
  to: string;
  note: SomaMemoryNote;
  digestPath: string;
}

/**
 * Assert the archive destination is safe to `rename` into: every EXISTING ancestor
 * directory under the memory root is a real directory (not a symlink that could
 * redirect the move outside the root), and the target file itself does not already
 * exist in ANY form (no-clobber — a lone `isRealEntry` check would miss a symlinked
 * tombstone). A not-yet-existing ancestor is fine; `mkdir` will create real dirs.
 */
async function assertSafeArchiveDest(memoryRoot: string, target: string): Promise<void> {
  let cur = memoryRoot;
  for (const seg of relative(memoryRoot, dirname(target)).split(sep)) {
    cur = join(cur, seg);
    const info = await lstat(cur).catch(() => undefined);
    if (info === undefined) break; // this and deeper segments don't exist yet — mkdir makes real dirs
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new MemoryNoteError(`archive destination parent "${cur}" is a symlink or non-directory — refusing to move outside the memory root.`, "id");
    }
  }
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
  const base = paths.resolve("memory", "episodic", kind);
  const files = await listEpisodicNotes(base);
  // Reads are independent and only feed the plan — do them with bounded parallelism
  // (same helper the durable-corpus scan uses) rather than serially.
  const parsedFiles = await runBoundedConcurrent(
    files,
    async (path): Promise<{ path: string; note: SomaMemoryNote | undefined }> => ({
      path,
      note: await readFile(path, "utf8").then(parseMemoryNote).catch(() => undefined),
    }),
    16,
  );
  const archives: EpisodicArchive[] = [];
  const unreadable: string[] = [];
  for (const entry of parsedFiles) {
    if (entry === undefined) continue;
    const { path, note: parsed } = entry;
    if (parsed === undefined) {
      unreadable.push(relative(root, path)); // surfaced, not silently dropped
      continue;
    }
    if (!NOTE_ID_SLUG.test(parsed.id) || parsed.id.length > 64) {
      // Defense in depth: an id that isn't a plain slug could form a traversal path.
      throw new MemoryNoteError(`episodic note ${path} has an unsafe id "${parsed.id}".`, "id");
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
      digestPath: paths.resolve("memory", "episodic", "digests", `${month}.md`),
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
 * Plan contradiction pairs among ACTIVE durable notes (listing only). A token→notes
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

  const pairs: SomaMemorySimilarPair[] = [];
  for (let i = 0; i < active.length; i += 1) {
    // candidates is a Set keyed by j, and only j > i is added, so every (i, j)
    // pair is visited at most once — no extra dedup needed.
    const candidates = new Set<number>();
    for (const token of tokens[i]) {
      for (const j of postings.get(token)!) if (j > i) candidates.add(j);
    }
    for (const j of candidates) {
      const score = jaccard(tokens[i], tokens[j]);
      if (score >= CONTRADICTION_JACCARD) {
        const [a, b] = [active[i].id, active[j].id].sort();
        pairs.push({ a, b, score });
      }
    }
  }
  pairs.sort((l, r) => r.score - l.score || l.a.localeCompare(r.a) || l.b.localeCompare(r.b));
  // Cap the report: a heavily-duplicated corpus could otherwise produce n(n-1)/2
  // pairs. The highest-similarity pairs are what a reviewer acts on first; the tail
  // is bounded away rather than allocated/rendered in full.
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
async function regenerateMonthlyDigests(paths: SomaPaths, months: Set<string>): Promise<void> {
  for (const month of [...months].sort()) {
    // Episodic notes are stored under their created month (`YYYY-MM/`), and the
    // archive mirrors that, so only the affected month's archive dirs need reading —
    // NOT the whole growing archive.
    const monthFiles = [
      ...(await listArchivedMonthNotes(paths, "sessions", month)),
      ...(await listArchivedMonthNotes(paths, "actions", month)),
    ];
    const parsed = await runBoundedConcurrent(
      monthFiles,
      (path) => readFile(path, "utf8").then(parseMemoryNote).catch(() => undefined),
      16,
    );
    const notes = parsed
      .filter((n): n is SomaMemoryNote => n !== undefined && n.created.slice(0, 7) === month)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (notes.length === 0) continue;
    const digestPath = paths.resolve("memory", "episodic", "digests", `${month}.md`);
    const body = notes.map((n) => `- ${n.id}: ${firstBodyLine(n)}`).join("\n");
    await mkdir(dirname(digestPath), { recursive: true });
    await writeFile(digestPath, `# Episodic digest ${month}\n\n${body}\n`, "utf8");
  }
}

/** Real `.md` files directly under one archived-episodic `<kind>/<month>/` dir. */
function listArchivedMonthNotes(paths: SomaPaths, kind: "sessions" | "actions", month: string): Promise<string[]> {
  return listRealMarkdownFiles(paths.resolve("memory", "archive", "episodic", kind, month));
}

/**
 * Apply the episodic prune: MOVE each note into the archive, then regenerate the
 * affected monthly digests from the archive. Move-then-regenerate is crash-tolerant
 * — the archived raw note is the durable record, and the digest is a recoverable,
 * idempotent derivation of it (never the source of truth).
 */
async function applyEpisodicArchive(paths: SomaPaths, episodic: EpisodicArchive[]): Promise<void> {
  const months = new Set<string>();
  // Destinations were all preflighted in the plan phase (both dry-run and real),
  // so no per-note refusal can leave an earlier note already moved.
  for (const e of episodic.slice().sort((a, b) => a.note.id.localeCompare(b.note.id))) {
    await mkdir(dirname(e.to), { recursive: true });
    await rename(e.from, e.to);
    months.add(e.note.created.slice(0, 7));
  }
  await regenerateMonthlyDigests(paths, months);
}

/** Apply the `review: stale` marks in place. */
async function applyStaleMarks(marks: { path: string; note: SomaMemoryNote }[]): Promise<void> {
  for (const { path, note } of marks) {
    await writeFile(path, serializeMemoryNote({ ...note, review: "stale" }), "utf8");
  }
}

/** Apply the state GC — the only deletion. Reported `stateGced` must be TRUE. */
async function applyStateGc(root: string, stateGc: string[]): Promise<void> {
  for (const rel of stateGc) {
    try {
      await unlink(join(root, rel));
    } catch (error) {
      // ENOENT = already gone (fine). Any other failure means the file is NOT
      // deleted — do NOT swallow it, or the pass would report/record a deletion
      // that did not happen.
      if (!isEnoent(error)) throw error;
    }
  }
}

/**
 * Run (or plan, under `dryRun`) the deterministic consolidation pass. See the
 * module docstring for the ops and ordering. Given the same tree + `now`, the plan
 * is identical whether or not it is applied — so a dry-run's reported ops match the
 * real run's.
 */
export async function consolidateMemory(options: SomaMemoryConsolidateOptions = {}): Promise<SomaMemoryConsolidateResult> {
  const paths = createPaths(options);
  const somaHome = paths.root();
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;

  // --- plan (pure reads) ---
  const sessionPlan = await planEpisodicArchive(paths, "sessions", EPISODIC_SESSION_TTL_DAYS, now);
  const actionPlan = await planEpisodicArchive(paths, "actions", EPISODIC_ACTION_TTL_DAYS, now);
  const episodic = [...sessionPlan.archives, ...actionPlan.archives];
  // Preflight EVERY archive destination now (in the plan phase, so a dry-run refuses
  // exactly what the real run would) — before any note is moved, so an unsafe or
  // colliding target can never leave a partially-applied consolidation.
  const memoryRoot = paths.memory();
  for (const e of episodic) await assertSafeArchiveDest(memoryRoot, e.to);

  const durable = await collectDurableNotes(somaHome);
  const staleMarks = await planStaleMarks(durable.notes, somaHome, now);
  const similarPairs = planSimilarPairs(durable.notes);
  // State GC deletes protected state, so it only runs under the explicit --gc-state
  // override (CONTEXT.md: protected data needs a deliberate destructive flag).
  const stateGc = options.gcState === true ? await planStateGc(paths, now) : [];
  // Unreadable files (episodic + durable) are surfaced, never silently skipped —
  // otherwise a run could report success while known notes went unchecked.
  const unreadable = [...sessionPlan.unreadable, ...actionPlan.unreadable, ...durable.unreadable].sort();

  const result: SomaMemoryConsolidateResult = {
    somaHome,
    dryRun,
    archived: episodic.map((e) => e.plan),
    digestsWritten: Array.from(new Set(episodic.map((e) => relative(somaHome, e.digestPath)))).sort(),
    markedStale: staleMarks.map((s) => s.rel).sort(),
    stateGced: stateGc,
    similarPairs,
    unreadable,
    indexPath: memoryIndexPath(somaHome),
  };
  if (dryRun) return result;

  // --- apply (mutations only on the real run) ---
  const mutated = episodic.length > 0 || staleMarks.length > 0 || stateGc.length > 0;
  await applyEpisodicArchive(paths, episodic);
  await applyStaleMarks(staleMarks);
  await applyStateGc(somaHome, stateGc);
  // Only rebuild the INDEX when something actually changed — a no-op maintenance
  // run must not do corpus-scale work for an unchanged corpus.
  if (mutated) await rebuildMemoryIndex({ somaHome, now });

  // Governed event: a post-hoc RECORD of the pass (only when it mutated something).
  // NOT rollback-coupled — consolidation is idempotent and safe to repeat, so a
  // failed append leaves the already-applied, re-runnable mutations rather than
  // attempting a multi-file rollback (the guarantee is repeatability, not atomicity;
  // see architecture.md). The M1 write|verify rollback is a different, single-note path.
  if (mutated) {
    await appendSomaMemoryEvent(somaHome, {
      timestamp: now.toISOString(),
      substrate: options.substrate ?? "custom",
      kind: "memory.consolidate",
      summary: `Consolidation: ${episodic.length} archived, ${staleMarks.length} marked stale, ${stateGc.length} state GC'd.`,
      artifactPaths: [result.indexPath],
      metadata: { archived: episodic.length, markedStale: staleMarks.length, stateGced: stateGc.length, similarPairs: similarPairs.length, unreadable: unreadable.length },
    });
  }

  return result;
}
