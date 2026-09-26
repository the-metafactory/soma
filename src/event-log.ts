import { createHash } from "node:crypto";
import { constants as fsConstants, createWriteStream } from "node:fs";
import { open, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createGunzip, createGzip } from "node:zlib";

export const EVENT_SEGMENT_LIMIT = 16 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 30_000;
const ARCHIVE = "events-archive";
const INDEX = "events-index.json";
const ROTATION_PENDING = ".rotation-pending.json";
const SEGMENT = /^events-(\d{6})\.jsonl(\.gz)?$/;
const LEGACY = /^events-until-.*\.jsonl$/;
const MAX_EXPANDED_ARCHIVE_BYTES = 256 * 1024 * 1024;
const PINNED_SEGMENT_LIMIT = 64;
const READER_LEASE_TIMEOUT_MS = 5 * 60_000;
const validatedMirrors = new Map<string, string>();
const VALIDATED_MIRROR_CACHE_LIMIT = 128;

function fileVersion(file: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
}

function validationPath(plainPath: string): string { return `${plainPath}.validation` }

async function pairVersion(plainPath: string, gzipPath: string): Promise<string> {
  const [plain, gzip] = await Promise.all([stat(plainPath), stat(gzipPath)]);
  return `${fileVersion(plain)}:${fileVersion(gzip)}`;
}

export function eventArchiveDir(eventsPath: string): string { return join(dirname(eventsPath), ARCHIVE); }
export function eventIndexPath(eventsPath: string): string { return join(dirname(eventsPath), INDEX); }
function readerLeasesDir(eventsPath: string): string { return join(dirname(eventsPath), ".events.readers"); }
export function eventSegmentPath(eventsPath: string, number: number): string {
  return join(eventArchiveDir(eventsPath), `events-${String(number).padStart(6, "0")}.jsonl`);
}

function isGone(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function createMetadataFile(path: string, content: string): Promise<void> {
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); }
  finally { await handle.close(); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

async function retireStaleOwnedDirectory(path: string): Promise<boolean> {
  const age = Date.now() - (await stat(path).then((s) => s.mtimeMs).catch(() => Date.now()));
  if (age <= LOCK_TIMEOUT_MS) return false;
  const raw = await readFile(join(path, "owner.json"), "utf8").catch((error: unknown) => { if (isGone(error)) return undefined; throw error; });
  if (raw !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return false; }
    if (typeof parsed !== "object" || parsed === null) return false;
    const owner = parsed as { host?: string; pid?: number };
    if (owner.host !== hostname() || typeof owner.pid !== "number" || alive(owner.pid)) return false;
  }
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
      if (await tryReclaimStaleLock(lock)) continue;
      await sleep(15);
    }
  }
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

async function createReaderLease(eventsPath: string): Promise<string> {
  const root = readerLeasesDir(eventsPath);
  await mkdir(root, { recursive: true });
  const lease = join(root, crypto.randomUUID());
  await mkdir(lease);
  try { await createMetadataFile(join(lease, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname() })); }
  catch (error) { await rm(lease, { recursive: true, force: true }); throw error; }
  return lease;
}

/** Rollback calls this under the writer lock before replacing archive paths. */
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
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await createMetadataFile(temporary, `${JSON.stringify({ nextSegment })}\n`);
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
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
  const closedExists = await stat(closed).then(() => true).catch((error: unknown) => { if (isGone(error)) return false; throw error; });
  if (closedExists) {
    const recorded = await recordedNextSegment(eventsPath);
    if (recorded !== undefined && recorded !== number && recorded !== number + 1) throw new Error(`Conflicting pending event rotation: ${marker}`);
    if (recorded !== number + 1) await writeNextSegment(eventsPath, number + 1);
    const live = await stat(eventsPath).then(() => true).catch((error: unknown) => { if (isGone(error)) return false; throw error; });
    if (!live) await writeFile(eventsPath, "", { flag: "wx", mode: 0o600 });
  } else {
    const live = await stat(eventsPath).then(() => true).catch((error: unknown) => { if (isGone(error)) return false; throw error; });
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

async function checkedSegments(eventsPath: string): Promise<SegmentNames[]> {
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
  return segments;
}

/** Import the historical archive byte for byte when the first writer arrives. */
export async function importLegacyEventArchive(eventsPath: string): Promise<void> {
  const dir = eventArchiveDir(eventsPath);
  const marker = join(dir, ".legacy-importing");
  const markerExists = await stat(marker).then(() => true).catch((error: unknown) => { if (isGone(error)) return false; throw error; });
  if (!markerExists && (await recordedNextSegment(eventsPath)) !== undefined) return;
  const entries: string[] = await readdir(dir).catch((error: unknown) => { if (isGone(error)) return []; throw error; });
  const { plain: legacy, gzip: legacyCompressed } = legacyCopies(entries);
  const moveCompressed = async (legacyName: string): Promise<void> => {
    const source = join(dir, `${legacyName}.gz`);
    if (legacyCompressed.includes(`${legacyName}.gz`)) {
      const target = `${eventSegmentPath(eventsPath, 1)}.gz`;
      if (await stat(target).then(() => true).catch((error: unknown) => { if (isGone(error)) return false; throw error; })) {
        throw new Error(`Conflicting legacy compressed event copies in ${dir}`);
      }
      await rename(source, target);
      const validation = validationPath(join(dir, legacyName));
      const exists = await stat(validation).then(() => true).catch((error: unknown) => { if (isGone(error)) return false; throw error; });
      if (exists) await rename(validation, validationPath(eventSegmentPath(eventsPath, 1)));
    }
  };
  if (entries.includes(".legacy-importing")) {
    const first = eventSegmentPath(eventsPath, 1);
    if (legacy.length === 1 && !entries.some((name) => SEGMENT.test(name))) await rename(join(dir, legacy[0]), first);
    else if (legacy.length > 0 || !entries.includes("events-000001.jsonl")) throw new Error(`Conflicting legacy event import in ${dir}`);
    const compressedName = legacy.length === 1 ? legacy[0] : legacyCompressed[0]?.slice(0, -3);
    if (compressedName) await moveCompressed(compressedName);
    if ((await recordedNextSegment(eventsPath)) === undefined) await writeNextSegment(eventsPath, 2);
    await rm(marker);
    return;
  }
  if (legacy.length === 0) return;
  if (legacy.length !== 1 || entries.some((name) => SEGMENT.test(name))) throw new Error(`Conflicting event archives in ${dir}`);
  await createMetadataFile(marker, "importing\n");
  await rename(join(dir, legacy[0]), eventSegmentPath(eventsPath, 1));
  await moveCompressed(legacy[0]);
  await writeNextSegment(eventsPath, 2);
  await rm(marker);
}

export async function compressEventSegment(plainPath: string): Promise<void> {
  const target = `${plainPath}.gz`;
  const existing = await stat(target).catch((error: unknown) => { if (isGone(error)) return undefined; throw error; });
  if (existing) return;
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const source = await open(plainPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    if (!(await source.stat()).isFile()) throw new Error(`Event segment is not a regular file: ${plainPath}`);
    await pipeline(source.createReadStream({ autoClose: false }), createGzip(), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    await rename(temporary, target);
    const validation = validationPath(plainPath);
    const temporaryValidation = `${validation}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await createMetadataFile(temporaryValidation, `${await pairVersion(plainPath, target)}\n`);
      await rename(temporaryValidation, validation);
    } finally { await rm(temporaryValidation, { force: true }); }
  }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  finally { await source.close(); }
}

/** Called while snapshot staging holds the event lock. */
export async function ensureCompressedEventSegments(eventsPath: string): Promise<void> {
  for (const segment of await checkedSegments(eventsPath)) {
    if (!segment.plain && segment.gzip) {
      const handle = await open(segment.gzip, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        if ((await handle.stat()).size === 0) throw new Error(`Empty closed event segment: ${segment.gzip}`);
        let expanded = 0;
        let lastByte = -1;
        for await (const chunk of handle.createReadStream({ autoClose: false }).pipe(createGunzip())) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          expanded += bytes.length;
          if (expanded > MAX_EXPANDED_ARCHIVE_BYTES) throw new Error(`Expanded event archive exceeds safety limit: ${segment.gzip}`);
          if (bytes.length > 0) lastByte = bytes[bytes.length - 1];
        }
        if (lastByte !== 10) throw new Error(`Torn event record in ${segment.gzip}`);
      } finally { await handle.close(); }
      continue;
    }
    if (!segment.plain) continue;
    if (!segment.gzip) { await compressEventSegment(segment.plain); continue; }
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
    const segments = await checkedSegments(eventsPath);
    const recorded = await recordedNextSegment(eventsPath);
    if (segments.length > 0 || recorded !== undefined) {
      await stat(eventsPath).catch((error: unknown) => {
        if (isGone(error)) throw new Error(`Missing live event log: ${eventsPath}`);
        throw error;
      });
    }
    let nextNumber = segments.length + 1;
    if (recorded === undefined && segments.length === 0) {
      const liveExists = await stat(eventsPath).then(() => true).catch((error: unknown) => { if (isGone(error)) return false; throw error; });
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
  try { return await withEventLogLock(eventsPath, () => openSegmentsSnapshot(eventsPath, true)); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS"))) throw error;
    // A read-only home cannot create the lock. Pin the same files and reject
    // a concurrent archive mutation rather than returning a mixed generation.
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

/** Ordered byte streams; boundaries let the JSONL reader reject torn segments. */
async function* streamEventChunks(eventsPath: string): AsyncGenerator<{ path: string; bytes?: Buffer; boundary?: true }> {
  const snapshot = await snapshotSegments(eventsPath);
  try {
    for (const item of snapshot.segments) {
      const handle = item.handle ?? await open(item.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let mirror: FileHandle | undefined;
      try {
        mirror = item.mirror ?? (item.mirrorPath ? await open(item.mirrorPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW) : undefined);
        const size = item.size ?? (await handle.stat()).size;
        if (!item.handle && size === 0) throw new Error(`Empty closed event segment: ${item.path}`);
        await validateMirror({ ...item, handle, size, ...(mirror ? { mirror } : {}) });
        let expanded = 0;
        if (size > 0) {
          const source = handle.createReadStream({ start: 0, end: size - 1, autoClose: false });
          const stream = item.gzip ? source.pipe(createGunzip()) : source;
          for await (const chunk of stream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            expanded += bytes.length;
            if (expanded > MAX_EXPANDED_ARCHIVE_BYTES) throw new Error(`Expanded event archive exceeds safety limit: ${item.path}`);
            yield { path: item.path, bytes };
          }
        }
        yield { path: item.path, boundary: true };
      } finally {
        if (!item.mirror && mirror) await mirror.close();
        if (!item.handle) await handle.close();
      }
    }
  } finally { await closeEventSnapshot(snapshot); }
}

/** Ordered records retain real source path and per-file line for citations. */
export async function* streamEventRecords(eventsPath: string): AsyncGenerator<{ path: string; lineNumber: number; line: string }> {
  let pending = "";
  const lineNumbers = new Map<string, number>();
  const decoder = new TextDecoder();
  for await (const item of streamEventChunks(eventsPath)) {
    if (item.boundary) {
      pending += decoder.decode();
      if (pending.length > 0) throw new Error(`Torn event record in ${item.path}`);
      continue;
    }
    if (!item.bytes) continue;
    pending += decoder.decode(item.bytes, { stream: true });
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      const lineNumber = (lineNumbers.get(item.path) ?? 0) + 1;
      lineNumbers.set(item.path, lineNumber);
      yield { path: item.path, lineNumber, line: pending.slice(0, end).replace(/\r$/, "") };
      pending = pending.slice(end + 1);
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) throw new Error(`Torn event record at end of ${eventsPath}`);
}

export async function* streamEventLines(eventsPath: string): AsyncGenerator<string> {
  for await (const record of streamEventRecords(eventsPath)) yield record.line;
}
