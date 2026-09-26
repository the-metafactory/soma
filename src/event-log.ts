import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
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
const SEGMENT = /^events-(\d{6})\.jsonl(\.gz)?$/;
const LEGACY = /^events-until-.*\.jsonl$/;
const MAX_EXPANDED_ARCHIVE_BYTES = 256 * 1024 * 1024;
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
export function eventSegmentPath(eventsPath: string, number: number): string {
  return join(eventArchiveDir(eventsPath), `events-${String(number).padStart(6, "0")}.jsonl`);
}

function isGone(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
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
        await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname() }));
      } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for event log lock: ${lock}`, { cause: error });
      // Reclaim only a dead same-host owner. An ownerless or foreign-host lock
      // remains closed: silently stealing it could split two appenders.
      const guard = `${lock}.reclaim`;
      const guarded = await mkdir(guard).then(() => true).catch((e: unknown) => { if (e instanceof Error && "code" in e && e.code === "EEXIST") return false; throw e; });
      if (guarded) {
        try {
          const age = Date.now() - (await stat(lock).then((s) => s.mtimeMs).catch(() => Date.now()));
          if (age > LOCK_TIMEOUT_MS) {
            const owner = await readFile(join(lock, "owner.json"), "utf8").then((s) => JSON.parse(s) as { pid?: number; host?: string }).catch(() => null);
            if (owner?.host === hostname() && typeof owner.pid === "number" && !alive(owner.pid)) {
              const retired = `${lock}.stale-${process.pid}-${crypto.randomUUID()}`;
              await rename(lock, retired).catch((e: unknown) => { if (!isGone(e)) throw e; });
              await rm(retired, { recursive: true, force: true });
              continue;
            }
          }
        } finally {
          await rm(guard, { recursive: true, force: true });
        }
      }
      await sleep(15);
    }
  }
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

interface SegmentNames { number: number; plain?: string; gzip?: string }

async function segmentNames(eventsPath: string): Promise<SegmentNames[]> {
  const dir = eventArchiveDir(eventsPath);
  const entries: string[] = await readdir(dir).catch((error: unknown) => { if (isGone(error)) return []; throw error; });
  const found = new Map<number, SegmentNames>();
  const legacy = entries.filter((name) => LEGACY.test(name));
  if (legacy.length > 1) throw new Error(`Conflicting legacy event archives in ${dir}`);
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
  if (legacy.length && found.has(1)) throw new Error(`Conflicting first event segments in ${dir}`);
  if (legacy.length) found.set(1, { number: 1, plain: join(dir, legacy[0]) });
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
  await writeFile(temporary, `${JSON.stringify({ nextSegment })}\n`);
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

async function checkedSegments(eventsPath: string): Promise<SegmentNames[]> {
  const segments = await segmentNames(eventsPath);
  const recorded = await recordedNextSegment(eventsPath);
  const unmigratedLegacy = segments.length === 1 && segments[0].plain !== undefined && LEGACY.test(basename(segments[0].plain));
  if (segments.length > 0 && recorded === undefined && !unmigratedLegacy) {
    throw new Error(`Missing event segment index: ${eventIndexPath(eventsPath)}`);
  }
  if (recorded !== undefined && recorded > segments.length + 1) {
    throw new Error(`Missing event segment ${segments.length + 1} in ${eventArchiveDir(eventsPath)}`);
  }
  if (recorded !== undefined && recorded < segments.length + 1) {
    throw new Error(`Event segment index trails archive in ${eventArchiveDir(eventsPath)}`);
  }
  return segments;
}

/** Import the historical archive byte for byte when the first writer arrives. */
export async function importLegacyEventArchive(eventsPath: string): Promise<void> {
  const dir = eventArchiveDir(eventsPath);
  const marker = join(dir, ".legacy-importing");
  const entries: string[] = await readdir(dir).catch((error: unknown) => { if (isGone(error)) return []; throw error; });
  const legacy = entries.filter((name) => LEGACY.test(name));
  if (entries.includes(".legacy-importing")) {
    const first = eventSegmentPath(eventsPath, 1);
    if (legacy.length === 1 && !entries.some((name) => SEGMENT.test(name))) await rename(join(dir, legacy[0]), first);
    else if (legacy.length > 0 || !entries.includes("events-000001.jsonl")) throw new Error(`Conflicting legacy event import in ${dir}`);
    await mirrorEventSegment(first);
    if ((await recordedNextSegment(eventsPath)) === undefined) await writeNextSegment(eventsPath, 2);
    await rm(marker);
    return;
  }
  if (legacy.length === 0) return;
  if (legacy.length !== 1 || entries.some((name) => SEGMENT.test(name))) throw new Error(`Conflicting event archives in ${dir}`);
  await writeFile(marker, "importing\n");
  await rename(join(dir, legacy[0]), eventSegmentPath(eventsPath, 1));
  await mirrorEventSegment(eventSegmentPath(eventsPath, 1));
  await writeNextSegment(eventsPath, 2);
  await rm(marker);
}

export async function mirrorEventSegment(plainPath: string): Promise<void> {
  const target = `${plainPath}.gz`;
  const existing = await stat(target).catch((error: unknown) => { if (isGone(error)) return undefined; throw error; });
  if (existing) return;
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await pipeline(createReadStream(plainPath), createGzip(), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    await rename(temporary, target);
    await writeFile(validationPath(plainPath), `${await pairVersion(plainPath, target)}\n`);
  }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** Called while snapshot staging holds the event lock. */
export async function mirrorMissingEventSegments(eventsPath: string): Promise<void> {
  for (const segment of await segmentNames(eventsPath)) {
    if (segment.plain && SEGMENT.test(basename(segment.plain)) && !segment.gzip) await mirrorEventSegment(segment.plain);
  }
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
  const mirrors = await withEventLogLock(eventsPath, async () => {
    await importLegacyEventArchive(eventsPath);
    const segments = await checkedSegments(eventsPath);
    const pendingMirrors = segments.flatMap((segment) => segment.plain && !segment.gzip ? [segment.plain] : []);
    if (segments.length > 0) {
      await stat(eventsPath).catch((error: unknown) => {
        if (isGone(error)) throw new Error(`Missing live event log: ${eventsPath}`);
        throw error;
      });
    }
    let nextNumber = segments.length + 1;
    if ((await recordedNextSegment(eventsPath)) !== nextNumber) await writeNextSegment(eventsPath, nextNumber);
    let currentSize = await stat(eventsPath).then((s) => s.size).catch((error: unknown) => { if (isGone(error)) return 0; throw error; });
    if (currentSize > 0) {
      const existing = await open(eventsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const tail = Buffer.alloc(1);
        await existing.read(tail, 0, 1, currentSize - 1);
        if (tail[0] !== 10) throw new Error(`Refusing to append to torn event log: ${eventsPath}`);
      } finally { await existing.close(); }
    }
    let writer: FileHandle | undefined;
    try {
      for (const record of records) {
        if (currentSize > 0 && currentSize + record.length > limit) {
          if (writer) { await writer.close(); writer = undefined; }
          const closed = eventSegmentPath(eventsPath, nextNumber++);
          await mkdir(eventArchiveDir(eventsPath), { recursive: true });
          await rename(eventsPath, closed);
          await writeNextSegment(eventsPath, nextNumber);
          pendingMirrors.push(closed);
          currentSize = 0;
        }
        writer ??= await open(eventsPath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
        await writer.writeFile(record);
        currentSize += record.length;
      }
    } finally { if (writer) await writer.close(); }
    return pendingMirrors;
  });
  for (const path of mirrors) await mirrorEventSegment(path);
}

interface OpenSegment { path: string; handle: FileHandle; size: number; gzip: boolean; mirror?: FileHandle }

/** Pin archive handles and the live byte bound under the writer lock. */
async function snapshotSegments(eventsPath: string): Promise<OpenSegment[]> {
  return withEventLogLock(eventsPath, async () => {
    const names = await checkedSegments(eventsPath);
    const opened: OpenSegment[] = [];
    try {
      for (const item of names) {
        const path = item.plain ?? item.gzip;
        if (!path) throw new Error(`Event segment ${item.number} has no readable copy`);
        const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const segment: OpenSegment = { path, handle, size: (await handle.stat()).size, gzip: !item.plain };
        opened.push(segment);
        if (item.plain && item.gzip) segment.mirror = await open(item.gzip, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      }
      const live = await open(eventsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error: unknown) => { if (isGone(error)) return undefined; throw error; });
      if (!live && (names.length > 0 || (await recordedNextSegment(eventsPath)) !== undefined)) {
        throw new Error(`Missing live event log: ${eventsPath}`);
      }
      if (live) opened.push({ path: eventsPath, handle: live, size: (await live.stat()).size, gzip: false });
      return opened;
    } catch (error) { await Promise.all(opened.flatMap((item) => [item.handle, item.mirror].filter((handle): handle is FileHandle => handle !== undefined)).map((handle) => handle.close())); throw error; }
  });
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

async function validateMirror(item: OpenSegment): Promise<void> {
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
  const segments = await snapshotSegments(eventsPath);
  try {
    for (const item of segments) {
      await validateMirror(item);
      let expanded = 0;
      if (item.size > 0) {
        const source = item.handle.createReadStream({ start: 0, end: item.size - 1, autoClose: false });
        const stream = item.gzip ? source.pipe(createGunzip()) : source;
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          expanded += bytes.length;
          if (expanded > MAX_EXPANDED_ARCHIVE_BYTES) throw new Error(`Expanded event archive exceeds safety limit: ${item.path}`);
          yield { path: item.path, bytes };
        }
      }
      yield { path: item.path, boundary: true };
    }
  } finally { await Promise.all(segments.flatMap((item) => [item.handle, item.mirror].filter((handle): handle is FileHandle => handle !== undefined)).map((handle) => handle.close().catch(() => undefined))); }
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
