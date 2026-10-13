import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { validateExecutionRunFinished, type ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import { FEED_FETCH_TIMEOUT_MS, runFeedSensor, type FeedFetch, type FeedSensorDeps, type FeedSensorOptions } from "../src/goal-sense";
import { buildRunFinishedEnvelope, type RunLedgerEnv } from "../src/run-ledger";

// `soma goal sense feed` (node #838): count one feed's items in a rolling
// window and publish the goal's state through the run ledger (soma#786 D3–D5).

const NOW = new Date("2026-10-12T06:30:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const URL = "https://feed.example.test/feed.xml";
const FIXTURES = join(import.meta.dir, "fixtures", "goal-sense");

const fixture = (name: string): Promise<string> => readFile(join(FIXTURES, name), "utf8");
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);
const rfc822 = (date: Date): string => date.toUTCString().replace("GMT", "+0000");

function rss(...pubDates: (string | undefined)[]): string {
  const items = pubDates.map((date, index) =>
    `<item><title>Item ${index + 1}</title>${date === undefined ? "" : `<pubDate>${date}</pubDate>`}</item>`).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`;
}

function atom(...entries: { published?: string; updated?: string }[]): string {
  const body = entries.map((entry) => `<entry><title>E</title>${
    entry.published === undefined ? "" : `<published>${entry.published}</published>`}${
    entry.updated === undefined ? "" : `<updated>${entry.updated}</updated>`}</entry>`).join("");
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>${body}</feed>`;
}

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

interface Harness {
  events: ExecutionRunFinishedEvent[];
  stdout: string[];
  stderr: string[];
  fetched: string[];
  deps: FeedSensorDeps;
}

async function harness(
  respond: FeedFetch | string,
  env: RunLedgerEnv = { SOMA_PRINCIPAL: "jc" },
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "soma-goal-sense-"));
  homes.push(dir);
  const events: ExecutionRunFinishedEvent[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetched: string[] = [];
  const fetchFeed: FeedFetch = typeof respond === "string"
    ? () => Promise.resolve(new Response(respond, { status: 200 }))
    : respond;
  return {
    events,
    stdout,
    stderr,
    fetched,
    deps: {
      somaHome: join(dir, ".soma"),
      env,
      now: () => NOW,
      fetch: (url, init) => {
        fetched.push(url);
        return fetchFeed(url, init);
      },
      publish: (event) => {
        events.push(event);
        return Promise.resolve();
      },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  };
}

const DEFAULTS: FeedSensorOptions = { goal: "G5", url: URL, windowDays: 7, min: 1 };

describe("soma goal sense feed", () => {
  test("an RSS 2.0 item dated 3 days ago is on-track: one job envelope serving the goal", async () => {
    const h = await harness(await fixture("rss.xml"));

    const result = await runFeedSensor(DEFAULTS, h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.fetched).toEqual([URL]);
    expect(h.events).toHaveLength(1);
    expect(h.events[0].input.payload).toMatchObject({
      producer: "soma",
      ran: { kind: "job", ref: "goal-sense/G5" },
      serves: { goal: "G5" },
      outcome: "succeeded",
      started_at: NOW.toISOString(),
      ended_at: NOW.toISOString(),
      state: { subject: "G5", value: "on-track" },
    });
    expect(h.stderr).toEqual([]);
  });

  test("the envelope carries no URL, feed title or item text anywhere", async () => {
    const h = await harness(await fixture("rss.xml"));
    await runFeedSensor(DEFAULTS, h.deps);

    const envelope = await buildRunFinishedEnvelope(h.events[0]);
    expect(validateExecutionRunFinished(envelope)).toEqual({ valid: true, errors: [] });
    const wire = JSON.stringify(envelope);
    for (const text of [URL, "feed.example.test", "https:", "Fixture Feed Title", "Fixture Item Title", "Fixture item text", "fixture-item", "Fixture channel"]) {
      expect(wire).not.toContain(text);
    }
    expect(Object.keys(envelope.payload as object).sort()).toEqual(
      ["correlation_id", "ended_at", "outcome", "producer", "ran", "run_id", "serves", "started_at", "state"],
    );
  });

  test("an Atom feed whose newest entry was published 8 days ago is off-track", async () => {
    const h = await harness(await fixture("atom.xml"));

    expect((await runFeedSensor(DEFAULTS, h.deps)).exitCode).toBe(0);

    expect(h.events[0].input.payload).toMatchObject({ outcome: "succeeded", state: { subject: "G5", value: "off-track" } });
  });

  test("an Atom entry with no <published> is dated by its <updated>", async () => {
    const h = await harness(atom({ updated: daysAgo(2).toISOString() }));
    await runFeedSensor(DEFAULTS, h.deps);
    expect(h.events[0].input.payload.state).toEqual({ subject: "G5", value: "on-track" });
  });

  test("an item dated after now is not counted", async () => {
    const h = await harness(rss(rfc822(new Date(NOW.getTime() + DAY_MS))));
    const result = await runFeedSensor(DEFAULTS, h.deps);
    expect(result).toMatchObject({ exitCode: 0, count: 0, value: "off-track" });
    expect(h.events[0].input.payload.state).toEqual({ subject: "G5", value: "off-track" });
  });

  test("--min 2 with one item inside the window is off-track", async () => {
    const h = await harness(rss(rfc822(daysAgo(1)), rfc822(daysAgo(10))));
    const result = await runFeedSensor({ ...DEFAULTS, min: 2 }, h.deps);
    expect(result).toMatchObject({ exitCode: 0, count: 1, value: "off-track" });
    expect(h.events[0].input.payload.state).toEqual({ subject: "G5", value: "off-track" });
  });

  test("--window-days widens the window", async () => {
    const h = await harness(await fixture("atom.xml"));
    expect(await runFeedSensor({ ...DEFAULTS, windowDays: 9 }, h.deps)).toMatchObject({ count: 1, value: "on-track" });
  });

  test.each([
    ["an RSS feed", rss()],
    ["an Atom feed", atom()],
  ])("%s with no items is off-track", async (_label, body) => {
    const h = await harness(body);
    expect(await runFeedSensor(DEFAULTS, h.deps)).toMatchObject({ exitCode: 0, count: 0, value: "off-track" });
    expect(h.events[0].input.payload).toMatchObject({ outcome: "succeeded", state: { subject: "G5", value: "off-track" } });
  });

  test("an item whose date does not parse is skipped with one warning naming its position; the rest count", async () => {
    const h = await harness(rss("not a date", rfc822(daysAgo(1)), undefined, rfc822(daysAgo(2))));

    const result = await runFeedSensor({ ...DEFAULTS, min: 2 }, h.deps);

    expect(result).toMatchObject({ exitCode: 0, count: 2, value: "on-track" });
    expect(h.stderr).toHaveLength(2);
    expect(h.stderr[0]).toContain("item 1");
    expect(h.stderr[1]).toContain("item 3");
    expect(h.stderr.join("\n")).not.toContain("not a date");
  });

  const failures: [string, FeedFetch | string, string][] = [
    ["a DNS failure", () => Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })), "ENOTFOUND"],
    ["a timeout", () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")), "timed out after 10 s"],
    ["a non-2xx status", () => Promise.resolve(new Response("gone", { status: 404 })), "HTTP 404"],
    ["a body with neither an <rss> nor a <feed> root", "<html><body><item>x</item></body></html>", "neither an RSS nor an Atom feed"],
    ["an RDF root", "<?xml version=\"1.0\"?><rdf:RDF><item/></rdf:RDF>", "neither an RSS nor an Atom feed"],
  ];
  for (const [name, respond, cause] of failures) {
    test(`${name} publishes one failed envelope with no state and exits 1`, async () => {
      const h = await harness(respond);

      const result = await runFeedSensor(DEFAULTS, h.deps);

      expect(result.exitCode).toBe(1);
      expect(result.error).toContain(cause);
      expect(result.error).not.toContain(URL);
      expect(h.events).toHaveLength(1);
      expect(h.events[0].input.payload).toMatchObject({ ran: { kind: "job", ref: "goal-sense/G5" }, serves: { goal: "G5" }, outcome: "failed" });
      expect(h.events[0].input.payload).not.toHaveProperty("state");
    });
  }

  test("the fetch is bounded at 10 s: the sensor passes an abort signal and a slow feed fails", async () => {
    expect(FEED_FETCH_TIMEOUT_MS).toBe(10_000);
    const signals: AbortSignal[] = [];
    const hang: FeedFetch = (_url, init) => new Promise((_resolve, reject) => {
      signals.push(init.signal);
      init.signal.addEventListener("abort", () => { reject(init.signal.reason as Error); });
    });
    const h = await harness(hang);

    const result = await runFeedSensor(DEFAULTS, { ...h.deps, fetchTimeoutMs: 20 });

    expect(signals).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("timed out");
    expect(h.events[0].input.payload.outcome).toBe("failed");
  });

  const refused: [string, Partial<FeedSensorOptions>][] = [
    ["a goal id not matching G<n>", { goal: "goal-5" }],
    ["a lowercase goal id", { goal: "g5" }],
    ["an http: URL", { url: "http://feed.example.test/feed.xml" }],
    ["a file: URL", { url: "file:///etc/passwd" }],
    ["a URL that does not parse", { url: "not a url" }],
  ];
  for (const [name, override] of refused) {
    test(`${name} fetches and publishes nothing and exits 2`, async () => {
      const h = await harness(await fixture("rss.xml"));

      const result = await runFeedSensor({ ...DEFAULTS, ...override }, h.deps);

      expect(result.exitCode).toBe(2);
      expect(result.error).toBeDefined();
      expect(h.fetched).toEqual([]);
      expect(h.events).toEqual([]);
    });
  }

  test("with SOMA_PRINCIPAL unset nothing is published; value and count print to stdout and the exit code is 0", async () => {
    const h = await harness(await fixture("rss.xml"), {});

    const result = await runFeedSensor(DEFAULTS, h.deps);

    expect(result).toMatchObject({ exitCode: 0, value: "on-track", count: 1, ledger: "disabled" });
    expect(h.events).toEqual([]);
    expect(h.stdout).toHaveLength(1);
    expect(h.stdout[0]).toContain("G5: on-track");
    expect(h.stdout[0]).toContain("1 item");
  });

  test("with SOMA_PRINCIPAL unset a failed fetch still exits 1 and publishes nothing", async () => {
    const h = await harness(() => Promise.resolve(new Response("", { status: 503 })), {});
    const result = await runFeedSensor(DEFAULTS, h.deps);
    expect(result).toMatchObject({ exitCode: 1, ledger: "disabled" });
    expect(result.error).toContain("HTTP 503");
    expect(h.events).toEqual([]);
  });

  test("a bus that fails does not fail the sensor", async () => {
    const h = await harness(await fixture("rss.xml"));
    const result = await runFeedSensor(DEFAULTS, { ...h.deps, publish: () => Promise.reject(new Error("bus down")) });
    expect(result).toMatchObject({ exitCode: 0, value: "on-track", ledger: "failed" });
  });
});
