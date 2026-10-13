/**
 * The feed goal sensor (node #838, settled by soma#786 D3–D5 and D7): fetch
 * one RSS 2.0 or Atom feed, count the items dated inside a rolling window, and
 * publish the goal's state through the run ledger.
 *
 * At least `min` items in the window is `on-track`, fewer is `off-track`; there
 * is no `at-risk`. A failed fetch or a body that is no feed is `outcome:
 * failed` with no state: a missing fact is not a regression. The code is
 * goal-agnostic; the goal id and URL come in as arguments.
 *
 * The scanner is a block scanner, not an XML parser: it finds `<item>` and
 * `<entry>` blocks and their date element, and nothing else. It never follows
 * links or resolves entities. The envelope carries the goal id and the state
 * only, never the URL, the feed's title or any item text.
 */
import { randomUUID } from "node:crypto";
import {
  publishRunFinished,
  type RunFinishedPublisher,
  type RunFinishedResult,
  type RunLedgerEnv,
  type RunOutcome,
} from "./run-ledger";

/** The whole fetch, every redirect hop and the body together, gives up after this. */
export const FEED_FETCH_TIMEOUT_MS = 10_000;

/** A body past this is not a feed worth scanning: the read stops and the run fails. */
export const FEED_MAX_BYTES = 2 * 1024 * 1024;

/** Redirects are followed by hand, each hop checked for `https:`, up to this many. */
export const FEED_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const FEED_SENSOR_DEFAULTS = { windowDays: 7, min: 1 } as const;

// As in `soma goal`: goal ids only, never goal wording.
const GOAL_ID = /^G\d+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export type GoalSenseValue = "on-track" | "off-track";

export interface FeedSensorOptions {
  goal: string;
  url: string;
  windowDays: number;
  min: number;
}

export type FeedFetch = (url: string, init: { signal: AbortSignal; redirect: "manual" }) => Promise<Response>;

export interface FeedSensorDeps {
  somaHome: string;
  env?: RunLedgerEnv;
  publish?: RunFinishedPublisher;
  now?: () => Date;
  fetch?: FeedFetch;
  fetchTimeoutMs?: number;
  runId?: () => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface FeedSensorResult {
  /** 0 measured, 1 the feed could not be read, 2 refused before any fetch. */
  exitCode: 0 | 1 | 2;
  value?: GoalSenseValue;
  count?: number;
  ledger?: RunFinishedResult;
  /** Why the exit code is not 0; never contains the URL. */
  error?: string;
}

export interface FeedScan {
  kind: "rss" | "atom";
  /** Each item's raw date text in document order; `undefined` when it has none. */
  dates: (string | undefined)[];
}

const PREFIX = "(?:[A-Za-z_][\\w.-]*:)?";

// One pass, leftmost wins: a comment inside CDATA stays text and CDATA inside a
// comment goes with the comment. CDATA becomes escaped text, so markup in an
// item's description cannot open or close a block.
const COMMENT_OR_CDATA = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>/g;
const ROOT = new RegExp(`^\\uFEFF?(?:\\s|<\\?[\\s\\S]*?\\?>|<!DOCTYPE(?:[^>[]|\\[[^\\]]*\\])*>)*<${PREFIX}(rss|feed)[\\s/>]`);

function blocks(name: string): RegExp {
  return new RegExp(`<(${PREFIX})${name}(?:\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</\\1${name}>)`, "g");
}

function element(block: string, name: string): string | undefined {
  const match = new RegExp(`<(${PREFIX})${name}(?:\\s[^>]*)?>([\\s\\S]*?)</\\1${name}>`).exec(block);
  return match?.[2].trim();
}

function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** `undefined` when the body has neither an `<rss>` nor a `<feed>` root. */
export function scanFeed(body: string): FeedScan | undefined {
  const text = body.replace(COMMENT_OR_CDATA, (_match, cdata: string | undefined) => (cdata === undefined ? "" : escapeText(cdata)));
  const root = ROOT.exec(text)?.[1];
  if (root === undefined) return undefined;
  const kind = root === "rss" ? "rss" : "atom";
  const dates = [...text.matchAll(blocks(kind === "rss" ? "item" : "entry"))].map(([, , inner = ""]) =>
    kind === "rss" ? element(inner, "pubDate") : element(inner, "published") ?? element(inner, "updated"));
  return { kind, dates };
}

/** Items dated in `[now - windowDays, now]`. An undated or unparseable item is skipped with one warning naming its position. */
export function countInWindow(scan: FeedScan, now: Date, windowDays: number, warn: (line: string) => void): number {
  const end = now.getTime();
  const start = end - windowDays * DAY_MS;
  const noun = scan.kind === "rss" ? "item" : "entry";
  let count = 0;
  scan.dates.forEach((date, index) => {
    const missing = date === undefined || date === "";
    const instant = missing ? Number.NaN : Date.parse(date);
    if (Number.isNaN(instant)) {
      warn(`soma goal sense feed: ${noun} ${index + 1}: ${missing ? "no date" : "date does not parse"}; skipped`);
      return;
    }
    if (instant >= start && instant <= end) count++;
  });
  return count;
}

export function goalState(count: number, min: number): GoalSenseValue {
  return count >= min ? "on-track" : "off-track";
}

function refusal(options: FeedSensorOptions): string | undefined {
  if (!GOAL_ID.test(options.goal)) return "--goal must match G<n>";
  let protocol: string;
  try {
    protocol = new URL(options.url).protocol;
  } catch {
    return "--url is not a URL";
  }
  if (protocol !== "https:") return "--url must be an https: URL";
  for (const [flag, value] of [["--window-days", options.windowDays], ["--min", options.min]] as const) {
    if (!Number.isInteger(value) || value < 1) return `${flag} must be a positive integer`;
  }
  return undefined;
}

class FeedReadError extends Error {}

/** Every URL fetched, then its `host` (with port) before its bare `hostname`. */
function redact(text: string, urls: readonly string[]): string {
  let redacted = text;
  for (const url of urls) redacted = redacted.replaceAll(url, "<url>");
  for (const url of urls) {
    const { host, hostname } = new URL(url);
    redacted = redacted.replaceAll(host, "<host>").replaceAll(hostname, "<host>");
  }
  return redacted;
}

const tooLarge = () => new FeedReadError(`body too large (over ${FEED_MAX_BYTES} bytes)`);

/** The body as text, refused on a Content-Length past the cap and cut off once the stream passes it. */
async function readCapped(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > FEED_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > FEED_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** Follow redirects by hand so that every hop, not just the last, must be `https:`. */
async function fetchFeedBody(fetchFeed: FeedFetch, url: string, signal: AbortSignal, visited: string[]): Promise<string> {
  let current = url;
  for (let hop = 0; ; hop++) {
    visited.push(current);
    const response = await fetchFeed(current, { signal, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) {
      if (!response.ok) throw new FeedReadError(`HTTP ${response.status}`);
      return readCapped(response);
    }
    await response.body?.cancel().catch(() => undefined);
    if (hop === FEED_MAX_REDIRECTS) throw new FeedReadError(`more than ${FEED_MAX_REDIRECTS} redirects`);
    const location = response.headers.get("location");
    if (location === null) throw new FeedReadError(`HTTP ${response.status} redirect without a Location`);
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new FeedReadError("redirected to an invalid URL");
    }
    if (next.protocol !== "https:") throw new FeedReadError("redirected off https:");
    current = next.href;
  }
}

async function readFeed(options: FeedSensorOptions, deps: FeedSensorDeps): Promise<FeedScan> {
  const timeoutMs = deps.fetchTimeoutMs ?? FEED_FETCH_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const fetchFeed: FeedFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const visited: string[] = [];
  let body: string;
  try {
    body = await fetchFeedBody(fetchFeed, options.url, signal, visited);
  } catch (error) {
    if (error instanceof FeedReadError) throw error;
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new FeedReadError(`fetch timed out after ${timeoutMs / 1000} s`);
    }
    const code = (error as { code?: unknown } | null)?.code;
    const cause = typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
    throw new FeedReadError(`fetch failed: ${redact(cause, visited)}`);
  }
  const scan = scanFeed(body);
  if (scan === undefined) throw new FeedReadError("the body is neither an RSS nor an Atom feed");
  return scan;
}

/** Sense one feed for one goal. Never throws: every path is an exit code. */
export async function runFeedSensor(options: FeedSensorOptions, deps: FeedSensorDeps): Promise<FeedSensorResult> {
  const refused = refusal(options);
  if (refused !== undefined) return { exitCode: 2, error: `soma goal sense feed: ${refused}; nothing fetched` };

  const now = deps.now ?? (() => new Date());
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const startedAt = now().toISOString();

  let measured: { count: number; value: GoalSenseValue } | undefined;
  let error: string | undefined;
  try {
    const scan = await readFeed(options, deps);
    const count = countInWindow(scan, now(), options.windowDays, stderr);
    measured = { count, value: goalState(count, options.min) };
  } catch (failure) {
    error = `soma goal sense feed: ${failure instanceof FeedReadError ? failure.message : String(failure)}`;
  }

  const outcome: RunOutcome = measured === undefined ? "failed" : "succeeded";
  const ledger = await publishRunFinished(
    {
      kind: "job",
      ref: `goal-sense/${options.goal}`,
      runId: deps.runId?.() ?? randomUUID(),
      outcome,
      startedAt,
      endedAt: now().toISOString(),
      serves: { goal: options.goal },
      ...(measured === undefined ? {} : { state: { subject: options.goal, value: measured.value } }),
    },
    { somaHome: deps.somaHome, substrate: "custom", env: deps.env, publish: deps.publish },
  );

  if (measured === undefined) return { exitCode: 1, ledger, error };
  const items = measured.count === 1 ? "item" : "items";
  stdout(`${options.goal}: ${measured.value} (${measured.count} ${items} in the last ${options.windowDays} days, min ${options.min}; run ledger: ${ledger})`);
  return { exitCode: 0, ...measured, ledger };
}
