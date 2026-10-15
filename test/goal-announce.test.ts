import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateExecutionRunFinished, type ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import { runGoalAnnounce, type GoalAnnounceDeps } from "../src/goal-announce";
import { runGoalOutline } from "../src/goal-outline";
import { parseGoalArgs, runGoalCli } from "../src/cli/goal";
import { SomaCliError } from "../src/cli/errors";
import { buildRunFinishedEnvelope } from "../src/run-ledger";

const NOW = new Date("2026-10-14T06:30:00Z");
const FEED = "https://feed.example.test/private.xml";
const A = "https://articles.example.test/a";
const B = "https://articles.example.test/b";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const rss = (...links: string[]) => `<rss><channel><title>Private feed title</title>${links.map((link) =>
  `<item><title>Private item title</title><link>${link}</link><pubDate>2026-10-13</pubDate></item>`).join("")}</channel></rss>`;

async function fixture(body = rss(A, B)) {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-goal-announce-"));
  roots.push(somaHome);
  const events: ExecutionRunFinishedEvent[] = [];
  const requests: { prompt: string; level: string }[] = [];
  const fetched: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: GoalAnnounceDeps = {
    goal: "G5", url: FEED, channels: ["linkedin", "mastodon"], somaHome,
    now: () => NOW, runId: () => "announce-test-run",
    env: { SOMA_PRINCIPAL: "jc", MF_SERVES_GOAL: "G999" },
    fetch: async (url, init) => {
      fetched.push(url);
      // Only the feed may be requested. In particular no article, social API or inference API.
      expect(url).toBe(FEED);
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(body);
    },
    inference: async (prompt, options) => {
      requests.push({ prompt, level: options.level });
      const source = JSON.parse(prompt.split("\n\n").at(-1)!) as { channel: string; item: { link: string } };
      return `Private draft for ${source.channel}: ${source.item.link}`;
    },
    publish: async (event) => { events.push(event); },
    stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
  };
  const seenPath = join(somaHome, "memory", "STATE", "goal-announce", "G5.json");
  const output = join(somaHome, "outputs", "G5-2026-W42.md");
  async function seed(links: string[] = []) {
    await mkdir(dirname(seenPath), { recursive: true });
    await writeFile(seenPath, JSON.stringify(links));
  }
  async function outline(text: string) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, text);
  }
  return { deps, events, requests, fetched, stdout, stderr, seenPath, output, seed, outline };
}

async function assertEnvelope(f: Awaited<ReturnType<typeof fixture>>, outcome: "succeeded" | "failed", result = false) {
  expect(f.events).toHaveLength(1);
  const envelope = await buildRunFinishedEnvelope(f.events[0]);
  expect(validateExecutionRunFinished(envelope)).toEqual({ valid: true, errors: [] });
  expect(envelope.payload).toMatchObject({ ran: { kind: "job", ref: "goal-announce/G5" },
    serves: { goal: "G5" }, outcome, started_at: NOW.toISOString(), ended_at: NOW.toISOString() });
  if (result) expect(envelope.payload).toHaveProperty("result_ref", "soma:outputs/G5-2026-W42.md");
  else expect(envelope.payload).not.toHaveProperty("result_ref");
  expect(envelope.payload).not.toHaveProperty("state");
  expect(envelope.payload).not.toHaveProperty("detail_ref");
  const wire = JSON.stringify(envelope);
  for (const secret of [FEED, A, B, "example.test", "Private", "linkedin", "mastodon", f.deps.somaHome]) {
    expect(wire).not.toContain(secret);
  }
}

describe("goal announcement drafts", () => {
  test("one unseen link creates one draft per channel and joins the seen-set; only the feed is fetched", async () => {
    const f = await fixture();
    await f.seed([A]);
    expect(await runGoalAnnounce(f.deps)).toMatchObject({ exitCode: 0, draftsAdded: 2, outputPath: f.output, ledger: "published" });
    const text = await readFile(f.output, "utf8");
    expect(text).toStartWith("# G5 — 2026-W42\n");
    expect(text).toContain("## Share drafts\n");
    for (const channel of f.deps.channels) expect(text).toContain(`### ${channel}\n\n`);
    expect(text.match(/Private draft/g)).toHaveLength(2);
    expect(text).toContain(B);
    expect(text).not.toContain(A);
    expect(JSON.parse(await readFile(f.seenPath, "utf8"))).toEqual([A, B]);
    expect(f.requests).toHaveLength(2);
    for (const request of f.requests) {
      expect(request.level).toBe("standard");
      expect(request.prompt).toContain("Private item title");
      expect(request.prompt).toContain("2026-10-13");
    }
    expect(f.fetched).toEqual([FEED]);
    expect((await stat(f.output)).mode & 0o777).toBe(0o600);
    expect((await stat(f.seenPath)).mode & 0o777).toBe(0o600);
    expect(f.stdout).toEqual(["soma:outputs/G5-2026-W42.md"]);
    expect(f.stderr).toEqual([]);
    await assertEnvelope(f, "succeeded", true);
  });

  test("first run seeds every current link without inference or touching an existing outline", async () => {
    const f = await fixture();
    await f.outline("Keep the existing outline\n");
    const before = await stat(f.output);
    expect(await runGoalAnnounce(f.deps)).toMatchObject({ exitCode: 0, draftsAdded: 0 });
    expect(JSON.parse(await readFile(f.seenPath, "utf8"))).toEqual([A, B]);
    expect(await readFile(f.output, "utf8")).toBe("Keep the existing outline\n");
    expect((await stat(f.output)).mtimeMs).toBe(before.mtimeMs);
    expect(f.requests).toEqual([]);
    expect(f.stdout).toEqual([]);
    await assertEnvelope(f, "succeeded");
  });

  test("empty first run seeds an empty set and creates no output", async () => {
    const f = await fixture(rss());
    expect((await runGoalAnnounce(f.deps)).exitCode).toBe(0);
    expect(await readFile(f.seenPath, "utf8")).toBe("[]\n");
    expect(await Bun.file(f.output).exists()).toBe(false);
    expect(f.requests).toEqual([]);
    await assertEnvelope(f, "succeeded");
  });

  test("idle runs leave output and seen-set byte-for-byte and mtime unchanged, without inference", async () => {
    const f = await fixture();
    await f.seed([A, B]);
    await f.outline("## Share drafts\n\nExisting\n");
    const before = await Promise.all([stat(f.seenPath), stat(f.output)]);
    expect((await runGoalAnnounce(f.deps)).draftsAdded).toBe(0);
    expect(await readFile(f.seenPath, "utf8")).toBe(JSON.stringify([A, B]));
    expect(await readFile(f.output, "utf8")).toBe("## Share drafts\n\nExisting\n");
    const after = await Promise.all([stat(f.seenPath), stat(f.output)]);
    expect(after.map((s) => s.mtimeMs)).toEqual(before.map((s) => s.mtimeMs));
    expect(f.requests).toEqual([]);
    await assertEnvelope(f, "succeeded");
  });

  for (const bootstrap of [true, false]) test(`failed feed leaves both files untouched (bootstrap=${bootstrap})`, async () => {
    const f = await fixture();
    if (!bootstrap) await f.seed([A]);
    await f.outline("Existing output\n");
    f.deps.fetch = async () => { throw new Error(`Private transport failure ${FEED}`); };
    expect(await runGoalAnnounce(f.deps)).toMatchObject({ exitCode: 1, draftsAdded: 0, error: "soma goal announce: feed reader failed" });
    expect(await Bun.file(f.seenPath).exists()).toBe(!bootstrap);
    if (!bootstrap) expect(await readFile(f.seenPath, "utf8")).toBe(JSON.stringify([A]));
    expect(await readFile(f.output, "utf8")).toBe("Existing output\n");
    expect(f.requests).toEqual([]);
    expect(f.stderr.join(" ")).not.toContain("Private");
    await assertEnvelope(f, "failed");
  });

  test.each(["bad-body", "non-2xx"])("%s is a failed feed and writes nothing", async (kind) => {
    const f = await fixture();
    f.deps.fetch = async () => kind === "bad-body" ? new Response("<html/>") : new Response("", { status: 503 });
    expect((await runGoalAnnounce(f.deps)).exitCode).toBe(1);
    expect(await Bun.file(f.output).exists()).toBe(false);
    expect(await Bun.file(f.seenPath).exists()).toBe(false);
    await assertEnvelope(f, "failed");
  });

  test("failure in an item's second channel saves none for it; other items save and retry does not duplicate them", async () => {
    const f = await fixture();
    await f.seed();
    const success = f.deps.inference!;
    f.deps.inference = async (prompt, options) => {
      if (prompt.includes(A) && prompt.includes('"mastodon"')) throw new Error(`Private failure ${A}`);
      return success(prompt, options);
    };
    expect(await runGoalAnnounce(f.deps)).toMatchObject({ exitCode: 1, draftsAdded: 2, outputPath: f.output });
    let text = await readFile(f.output, "utf8");
    expect(text).toContain(B);
    expect(text).not.toContain(A);
    expect(JSON.parse(await readFile(f.seenPath, "utf8"))).toEqual([B]);
    expect(f.stderr).toEqual(["soma goal announce: inference failed or timed out"]);
    await assertEnvelope(f, "failed");
    f.deps.inference = success;
    f.events.length = 0;
    expect((await runGoalAnnounce(f.deps)).exitCode).toBe(0);
    text = await readFile(f.output, "utf8");
    expect(text.match(/Private draft/g)).toHaveLength(4);
    expect(JSON.parse(await readFile(f.seenPath, "utf8"))).toEqual([B, A]);
    await assertEnvelope(f, "succeeded", true);
  });

  test.each(["empty", "timeout"])("%s inference leaves the item unseen and existing output untouched", async (kind) => {
    const f = await fixture(rss(A));
    await f.seed();
    await f.outline("Existing\n");
    f.deps.inferenceTimeoutMs = 5;
    f.deps.inference = () => kind === "empty" ? Promise.resolve("  ") : new Promise(() => {});
    expect((await runGoalAnnounce(f.deps)).exitCode).toBe(1);
    expect(await readFile(f.seenPath, "utf8")).toBe("[]");
    expect(await readFile(f.output, "utf8")).toBe("Existing\n");
    await assertEnvelope(f, "failed");
  });

  test("adds drafts inside the actual section, ignores fenced headings, and survives outline regeneration", async () => {
    const f = await fixture(rss(A));
    await f.seed();
    const prefix = "# Outline\n\n~~~~md\n## Share drafts\nFake\n~~~~\n\n## Captures\nKeep\n\n";
    const tail = "## Notes\nKeep notes\n";
    await f.outline(prefix + "## Share drafts\r\n\r\nOld draft\r\n" + tail);
    f.deps.inference = async () => "Example\n```\n## Share drafts\n```\n## Captures\nGenerated body";
    await runGoalAnnounce(f.deps);
    const text = await readFile(f.output, "utf8");
    expect(text).toStartWith(prefix);
    expect(text).toEndWith(tail);
    expect(text.indexOf("### linkedin")).toBeGreaterThan(text.indexOf("Old draft"));
    expect(text.indexOf("### mastodon")).toBeLessThan(text.indexOf("## Notes"));
    const share = text.slice(prefix.length, text.indexOf(tail));
    const draftsDir = join(f.deps.somaHome, "drafts");
    await mkdir(draftsDir);
    expect((await runGoalOutline({ goal: "G5", somaHome: f.deps.somaHome, tanaTag: "capture", draftsDir,
      now: () => NOW, readCaptures: async () => [], env: {}, stdout: () => {} })).exitCode).toBe(0);
    expect(await readFile(f.output, "utf8")).toEndWith(share);
  });

  test("duplicate links/channels and missing or non-web links never create extra drafts", async () => {
    const f = await fixture(rss(A, A, "", "javascript:alert(1)"));
    await f.seed();
    f.deps.channels.push("linkedin");
    expect((await runGoalAnnounce(f.deps)).draftsAdded).toBe(2);
    expect(f.requests).toHaveLength(2);
    expect(JSON.parse(await readFile(f.seenPath, "utf8"))).toEqual([A]);
  });

  test("Atom links reach inference and an existing outline without Share drafts is retained", async () => {
    const f = await fixture(`<feed><entry><title>Atom title</title><updated>2026-10-13</updated>
      <link rel="self" href="https://feed.example.test/entry.xml"/><link rel="alternate" href="${A}"/></entry></feed>`);
    await f.seed();
    const existing = "# Existing\n\n## Outline\n\nKeep these words.  \n";
    await f.outline(existing);
    expect((await runGoalAnnounce(f.deps)).draftsAdded).toBe(2);
    expect(await readFile(f.output, "utf8")).toStartWith(existing);
    expect(f.requests[0].prompt).toContain('"title":"Atom title"');
    expect(f.requests[0].prompt).toContain(A);
    expect(f.fetched).toEqual([FEED]);
    await assertEnvelope(f, "succeeded", true);
  });

  test("a malformed seen-set fails safely rather than silently bootstrapping", async () => {
    const f = await fixture();
    await f.seed();
    await writeFile(f.seenPath, '{"bad":"Private"}');
    expect((await runGoalAnnounce(f.deps)).exitCode).toBe(1);
    expect(await readFile(f.seenPath, "utf8")).toBe('{"bad":"Private"}');
    expect(await Bun.file(f.output).exists()).toBe(false);
    expect(f.requests).toEqual([]);
    await assertEnvelope(f, "failed");
  });

  test("output write failure keeps new links unseen", async () => {
    const f = await fixture(rss(A));
    await f.seed();
    await writeFile(dirname(f.output), "block output directory");
    expect((await runGoalAnnounce(f.deps)).exitCode).toBe(1);
    expect(await readFile(f.seenPath, "utf8")).toBe("[]");
    await assertEnvelope(f, "failed");
  });

  test("uses the same Zurich ISO week at the year boundary as weekly outlines", async () => {
    const f = await fixture(rss(A));
    await f.seed();
    f.deps.now = () => new Date("2027-01-03T23:30:00Z"); // Monday in Zurich.
    const result = await runGoalAnnounce(f.deps);
    expect(result.outputPath).toEndWith("G5-2027-W01.md");
    expect(f.events[0].input.payload.result_ref).toBe("soma:outputs/G5-2027-W01.md");
  });

  test("unset principal disables the ledger; ledger failure does not fail saved drafts", async () => {
    for (const env of [{}, { SOMA_PRINCIPAL: "jc" }]) {
      const f = await fixture(rss(A));
      await f.seed();
      f.deps.env = env;
      f.deps.publish = async () => { throw new Error("bus down"); };
      expect(await runGoalAnnounce(f.deps)).toMatchObject({ exitCode: 0, draftsAdded: 2,
        ledger: "SOMA_PRINCIPAL" in env ? "failed" : "disabled" });
      expect(JSON.parse(await readFile(f.seenPath, "utf8"))).toEqual([A]);
    }
  });
});

describe("goal announce CLI", () => {
  const args = ["goal", "announce", "--goal", "G5", "--url", FEED, "--channels", "linkedin,mastodon"];
  test("parses options, deduplicates channels and runs the injected runner", async () => {
    const f = await fixture(rss(A));
    await f.seed();
    const parsed = parseGoalArgs([...args, "--channels", "linkedin, mastodon,linkedin", "--soma-home", f.deps.somaHome]);
    expect(parsed.options.announce).toEqual({ goal: "G5", url: FEED, channels: ["linkedin", "mastodon"] });
    expect(await runGoalCli(parsed, { announce: f.deps })).toBe("soma:outputs/G5-2026-W42.md");
    await assertEnvelope(f, "succeeded", true);
  });
  test("failed runner becomes exit 1 without echoing private errors", async () => {
    const f = await fixture();
    f.deps.fetch = async () => new Response("", { status: 503 });
    const result = runGoalCli(parseGoalArgs(args), { announce: f.deps });
    await expect(result).rejects.toMatchObject({ exitCode: 1, message: "soma goal announce: feed reader failed" });
  });
  test("the default inference path uses soma's tool-free Claude backend once per channel", async () => {
    const f = await fixture(rss(A));
    await f.seed();
    const bin = join(f.deps.somaHome, "bin");
    await mkdir(bin);
    const calls = join(f.deps.somaHome, "calls.jsonl");
    const binary = join(bin, "claude");
    await writeFile(binary, `#!${process.execPath}
      import { appendFileSync } from 'node:fs';
      const prompt = await new Response(Bun.stdin.stream()).text();
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), prompt })+'\\n');
      console.log('A short integration announcement.');
    `);
    await chmod(binary, 0o755);
    const source = join(import.meta.dir, "../src/cli/goal.ts");
    const script = `import { parseGoalArgs, runGoalCli } from ${JSON.stringify(source)};
      const fetched = [];
      const output = await runGoalCli(parseGoalArgs(${JSON.stringify([...args, "--soma-home", f.deps.somaHome])}), {
        env: {}, announce: { now: () => new Date(${JSON.stringify(NOW.toISOString())}), fetch: async (url) => {
          fetched.push(url); if (url !== ${JSON.stringify(FEED)}) throw new Error('non-feed HTTP request');
          return new Response(${JSON.stringify(rss(A))});
        } }
      });
      console.log(JSON.stringify({ output, fetched }));`;
    const result = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, PATH: bin, SOMA_PRINCIPAL: "" } });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({ output: "soma:outputs/G5-2026-W42.md", fetched: [FEED] });
    const log = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(log).toHaveLength(2);
    for (const call of log) expect(call.args).toEqual(["-p", "--model", "sonnet", "--allowedTools", "", "--hookTimeout", "1"]);
    expect((await readFile(f.output, "utf8")).match(/A short integration announcement/g)).toHaveLength(2);
  });
  test("missing, invalid or unknown arguments exit 2 without echoing values", async () => {
    for (const rest of [[], ["--goal", "private wording"],
      ["--goal", "G5", "--url", FEED], [...args.slice(2), "--channels", ""],
      [...args.slice(2), "--channels", "linkedin,,mastodon"], [...args.slice(2), "--channels", "../private"],
      [...args.slice(2), "--url", "http://private.test/"], [...args.slice(2), "--url", "private wording"],
      [...args.slice(2), "--post-private", "private wording"]]) {
      try { parseGoalArgs(["goal", "announce", ...rest]); throw new Error("accepted invalid arguments"); }
      catch (error) {
        expect(error).toBeInstanceOf(SomaCliError);
        expect((error as SomaCliError).exitCode).toBe(2);
        expect((error as Error).message).not.toContain("private wording");
        expect((error as Error).message).not.toContain("private.test");
      }
    }
    const f = await fixture();
    expect((await runGoalAnnounce({ ...f.deps, goal: "../bad" })).exitCode).toBe(2);
    expect(f.fetched).toEqual([]);
    expect(f.events).toEqual([]);
  });
});
