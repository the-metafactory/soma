import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueKind, queueParams } from "../src/goal-kinds/queue";
import { rateKind, rateParams } from "../src/goal-kinds/rate";
import { feedKind, feedParams } from "../src/goal-kinds/feed";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const now = new Date("2026-10-14T10:00:00Z");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "soma-baseline-"));
  roots.push(root);
  const dir = join(root, ".config", "ranger");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "state.sqlite");
  const db = new Database(path, { create: true });
  try {
    db.run("CREATE TABLE escalations (status TEXT, route TEXT, closed_at TEXT, title TEXT)");
    db.run("INSERT INTO escalations VALUES ('open', 'escalate-hitl', NULL, 'private title')");
    db.run("INSERT INTO escalations VALUES ('open', 'provisioning', NULL, 'private title')");
    db.run("INSERT INTO escalations VALUES ('closed', 'escalate-hitl', '2026-10-13T10:00:00Z', 'private title')");
    db.run("INSERT INTO escalations VALUES ('closed', 'escalate-hitl', '2026-10-01T10:00:00Z', 'private title')");
  } finally { db.close(); }
  return { root, dir, path };
}

test("queue and rate baselines read counts without ledger, state or bus writes", async () => {
  const f = await fixture();
  const before = await readFile(f.path);
  const queue = queueParams.parse({ goal: "G0", source: "ranger-escalations", max: 0 });
  const rate = rateParams.parse({ goal: "G0", source: "ranger-escalations", min: 2, window_workdays: 3 });
  const deps = { homeDir: f.root, now: () => now };
  expect(await queueKind.baseline(queue, deps)).toEqual({ state: "off-track", summary: "1 open escalate-hitl escalations, max 0" });
  expect(await queueKind.baseline({ ...queue, max: 1 }, deps)).toMatchObject({ state: "on-track" });
  expect(await rateKind.baseline(rate, deps)).toEqual({ state: "off-track",
    summary: "1 closed escalate-hitl escalations, min 2 in 3 workdays (Europe/Zurich)" });
  expect(await rateKind.baseline({ ...rate, min: 1 }, deps)).toMatchObject({ state: "on-track" });
  expect(await readFile(f.path)).toEqual(before);
  expect(await readdir(f.dir)).toEqual(["state.sqlite"]);
  expect(await readdir(f.root)).toEqual([".config"]);
});

test("journal baseline errors propagate without creating a journal or false state", async () => {
  const f = await fixture();
  const journalPath = join(f.root, "absent.sqlite");
  const deps = { journalPath, now: () => now };
  await expect(queueKind.baseline(queueParams.parse({ goal: "G0", source: "ranger-escalations", max: 3 }), deps)).rejects.toThrow();
  await expect(rateKind.baseline(rateParams.parse({ goal: "G0", source: "ranger-escalations", min: 1, window_workdays: 3 }), deps)).rejects.toThrow();
  expect(await readdir(f.root)).toEqual([".config"]);
});

test("feed baseline reads once, honors the window and link filter, and exposes only counts", async () => {
  let reads = 0;
  const url = "https://private.example.org/feed?token=fixture";
  const params = feedParams.parse({ goal: "G0", url, window_days: 7, min: 2, link_match: "/shorts/" });
  const result = await feedKind.baseline(params, {
    now: () => now,
    fetch: async (requested, init) => {
      reads++;
      expect(requested).toBe(url);
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(`<rss><channel>
        <item><pubDate>2026-10-13T10:00:00Z</pubDate><link>https://video.example/shorts/1</link><title>Private title</title></item>
        <item><pubDate>2026-10-13T10:00:00Z</pubDate><link>https://video.example/watch/2</link></item>
        <item><pubDate>2026-10-01T10:00:00Z</pubDate><link>https://video.example/shorts/3</link></item>
      </channel></rss>`);
    },
  });
  expect(reads).toBe(1);
  expect(result).toEqual({ state: "off-track", summary: "1 items in 7 days, min 2" });
  expect(JSON.stringify(result)).not.toContain(url);
  expect(JSON.stringify(result)).not.toContain("Private title");
});
