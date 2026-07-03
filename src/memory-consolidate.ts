import { mkdir, readdir, readFile, rename, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { createPaths } from "./paths";
import { isEnoent } from "./fs-utils";
import { appendSomaMemoryEvent } from "./memory";
import { parseMemoryNote, serializeMemoryNote, MemoryNoteError } from "./memory-note";
import { collectDurableNotes } from "./memory-write";
import { memoryTermSet } from "./memory-terms";
import { rebuildMemoryIndex, memoryIndexPath } from "./memory-index";
import type {
  SomaMemoryConsolidateOptions,
  SomaMemoryConsolidateResult,
  SomaMemoryArchivePlan,
  SomaMemoryContradiction,
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
 *    the source's FULL relative path (invalidate-never-delete; archive-before-prune).
 * 2. **Mark stale** — active semantic notes unverified >180d AND never resurfaced
 *    get frontmatter `review: stale`. NEVER auto-archived — a human reviews.
 * 3. **List contradictions** — active durable notes with Jaccard ≥ 0.6 are surfaced
 *    for review (no auto-merge — the write path already refuses near-duplicates).
 * 4. **GC state** — `current-work-*.json` files older than 7d are DELETED. This is
 *    the ONE true deletion in the whole memory subsystem (state is not memory).
 * 5. **Rebuild INDEX** to reflect the archived/stale changes.
 *
 * A real run that mutated anything appends one governed `memory.consolidate` event
 * to the journal (the consolidation counterpart of M1's one-mutation-one-event).
 * Idempotent: a second run finds the aged notes already archived, the stale notes
 * already marked, the old state already gone → an empty plan, unchanged INDEX.
 */

const EPISODIC_SESSION_TTL_DAYS = 90;
const EPISODIC_ACTION_TTL_DAYS = 180;
const SEMANTIC_STALE_DAYS = 180;
const STATE_GC_DAYS = 7;
// Same near-duplicate floor as the M1 write-path dedup gate.
const CONTRADICTION_JACCARD = 0.6;

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

/** List `*.md` note files under a two-level `<base>/<month>/` tree; [] if base absent. */
async function listEpisodicNotes(base: string): Promise<string[]> {
  let months: string[];
  try {
    months = await readdir(base);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const month of months.sort()) {
    let entries: string[];
    try {
      entries = await readdir(join(base, month));
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    for (const entry of entries.sort()) {
      if (entry.endsWith(".md")) files.push(join(base, month, entry));
    }
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
 * Archive target that MIRRORS the source's full relative path under `archive/`
 * (`memory/episodic/…/x.md` → `archive/memory/episodic/…/x.md`), so the audit trail
 * truly preserves the original location. `paths.resolve` asserts the result stays
 * inside the Soma root — combined with the id-slug validation upstream, no crafted
 * frontmatter can redirect a rename outside the tree.
 */
function archiveTargetFor(paths: SomaPaths, sourcePath: string): string {
  const relSegments = relative(paths.root(), sourcePath).split(sep);
  return paths.resolve("archive", ...relSegments);
}

interface EpisodicArchive {
  plan: SomaMemoryArchivePlan;
  from: string;
  to: string;
  note: SomaMemoryNote;
  digestPath: string;
}

/** Plan the episodic prune → digest → archive for one kind, oldest first. */
async function planEpisodicArchive(
  paths: SomaPaths,
  kind: "sessions" | "actions",
  ttlDays: number,
  now: Date,
): Promise<EpisodicArchive[]> {
  const root = paths.root();
  const base = paths.resolve("memory", "episodic", kind);
  const files = await listEpisodicNotes(base);
  const out: EpisodicArchive[] = [];
  for (const path of files) {
    const parsed = await readFile(path, "utf8").then(parseMemoryNote).catch(() => undefined);
    if (parsed === undefined) continue; // unreadable/unparseable — leave for the audit
    if (!NOTE_ID_SLUG.test(parsed.id) || parsed.id.length > 64) {
      // Defense in depth: an id that isn't a plain slug could form a traversal path.
      throw new MemoryNoteError(`episodic note ${path} has an unsafe id "${parsed.id}".`, "id");
    }
    if (ageDays(parsed.created, now) <= ttlDays) continue;
    const to = archiveTargetFor(paths, path);
    const month = parsed.created.slice(0, 7);
    out.push({
      plan: { from: relative(root, path), to: relative(root, to), reason: `${kind} note older than ${ttlDays}d` },
      from: path,
      to,
      note: parsed,
      digestPath: paths.resolve("memory", "episodic", "digests", `${month}.md`),
    });
  }
  return out;
}

/** Plan the `review: stale` marks for aged-unverified semantic notes. */
function planStaleMarks(
  notes: { path: string; note: SomaMemoryNote }[],
  root: string,
  now: Date,
): { path: string; rel: string; note: SomaMemoryNote }[] {
  const out: { path: string; rel: string; note: SomaMemoryNote }[] = [];
  for (const { path, note } of notes) {
    if (note.type !== "semantic") continue;
    if (note.valid_until !== null) continue; // superseded already
    if (note.review === "stale") continue; // already marked
    if (note.resurface_count !== 0) continue; // used → not stale
    if (ageDays(note.last_verified, now) <= SEMANTIC_STALE_DAYS) continue;
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
function planContradictions(notes: { note: SomaMemoryNote }[]): SomaMemoryContradiction[] {
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

  const seen = new Set<string>();
  const pairs: SomaMemoryContradiction[] = [];
  for (let i = 0; i < active.length; i += 1) {
    const candidates = new Set<number>();
    for (const token of tokens[i]) {
      for (const j of postings.get(token)!) if (j > i) candidates.add(j);
    }
    for (const j of candidates) {
      const key = `${i}:${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const score = jaccard(tokens[i], tokens[j]);
      if (score >= CONTRADICTION_JACCARD) {
        const [a, b] = [active[i].id, active[j].id].sort();
        pairs.push({ a, b, score });
      }
    }
  }
  pairs.sort((l, r) => r.score - l.score || l.a.localeCompare(r.a) || l.b.localeCompare(r.b));
  return pairs;
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
    const info = await stat(full).catch(() => undefined);
    if (info === undefined) continue;
    if ((now.getTime() - info.mtimeMs) / MS_PER_DAY > STATE_GC_DAYS) {
      out.push(relative(paths.root(), full));
    }
  }
  return out;
}

/** Apply the episodic prune: append monthly-digest pointers, then MOVE the notes. */
async function applyEpisodicArchive(episodic: EpisodicArchive[]): Promise<void> {
  const byDigest = new Map<string, EpisodicArchive[]>();
  for (const e of episodic) {
    const list = byDigest.get(e.digestPath) ?? [];
    list.push(e);
    byDigest.set(e.digestPath, list);
  }
  for (const [digestPath, group] of [...byDigest.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    await mkdir(dirname(digestPath), { recursive: true });
    const header = (await readFile(digestPath, "utf8").catch(() => "")).length === 0
      ? `# Episodic digest ${group[0].note.created.slice(0, 7)}\n\n`
      : "";
    const lines = group
      .slice()
      .sort((a, b) => a.note.id.localeCompare(b.note.id))
      .map((e) => `- ${e.note.id}: ${firstBodyLine(e.note)}`)
      .join("\n");
    await appendFile(digestPath, `${header}${lines}\n`, "utf8");
  }
  for (const e of episodic) {
    await mkdir(dirname(e.to), { recursive: true });
    await rename(e.from, e.to);
  }
}

/** Apply the `review: stale` marks in place. */
async function applyStaleMarks(marks: { path: string; note: SomaMemoryNote }[]): Promise<void> {
  for (const { path, note } of marks) {
    await writeFile(path, serializeMemoryNote({ ...note, review: "stale" }), "utf8");
  }
}

/** Apply the state GC — the one true deletion. */
async function applyStateGc(root: string, stateGc: string[]): Promise<void> {
  for (const rel of stateGc) {
    await unlink(join(root, rel)).catch(() => undefined);
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
  const episodic = [
    ...(await planEpisodicArchive(paths, "sessions", EPISODIC_SESSION_TTL_DAYS, now)),
    ...(await planEpisodicArchive(paths, "actions", EPISODIC_ACTION_TTL_DAYS, now)),
  ];
  const durable = await collectDurableNotes(somaHome);
  const staleMarks = planStaleMarks(durable.notes, somaHome, now);
  const contradictions = planContradictions(durable.notes);
  const stateGc = await planStateGc(paths, now);

  const result: SomaMemoryConsolidateResult = {
    somaHome,
    dryRun,
    archived: episodic.map((e) => e.plan),
    digestsWritten: Array.from(new Set(episodic.map((e) => relative(somaHome, e.digestPath)))).sort(),
    markedStale: staleMarks.map((s) => s.rel).sort(),
    stateGced: stateGc,
    contradictions,
    indexPath: memoryIndexPath(somaHome),
  };
  if (dryRun) return result;

  // --- apply (mutations only on the real run) ---
  await applyEpisodicArchive(episodic);
  await applyStaleMarks(staleMarks);
  await applyStateGc(somaHome, stateGc);
  await rebuildMemoryIndex({ somaHome, now });

  // Governed event for the pass (only when it actually mutated something).
  if (episodic.length > 0 || staleMarks.length > 0 || stateGc.length > 0) {
    await appendSomaMemoryEvent(somaHome, {
      timestamp: now.toISOString(),
      substrate: options.substrate ?? "custom",
      kind: "memory.consolidate",
      summary: `Consolidation: ${episodic.length} archived, ${staleMarks.length} marked stale, ${stateGc.length} state GC'd.`,
      artifactPaths: [result.indexPath],
      metadata: { archived: episodic.length, markedStale: staleMarks.length, stateGced: stateGc.length, contradictions: contradictions.length },
    });
  }

  return result;
}
