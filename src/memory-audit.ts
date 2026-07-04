import { type Dirent, constants as fsConstants } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
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
 * These are DETERMINISTIC SMOKE checks, not invariant ENFORCEMENT: they surface the
 * cheap-to-detect drift each memory milestone can leave behind — an unparseable note
 * (schema), an INDEX older by mtime than the corpus (freshness — NOT a content
 * check), archived notes missing from their month's digest (coverage), and a coarse
 * event/note ratio. A passing audit means no drift was DETECTED, not that every
 * invariant is proven.
 */
const SCAN_CONCURRENCY = 16;

/** Raised when a directory is replaced (swapped for a symlink or another inode)
 *  between the pre- and post-`readdir` lstat — the audit fails LOUDLY rather than
 *  trusting a possibly-redirected read. */
class AuditTreeError extends Error {}

/** All `.md` files under `dir`, recursively, REJECTING symlinked dirs/files (they
 *  could point outside the memory root — the audit only trusts real entries). */
async function listRealMarkdownFilesRec(dir: string): Promise<string[]> {
  // lstat the dir ITSELF before reading it — `readdir` follows a symlinked directory,
  // so a symlinked dir could otherwise redirect the walk outside the memory root and
  // have the audit trust foreign files.
  const before = await lstat(dir).catch((error) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (before === undefined) return []; // a missing dir is genuinely empty
  if (!before.isDirectory()) return []; // a symlink or non-directory — never follow it
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return []; // vanished between lstat and readdir
    throw error; // any other failure is a real blind spot — do not treat as empty
  }
  // Close the lstat→readdir TOCTOU: re-lstat and require the SAME real directory
  // (inode+device unchanged, still not a symlink). A mid-read swap → fail loudly.
  const after = await lstat(dir).catch(() => undefined);
  if (after === undefined || after.isSymbolicLink() || !after.isDirectory() || after.ino !== before.ino || after.dev !== before.dev) {
    throw new AuditTreeError(`directory ${dir} was replaced during the audit walk — refusing to trust the read`);
  }
  const files: string[] = [];
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow a symlink out of the tree
    const full = join(dir, entry.name);
    if (entry.isDirectory()) subdirs.push(full);
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  // Walk sibling subtrees concurrently but BOUNDED — a wide archive (many
  // month/project dirs) neither serializes nor spikes fds on an unbounded fan-out.
  const nested = await runBoundedConcurrent(subdirs, listRealMarkdownFilesRec, SCAN_CONCURRENCY);
  return [...files, ...nested.flat()];
}

// Read WITHOUT following a final-component symlink — closes the TOCTOU where a listed
// regular file is swapped for a symlink between enumeration and read. O_NOFOLLOW makes
// the open fail (ELOOP) on a symlink, so a swapped file reads as unreadable, never
// through the link to an outside target.
const NOFOLLOW_READ = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

/** Parse one note file → the note, or `undefined` if it cannot be read/parsed (incl.
 *  a symlink swapped in after enumeration, which O_NOFOLLOW rejects). */
async function parseFile(path: string): Promise<SomaMemoryNote | undefined> {
  return readFile(path, { encoding: "utf8", flag: NOFOLLOW_READ }).then(parseMemoryNote).catch(() => undefined);
}

/** mtime in ms, or `undefined` if the path is absent. Uses `lstat` — a path swapped to
 *  a symlink after enumeration is measured as the link itself, never followed. */
async function mtimeMs(path: string): Promise<number | undefined> {
  return lstat(path).then((s) => s.mtimeMs).catch((error) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
}

/** lstat-based classification of INDEX.md — the audit trusts only a REAL file, so a
 *  symlinked INDEX (which could point at a newer file to spoof freshness) is rejected. */
async function classifyIndex(path: string): Promise<{ kind: "absent" | "symlink" | "irregular" | "file"; mtimeMs: number }> {
  const info = await lstat(path).catch((error) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (info === undefined) return { kind: "absent", mtimeMs: 0 };
  if (info.isSymbolicLink()) return { kind: "symlink", mtimeMs: 0 };
  if (!info.isFile()) return { kind: "irregular", mtimeMs: 0 };
  return { kind: "file", mtimeMs: info.mtimeMs };
}

export async function auditMemory(options: SomaMemoryAuditOptions = {}): Promise<SomaMemoryAuditResult> {
  const paths = createPaths(options);
  const somaHome = paths.root();
  const probes: SomaMemoryAuditProbe[] = [];

  // --- enumerate every note file in the tree (durable + episodic + archive) ---
  const durableDirs = [paths.resolve("memory", "semantic"), paths.resolve("memory", "procedural")];
  const episodicDirs = [paths.resolve("memory", "episodic", "sessions"), paths.resolve("memory", "episodic", "actions")];
  const archiveDir = paths.resolve("memory", "archive");

  // Root integrity GATES health FIRST: a present-but-abnormal root (a symlink or
  // non-directory where a real note dir belongs) makes the corpus inaccessible/
  // untrusted — the walk skips it, so without this the tree would fail OPEN as
  // "empty and healthy". A missing root is genuinely empty and fine.
  const rootDirs = [...durableDirs, ...episodicDirs, archiveDir, paths.resolve("memory", "episodic", "digests")];
  const treeIntegrity = await probeTreeIntegrity(rootDirs, somaHome);

  const durableFiles = (await Promise.all(durableDirs.map(listRealMarkdownFilesRec))).flat();
  const [sessionFiles, actionFiles] = await Promise.all(episodicDirs.map(listRealMarkdownFilesRec));
  const archiveFiles = await listRealMarkdownFilesRec(archiveDir);
  const allFiles = [...durableFiles, ...sessionFiles, ...actionFiles, ...archiveFiles];

  const parsed = await runBoundedConcurrent(
    allFiles,
    async (path) => ({ path, note: await parseFile(path) }),
    SCAN_CONCURRENCY,
  );

  const schema = probeSchema(parsed, allFiles.length, somaHome);
  const index = await probeIndexFreshness(somaHome, durableFiles);
  const digestFilesList = await listRealMarkdownFilesRec(paths.resolve("memory", "episodic", "digests"));
  const digestCov = probeDigestCoverage(sessionFiles.length, actionFiles.length, digestFilesList.length);
  const archive = await probeOrphanedArchive(parsed, archiveDir, digestFilesList, somaHome);
  const eventLines = await countEventLines(somaMemoryEventsPath(somaHome));
  const validNotes = parsed.length - schema.invalidNotes.length;
  const eventProbe = probeEventRatio(eventLines, validNotes);

  probes.push(treeIntegrity.probe, schema.probe, index.probe, digestCov.probe, archive.probe, eventProbe.probe);

  // Single source of truth: healthy iff every HEALTH-GATING probe is ok. The
  // informational probes carry gatesHealth:false and never affect this.
  const healthy = probes.every((p) => !p.gatesHealth || p.ok);
  return {
    somaHome,
    healthy,
    notesByType: schema.notesByType,
    invalidNotes: schema.invalidNotes,
    index: { path: index.path, stale: !index.probe.ok, reason: index.probe.detail },
    digests: digestCov.digests,
    orphanedArchive: archive.orphanedArchive,
    events: eventProbe.events,
    probes,
  };
}

/**
 * Probe: every expected note ROOT dir is either absent (empty, fine) or a REAL
 * directory (GATES health). A root that exists but is a symlink or non-directory is
 * abnormal — the walk skips it, so without this gate the corpus would fail OPEN as
 * "empty and healthy" while durable notes are actually inaccessible/redirected.
 */
async function probeTreeIntegrity(rootDirs: string[], somaHome: string): Promise<{ probe: SomaMemoryAuditProbe }> {
  const abnormal: string[] = [];
  for (const dir of rootDirs) {
    const info = await lstat(dir).catch((error) => {
      if (isEnoent(error)) return undefined;
      throw error;
    });
    if (info === undefined) continue; // absent → genuinely empty
    if (info.isSymbolicLink() || !info.isDirectory()) abnormal.push(relative(somaHome, dir));
  }
  abnormal.sort();
  return {
    probe: {
      name: "root-integrity",
      gatesHealth: true,
      ok: abnormal.length === 0,
      detail:
        abnormal.length === 0
          ? "every note root is absent or a real directory"
          : `${abnormal.length} note root(s) replaced by a symlink/non-directory: ${abnormal.join(", ")}`,
    },
  };
}

/** Probe: every note file parses against the schema (GATES health). */
function probeSchema(
  parsed: { path: string; note: SomaMemoryNote | undefined }[],
  fileCount: number,
  somaHome: string,
): { probe: SomaMemoryAuditProbe; invalidNotes: string[]; notesByType: { semantic: number; procedural: number; episodic: number } } {
  const invalidNotes = parsed.filter((p) => p.note === undefined).map((p) => relative(somaHome, p.path)).sort();
  const notesByType = { semantic: 0, procedural: 0, episodic: 0 };
  for (const { note } of parsed) if (note && note.type in notesByType) notesByType[note.type] += 1;
  return {
    invalidNotes,
    notesByType,
    probe: {
      name: "schema",
      gatesHealth: true,
      ok: invalidNotes.length === 0,
      detail:
        invalidNotes.length === 0
          ? `${fileCount} note file(s) parse (semantic ${notesByType.semantic}, procedural ${notesByType.procedural}, episodic ${notesByType.episodic})`
          : `${invalidNotes.length} schema-invalid note file(s): ${invalidNotes.join(", ")}`,
    },
  };
}

/**
 * Probe: INDEX.md is at least as new as every DURABLE note (GATES health). This is a
 * FRESHNESS smoke check via mtime only — it does NOT read or validate INDEX contents,
 * so a stale INDEX that was merely touched would still pass. `soma memory reindex`
 * is the fix for a real staleness.
 */
async function probeIndexFreshness(
  somaHome: string,
  durableFiles: string[],
): Promise<{ probe: SomaMemoryAuditProbe; path: string }> {
  const path = memoryIndexPath(somaHome);
  const index = await classifyIndex(path);
  // Bounded stats (not one-per-note unbounded), and every listed durable note MUST
  // stat — a note that vanished/could-not-be-statted mid-audit means we can't confirm
  // freshness against the full corpus, so the probe fails rather than passing blind.
  const durableMtimes = await runBoundedConcurrent(durableFiles, mtimeMs, SCAN_CONCURRENCY);
  const unstattable = durableFiles.filter((_, i) => durableMtimes[i] === undefined).length;
  const newestDurable = durableMtimes.reduce<number>((max, m) => (m !== undefined && m > max ? m : max), 0);
  let ok: boolean;
  let detail: string;
  if (index.kind === "symlink" || index.kind === "irregular") {
    // A non-regular INDEX can spoof mtime freshness — reject regardless of note count.
    ok = false;
    detail = `INDEX.md is a ${index.kind === "symlink" ? "symlink" : "non-regular file"} — refusing to trust it; run 'soma memory reindex' on a clean tree`;
  } else if (unstattable > 0) {
    ok = false;
    detail = `${unstattable} durable note(s) could not be statted (changed under the audit) — re-run the audit`;
  } else if (durableFiles.length === 0) {
    ok = true;
    detail = "no durable notes — nothing to index";
  } else if (index.kind === "absent") {
    ok = false;
    detail = `INDEX.md is absent but ${durableFiles.length} durable note(s) exist — run 'soma memory reindex'`;
  } else if (newestDurable > index.mtimeMs) {
    ok = false;
    detail = "a durable note is newer than INDEX.md (mtime check only, not contents) — run 'soma memory reindex'";
  } else {
    ok = true;
    detail = "INDEX.md is at least as new as every durable note (mtime freshness only)";
  }
  return { path, probe: { name: "index-freshness", gatesHealth: true, ok, detail } };
}

/** Probe: episodic coverage counts (informational). */
function probeDigestCoverage(
  sessionNotes: number,
  actionNotes: number,
  digestFiles: number,
): { probe: SomaMemoryAuditProbe; digests: { sessionNotes: number; actionNotes: number; digestFiles: number } } {
  const digests = { sessionNotes, actionNotes, digestFiles };
  return {
    digests,
    probe: {
      name: "digest-coverage",
      gatesHealth: false,
      ok: true,
      detail: `${sessionNotes} session + ${actionNotes} action note(s), ${digestFiles} monthly digest file(s)`,
    },
  };
}

/**
 * Probe: every archived episodic note is referenced by ITS created-month digest
 * (informational). A reference in a DIFFERENT month is drift, not coverage — the
 * check is scoped per month, not against all digests globally.
 */
async function probeOrphanedArchive(
  parsed: { path: string; note: SomaMemoryNote | undefined }[],
  archiveDir: string,
  digestFilesList: string[],
  somaHome: string,
): Promise<{ probe: SomaMemoryAuditProbe; orphanedArchive: string[] }> {
  // Archived episodic notes and the months they need a digest for — computed FIRST so
  // only the digests for those months are read (an empty archive reads no digest).
  const archived: { relFromSoma: string; id: string; month: string }[] = [];
  const neededMonths = new Set<string>();
  for (const { path, note } of parsed) {
    if (note === undefined || note.type !== "episodic") continue;
    // Path-segment containment (not a raw string prefix): `path` is under the archive
    // iff its relative path neither escapes (`..`) nor is absolute.
    const rel = relative(archiveDir, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    const month = note.created.slice(0, 7);
    archived.push({ relFromSoma: relative(somaHome, path), id: note.id, month });
    neededMonths.add(month);
  }
  const relevantDigests = digestFilesList.filter((p) => neededMonths.has(basename(p).replace(/\.md$/, "")));
  const digestIdsByMonth = await collectDigestIdsByMonth(relevantDigests);
  const orphanedArchive: string[] = [];
  for (const a of archived) {
    if (!digestIdsByMonth.get(a.month)?.has(a.id)) orphanedArchive.push(a.relFromSoma);
  }
  orphanedArchive.sort();
  return {
    orphanedArchive,
    probe: {
      name: "orphaned-archive",
      gatesHealth: false,
      ok: true, // informational: a re-consolidation regenerates the month's digest
      detail:
        orphanedArchive.length === 0
          ? "every archived episodic note is referenced by its created-month digest"
          : `${orphanedArchive.length} archived note(s) missing from their created-month digest (run 'soma memory consolidate')`,
    },
  };
}

/** Probe: event-stream lines over valid-note count (informational). */
function probeEventRatio(lines: number, notes: number): { probe: SomaMemoryAuditProbe; events: { lines: number; notes: number } } {
  return { events: { lines, notes }, probe: { name: "event-ratio", gatesHealth: false, ok: true, detail: `${lines} event line(s) over ${notes} valid note(s)` } };
}

/**
 * Digest-referenced ids keyed by MONTH (the digest's `YYYY-MM.md` basename). Keyed
 * by month so the orphan check can require a note to appear in ITS created-month
 * digest — a reference in the wrong month is drift, not coverage. Each digest line
 * is `- <id>: <text>`.
 */
async function collectDigestIdsByMonth(digestFiles: string[]): Promise<Map<string, Set<string>>> {
  const byMonth = new Map<string, Set<string>>();
  const parsedFiles = await runBoundedConcurrent(
    digestFiles,
    // NOFOLLOW like every other audit read — a digest swapped to a symlink is not
    // followed (reads empty), so it can't spoof archive coverage from an outside file.
    async (path) => ({ month: basename(path).replace(/\.md$/, ""), content: await readFile(path, { encoding: "utf8", flag: NOFOLLOW_READ }).catch(() => "") }),
    SCAN_CONCURRENCY,
  );
  for (const { month, content } of parsedFiles) {
    const ids = byMonth.get(month) ?? new Set<string>();
    for (const line of content.split("\n")) {
      const match = /^-\s+([^:\s]+):/.exec(line.trim());
      if (match) ids.add(match[1]);
    }
    byMonth.set(month, ids);
  }
  return byMonth;
}

/** Non-empty JSONL lines in the events file (0 if absent). Single pass over the
 *  content counting non-empty lines — no `split` allocation of the whole history.
 *  Read with O_NOFOLLOW (same as notes), so a symlinked events file — even one
 *  swapped in racily — makes the open fail and counts as 0; the audit follows NO
 *  symlink, atomically, with no lstat/read TOCTOU gap. */
async function countEventLines(eventsPath: string): Promise<number> {
  const content = await readFile(eventsPath, { encoding: "utf8", flag: NOFOLLOW_READ }).catch(() => "");
  let count = 0;
  let lineHasContent = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === "\n") {
      if (lineHasContent) count += 1;
      lineHasContent = false;
    } else if (ch !== "\r" && ch !== " " && ch !== "\t") {
      lineHasContent = true;
    }
  }
  if (lineHasContent) count += 1; // a final line with no trailing newline
  return count;
}
