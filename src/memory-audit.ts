import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { basename, dirname, isAbsolute, relative } from "node:path";
import { parseDigestPointerIds } from "./episodic-digest";
import { createPaths } from "./paths";
import { isEnoent } from "./fs-utils";
import { listMemoryNotes } from "./memory-fs";
import { runBoundedConcurrent } from "./internal-concurrency";
import { memoryIndexPath } from "./memory-index";
import { somaMemoryEventsPath } from "./memory";
import { parseMemoryNote } from "./memory-note";
import type {
  SomaMemoryAuditOptions,
  SomaMemoryAuditProbe,
  SomaMemoryAuditResult,
  SomaMemoryEvent,
  SomaMemoryNote,
  SomaMemoryRetrievalQuality,
} from "./types";

/**
 * M7 — a DETERMINISTIC audit of the on-disk memory tree. No LLM, no sentiment: each
 * GATING probe reads the filesystem and reports a ground-truth fact. Read-only — it
 * mutates nothing and appends no event. `healthy` is false (and the CLI exits
 * non-zero) when any HEALTH-GATING probe fails: an abnormal note root
 * (root-integrity), a schema-invalid note, or a stale INDEX. The other four (digest
 * coverage, orphaned archive, event ratio, retrieval quality) are informational —
 * they never affect `healthy`.
 *
 * These are DETERMINISTIC SMOKE checks, not invariant ENFORCEMENT: they surface the
 * cheap-to-detect drift each memory milestone can leave behind — a redirected note
 * root (root-integrity), an unparseable note (schema), an INDEX older by mtime than
 * the corpus (freshness — NOT a content check), archived notes missing from their
 * month's digest (orphaned-archive), a coarse event/note ratio, and (#425) a
 * retrieval-quality signal read from the `memory.recall`/`memory.verify`/(#427)
 * `memory.resurface` journal. The retrieval-quality metric is over PARSEABLE journal events only — a malformed
 * JSONL line is skipped and surfaced as a count (`skippedEventLines`), so that one
 * probe is honestly "ground truth over the parseable journal", not the complete
 * journal. A HEALTHY exit means no health-GATING drift was detected — the
 * informational probes may STILL report drift (e.g. orphaned archive) on a
 * healthy tree; read each probe.
 */
const SCAN_CONCURRENCY = 16;

/**
 * All `.md` files under `dir`, recursively, via the shared `listMemoryNotes`
 * seam (#408). `onSymlink: "skip"` — the audit only trusts real entries, so a
 * symlinked dir/file is silently omitted rather than followed (matching this
 * probe's own tests: a symlinked note or note dir is invisible, not flagged).
 * The seam's mid-walk directory-swap TOCTOU detection (a directory replaced —
 * a different inode — between the pre- and post-`readdir` `lstat`) is
 * UNCONDITIONAL regardless of `onSymlink`, so the audit's original loud-fail
 * stance on that specific race (formerly `AuditTreeError`, now the shared
 * `MemoryTraversalError`) is preserved without asking for "throw" here (which
 * would also make a plain symlinked entry fail the whole walk — this probe's
 * contract is to skip those, not abort on them).
 */
function listRealMarkdownFilesRec(dir: string): Promise<string[]> {
  return listMemoryNotes(dir, { recursive: true, onSymlink: "skip" });
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
  const durableDirs = [paths.semantic(), paths.procedural()];
  const episodicDirs = [paths.episodic("sessions"), paths.episodic("actions")];
  const archiveDir = paths.archive();

  // Root integrity GATES health FIRST: a present-but-abnormal root (a symlink or
  // non-directory where a real note dir belongs) makes the corpus inaccessible/
  // untrusted — the walk skips it, so without this the tree would fail OPEN as
  // "empty and healthy". A missing root is genuinely empty and fine.
  const rootDirs = [...durableDirs, ...episodicDirs, archiveDir, paths.episodic("digests")];
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
  // CANONICAL digests only: a real `<YYYY-MM>.md` DIRECTLY under the digests root. A
  // nested or oddly-named file (e.g. `digests/nested/2026-07.md`) must not satisfy
  // month coverage.
  const digestsDir = paths.episodic("digests");
  const digestFilesList = (await listRealMarkdownFilesRec(digestsDir)).filter(
    (p) => dirname(p) === digestsDir && /^\d{4}-\d{2}\.md$/.test(basename(p)),
  );
  const digestCov = probeDigestCoverage(sessionFiles.length, actionFiles.length, digestFilesList.length);
  const archive = await probeOrphanedArchive(parsed, archiveDir, digestFilesList, somaHome);
  // ONE streaming pass over the journal feeds BOTH the event-ratio line count AND the
  // #425 retrieval-quality metric — the file is read once, line by line, and only a
  // bounded window of pending recalls (plus the counters) stays resident, so audit
  // memory does not grow with total historical events.
  const journal = await streamJournalStats(somaMemoryEventsPath(somaHome));
  const validNotes = parsed.length - schema.invalidNotes.length;
  const eventProbe = probeEventRatio(journal.eventLines, validNotes);
  const retrieval = probeRetrievalQuality(journal.retrieval);

  probes.push(treeIntegrity.probe, schema.probe, index.probe, digestCov.probe, archive.probe, eventProbe.probe, retrieval.probe);

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
    retrieval: journal.retrieval,
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
 * check is scoped per month, not against all digests globally. Covers only PARSEABLE
 * episodic notes under `memory/archive/`; a malformed archived file is surfaced by
 * the (health-gating) schema probe instead, not double-counted here.
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

// --- #425 retrieval-quality (informational) -----------------------------------

/**
 * The subsequent-event window the retrieval-quality metric searches, chronologically
 * after a `memory.recall` event, for a `memory.verify` OR (#427) `memory.resurface`
 * of one of its returned ids. No existing audit window applies here (the consolidate TTLs are day-based
 * staleness thresholds for a different concern), so this is a fresh, documented
 * default rather than a reused constant — events, not days, keep the correlation
 * deterministic and independent of clock/timezone handling. The window is counted
 * in PARSEABLE journal events (a malformed line is skipped, does not consume a
 * window slot). Not yet configurable; a future slice may need to tune it once real
 * recall volume exists.
 */
const RECALL_VERIFY_WINDOW_EVENTS = 50;

/** The `noteIds` a `memory.recall` event recorded (its returned note ids — both
 *  term matches and 1-hop link pulls), or `[]` if absent/malformed. */
function recallEventNoteIds(event: SomaMemoryEvent): string[] {
  const raw = event.metadata?.noteIds;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/**
 * #427 — the second event kind that satisfies a pending recall, alongside
 * `memory.verify`: `memory.resurface` (`memory-write.ts`'s `resurfaceMemoryNote`,
 * the low-friction "this recalled note helped" signal). Both record the bumped
 * note id the same way (`metadata.id`) and both assert the recalled note was
 * useful — one by hand-authored re-confirmation, the other by observed usage —
 * so both count toward `verifyFollowsRecallRate`; the metric name stays
 * `verifyFollowsRecallRate` (not renamed) since it is still measuring "did a
 * recall get reinforced", just via either turning force.
 */
const VERIFY_LIKE_EVENT_KINDS = new Set(["memory.verify", "memory.resurface"]);

/** The note id a `memory.verify`/`memory.resurface` event bumped
 *  (`memory-write.ts`'s verify/resurface paths both record it as
 *  `metadata.id`), or `undefined` if the event is neither kind, or the id is
 *  absent/malformed. */
function verifyEventNoteId(event: SomaMemoryEvent): string | undefined {
  if (!VERIFY_LIKE_EVENT_KINDS.has(event.kind)) return undefined;
  const raw = event.metadata?.id;
  return typeof raw === "string" ? raw : undefined;
}

/**
 * The bounded, incremental retrieval-quality accumulator. Only the running counters
 * plus a window of PENDING recalls (each a non-empty recall still inside its
 * lookahead window) are resident — never the whole journal. A pending recall retires
 * as soon as a matching `memory.verify` is seen (counted as followed) OR after
 * `RECALL_VERIFY_WINDOW_EVENTS` subsequent parseable events elapse (unfollowed), so
 * `pending.length ≤ RECALL_VERIFY_WINDOW_EVENTS` at all times.
 */
interface RetrievalAccumulator {
  recallVolume: number;
  emptyRecalls: number;
  recallsWithResults: number;
  verifiedFollows: number;
  pending: { noteIds: Set<string>; remaining: number }[];
}

function newRetrievalAccumulator(): RetrievalAccumulator {
  return { recallVolume: 0, emptyRecalls: 0, recallsWithResults: 0, verifiedFollows: 0, pending: [] };
}

/**
 * Fold one PARSEABLE event into the accumulator, preserving the exact
 * array-based semantics of the prior implementation: the current event is a
 * SUBSEQUENT event for every earlier pending recall (so it decrements each window
 * and may satisfy one via a matching verify OR #427 resurface), and only AFTER
 * that does the event — if it is itself a recall — become pending (a recall
 * never verifies/resurfaces itself).
 */
function foldRetrievalEvent(acc: RetrievalAccumulator, event: SomaMemoryEvent): void {
  if (acc.pending.length > 0) {
    const verifiedId = verifyEventNoteId(event);
    const stillPending: RetrievalAccumulator["pending"][number][] = [];
    for (const p of acc.pending) {
      p.remaining -= 1;
      if (verifiedId !== undefined && p.noteIds.has(verifiedId)) {
        acc.verifiedFollows += 1; // satisfied → retire, counted as followed
      } else if (p.remaining > 0) {
        stillPending.push(p); // window not yet exhausted → keep watching
      }
      // else: window exhausted unsatisfied → retire, uncounted
    }
    acc.pending = stillPending;
  }

  if (event.kind === "memory.recall") {
    acc.recallVolume += 1;
    const noteIds = recallEventNoteIds(event);
    if (noteIds.length === 0) {
      acc.emptyRecalls += 1;
    } else {
      acc.recallsWithResults += 1;
      acc.pending.push({ noteIds: new Set(noteIds), remaining: RECALL_VERIFY_WINDOW_EVENTS });
    }
  }
}

function finalizeRetrieval(acc: RetrievalAccumulator, skippedEventLines: number): SomaMemoryRetrievalQuality {
  return {
    recallVolume: acc.recallVolume,
    emptyRecallRate: acc.recallVolume === 0 ? 0 : acc.emptyRecalls / acc.recallVolume,
    verifyFollowsRecallRate: acc.recallsWithResults === 0 ? 0 : acc.verifiedFollows / acc.recallsWithResults,
    recallsWithResults: acc.recallsWithResults,
    verifyWindowEvents: RECALL_VERIFY_WINDOW_EVENTS,
    skippedEventLines,
  };
}

/**
 * ONE streaming pass over the JSONL journal — read line by line via an
 * O_NOFOLLOW-opened FileHandle (a symlinked events file fails the open with ELOOP
 * and is treated as an empty journal, same forgiving stance as the rest of the
 * audit), so audit memory stays O(window + counters), not O(journal). Feeds BOTH:
 * `eventLines` (non-empty lines — the coarse event-ratio count, malformed lines
 * INCLUDED, matching the old byte-scan) and the incremental retrieval accumulator
 * (PARSEABLE events only; a malformed line is skipped and counted). A malformed
 * line is a non-empty line that is not JSON, or lacks a string `kind`/`timestamp`.
 */
async function streamJournalStats(eventsPath: string): Promise<{ eventLines: number; retrieval: SomaMemoryRetrievalQuality }> {
  let eventLines = 0;
  let skippedEventLines = 0;
  const acc = newRetrievalAccumulator();

  const handle = await open(eventsPath, NOFOLLOW_READ).catch(() => undefined);
  if (handle === undefined) {
    // absent, symlinked (ELOOP), or otherwise unopenable → empty journal
    return { eventLines: 0, retrieval: finalizeRetrieval(acc, 0) };
  }
  try {
    const lines = createInterface({ input: handle.createReadStream({ encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      eventLines += 1; // event-ratio counts every non-empty line, parseable or not
      let event: SomaMemoryEvent | undefined;
      try {
        const parsed = JSON.parse(line) as Partial<SomaMemoryEvent>;
        if (typeof parsed.kind === "string" && typeof parsed.timestamp === "string") {
          event = parsed as SomaMemoryEvent;
        }
      } catch {
        // fall through to the malformed count below
      }
      if (event === undefined) {
        skippedEventLines += 1;
        continue; // malformed → does not consume a retrieval window slot
      }
      foldRetrievalEvent(acc, event);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  return { eventLines, retrieval: finalizeRetrieval(acc, skippedEventLines) };
}

/**
 * Probe: the #425 retrieval-quality signal, computed PURELY from the journal (no
 * new state) — informational, never gates `healthy`. Three AUTOMEM-inspired
 * numbers over `memory.recall` events: recall volume, empty-recall rate (0
 * returned ids), and verify-follows-recall rate (a returned id gets a
 * `memory.verify` OR (#427) `memory.resurface` within `RECALL_VERIFY_WINDOW_EVENTS`
 * subsequent parseable journal events — the "recalled → actually useful" proxy,
 * satisfied either by a hand-authored re-confirmation or the cheaper observed-use
 * signal). The verify-follow denominator is recalls WITH results, not every
 * recall: an empty recall can structurally never be verify-followed, so folding
 * it in would just re-encode the empty-recall rate a second time. Malformed
 * journal lines are skipped and surfaced (`skippedEventLines`) so the rates read
 * as "over the parseable journal".
 */
function probeRetrievalQuality(retrieval: SomaMemoryRetrievalQuality): { probe: SomaMemoryAuditProbe } {
  const skipped = retrieval.skippedEventLines > 0 ? `, ${retrieval.skippedEventLines} malformed line(s) skipped` : "";
  return {
    probe: {
      name: "retrieval-quality",
      gatesHealth: false,
      ok: true,
      detail:
        `${retrieval.recallVolume} recall(s), empty-recall-rate ${(retrieval.emptyRecallRate * 100).toFixed(1)}%, ` +
        `verify-follows-recall-rate ${(retrieval.verifyFollowsRecallRate * 100).toFixed(1)}% ` +
        `(${retrieval.recallsWithResults} non-empty recall(s), ${retrieval.verifyWindowEvents}-event window)${skipped}`,
    },
  };
}

/**
 * Digest-referenced ids keyed by MONTH (the digest's `YYYY-MM.md` basename). Keyed
 * by month so the orphan check can require a note to appear in ITS created-month
 * digest — a reference in the wrong month is drift, not coverage. The digest
 * pointer grammar is owned by `episodic-digest.ts` so producer and consumer stay paired.
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
    for (const id of parseDigestPointerIds(content)) {
      ids.add(id);
    }
    byMonth.set(month, ids);
  }
  return byMonth;
}

