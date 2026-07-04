import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createPaths } from "./paths";
import { isEnoent } from "./fs-utils";
import { runBoundedConcurrent } from "./internal-concurrency";
import { memoryIndexPath } from "./memory-index";
import { somaMemoryEventsPath } from "./memory";
import { parseMemoryNote } from "./memory-note";
import type { SomaMemoryAuditOptions, SomaMemoryAuditProbe, SomaMemoryAuditResult, SomaMemoryNote } from "./types";

/**
 * M7 — a DETERMINISTIC audit of the on-disk memory tree. No LLM, no sentiment: every
 * probe reads the filesystem and reports a ground-truth fact. Read-only — it mutates
 * nothing and appends no event. `healthy` is false (and the CLI exits non-zero) when
 * a probe that GATES health fails: a schema-invalid note, or a stale INDEX. The rest
 * (digest coverage, orphaned archive, event ratio) are informational drift signals.
 *
 * Every §15 design invariant of the memory subsystem maps to a probe here: notes
 * parse (schema), the INDEX reflects the corpus (freshness), episodic prune leaves a
 * digest (coverage), the archive stays consistent with its digests (orphans), and
 * the event stream tracks mutations (ratio).
 */
const SCAN_CONCURRENCY = 16;

/** All `.md` files under `dir`, recursively, REJECTING symlinked dirs/files (they
 *  could point outside the memory root — the audit only trusts real entries). */
async function listRealMarkdownFilesRec(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return []; // a missing dir is genuinely empty
    throw error; // any other failure is a real blind spot — do not treat as empty
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow a symlink out of the tree
    if (entry.isDirectory()) {
      out.push(...(await listRealMarkdownFilesRec(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/** Parse one note file → the note, or `undefined` if it cannot be read/parsed. */
async function parseFile(path: string): Promise<SomaMemoryNote | undefined> {
  return readFile(path, "utf8").then(parseMemoryNote).catch(() => undefined);
}

/** mtime in ms, or `undefined` if the path is absent. */
async function mtimeMs(path: string): Promise<number | undefined> {
  return stat(path).then((s) => s.mtimeMs).catch((error) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
}

export async function auditMemory(options: SomaMemoryAuditOptions = {}): Promise<SomaMemoryAuditResult> {
  const paths = createPaths(options);
  const somaHome = paths.root();
  const probes: SomaMemoryAuditProbe[] = [];

  // --- enumerate every note file in the tree (durable + episodic + archive) ---
  const durableDirs = [paths.resolve("memory", "semantic"), paths.resolve("memory", "procedural")];
  const episodicDirs = [paths.resolve("memory", "episodic", "sessions"), paths.resolve("memory", "episodic", "actions")];
  const archiveDir = paths.resolve("memory", "archive");

  const durableFiles = (await Promise.all(durableDirs.map(listRealMarkdownFilesRec))).flat();
  const [sessionFiles, actionFiles] = await Promise.all(episodicDirs.map(listRealMarkdownFilesRec));
  const archiveFiles = await listRealMarkdownFilesRec(archiveDir);
  const allFiles = [...durableFiles, ...sessionFiles, ...actionFiles, ...archiveFiles];

  const parsed = await runBoundedConcurrent(
    allFiles,
    async (path) => ({ path, note: await parseFile(path) }),
    SCAN_CONCURRENCY,
  );

  // --- probe: schema validity (GATES health) ---
  const invalidNotes = parsed.filter((p) => p.note === undefined).map((p) => relative(somaHome, p.path)).sort();
  const notesByType = { semantic: 0, procedural: 0, episodic: 0 };
  for (const { note } of parsed) {
    if (note && note.type in notesByType) notesByType[note.type] += 1;
  }
  probes.push({
    name: "schema",
    ok: invalidNotes.length === 0,
    detail:
      invalidNotes.length === 0
        ? `${allFiles.length} note file(s) parse (semantic ${notesByType.semantic}, procedural ${notesByType.procedural}, episodic ${notesByType.episodic})`
        : `${invalidNotes.length} schema-invalid note file(s): ${invalidNotes.join(", ")}`,
  });

  // --- probe: INDEX freshness (GATES health) ---
  const indexPath = memoryIndexPath(somaHome);
  const indexMtime = await mtimeMs(indexPath);
  // The INDEX is built from the DURABLE corpus only (M3), so freshness is measured
  // against durable-note mtimes — an episodic write does not stale the INDEX.
  const durableMtimes = await Promise.all(durableFiles.map(mtimeMs));
  const newestDurable = durableMtimes.reduce<number>((max, m) => (m !== undefined && m > max ? m : max), 0);
  let indexStale: boolean;
  let indexReason: string;
  if (durableFiles.length === 0) {
    indexStale = false;
    indexReason = "no durable notes — nothing to index";
  } else if (indexMtime === undefined) {
    indexStale = true;
    indexReason = `INDEX.md is absent but ${durableFiles.length} durable note(s) exist — run 'soma memory reindex'`;
  } else if (newestDurable > indexMtime) {
    indexStale = true;
    indexReason = "a durable note is newer than INDEX.md — run 'soma memory reindex'";
  } else {
    indexStale = false;
    indexReason = "INDEX.md is at least as new as every durable note";
  }
  probes.push({ name: "index-freshness", ok: !indexStale, detail: indexReason });

  // --- probe: digest coverage (informational) ---
  const digestFilesList = await listRealMarkdownFilesRec(paths.resolve("memory", "episodic", "digests"));
  const digests = { sessionNotes: sessionFiles.length, actionNotes: actionFiles.length, digestFiles: digestFilesList.length };
  probes.push({
    name: "digest-coverage",
    ok: true,
    detail: `${digests.sessionNotes} session + ${digests.actionNotes} action note(s), ${digests.digestFiles} monthly digest file(s)`,
  });

  // --- probe: orphaned archive (informational) ---
  // An archived episodic note whose id is not referenced in its created-month digest
  // signals digest/archive drift (a lost or un-regenerated digest pointer).
  const digestIds = await collectDigestIds(digestFilesList);
  const orphanedArchive: string[] = [];
  for (const { path, note } of parsed) {
    if (note === undefined) continue;
    if (!path.startsWith(archiveDir)) continue;
    if (note.type !== "episodic") continue;
    if (!digestIds.has(note.id)) orphanedArchive.push(relative(somaHome, path));
  }
  orphanedArchive.sort();
  probes.push({
    name: "orphaned-archive",
    ok: true, // informational: a re-consolidation regenerates digests
    detail:
      orphanedArchive.length === 0
        ? "every archived episodic note is referenced by a monthly digest"
        : `${orphanedArchive.length} archived note(s) missing from a digest (run 'soma memory consolidate')`,
  });

  // --- probe: event/note ratio (informational) ---
  const eventLines = await countEventLines(somaMemoryEventsPath(somaHome));
  const validNotes = parsed.length - invalidNotes.length;
  const events = { lines: eventLines, notes: validNotes };
  probes.push({ name: "event-ratio", ok: true, detail: `${eventLines} event line(s) over ${validNotes} valid note(s)` });

  const healthy = invalidNotes.length === 0 && !indexStale;
  return {
    somaHome,
    healthy,
    notesByType,
    invalidNotes,
    index: { path: indexPath, stale: indexStale, reason: indexReason },
    digests,
    orphanedArchive,
    events,
    probes,
  };
}

/** Ids referenced by any monthly digest — each digest line is `- <id>: <text>`. */
async function collectDigestIds(digestFiles: string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  const contents = await runBoundedConcurrent(
    digestFiles,
    (path) => readFile(path, "utf8").catch(() => ""),
    SCAN_CONCURRENCY,
  );
  for (const content of contents) {
    for (const line of content.split("\n")) {
      const match = /^-\s+([^:\s]+):/.exec(line.trim());
      if (match) ids.add(match[1]);
    }
  }
  return ids;
}

/** Non-empty JSONL lines in the events file (0 if absent). */
async function countEventLines(eventsPath: string): Promise<number> {
  const content = await readFile(eventsPath, "utf8").catch((error) => {
    if (isEnoent(error)) return "";
    throw error;
  });
  return content.trim() === "" ? 0 : content.trim().split("\n").length;
}
