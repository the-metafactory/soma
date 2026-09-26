import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { appendEventBatch, eventArchiveDir, eventIndexPath, eventSegmentPath, streamEventLines, streamEventRecords } from "../src/event-log";
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

test("reader uses gzip fallback and reports missing or conflicting segments", async () => {
  const { events } = await home();
  for (let i = 0; i < 12; i++) await appendEventBatch(events, Buffer.from(`${JSON.stringify({ i })}\n`), 30);
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

test("reader detects conflicting plain and gzip copies", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 12);
  const first = eventSegmentPath(events, 1);
  expect(await lines(events)).toHaveLength(2);
  await writeFile(`${first}.gz`, gzipSync('{"i":999}\n'));
  await expect(lines(events)).rejects.toThrow(/Conflicting event segment copies/);
  await expect(streamEventRecords(events).next()).rejects.toThrow(/Conflicting event segment copies/);
});

test("high water mark detects loss of the last closed segment", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 12);
  await appendEventBatch(events, Buffer.from('{"i":3}\n'), 12);
  const last = eventSegmentPath(events, 2);
  await rm(last);
  await rm(`${last}.gz`);
  await expect(lines(events)).rejects.toThrow(/Missing event segment 2/);
  await expect(appendEventBatch(events, Buffer.from('{"i":4}\n'), 12)).rejects.toThrow(/Missing event segment 2/);
});

test("reader and writer refuse segmented history with a missing index", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 12);
  await rm(eventIndexPath(events));
  await expect(lines(events)).rejects.toThrow(/Missing event segment index/);
  await expect(appendEventBatch(events, Buffer.from('{"i":3}\n'), 12)).rejects.toThrow(/Missing event segment index/);
});

test("reader rejects an index behind the discovered archive", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 12);
  await writeFile(eventIndexPath(events), '{"nextSegment":1}\n');
  await expect(lines(events)).rejects.toThrow(/index trails archive/);
});

test("writer refuses to recreate a lost live file", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 12);
  await rm(events);
  await expect(appendEventBatch(events, Buffer.from('{"i":3}\n'), 12)).rejects.toThrow(/Missing live event log/);
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

test("first legacy import refuses a missing live tail", async () => {
  const { events } = await home();
  const archive = eventArchiveDir(events);
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, "events-until-2026-08-24T18-48-54Z.jsonl"), '{"i":0}\n');
  await expect(appendEventBatch(events, Buffer.from('{"i":1}\n'), 12)).rejects.toThrow(/Missing live event log/);
});

test("reader rejects loss of the live file after history was written", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 12);
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

test("one large batch splits only at record boundaries", async () => {
  const { events } = await home();
  await appendEventBatch(events, Buffer.from('{"i":1}\n{"i":2}\n{"i":3}\n'), 16);
  expect((await lines(events)).map((line) => JSON.parse(line).i)).toEqual([1, 2, 3]);
});

test("legacy archive import preserves bytes and rollback retains history and sequence", async () => {
  const { root, events } = await home();
  await createSomaSnapshot({ somaHome: root, name: "old" });
  const snapshot = await createSomaSnapshot({ somaHome: root, name: "older" });
  const archive = eventArchiveDir(events);
  await mkdir(archive, { recursive: true });
  await Bun.write(join(archive, "events-until-2026-08-24T18-48-54Z.jsonl"), '{"i":0}\n');
  await writeFile(events, "");
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 12);
  expect(await readFile(eventSegmentPath(events, 1), "utf8")).toBe('{"i":0}\n');
  const before = await lines(events);
  await rollbackSomaSnapshot({ somaHome: root, snapshot: snapshot.id });
  expect(await lines(events)).toEqual(before);
  await appendEventBatch(events, Buffer.from('{"i":3}\n'), 12);
  expect((await lines(events)).map((line) => JSON.parse(line).i)).toEqual([0, 1, 2, 3]);
  expect((await readdir(archive)).filter((name) => name.endsWith(".jsonl"))).toContain("events-000003.jsonl");
});

test("private snapshots track gzip mirrors but not active or plain archives", async () => {
  const { root, events } = await home();
  await createSomaSnapshot({ somaHome: root, name: "baseline" });
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 12);
  await createSomaSnapshot({ somaHome: root, name: "with-mirror" });
  const tracked = spawnSync("git", ["ls-files", "memory/STATE"], { cwd: root, encoding: "utf8" }).stdout;
  expect(tracked).toContain("events-000001.jsonl.gz");
  expect(tracked).not.toMatch(/events-000001\.jsonl\n/);
  expect(tracked).not.toMatch(/events\.jsonl\n/);
});

test("snapshot stages a mirror when compression is pending", async () => {
  const { root, events } = await home();
  await createSomaSnapshot({ somaHome: root, name: "baseline" });
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 12);
  const first = eventSegmentPath(events, 1);
  await rm(`${first}.gz`);
  await createSomaSnapshot({ somaHome: root, name: "closed" });
  expect(gunzipSync(await readFile(`${first}.gz`)).toString()).toBe('{"i":1}\n');
  const tracked = spawnSync("git", ["ls-files", "memory/STATE"], { cwd: root, encoding: "utf8" }).stdout;
  expect(tracked).toContain("events-000001.jsonl.gz");
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
  await appendEventBatch(events, Buffer.from('{"i":1}\n'), 12);
  await appendEventBatch(events, Buffer.from('{"i":2}\n'), 12);
  const first = eventSegmentPath(events, 1);
  await appendFile(first, "bad");
  await expect(lines(events)).rejects.toThrow(/Conflicting event segment copies|Torn event record/);
});
