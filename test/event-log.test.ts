import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { appendEventBatch, ensureCompressedEventSegments, eventArchiveDir, eventIndexPath, eventSegmentPath, compressEventSegment, streamEventLines, streamEventRecords, withEventLogLock } from "../src/event-log";
import { createSomaSnapshot, rollbackSomaSnapshot } from "../src/snapshots";

const homes: string[] = [];
async function home(): Promise<{ root: string; events: string }> {
  const root = await mkdtemp(join(tmpdir(), "soma-event-log-"));
  homes.push(root);
  return { root, events: join(root, "memory/STATE/events.jsonl") };
}
async function lines(path: string): Promise<string[]> {
  const result: string[] = [];
  for await (const line of streamEventLines(path)) result.push(line);
  return result;
}
async function oneClosedSegment(events: string): Promise<void> {
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 12);
  await withEventLogLock(events, () => ensureCompressedEventSegments(events));
}
afterEach(async () => { await Promise.all(homes.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("cross-process append rotates complete ordered segments without duplicates", async () => {
  const { events } = await home();
  const modulePath = join(import.meta.dir, "../src/event-log.ts");
  const processes = Array.from({ length: 4 }, (_, worker) => Bun.spawn([
    "bun", "-e",
    `import { appendEventBatch } from ${JSON.stringify(modulePath)}; for(let i=0;i<20;i++) await appendEventBatch(${JSON.stringify(events)}, Buffer.from(JSON.stringify({worker:${worker},i})+'\\n'), 120);`,
  ], { stdout: "pipe", stderr: "pipe" }));
  const exits = await Promise.all(processes.map((proc) => proc.exited));
  expect(exits).toEqual([0, 0, 0, 0]);
  await withEventLogLock(events, () => ensureCompressedEventSegments(events));
  const all = (await lines(events)).map((line) => JSON.parse(line) as { worker: number; i: number });
  expect(all).toHaveLength(80);
  expect(new Set(all.map((event) => `${event.worker}:${event.i}`)).size).toBe(80);
  const archive = eventArchiveDir(events);
  const names = await readdir(archive);
  const plain = names.filter((name) => name.endsWith(".jsonl"));
  expect(plain.length).toBeGreaterThan(1);
  for (const name of plain) {
    const bytes = await readFile(join(archive, name));
    expect(bytes[bytes.length - 1]).toBe(10);
    expect(names).toContain(`${name}.gz`);
  }
});

test("an ownerless stale lock is not reclaimed while its creator could be alive", async () => {
  const { events } = await home();
  const lock = join(dirname(events), ".events.lock");
  await mkdir(dirname(events), { recursive: true });
  await mkdir(lock);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  const append = appendEventBatch(events, Buffer.from('{"i":1}\n'));
  try {
    await sleep(100);
    expect((await stat(lock)).isDirectory()).toBe(true);
  } finally { await rm(lock, { recursive: true, force: true }); }
  await append;
});

test("reader uses gzip fallback and reports missing or conflicting segments", async () => {
  const { events } = await home();
  for (let i = 0; i < 12; i++) await appendEventBatch(events, Buffer.from(`${JSON.stringify({ i })}\n`), 30);
  await withEventLogLock(events, () => ensureCompressedEventSegments(events));
  const expected = await lines(events);
  const first = eventSegmentPath(events, 1);
  await rm(first);
  expect(await lines(events)).toEqual(expected);
  const citation = (await Array.fromAsync(streamEventRecords(events)))[0];
  expect(citation.path).toBe(`${first}.gz`);
  expect(citation.lineNumber).toBe(1);
  expect(gunzipSync(await readFile(citation.path)).toString().split("\n")[citation.lineNumber - 1]).toBe(citation.line);
  await expect(readFile(first)).rejects.toThrow();
  const second = eventSegmentPath(events, 2);
  await rm(second);
  await rm(`${second}.gz`);
  await expect(lines(events)).rejects.toThrow(/Missing event segment 2/);
});

test("reader uses the legacy gzip copy when its plain archive is gone", async () => {
  const { events } = await home();
  const archive = eventArchiveDir(events);
  await mkdir(archive, { recursive: true });
  const legacy = join(archive, "events-until-2026-08-24T18-48-54Z.jsonl.gz");
  await writeFile(legacy, gzipSync('{"i":0}\n'));
  await writeFile(events, '{"i":1}\n');
  expect((await lines(events)).map((line) => JSON.parse(line).i)).toEqual([0, 1]);
});

test("first writer imports a gzip-only legacy archive as segment one", async () => {
  const { events } = await home();
  const archive = eventArchiveDir(events);
  await mkdir(archive, { recursive: true });
  const legacy = join(archive, "events-until-2026-08-24T18-48-54Z.jsonl.gz");
  await writeFile(legacy, gzipSync('{"i":0}\n'));
  await writeFile(events, "");
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  expect((await lines(events)).map((line) => (JSON.parse(line) as { i: number }).i)).toEqual([0, 1]);
  expect(gunzipSync(await readFile(`${eventSegmentPath(events, 1)}.gz`)).toString()).toBe('{"i":0}\n');
  await expect(readFile(legacy)).rejects.toThrow();
});

test("writer finishes an interrupted gzip-only legacy import", async () => {
  const { events } = await home();
  const archive = eventArchiveDir(events);
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, ".legacy-importing"), "importing\n");
  await writeFile(`${eventSegmentPath(events, 1)}.gz`, gzipSync('{"i":0}\n'));
  await writeFile(events, "");
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  expect((await lines(events)).map((line) => (JSON.parse(line) as { i: number }).i)).toEqual([0, 1]);
  await expect(readFile(join(archive, ".legacy-importing"))).rejects.toThrow();
});

test("reader rejects an empty gzip fallback", async () => {
  const { events } = await home();
  await oneClosedSegment(events);
  const first = eventSegmentPath(events, 1);
  await rm(first);
  await writeFile(`${first}.gz`, "");
  await expect(lines(events)).rejects.toThrow(/Empty closed event segment/);
});

test("reader rejects a valid gzip that expands to an empty segment", async () => {
  const { events } = await home();
  await oneClosedSegment(events);
  const first = eventSegmentPath(events, 1);
  await rm(first);
  await writeFile(`${first}.gz`, gzipSync(""));
  await expect(lines(events)).rejects.toThrow(/Empty closed event segment/);
});

test("reader rejects an empty closed plain segment", async () => {
  const { events } = await home();
  await oneClosedSegment(events);
  const first = eventSegmentPath(events, 1);
  await writeFile(first, "");
  await rm(`${first}.gz`);
  await expect(lines(events)).rejects.toThrow(/Empty closed event segment/);
});

test("mirror creation rejects a symlinked segment", async () => {
  const { root, events } = await home();
  await mkdir(eventArchiveDir(events), { recursive: true });
  const outside = join(root, "outside-secret.txt");
  await writeFile(outside, "secret\n");
  const segment = eventSegmentPath(events, 1);
  await symlink(outside, segment);
  await expect(compressEventSegment(segment)).rejects.toThrow();
  await expect(readFile(`${segment}.gz`)).rejects.toThrow();
});

test("reader detects conflicting plain and gzip copies", async () => {
  const { events } = await home();
  await oneClosedSegment(events);
  const first = eventSegmentPath(events, 1);
  expect(await lines(events)).toHaveLength(2);
  await writeFile(`${first}.gz`, gzipSync('{"i":999}\n'));
  await expect(lines(events)).rejects.toThrow(/Conflicting event segment copies/);
  await expect(streamEventRecords(events).next()).rejects.toThrow(/Conflicting event segment copies/);
});

test("high water mark detects loss of the last closed segment", async () => {
  const { events } = await home();
  await oneClosedSegment(events);
  await appendEventBatch(events, Buffer.from('{"i":3}\n'), 12);
  await withEventLogLock(events, () => ensureCompressedEventSegments(events));
  const last = eventSegmentPath(events, 2);
  await rm(last);
  await rm(`${last}.gz`);
  await expect(lines(events)).rejects.toThrow(/Missing event segment 2/);
  await expect(appendEventBatch(events, Buffer.from('{"i":4}\n'), 12)).rejects.toThrow(/Missing event segment 2/);
});

test("reader and writer refuse segmented history with a missing index", async () => {
  const { events } = await home();
  await oneClosedSegment(events);
  await rm(eventIndexPath(events));
  await expect(lines(events)).rejects.toThrow(/Missing event segment index/);
  await expect(appendEventBatch(events, Buffer.from('{"i":3}\n'), 12)).rejects.toThrow(/Missing event segment index/);
});

test("reader rejects an index behind the discovered archive", async () => {
  const { events } = await home();
  await oneClosedSegment(events);
  await writeFile(eventIndexPath(events), '{"nextSegment":1}\n');
  await expect(lines(events)).rejects.toThrow(/index trails archive/);
});

test("writer refuses to recreate a lost live file", async () => {
  const { events } = await home();
  await oneClosedSegment(events);
  await rm(events);
  await expect(appendEventBatch(events, Buffer.from('{"i":3}\n'), 12)).rejects.toThrow(/Missing live event log/);
});

test("writer refuses a missing live file before the first rotation", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n'));
  await rm(events);
  await expect(appendEventBatch(events, Buffer.from('{"i":2}\n'))).rejects.toThrow(/Missing live event log/);
});

test("writer recovers an interrupted marked legacy import", async () => {
  const { events } = await home();
  const archive = eventArchiveDir(events);
  await mkdir(archive, { recursive: true });
  await writeFile(eventSegmentPath(events, 1), '{"i":0}\n');
  await writeFile(join(archive, ".legacy-importing"), "importing\n");
  await writeFile(events, "");
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  expect((await lines(events)).map((line) => JSON.parse(line).i)).toEqual([0, 1]);
  expect(JSON.parse(await readFile(eventIndexPath(events), "utf8")).nextSegment).toBe(2);
});

test("writer recovers rotation after the live file was renamed", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  await mkdir(eventArchiveDir(events), { recursive: true });
  await writeFile(join(dirname(events), ".rotation-pending.json"), '{"number":1}\n');
  await rename(events, eventSegmentPath(events, 1));
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 12);
  expect((await lines(events)).map((line) => JSON.parse(line).i)).toEqual([1, 2]);
  expect(JSON.parse(await readFile(eventIndexPath(events), "utf8")).nextSegment).toBe(2);
});

test("append commits records before gzip maintenance", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 12);
  expect((await lines(events)).map((line) => JSON.parse(line).i)).toEqual([1, 2]);
  await expect(readFile(`${eventSegmentPath(events, 1)}.gz`)).rejects.toThrow();
  await withEventLogLock(events, () => ensureCompressedEventSegments(events));
  expect(gunzipSync(await readFile(`${eventSegmentPath(events, 1)}.gz`)).toString()).toBe('{"i":1}\n');
});

test("first legacy import refuses a missing live tail", async () => {
  const { events } = await home();
  const archive = eventArchiveDir(events);
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, "events-until-2026-08-24T18-48-54Z.jsonl"), '{"i":0}\n');
  await expect(appendEventBatch(events, Buffer.from('{"i":1}\n'), 12)).rejects.toThrow(/Missing live event log/);
});

test("reader rejects loss of the live file after history was written", async () => {
  const { events } = await home();
  await oneClosedSegment(events);
  await rm(events);
  await expect(lines(events)).rejects.toThrow(/Missing live event log/);
});

test("reader rejects valid JSON without a terminating newline", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n'));
  await writeFile(events, '{"i":1}');
  await expect(lines(events)).rejects.toThrow(/Torn event record/);
});

test("reader snapshot sees a rotating live file exactly once", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 16);
  const snapshot = streamEventLines(events);
  expect((await snapshot.next()).value).toBe('{"i":1}');
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 16);
  expect((await snapshot.next()).done).toBe(true);
  expect((await lines(events)).map((line) => JSON.parse(line).i)).toEqual([1, 2]);
});

test("reader can inspect a readable home without write permission", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n'));
  await chmod(dirname(events), 0o500);
  try { expect(await lines(events)).toEqual(['{"i":1}']); }
  finally { await chmod(dirname(events), 0o700); }
});

test("large archive reads use a bounded-handle lease", async () => {
  const { events } = await home();
  for (let i = 0; i < 66; i++) await appendEventBatch(events, Buffer.from(`${JSON.stringify({ i })}\n`), 12);
  const reader = streamEventRecords(events);
  expect((await reader.next()).value?.line).toBe('{"i":0}');
  expect((await readdir(join(dirname(events), ".events.readers"))).length).toBe(1);
  const all = [0];
  for await (const record of reader) all.push((JSON.parse(record.line) as { i: number }).i);
  expect(all).toEqual(Array.from({ length: 66 }, (_, i) => i));
  expect(await readdir(join(dirname(events), ".events.readers"))).toEqual([]);
});

test("rollback waits for a leased archive reader", async () => {
  const { root, events } = await home();
  const target = await createSomaSnapshot({ somaHome: root, name: "before-events" });
  for (let i = 0; i < 66; i++) await appendEventBatch(events, Buffer.from(`${JSON.stringify({ i })}\n`), 12);
  const reader = streamEventRecords(events);
  expect((await reader.next()).value?.line).toBe('{"i":0}');
  let finished = false;
  const rollback = rollbackSomaSnapshot({ somaHome: root, snapshot: target.id }).then(() => { finished = true; });
  const gate = join(dirname(events), ".events.rollback");
  for (let i = 0; i < 100; i++) {
    if (await stat(gate).then(() => true).catch(() => false)) break;
    await Bun.sleep(10);
  }
  expect(await stat(gate).then(() => true).catch(() => false)).toBe(true);
  expect(finished).toBe(false);
  await appendEventBatch(events, Buffer.from('{"i":66}\n'), 12);
  const nextReader = streamEventRecords(events);
  let nextReaderStarted = false;
  const nextRead = nextReader.next().then((value) => { nextReaderStarted = true; return value; });
  await Bun.sleep(50);
  expect(nextReaderStarted).toBe(false);
  await reader.return(undefined);
  await rollback;
  expect((await nextRead).value?.line).toBe('{"i":0}');
  await nextReader.return(undefined);
  expect((await lines(events)).length).toBe(67);
  expect(await stat(gate).then(() => true).catch(() => false)).toBe(false);
});

test("one large batch splits only at record boundaries", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n{"i":2}\n{"i":3}\n'), 8);
  await withEventLogLock(events, () => ensureCompressedEventSegments(events));
  expect((await lines(events)).map((line) => JSON.parse(line).i)).toEqual([1, 2, 3]);
  expect(await readFile(`${eventSegmentPath(events, 1)}.gz`)).toBeTruthy();
  expect(await readFile(`${eventSegmentPath(events, 2)}.gz`)).toBeTruthy();
});

test("legacy archive import preserves bytes and rollback retains history and sequence", async () => {
  const { root, events } = await home();
  await createSomaSnapshot({ somaHome: root, name: "old" });
  const snapshot = await createSomaSnapshot({ somaHome: root, name: "older" });
  const archive = eventArchiveDir(events);
  await mkdir(archive, { recursive: true });
  await Bun.write(join(archive, "events-until-2026-08-24T18-48-54Z.jsonl"), '{"i":0}\n');
  await writeFile(events, "");
  await oneClosedSegment(events);
  expect(await readFile(eventSegmentPath(events, 1), "utf8")).toBe('{"i":0}\n');
  const before = await lines(events);
  await rollbackSomaSnapshot({ somaHome: root, snapshot: snapshot.id });
  expect(await lines(events)).toEqual(before);
  await appendEventBatch(events, Buffer.from('{"i":3}\n'), 12);
  expect((await lines(events)).map((line) => JSON.parse(line).i)).toEqual([0, 1, 2, 3]);
  expect((await readdir(archive)).filter((name) => name.endsWith(".jsonl"))).toContain("events-000003.jsonl");
});

test("snapshot protects the legacy archive before its first import", async () => {
  const { root, events } = await home();
  await createSomaSnapshot({ somaHome: root, name: "baseline" });
  const archive = eventArchiveDir(events);
  await mkdir(archive, { recursive: true });
  const legacy = join(archive, "events-until-2026-08-24T18-48-54Z.jsonl");
  await writeFile(legacy, '{"i":0}\n');
  await writeFile(events, "");
  await createSomaSnapshot({ somaHome: root, name: "legacy-protected" });
  expect(gunzipSync(await readFile(`${legacy}.gz`)).toString()).toBe('{"i":0}\n');
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  expect(gunzipSync(await readFile(`${eventSegmentPath(events, 1)}.gz`)).toString()).toBe('{"i":0}\n');
  expect((await lines(events)).map((line) => JSON.parse(line).i)).toEqual([0, 1]);
});

test("snapshot saves counts after scanning a gzip-only legacy archive", async () => {
  const { root, events } = await home();
  const archive = eventArchiveDir(events);
  await mkdir(archive, { recursive: true });
  const legacy = join(archive, "events-until-2026-08-24T18-48-54Z.jsonl.gz");
  await writeFile(legacy, gzipSync('{"i":0}\n'));
  await writeFile(events, "");
  await createSomaSnapshot({ somaHome: root, name: "legacy-counts" });
  const countsPath = legacy.slice(0, -3) + ".counts.json";
  const counts = await readFile(countsPath, "utf8");
  expect(JSON.parse(counts) as { skippedMalformedLines: number }).toHaveProperty("skippedMalformedLines", 1);
  await createSomaSnapshot({ somaHome: root, name: "legacy-counts-again" });
  expect(await readFile(countsPath, "utf8")).toBe(counts);
});

test("private snapshots track gzip mirrors but not active or plain archives", async () => {
  const { root, events } = await home();
  await createSomaSnapshot({ somaHome: root, name: "baseline" });
  await oneClosedSegment(events);
  await createSomaSnapshot({ somaHome: root, name: "with-mirror" });
  const tracked = spawnSync("git", ["ls-files", "memory/STATE"], { cwd: root, encoding: "utf8" }).stdout;
  expect(tracked).toContain("events-000001.jsonl.gz");
  expect(tracked).not.toMatch(/events-000001\.jsonl\n/);
  expect(tracked).not.toMatch(/events\.jsonl\n/);
});

test("snapshot stages a mirror when compression is pending", async () => {
  const { root, events } = await home();
  await createSomaSnapshot({ somaHome: root, name: "baseline" });
  await oneClosedSegment(events);
  const first = eventSegmentPath(events, 1);
  await rm(`${first}.gz`);
  await createSomaSnapshot({ somaHome: root, name: "closed" });
  expect(gunzipSync(await readFile(`${first}.gz`)).toString()).toBe('{"i":1}\n');
  const tracked = spawnSync("git", ["ls-files", "memory/STATE"], { cwd: root, encoding: "utf8" }).stdout;
  expect(tracked).toContain("events-000001.jsonl.gz");
});

test("snapshot rejects an existing mirror that disagrees with plain history", async () => {
  const { root, events } = await home();
  await createSomaSnapshot({ somaHome: root, name: "baseline" });
  await oneClosedSegment(events);
  await writeFile(`${eventSegmentPath(events, 1)}.gz`, gzipSync('{"i":999}\n'));
  await expect(createSomaSnapshot({ somaHome: root, name: "corrupt" })).rejects.toThrow(/Conflicting event segment copies/);
});

test("snapshot rejects a corrupt gzip-only segment", async () => {
  const { root, events } = await home();
  await createSomaSnapshot({ somaHome: root, name: "baseline" });
  await oneClosedSegment(events);
  const first = eventSegmentPath(events, 1);
  await rm(first);
  await writeFile(`${first}.gz`, "corrupt gzip");
  await expect(createSomaSnapshot({ somaHome: root, name: "corrupt" })).rejects.toThrow();
});

test("snapshot caches validation for an unchanged gzip-only segment", async () => {
  const { root, events } = await home();
  await createSomaSnapshot({ somaHome: root, name: "baseline" });
  await oneClosedSegment(events);
  const first = eventSegmentPath(events, 1);
  await rm(first);
  await createSomaSnapshot({ somaHome: root, name: "gzip-only" });
  expect(await readFile(`${first}.validation`, "utf8")).toMatch(/^gzip:/);
  await createSomaSnapshot({ somaHome: root, name: "gzip-only-again" });
});

test("rollback preserves the archive if live backup fails before the archive moves", async () => {
  const { root, events } = await home();
  const baseline = await createSomaSnapshot({ somaHome: root, name: "baseline" });
  await oneClosedSegment(events);
  const first = eventSegmentPath(events, 1);
  const original = await readFile(first);
  await rm(events);
  await mkdir(events);
  await expect(rollbackSomaSnapshot({ somaHome: root, snapshot: baseline.id })).rejects.toThrow();
  expect(await readFile(first)).toEqual(original);
});

test("snapshot refuses a missing final segment despite a surviving index", async () => {
  const { root, events } = await home();
  await createSomaSnapshot({ somaHome: root, name: "baseline" });
  for (let i = 1; i <= 3; i++) await appendEventBatch(events, Buffer.from(`${JSON.stringify({ i })}\n`), 12);
  const last = eventSegmentPath(events, 2);
  await rm(last);
  await rm(`${last}.gz`, { force: true });
  await expect(createSomaSnapshot({ somaHome: root, name: "incomplete" })).rejects.toThrow(/Missing event segment 2/);
});

test("rollback replaces snapshot archive with the protected live archive", async () => {
  const { root, events } = await home();
  await createSomaSnapshot({ somaHome: root, name: "baseline" });
  for (let i = 1; i <= 4; i++) await appendEventBatch(events, Buffer.from(`${JSON.stringify({ i })}\n`), 12);
  const target = await createSomaSnapshot({ somaHome: root, name: "three-segments" });
  const third = eventSegmentPath(events, 3);
  await rm(third);
  await rm(`${third}.gz`);
  await writeFile(eventIndexPath(events), '{"nextSegment":3}\n');
  await rollbackSomaSnapshot({ somaHome: root, snapshot: target.id });
  expect((await readdir(eventArchiveDir(events))).some((name) => /^events-000003\.jsonl(\.gz)?$/.test(name))).toBe(false);
  expect((await lines(events)).map((line) => JSON.parse(line).i)).toEqual([1, 2, 4]);
});

test("reader rejects a torn archived record", async () => {
  const { events } = await home();
  await oneClosedSegment(events);
  const first = eventSegmentPath(events, 1);
  await appendFile(first, "bad");
  await expect(lines(events)).rejects.toThrow(/Conflicting event segment copies|Torn event record/);
});
