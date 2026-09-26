import { createHash } from "node:crypto";
import { constants as fsConstants, createWriteStream } from "node:fs";
import { open, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { SomaMemoryEvent } from "./types";

export const EVENT_SEGMENT_LIMIT = 16 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 30_000;
const ARCHIVE = "events-archive";
const INDEX = "events-index.json";
const COUNTS_INDEX = "events-counts-index.json";
const ROTATION_PENDING = ".rotation-pending.json";
const SEGMENT = /^events-(\d{6})\.jsonl(\.gz)?$/;
const LEGACY = /^events-until-.*\.jsonl$/;
const MAX_EXPANDED_ARCHIVE_BYTES = 256 * 1024 * 1024;
const PINNED_SEGMENT_LIMIT = 8;
const READER_LEASE_TIMEOUT_MS = 5 * 60_000;
const validatedMirrors = new Map<string, string>();
const VALIDATED_MIRROR_CACHE_LIMIT = 128;

function fileVersion(file: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
}

function validationPath(plainPath: string): string { return `${plainPath}.validation` }
function countPath(plainPath: string): string { return `${plainPath}.counts.json`; }

interface SegmentCounts {
  version: string;
  gzipVersion: string;
  totalEvents: number;
  skippedMalformedLines: number;
  checksum: string;
}

function countChecksum(counts: Omit<SegmentCounts, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(counts)).digest("hex");
}

export function isTelemetryEvent(value: unknown): value is SomaMemoryEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return ["id", "timestamp", "substrate", "kind", "summary"].every((key) => typeof event[key] === "string");
}

export function parseTelemetryEventLine(line: string): SomaMemoryEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isTelemetryEvent(value) ? value : undefined;
  } catch { return undefined; }
}

function classifyEventLine<T>(
  line: string,
  parse: (line: string) => T | undefined,
): { kind: "blank" } | { kind: "malformed" } | { kind: "valid"; value: T } {
  if (line.trim().length === 0) return { kind: "blank" };
  const value = parse(line);
  return value === undefined ? { kind: "malformed" } : { kind: "valid", value };
}

async function pairVersion(plainPath: string, gzipPath: string): Promise<string> {
  const [plain, gzip] = await Promise.all([stat(plainPath), stat(gzipPath)]);
  return `${fileVersion(plain)}:${fileVersion(gzip)}`;
}

export function eventArchiveDir(eventsPath: string): string { return join(dirname(eventsPath), ARCHIVE); }
export function eventIndexPath(eventsPath: string): string { return join(dirname(eventsPath), INDEX); }
export function eventCountsIndexPath(eventsPath: string): string { return join(dirname(eventsPath), COUNTS_INDEX); }
function readerLeasesDir(eventsPath: string): string { return join(dirname(eventsPath), ".events.readers"); }
function rollbackGateDir(eventsPath: string): string { return join(dirname(eventsPath), ".events.rollback"); }
export function eventSegmentPath(eventsPath: string, number: number): string {
  return join(eventArchiveDir(eventsPath), `events-${String(number).padStart(6, "0")}.jsonl`);
}

function isGone(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch((error: unknown) => { if (isGone(error)) return false; throw error; });
}

async function createMetadataFile(path: string, content: string): Promise<void> {
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); }
  finally { await handle.close(); }
}

async function writeAtomicMetadata(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await createMetadataFile(temporary, content);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

async function retireStaleOwnedDirectory(path: string): Promise<boolean> {
  const age = Date.now() - (await stat(path).then((s) => s.mtimeMs).catch(() => Date.now()));
  if (age <= LOCK_TIMEOUT_MS) return false;
  const raw = await readFile(join(path, "owner.json"), "utf8").catch((error: unknown) => { if (isGone(error)) return undefined; throw error; });
  if (raw === undefined) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (typeof parsed !== "object" || parsed === null) return false;
  const owner = parsed as { host?: string; pid?: number };
  if (owner.host !== hostname() || typeof owner.pid !== "number" || alive(owner.pid)) return false;
  const retired = `${path}.stale-${process.pid}-${crypto.randomUUID()}`;
  await rename(path, retired).catch((error: unknown) => { if (!isGone(error)) throw error; });
  await rm(retired, { recursive: true, force: true });
  return true;
}

async function tryReclaimStaleLock(lock: string): Promise<boolean> {
  const guard = `${lock}.reclaim`;
  const guarded = await mkdir(guard).then(() => true).catch(async (error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") { await retireStaleOwnedDirectory(guard); return false; }
    throw error;
  });
  if (!guarded) return false;
  try {
    await createMetadataFile(join(guard, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname() }));
    return await retireStaleOwnedDirectory(lock);
  } finally { await rm(guard, { recursive: true, force: true }); }
}

/** One lock for append, rotation, reader snapshots and rollback. */
export async function withEventLogLock<T>(eventsPath: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(eventsPath), { recursive: true });
  const lock = join(dirname(eventsPath), ".events.lock");
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      try {
        await createMetadataFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname() }));
      } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for event log lock: ${lock}`, { cause: error });
      // Only a dead same-host owner may be reclaimed.
      const lockAge = Date.now() - await stat(lock).then((value) => value.mtimeMs).catch((probeError: unknown) => {
        if (isGone(probeError)) return Date.now();
        throw probeError;
      });
      if (lockAge > LOCK_TIMEOUT_MS && await tryReclaimStaleLock(lock)) continue;
      await sleep(15);
    }
  }
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

async function createReaderLease(eventsPath: string): Promise<string> {
  if (await eventRollbackPending(eventsPath)) throw new EventRollbackPending();
  const root = readerLeasesDir(eventsPath);
  await mkdir(root, { recursive: true });
  const lease = join(root, crypto.randomUUID());
  await mkdir(lease);
  try { await createMetadataFile(join(lease, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname() })); }
  catch (error) { await rm(lease, { recursive: true, force: true }); throw error; }
  return lease;
}

class EventRollbackPending extends Error {}

async function eventRollbackPending(eventsPath: string): Promise<boolean> {
  const gate = rollbackGateDir(eventsPath);
  if (!await pathExists(gate)) return false;
  await retireStaleOwnedDirectory(gate);
  return pathExists(gate);
}

/** Establish a rollback reader gate under the writer lock, then drain leases outside it. */
export async function beginEventRollback(eventsPath: string): Promise<() => Promise<void>> {
  const gate = rollbackGateDir(eventsPath);
  await withEventLogLock(eventsPath, async () => {
    if (await eventRollbackPending(eventsPath)) throw new Error(`Event rollback already pending: ${gate}`);
    await mkdir(gate);
    try { await createMetadataFile(join(gate, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname() })); }
    catch (error) { await rm(gate, { recursive: true, force: true }); throw error; }
  });
  return () => rm(gate, { recursive: true, force: true });
}

/** Rollback calls this after gating new readers and before replacing archive paths. */
export async function waitForEventReaders(eventsPath: string): Promise<void> {
  const root = readerLeasesDir(eventsPath);
  const started = Date.now();
  for (;;) {
    const leases = await readdir(root).catch((error: unknown) => { if (isGone(error)) return []; throw error; });
    if (leases.length === 0) return;
    for (const name of leases) await retireStaleOwnedDirectory(join(root, name));
    const remaining = await readdir(root).catch((error: unknown) => { if (isGone(error)) return []; throw error; });
    if (remaining.length === 0) return;
    if (Date.now() - started > READER_LEASE_TIMEOUT_MS) throw new Error(`Timed out waiting for event readers: ${root}`);
    await sleep(25);
  }
}

interface SegmentNames { number: number; plain?: string; gzip?: string }
function legacyCopies(entries: readonly string[]): { plain: string[]; gzip: string[] } {
  return {
    plain: entries.filter((name) => LEGACY.test(name)),
    gzip: entries.filter((name) => name.endsWith(".gz") && LEGACY.test(name.slice(0, -3))),
  };
}
const segmentListingCache = new Map<string, { version: string; segments: SegmentNames[] }>();

async function segmentListingVersion(eventsPath: string): Promise<string> {
  const paths = [eventArchiveDir(eventsPath), eventIndexPath(eventsPath)];
  const versions = await Promise.all(paths.map(async (path) => {
    const value = await stat(path).catch((error: unknown) => { if (isGone(error)) return undefined; throw error; });
    return value ? fileVersion(value) : "missing";
  }));
  return versions.join("|");
}

async function segmentNames(eventsPath: string): Promise<SegmentNames[]> {
  const dir = eventArchiveDir(eventsPath);
  const entries: string[] = await readdir(dir).catch((error: unknown) => { if (isGone(error)) return []; throw error; });
  const found = new Map<number, SegmentNames>();
  const { plain: legacy, gzip: legacyGzip } = legacyCopies(entries);
  if (legacy.length > 1) throw new Error(`Conflicting legacy event archives in ${dir}`);
  if (legacyGzip.length > 1 || (legacy.length === 1 && legacyGzip.length === 1 && legacyGzip[0] !== `${legacy[0]}.gz`)) {
    throw new Error(`Conflicting legacy gzip archives in ${dir}`);
  }
  for (const name of entries) {
    const match = SEGMENT.exec(name);
    if (!match) continue;
    const number = Number(match[1]);
    if (number < 1) throw new Error(`Invalid event segment number: ${name}`);
    const item = found.get(number) ?? { number };
    if (name.endsWith(".gz")) item.gzip = join(dir, name);
    else item.plain = join(dir, name);
    found.set(number, item);
  }
  if ((legacy.length || legacyGzip.length) && found.has(1)) throw new Error(`Conflicting first event segments in ${dir}`);
  if (legacy.length || legacyGzip.length) found.set(1, { number: 1, ...(legacy.length ? { plain: join(dir, legacy[0]) } : {}), ...(legacyGzip.length ? { gzip: join(dir, legacyGzip[0]) } : {}) });
  const ordered = [...found.values()].sort((a, b) => a.number - b.number);
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].number !== i + 1) throw new Error(`Missing event segment ${i + 1} in ${dir}`);
  }
  return ordered;
}

async function recordedNextSegment(eventsPath: string): Promise<number | undefined> {
  const raw = await readFile(eventIndexPath(eventsPath), "utf8").catch((error: unknown) => { if (isGone(error)) return undefined; throw error; });
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`Malformed event segment index: ${eventIndexPath(eventsPath)}`); }
  const next = (value as { nextSegment?: unknown } | null)?.nextSegment;
  if (!Number.isSafeInteger(next) || typeof next !== "number" || next < 1) throw new Error(`Invalid event segment index: ${eventIndexPath(eventsPath)}`);
  return next;
}

async function writeNextSegment(eventsPath: string, nextSegment: number): Promise<void> {
  const path = eventIndexPath(eventsPath);
  await writeAtomicMetadata(path, `${JSON.stringify({ nextSegment })}\n`);
}

/** Complete or discard a rotation interrupted before its index and live file. */
export async function recoverPendingEventRotation(eventsPath: string): Promise<void> {
  const marker = join(dirname(eventsPath), ROTATION_PENDING);
  const raw = await readFile(marker, "utf8").catch((error: unknown) => { if (isGone(error)) return undefined; throw error; });
  if (raw === undefined) return;
  let number: unknown;
  try { number = (JSON.parse(raw) as { number?: unknown }).number; }
  catch { throw new Error(`Malformed pending event rotation: ${marker}`); }
  if (!Number.isSafeInteger(number) || typeof number !== "number" || number < 1) throw new Error(`Invalid pending event rotation: ${marker}`);
  const closed = eventSegmentPath(eventsPath, number);
  const closedExists = await pathExists(closed);
  if (closedExists) {
    const recorded = await recordedNextSegment(eventsPath);
    if (recorded !== undefined && recorded !== number && recorded !== number + 1) throw new Error(`Conflicting pending event rotation: ${marker}`);
    if (recorded !== number + 1) await writeNextSegment(eventsPath, number + 1);
    const live = await pathExists(eventsPath);
    if (!live) await writeFile(eventsPath, "", { flag: "wx", mode: 0o600 });
  } else {
    const live = await pathExists(eventsPath);
    if (!live) throw new Error(`Missing live event log during rotation: ${eventsPath}`);
  }
  await rm(marker);
}

async function rotateLiveEventLog(eventsPath: string, number: number): Promise<void> {
  const closed = eventSegmentPath(eventsPath, number);
  await mkdir(eventArchiveDir(eventsPath), { recursive: true });
  const marker = join(dirname(eventsPath), ROTATION_PENDING);
  await createMetadataFile(marker, `${JSON.stringify({ number })}\n`);
  await rename(eventsPath, closed);
  await writeNextSegment(eventsPath, number + 1);
  await writeFile(eventsPath, "", { flag: "wx", mode: 0o600 });
  await rm(marker);
}

async function checkedSegmentsAndIndex(eventsPath: string): Promise<{ segments: SegmentNames[]; recorded: number | undefined }> {
  const version = await segmentListingVersion(eventsPath);
  const cached = segmentListingCache.get(eventsPath);
  const segments = cached?.version === version ? cached.segments : await segmentNames(eventsPath);
  const recorded = await recordedNextSegment(eventsPath);
  const unmigratedLegacy = segments.length === 1 && (
    (segments[0].plain !== undefined && LEGACY.test(basename(segments[0].plain))) ||
    (segments[0].gzip !== undefined && LEGACY.test(basename(segments[0].gzip).slice(0, -3)))
  );
  if (segments.length > 0 && recorded === undefined && !unmigratedLegacy) {
    throw new Error(`Missing event segment index: ${eventIndexPath(eventsPath)}`);
  }
  if (recorded !== undefined && recorded > segments.length + 1) {
    throw new Error(`Missing event segment ${segments.length + 1} in ${eventArchiveDir(eventsPath)}`);
  }
  if (recorded !== undefined && recorded < segments.length + 1) {
    throw new Error(`Event segment index trails archive in ${eventArchiveDir(eventsPath)}`);
  }
  if (cached?.version !== version) {
    segmentListingCache.delete(eventsPath);
    segmentListingCache.set(eventsPath, { version, segments });
    if (segmentListingCache.size > 16) {
      const oldest = segmentListingCache.keys().next().value;
      if (oldest !== undefined) segmentListingCache.delete(oldest);
    }
  }
  return { segments, recorded };
}

async function checkedSegments(eventsPath: string): Promise<SegmentNames[]> {
  return (await checkedSegmentsAndIndex(eventsPath)).segments;
}

/** Import the historical archive byte for byte when the first writer arrives. */
export async function importLegacyEventArchive(eventsPath: string): Promise<void> {
  const dir = eventArchiveDir(eventsPath);
  const marker = join(dir, ".legacy-importing");
  const markerExists = await pathExists(marker);
  if (!markerExists && (await recordedNextSegment(eventsPath)) !== undefined) return;
  const entries: string[] = await readdir(dir).catch((error: unknown) => { if (isGone(error)) return []; throw error; });
  const { plain: legacy, gzip: legacyCompressed } = legacyCopies(entries);
  const moveCompressed = async (legacyName: string): Promise<void> => {
    const source = join(dir, `${legacyName}.gz`);
    if (legacyCompressed.includes(`${legacyName}.gz`)) {
      const target = `${eventSegmentPath(eventsPath, 1)}.gz`;
      if (await pathExists(target)) {
        throw new Error(`Conflicting legacy compressed event copies in ${dir}`);
      }
      await rename(source, target);
      const validation = validationPath(join(dir, legacyName));
      const exists = await pathExists(validation);
      if (exists) await rename(validation, validationPath(eventSegmentPath(eventsPath, 1)));
      const counts = countPath(join(dir, legacyName));
      if (await pathExists(counts)) await rename(counts, countPath(eventSegmentPath(eventsPath, 1)));
    }
  };
  if (entries.includes(".legacy-importing")) {
    if (legacy.length > 1 || legacyCompressed.length > 1 || (legacy.length === 1 && entries.includes("events-000001.jsonl"))) {
      throw new Error(`Conflicting legacy event import in ${dir}`);
    }
  } else {
    if (legacy.length === 0 && legacyCompressed.length === 0) return;
    if (legacy.length > 1 || legacyCompressed.length > 1 || entries.some((name) => SEGMENT.test(name)) ||
        (legacy.length === 1 && legacyCompressed.length === 1 && legacyCompressed[0] !== `${legacy[0]}.gz`)) {
      throw new Error(`Conflicting event archives in ${dir}`);
    }
    await createMetadataFile(marker, "importing\n");
  }
  const first = eventSegmentPath(eventsPath, 1);
  if (legacy.length === 1) await rename(join(dir, legacy[0]), first);
  const compressedName = legacyCompressed[0]?.slice(0, -3);
  if (compressedName) await moveCompressed(compressedName);
  if (!(await pathExists(first)) && !(await pathExists(`${first}.gz`))) throw new Error(`Missing first event segment during legacy import in ${dir}`);
  if ((await recordedNextSegment(eventsPath)) === undefined) await writeNextSegment(eventsPath, 2);
  await rm(marker);
}

export async function compressEventSegment(plainPath: string): Promise<void> {
  const target = `${plainPath}.gz`;
  const existing = await stat(target).catch((error: unknown) => { if (isGone(error)) return undefined; throw error; });
  if (existing) return;
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const source = await open(plainPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const sourceStat = await source.stat();
    if (!sourceStat.isFile() || sourceStat.size === 0) throw new Error(`Event segment is not a nonempty regular file: ${plainPath}`);
    const last = Buffer.alloc(1);
    await source.read(last, 0, 1, sourceStat.size - 1);
    if (last[0] !== 10) throw new Error(`Torn event record in ${plainPath}`);
    await pipeline(source.createReadStream({ autoClose: false }), createGzip(), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    const compressed = await open(temporary, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let counts: { totalEvents: number; skippedMalformedLines: number };
    try {
      const [plain, gzipHash] = await Promise.all([
        digestAndCountEventStream(source.createReadStream({ start: 0, end: sourceStat.size - 1, autoClose: false }), plainPath),
        digestStream(compressed.createReadStream({ autoClose: false }).pipe(createGunzip())),
      ]);
      if (plain.hash !== gzipHash) throw new Error(`Compressed event copy differs from source: ${plainPath}`);
      counts = plain.counts;
    } finally { await compressed.close(); }
    await rename(temporary, target);
    const validation = validationPath(plainPath);
    await writeAtomicMetadata(validation, `${await pairVersion(plainPath, target)}\n`);
    await persistSegmentCounts({ path: plainPath, gzip: false, mirrorPath: target }, counts);
  }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  finally { await source.close(); }
}

/** Called while snapshot staging holds the event lock. */
export async function pendingCompressedEventSegments(eventsPath: string): Promise<string[]> {
  return (await checkedSegments(eventsPath)).flatMap((segment) => segment.plain && !segment.gzip ? [segment.plain] : []);
}

/** Fingerprint the archive generation before and after out-of-lock validation. */
export async function eventArchiveVersion(eventsPath: string): Promise<string> {
  const segments = await checkedSegments(eventsPath);
  const paths = [eventIndexPath(eventsPath), ...segments.flatMap((segment) => [segment.plain, segment.gzip].filter((path): path is string => path !== undefined))];
  const versions = await Promise.all(paths.map(async (path) => {
    const value = await stat(path).catch((error: unknown) => { if (isGone(error)) return undefined; throw error; });
    return [path, value ? fileVersion(value) : "missing"];
  }));
  return JSON.stringify(versions);
}

export async function prepareEventCompression(eventsPath: string): Promise<{ paths: string[]; release: () => Promise<void> }> {
  const paths = await pendingCompressedEventSegments(eventsPath);
  const lease = await createReaderLease(eventsPath);
  return { paths, release: async () => { await rm(lease, { recursive: true, force: true }); } };
}

export async function ensureCompressedEventSegments(eventsPath: string, createMissing = true): Promise<void> {
  for (const segment of await checkedSegments(eventsPath)) {
    if (!segment.plain && segment.gzip) {
      const handle = await open(segment.gzip, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const file = await handle.stat();
        if (file.size === 0) throw new Error(`Empty closed event segment: ${segment.gzip}`);
        const validation = validationPath(segment.gzip.slice(0, -3));
        const version = `gzip:${fileVersion(file)}`;
        const persisted = await readFile(validation, "utf8").catch((error: unknown) => { if (isGone(error)) return ""; throw error; });
        if (persisted.trim() === version) continue;
        let expanded = 0;
        let lastByte = -1;
        for await (const chunk of handle.createReadStream({ autoClose: false }).pipe(createGunzip())) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          expanded += bytes.length;
          if (expanded > MAX_EXPANDED_ARCHIVE_BYTES) throw new Error(`Expanded event archive exceeds safety limit: ${segment.gzip}`);
          if (bytes.length > 0) lastByte = bytes[bytes.length - 1];
        }
        if (lastByte !== 10) throw new Error(`Torn event record in ${segment.gzip}`);
        await writeAtomicMetadata(validation, `${version}\n`);
      } finally { await handle.close(); }
      continue;
    }
    if (!segment.plain) continue;
    if (!segment.gzip) {
      if (!createMissing) throw new Error(`Pending event compression: ${segment.plain}`);
      await compressEventSegment(segment.plain);
      continue;
    }
    const plain = await open(segment.plain, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const mirror = await open(segment.gzip, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const size = (await plain.stat()).size;
        if (size === 0 || (await mirror.stat()).size === 0) throw new Error(`Empty closed event segment: ${segment.plain}`);
        await validateMirror({ path: segment.plain, handle: plain, size, gzip: false, mirror });
      } finally { await mirror.close(); }
    } finally { await plain.close(); }
  }
}

async function appendRecordsUnderLock(eventsPath: string, records: readonly Buffer[], limit: number): Promise<void> {
    await recoverPendingEventRotation(eventsPath);
    await importLegacyEventArchive(eventsPath);
    const { segments, recorded } = await checkedSegmentsAndIndex(eventsPath);
    if (segments.length > 0 || recorded !== undefined) {
      await stat(eventsPath).catch((error: unknown) => {
        if (isGone(error)) throw new Error(`Missing live event log: ${eventsPath}`);
        throw error;
      });
    }
    let nextNumber = segments.length + 1;
    if (recorded === undefined && segments.length === 0) {
      const liveExists = await pathExists(eventsPath);
      if (!liveExists) await createMetadataFile(eventsPath, "");
    }
    if (recorded !== nextNumber) await writeNextSegment(eventsPath, nextNumber);
    let currentSize = await stat(eventsPath).then((s) => s.size).catch((error: unknown) => { if (isGone(error)) return 0; throw error; });
    if (currentSize > 0) {
      const existing = await open(eventsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const tail = Buffer.alloc(1);
        await existing.read(tail, 0, 1, currentSize - 1);
        if (tail[0] !== 10) throw new Error(`Refusing to append to torn event log: ${eventsPath}`);
      } finally { await existing.close(); }
    }
    let pending: Buffer[] = [];
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const writer = await open(eventsPath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
      try { await writer.writeFile(Buffer.concat(pending)); }
      finally { await writer.close(); }
      pending = [];
    };
    for (const record of records) {
      if (currentSize > 0 && currentSize + record.length > limit) {
        await flush();
        await rotateLiveEventLog(eventsPath, nextNumber++);
        currentSize = 0;
      }
      pending.push(record);
      currentSize += record.length;
    }
    await flush();
}

export async function appendEventBatch(eventsPath: string, payload: Buffer, limit = EVENT_SEGMENT_LIMIT): Promise<void> {
  if (payload.length === 0) return;
  if (payload[payload.length - 1] !== 10) throw new Error("Event batch must end with a newline");
  const records: Buffer[] = [];
  let from = 0;
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] !== 10) continue;
    const record = payload.subarray(from, i + 1);
    if (record.length > limit) throw new Error(`Event record exceeds segment limit (${limit} bytes)`);
    records.push(record);
    from = i + 1;
  }
  await withEventLogLock(eventsPath, () => appendRecordsUnderLock(eventsPath, records, limit));
}

interface OpenSegment { path: string; handle?: FileHandle; size?: number; gzip: boolean; mirror?: FileHandle; mirrorPath?: string }
interface EventSnapshot { segments: OpenSegment[]; leasePath?: string }

async function closeSegments(segments: readonly OpenSegment[]): Promise<void> {
  const handles = segments.flatMap((segment) => [segment.handle, segment.mirror].filter((handle): handle is FileHandle => handle !== undefined));
  await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
}

async function closeEventSnapshot(snapshot: EventSnapshot): Promise<void> {
  await closeSegments(snapshot.segments);
  if (snapshot.leasePath) await rm(snapshot.leasePath, { recursive: true, force: true });
}

async function openSegmentsSnapshot(eventsPath: string, allowLease: boolean): Promise<EventSnapshot> {
    const names = await checkedSegments(eventsPath);
    const leasePath = allowLease && names.length > PINNED_SEGMENT_LIMIT ? await createReaderLease(eventsPath) : undefined;
    const opened: OpenSegment[] = [];
    try {
      for (const item of names) {
        const path = item.plain ?? item.gzip;
        if (!path) throw new Error(`Event segment ${item.number} has no readable copy`);
        if (leasePath) {
          opened.push({ path, gzip: !item.plain, ...(item.plain && item.gzip ? { mirrorPath: item.gzip } : {}) });
          continue;
        }
        const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const segment: OpenSegment = { path, handle, size: (await handle.stat()).size, gzip: !item.plain };
        if (segment.size === 0) {
          await handle.close();
          throw new Error(`Empty closed event segment: ${path}`);
        }
        opened.push(segment);
        if (item.plain && item.gzip) segment.mirror = await open(item.gzip, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      }
      const live = await open(eventsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error: unknown) => { if (isGone(error)) return undefined; throw error; });
      if (!live && (names.length > 0 || (await recordedNextSegment(eventsPath)) !== undefined)) {
        throw new Error(`Missing live event log: ${eventsPath}`);
      }
      if (live) opened.push({ path: eventsPath, handle: live, size: (await live.stat()).size, gzip: false });
      return { segments: opened, ...(leasePath ? { leasePath } : {}) };
    } catch (error) { await closeEventSnapshot({ segments: opened, ...(leasePath ? { leasePath } : {}) }); throw error; }
}

/** Pin archive handles and the live byte bound under the writer lock. */
async function snapshotSegments(eventsPath: string): Promise<EventSnapshot> {
  try {
    for (;;) {
      try { return await withEventLogLock(eventsPath, () => openSegmentsSnapshot(eventsPath, true)); }
      catch (error) {
        if (!(error instanceof EventRollbackPending)) throw error;
        await sleep(25);
      }
    }
  }
  catch (error) {
    if (!(error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS"))) throw error;
    // A read-only home cannot create the lock. Pin handles and reject listing
    // changes during acquisition; in-place archive edits require the closed-
    // segment immutability contract because they cannot be locked here.
    const before = await segmentListingVersion(eventsPath);
    const opened = await openSegmentsSnapshot(eventsPath, false);
    try {
      if ((await segmentListingVersion(eventsPath)) !== before) throw new Error(`Event archive changed during read-only snapshot: ${eventsPath}`, { cause: error });
      return opened;
    } catch (snapshotError) { await closeEventSnapshot(opened); throw snapshotError; }
  }
}

async function digestStream(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_EXPANDED_ARCHIVE_BYTES) throw new Error("Expanded event archive exceeds safety limit");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function digestAndCountEventStream(
  stream: AsyncIterable<Buffer | string>,
  path: string,
): Promise<{ hash: string; counts: { totalEvents: number; skippedMalformedLines: number } }> {
  const hash = createHash("sha256");
  const framer = createEventLineFramer();
  let bytesRead = 0;
  let totalEvents = 0;
  let skippedMalformedLines = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += bytes.length;
    if (bytesRead > MAX_EXPANDED_ARCHIVE_BYTES) throw new Error(`Expanded event archive exceeds safety limit: ${path}`);
    hash.update(bytes);
    for (const line of framer.push(bytes)) {
      const classified = classifyEventLine(line, parseTelemetryEventLine);
      if (classified.kind === "valid") totalEvents++;
      else if (classified.kind === "malformed") skippedMalformedLines++;
    }
  }
  framer.finish(path);
  return { hash: hash.digest("hex"), counts: { totalEvents, skippedMalformedLines } };
}

async function validateMirror(item: OpenSegment & { handle: FileHandle; size: number }): Promise<void> {
  if (!item.mirror) return;
  const [sourceStat, mirrorStat] = await Promise.all([item.handle.stat(), item.mirror.stat()]);
  const version = `${fileVersion(sourceStat)}:${fileVersion(mirrorStat)}`;
  if (validatedMirrors.get(item.path) === version) return;
  const persisted = await readFile(validationPath(item.path), "utf8").catch((error: unknown) => { if (isGone(error)) return ""; throw error; });
  if (persisted.trim() === version) {
    validatedMirrors.set(item.path, version);
    return;
  }
  const [plainHash, gzipHash] = await Promise.all([
    item.size === 0 ? Promise.resolve(createHash("sha256").digest("hex")) : digestStream(item.handle.createReadStream({ start: 0, end: item.size - 1, autoClose: false })),
    digestStream(item.mirror.createReadStream({ autoClose: false }).pipe(createGunzip())),
  ]);
  if (plainHash !== gzipHash) throw new Error(`Conflicting event segment copies: ${item.path}`);
  validatedMirrors.delete(item.path);
  validatedMirrors.set(item.path, version);
  if (validatedMirrors.size > VALIDATED_MIRROR_CACHE_LIMIT) {
    const oldest = validatedMirrors.keys().next().value;
    if (oldest !== undefined) validatedMirrors.delete(oldest);
  }
}

async function openSegmentHandles(item: OpenSegment): Promise<{ handle: FileHandle; mirror?: FileHandle; size: number; close: () => Promise<void> }> {
  const handle = item.handle ?? await open(item.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let mirror: FileHandle | undefined;
  const close = async (): Promise<void> => {
    if (!item.mirror && mirror) await mirror.close();
    if (!item.handle) await handle.close();
  };
  try {
    mirror = item.mirror ?? (item.mirrorPath ? await open(item.mirrorPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW) : undefined);
    const size = item.size ?? (await handle.stat()).size;
    return { handle, ...(mirror ? { mirror } : {}), size, close };
  } catch (error) { await close(); throw error; }
}

async function openReadableSegment(item: OpenSegment): Promise<{ handle: FileHandle; size: number; close: () => Promise<void> }> {
  const opened = await openSegmentHandles(item);
  try {
    await validateMirror({ ...item, handle: opened.handle, size: opened.size, ...(opened.mirror ? { mirror: opened.mirror } : {}) });
    return opened;
  } catch (error) { await opened.close(); throw error; }
}

async function* streamBoundedSegmentBytes(item: OpenSegment, handle: FileHandle, size: number): AsyncGenerator<Buffer> {
  let expanded = 0;
  if (size > 0) {
    const source = handle.createReadStream({ start: 0, end: size - 1, autoClose: false });
    const stream = item.gzip ? source.pipe(createGunzip()) : source;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      expanded += bytes.length;
      if (expanded > MAX_EXPANDED_ARCHIVE_BYTES) throw new Error(`Expanded event archive exceeds safety limit: ${item.path}`);
      yield bytes;
    }
  }
  if (item.gzip && expanded === 0) throw new Error(`Empty closed event segment: ${item.path}`);
}

function createEventLineFramer(): { push: (bytes: Uint8Array) => string[]; finish: (path: string) => void } {
  let pendingParts: string[] = [];
  const decoder = new TextDecoder();
  return {
    push(bytes) {
      const decoded = decoder.decode(bytes, { stream: true });
      const lines: string[] = [];
      let start = 0;
      for (;;) {
        const end = decoded.indexOf("\n", start);
        if (end < 0) break;
        const part = decoded.slice(start, end);
        lines.push((pendingParts.length > 0 ? pendingParts.join("") + part : part).replace(/\r$/, ""));
        pendingParts = [];
        start = end + 1;
      }
      if (start < decoded.length) pendingParts.push(decoded.slice(start));
      return lines;
    },
    finish(path) {
      const final = decoder.decode();
      if (final.length > 0) pendingParts.push(final);
      if (pendingParts.length > 0) throw new Error(`Torn event record in ${path}`);
    },
  };
}

async function* streamSegmentLines(item: OpenSegment, handle: FileHandle, size: number): AsyncGenerator<string> {
  const framer = createEventLineFramer();
  for await (const bytes of streamBoundedSegmentBytes(item, handle, size)) {
    for (const line of framer.push(bytes)) yield line;
  }
  framer.finish(item.path);
}

/** Ordered records retain real source path and per-file line for citations. */
export async function* streamEventRecords(eventsPath: string): AsyncGenerator<{ path: string; lineNumber: number; line: string }> {
  const snapshot = await snapshotSegments(eventsPath);
  try {
    for (const item of snapshot.segments) {
      const opened = await openReadableSegment(item);
      try {
        if (item.path !== eventsPath && opened.size === 0) throw new Error(`Empty closed event segment: ${item.path}`);
        let lineNumber = 0;
        for await (const line of streamSegmentLines(item, opened.handle, opened.size)) {
          yield { path: item.path, lineNumber: ++lineNumber, line };
        }
      } finally { await opened.close(); }
    }
  } finally { await closeEventSnapshot(snapshot); }
}

export async function* streamEventLines(eventsPath: string): AsyncGenerator<string> {
  for await (const record of streamEventRecords(eventsPath)) yield record.line;
}

async function scanSnapshotSegment<T>(
  item: OpenSegment,
  closed: boolean,
  limit: number,
  parse: (line: string) => T | undefined,
  matches: (value: T) => boolean,
): Promise<{ events: T[]; totalEvents: number; skippedMalformedLines: number }> {
  const opened = await openReadableSegment(item);
  try {
    const { handle, size } = opened;
    if (closed && size === 0) throw new Error(`Empty closed event segment: ${item.path}`);
    const recent: T[] = [];
    let matched = 0;
    let totalEvents = 0;
    let skippedMalformedLines = 0;
    for await (const line of streamSegmentLines(item, handle, size)) {
      const classified = classifyEventLine(line, parse);
      if (classified.kind === "blank") continue;
      if (classified.kind === "malformed") { skippedMalformedLines++; continue; }
      totalEvents++;
      if (matches(classified.value)) {
        recent[matched % limit] = classified.value;
        matched++;
      }
    }
    const retained = Math.min(matched, limit);
    const oldest = matched > limit ? matched % limit : 0;
    const events = Array.from({ length: retained }, (_, offset) => recent[(oldest + offset) % limit]).reverse();
    return { events, totalEvents, skippedMalformedLines };
  } finally { await opened.close(); }
}

async function segmentFileVersion(item: OpenSegment): Promise<string> {
  const source = fileVersion(await (item.handle ? item.handle.stat() : stat(item.path)));
  const mirror = item.mirror ? await item.mirror.stat() : item.mirrorPath ? await stat(item.mirrorPath) : undefined;
  return mirror ? `${source}:${fileVersion(mirror)}` : source;
}

async function persistSegmentCounts(
  item: OpenSegment,
  counts: { totalEvents: number; skippedMalformedLines: number },
): Promise<void> {
  const version = await segmentFileVersion(item);
  const gzipVersion = item.gzip ? version : item.mirrorPath ? fileVersion(await stat(item.mirrorPath)) : "";
  const fields = { version, gzipVersion, ...counts };
  const plainPath = item.gzip ? item.path.slice(0, -3) : item.path;
  await writeAtomicMetadata(countPath(plainPath), `${JSON.stringify({ ...fields, checksum: countChecksum(fields) })}\n`);
}

async function savedSegmentCounts(item: OpenSegment): Promise<{ totalEvents: number; skippedMalformedLines: number } | undefined> {
  const plainPath = item.gzip ? item.path.slice(0, -3) : item.path;
  const raw = await readFile(countPath(plainPath), "utf8").catch((error: unknown) => { if (isGone(error)) return null; throw error; });
  if (raw === null) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (typeof value !== "object" || value === null) return undefined;
  const counts = value as Partial<SegmentCounts>;
  if (typeof counts.version !== "string" || typeof counts.gzipVersion !== "string" || typeof counts.checksum !== "string" ||
      typeof counts.totalEvents !== "number" || typeof counts.skippedMalformedLines !== "number" ||
      !Number.isSafeInteger(counts.totalEvents) || !Number.isSafeInteger(counts.skippedMalformedLines) ||
      counts.totalEvents < 0 || counts.skippedMalformedLines < 0) return undefined;
  const fields = {
    version: counts.version,
    gzipVersion: counts.gzipVersion,
    totalEvents: counts.totalEvents,
    skippedMalformedLines: counts.skippedMalformedLines,
  };
  if (counts.checksum !== countChecksum(fields)) return undefined;
  const version = await segmentFileVersion(item);
  if ((item.gzip ? counts.gzipVersion : counts.version) !== version) return undefined;
  return { totalEvents: counts.totalEvents, skippedMalformedLines: counts.skippedMalformedLines };
}

interface CumulativeEventCounts {
  segmentCount: number;
  totalEvents: number;
  skippedMalformedLines: number;
  lastName: string;
  lastVersion: string;
  versions: string[];
  listingVersion: string;
  checksum: string;
}

function cumulativeChecksum(fields: Omit<CumulativeEventCounts, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** Snapshot maintenance builds one trusted prefix count outside the writer lock. */
export async function writeCumulativeEventCounts(eventsPath: string): Promise<void> {
  const names = await checkedSegments(eventsPath);
  const items = names.map((segment): OpenSegment => {
    const path = segment.plain ?? segment.gzip;
    if (!path) throw new Error(`Event segment ${segment.number} has no readable copy`);
    return { path, gzip: !segment.plain, ...(segment.gzip && segment.plain ? { mirrorPath: segment.gzip } : {}) };
  });
  const prefix = await readCumulativeEventCounts(eventsPath, items);
  let totalEvents = prefix?.totalEvents ?? 0;
  let skippedMalformedLines = prefix?.skippedMalformedLines ?? 0;
  const versions = prefix?.versions.slice() ?? [];
  for (const item of items.slice(prefix?.segmentCount ?? 0)) {
    let counts = await savedSegmentCounts(item);
    if (!counts) {
      const before = await segmentFileVersion(item);
      counts = await scanSnapshotSegment(item, true, 1, parseTelemetryEventLine, () => false);
      if ((await segmentFileVersion(item)) !== before) throw new Error(`Event segment changed while counting: ${item.path}`);
      await persistSegmentCounts(item, counts);
    }
    totalEvents += counts.totalEvents;
    skippedMalformedLines += counts.skippedMalformedLines;
    versions.push(await segmentFileVersion(item));
  }
  const last = names.at(-1);
  const lastPath = last?.plain ?? last?.gzip;
  const fields = {
    segmentCount: names.length,
    totalEvents,
    skippedMalformedLines,
    lastName: lastPath ? basename(lastPath) : "",
    lastVersion: versions.at(-1) ?? "",
    versions,
    listingVersion: await segmentListingVersion(eventsPath),
  };
  const target = eventCountsIndexPath(eventsPath);
  await writeAtomicMetadata(target, `${JSON.stringify({ ...fields, checksum: cumulativeChecksum(fields) })}\n`);
}

async function readCumulativeEventCounts(eventsPath: string, segments: readonly OpenSegment[]): Promise<CumulativeEventCounts | undefined> {
  const raw = await readFile(eventCountsIndexPath(eventsPath), "utf8").catch((error: unknown) => { if (isGone(error)) return undefined; throw error; });
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (typeof value !== "object" || value === null) return undefined;
  const index = value as Partial<CumulativeEventCounts>;
  if (typeof index.segmentCount !== "number" || typeof index.totalEvents !== "number" ||
      typeof index.skippedMalformedLines !== "number" || typeof index.lastName !== "string" ||
      typeof index.lastVersion !== "string" || !Array.isArray(index.versions) ||
      typeof index.listingVersion !== "string" || typeof index.checksum !== "string" ||
      !Number.isSafeInteger(index.segmentCount) || !Number.isSafeInteger(index.totalEvents) ||
      !Number.isSafeInteger(index.skippedMalformedLines) || index.segmentCount < 1 ||
      index.totalEvents < 0 || index.skippedMalformedLines < 0 || index.segmentCount > segments.length ||
      index.versions.length !== index.segmentCount || !index.versions.every((version) => typeof version === "string")) return undefined;
  const fields = {
    segmentCount: index.segmentCount, totalEvents: index.totalEvents,
    skippedMalformedLines: index.skippedMalformedLines,
    lastName: index.lastName, lastVersion: index.lastVersion,
    versions: index.versions, listingVersion: index.listingVersion,
  };
  if (index.checksum !== cumulativeChecksum(fields)) return undefined;
  const last = segments[index.segmentCount - 1];
  if (basename(last.path) !== index.lastName || index.lastVersion !== index.versions.at(-1)) return undefined;
  for (let start = 0; start < index.segmentCount; start += 32) {
    const checked = await Promise.allSettled(segments.slice(start, Math.min(start + 32, index.segmentCount)).map(segmentFileVersion));
    if (checked.some((result, offset) => result.status === "rejected" || result.value !== index.versions?.[start + offset])) return undefined;
  }
  return { ...fields, checksum: index.checksum };
}

/** Read only the newest matching records; count older compressed segments from pinned metadata. */
export async function queryRecentEventRecords<T>(
  eventsPath: string,
  limit: number,
  parse: (line: string) => T | undefined,
  matches: (value: T) => boolean,
): Promise<{ events: T[]; totalEvents: number; skippedMalformedLines: number }> {
  const snapshot = await snapshotSegments(eventsPath);
  const events: T[] = [];
  try {
    const closedSegments = snapshot.segments.filter((item) => item.path !== eventsPath);
    const prefix = await readCumulativeEventCounts(eventsPath, closedSegments);
    let totalEvents = prefix?.totalEvents ?? 0;
    let skippedMalformedLines = prefix?.skippedMalformedLines ?? 0;
    for (let index = snapshot.segments.length - 1; index >= 0; index--) {
      const item = snapshot.segments[index];
      const closed = item.path !== eventsPath;
      const inPrefix = closed && prefix !== undefined && index < prefix.segmentCount;
      if (inPrefix) {
        if (events.length >= limit) break;
        const scanned = await scanSnapshotSegment(item, true, limit - events.length, parse, matches);
        events.push(...scanned.events.slice(0, limit - events.length));
        continue;
      }
      const saved = closed ? await savedSegmentCounts(item) : undefined;
      const needsScan = events.length < limit || saved === undefined;
      const scanned = needsScan
        ? await scanSnapshotSegment(item, closed, limit - events.length || 1, parse, matches)
        : undefined;
      const counts = saved ?? scanned;
      if (!counts) throw new Error(`Missing event segment counts: ${item.path}`);
      if (saved && scanned) {
        if (scanned.totalEvents !== saved.totalEvents || scanned.skippedMalformedLines !== saved.skippedMalformedLines) {
          throw new Error(`Stale event segment counts: ${item.path}`);
        }
      }
      totalEvents += counts.totalEvents;
      skippedMalformedLines += counts.skippedMalformedLines;
      if (scanned && events.length < limit) events.push(...scanned.events.slice(0, limit - events.length));
    }
    return { events, totalEvents, skippedMalformedLines };
  } finally { await closeEventSnapshot(snapshot); }
}
