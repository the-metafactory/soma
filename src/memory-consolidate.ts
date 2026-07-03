import { mkdir, readdir, readFile, rename, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createPaths } from "./paths";
import { isEnoent } from "./fs-utils";
import { parseMemoryNote, serializeMemoryNote } from "./memory-note";
import { collectDurableNotes } from "./memory-write";
import { memoryTermSet } from "./memory-terms";
import { rebuildMemoryIndex, memoryIndexPath } from "./memory-index";
import type {
  SomaMemoryConsolidateOptions,
  SomaMemoryConsolidateResult,
  SomaMemoryArchivePlan,
  SomaMemoryContradiction,
  SomaMemoryNote,
} from "./types";

/**
 * Deterministic consolidation (subsystem M6). A no-LLM maintenance pass. Every op
 * is computed into a PLAN first, so a `--dry-run` prints exactly what the real run
 * will do (dry-run output == real-run diff), and the real run simply applies that
 * plan. Ops, in apply order:
 *
 * 1. **Prune aged episodic** — session notes older than 90d and action notes older
 *    than 180d (by `created`) are folded into a monthly digest (`episodic/digests/
 *    YYYY-MM.md`, a deterministic pointer list) and MOVED to `archive/`, preserving
 *    their relative path (invalidate-never-delete; archive-before-prune).
 * 2. **Mark stale** — active semantic notes unverified >180d AND never resurfaced
 *    get frontmatter `review: stale`. NEVER auto-archived — a human reviews.
 * 3. **List contradictions** — active durable notes with Jaccard ≥ 0.6 are surfaced
 *    for review (no auto-merge — the write path already refuses near-duplicates).
 * 4. **GC state** — `current-work-*.json` files older than 7d are DELETED. This is
 *    the ONE true deletion in the whole memory subsystem (state is not memory).
 * 5. **Rebuild INDEX** — reflect the archived/stale changes.
 *
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

/** First non-empty body line, trimmed — the monthly-digest pointer text. */
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

interface EpisodicArchive {
  plan: SomaMemoryArchivePlan;
  note: SomaMemoryNote;
  /** Monthly digest file this note folds into (by its `created` month). */
  digestPath: string;
}

/** Plan the episodic prune → digest → archive for one kind, oldest first. */
async function planEpisodicArchive(
  somaHome: string,
  kind: "sessions" | "actions",
  ttlDays: number,
  now: Date,
): Promise<EpisodicArchive[]> {
  const paths = createPaths(somaHome);
  const root = paths.root();
  const base = paths.resolve("memory", "episodic", kind);
  const files = await listEpisodicNotes(base);
  const out: EpisodicArchive[] = [];
  for (const path of files) {
    const parsed = await readFile(path, "utf8").then(parseMemoryNote).catch(() => undefined);
    if (parsed === undefined) continue; // unreadable/unparseable — leave it for the audit
    if (ageDays(parsed.created, now) <= ttlDays) continue;
    const month = parsed.created.slice(0, 7);
    const to = paths.resolve("archive", "episodic", kind, month, `${parsed.id}.md`);
    out.push({
      plan: {
        from: relative(root, path),
        to: relative(root, to),
        reason: `${kind} note older than ${ttlDays}d`,
      },
      note: parsed,
      digestPath: paths.resolve("memory", "episodic", "digests", `${month}.md`),
    });
  }
  return out;
}

/** Plan the `review: stale` marks for aged-unverified semantic notes. */
function planStaleMarks(notes: { path: string; note: SomaMemoryNote }[], root: string, now: Date): { path: string; rel: string; note: SomaMemoryNote }[] {
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

/** Plan contradiction pairs among ACTIVE durable notes (listing only). */
function planContradictions(notes: { note: SomaMemoryNote }[]): SomaMemoryContradiction[] {
  const active = notes.map((n) => n.note).filter((note) => note.valid_until === null);
  const tokens = active.map((note) => memoryTermSet(note.body.toLowerCase()));
  const pairs: SomaMemoryContradiction[] = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
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
async function planStateGc(somaHome: string, now: Date): Promise<string[]> {
  const paths = createPaths(somaHome);
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

/**
 * Run (or plan, under `dryRun`) the deterministic consolidation pass. See the
 * module docstring for the ops and ordering. Given the same tree + `now`, the plan
 * is identical whether or not it is applied — so a dry-run's reported ops match the
 * real run's diff.
 */
export async function consolidateMemory(options: SomaMemoryConsolidateOptions = {}): Promise<SomaMemoryConsolidateResult> {
  const somaHome = createPaths(options).root();
  const root = createPaths(options).root();
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;

  // --- plan (pure reads) ---
  const episodic = [
    ...(await planEpisodicArchive(somaHome, "sessions", EPISODIC_SESSION_TTL_DAYS, now)),
    ...(await planEpisodicArchive(somaHome, "actions", EPISODIC_ACTION_TTL_DAYS, now)),
  ];
  const durable = await collectDurableNotes(somaHome);
  const staleMarks = planStaleMarks(durable.notes, root, now);
  const contradictions = planContradictions(durable.notes);
  const stateGc = await planStateGc(somaHome, now);

  const archived = episodic.map((e) => e.plan);
  const digestsWritten = Array.from(new Set(episodic.map((e) => relative(root, e.digestPath)))).sort();
  const markedStale = staleMarks.map((s) => s.rel).sort();
  const indexPath = memoryIndexPath(somaHome);

  const result: SomaMemoryConsolidateResult = {
    somaHome,
    dryRun,
    archived,
    digestsWritten,
    markedStale,
    stateGced: stateGc,
    contradictions,
    indexPath,
  };
  if (dryRun) return result;

  // --- apply (mutations only on the real run) ---
  // 1. Prune episodic: append the monthly-digest pointer, then move the raw note.
  //    Group by digest file for deterministic append order.
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
    const from = join(root, e.plan.from);
    const to = join(root, e.plan.to);
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  }

  // 2. Mark stale: rewrite frontmatter with review: stale.
  for (const { path, note } of staleMarks) {
    await writeFile(path, serializeMemoryNote({ ...note, review: "stale" }), "utf8");
  }

  // 3. State GC — the one true deletion.
  for (const rel of stateGc) {
    await unlink(join(root, rel)).catch(() => undefined);
  }

  // 4. Rebuild INDEX to reflect archived/stale changes.
  await rebuildMemoryIndex({ somaHome, now });

  return result;
}
