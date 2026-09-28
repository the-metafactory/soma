import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";
import { createPaths } from "../src/paths";
import type { RouterCorpusRow } from "../src/router-corpus";
import {
  type FetchLike,
  assertLoopbackHost,
  assertNoProxyFor,
  connectOllamaEmbedder,
  fillEmbeddingCache,
  readEmbeddingCache,
  routerArmCFeatures,
  routerEmbeddingCachePath,
  textKey,
  writeEmbeddingCache,
} from "../src/router-embed";

const DIGEST = "7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab";
const DIM = 8;

/** A stand-in embedding: deterministic per text, and different for different texts. */
function fakeVector(text: string): number[] {
  const hash = textKey(text);
  return Array.from({ length: DIM }, (_, index) => parseInt(hash.slice(index * 2, index * 2 + 2), 16) / 255);
}

function fakeOllama(calls: { path: string; body?: unknown }[] = []): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path: url.pathname, body });
    if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "bge-m3:latest", digest: DIGEST }] });
    if (url.pathname === "/api/embed") return Response.json({ embeddings: (body.input as string[]).map(fakeVector) });
    return new Response("not found", { status: 404 });
  };
}

test("only loopback embedding hosts are accepted", () => {
  for (const host of ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"]) expect(() => assertLoopbackHost(host)).not.toThrow();
  for (const host of ["http://10.0.0.5:11434", "https://ollama.example.com", "http://127.0.0.1.example.com"]) {
    expect(() => assertLoopbackHost(host)).toThrow("must be loopback");
  }
  expect(() => assertLoopbackHost("not a url")).toThrow("not a URL");
});

test("a remote host is refused before any request is made", async () => {
  const calls: { path: string }[] = [];
  await expect(connectOllamaEmbedder({ host: "http://192.168.1.10:11434", fetch: fakeOllama(calls) })).rejects.toThrow("must be loopback");
  expect(calls).toHaveLength(0);
});

test("the embedder resolves the model digest and batches requests", async () => {
  const calls: { path: string; body?: any }[] = [];
  const embedder = await connectOllamaEmbedder({ fetch: fakeOllama(calls) });
  expect(embedder.digest).toBe(DIGEST);
  const texts = Array.from({ length: 70 }, (_, index) => `text ${index}`);
  const vectors = await embedder.embed(texts);
  expect(vectors).toHaveLength(70);
  expect(vectors[69]).toEqual(fakeVector("text 69"));
  expect(calls.filter((call) => call.path === "/api/embed").map((call) => call.body.input.length)).toEqual([32, 32, 6]);
});

test("a redirect from the loopback host is refused, and the prompt never reaches its target", async () => {
  const received: string[] = [];
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => (received.push(await request.text()), Response.json({ embeddings: [[0]] })) });
  const redirector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/api/tags"
        ? Response.json({ models: [{ name: "bge-m3:latest", digest: DIGEST }] })
        : new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${target.port}/api/embed` } }),
  });
  try {
    const embedder = await connectOllamaEmbedder({ host: `http://127.0.0.1:${redirector.port}` });
    await expect(embedder.embed(["PRIVATE"])).rejects.toThrow();
    expect(received).toHaveLength(0);
  } finally {
    await redirector.stop(true);
    await target.stop(true);
  }
});

test("a model re-pulled while embedding is refused, so its vectors are never filed under the old digest", async () => {
  let tagCalls = 0;
  const base = fakeOllama();
  const swapping: FetchLike = async (input, init) => {
    if (new URL(input).pathname === "/api/tags") {
      tagCalls += 1;
      return Response.json({ models: [{ name: "bge-m3:latest", digest: tagCalls === 1 ? DIGEST : "f".repeat(64) }] });
    }
    return base(input, init);
  };
  const embedder = await connectOllamaEmbedder({ fetch: swapping });
  const cache = new Map<string, number[]>();
  await expect(fillEmbeddingCache(embedder, cache, ["a"])).rejects.toThrow("changed while embedding");
  expect(cache.size).toBe(0);
});

test("a configured proxy is refused unless NO_PROXY exempts this exact host or everything", () => {
  const url = new URL("http://127.0.0.1:11434");
  expect(() => assertNoProxyFor(url, {})).not.toThrow();
  expect(() => assertNoProxyFor(url, { HTTP_PROXY: "http://proxy.example:3128" })).toThrow("HTTP_PROXY is set");
  expect(() => assertNoProxyFor(url, { https_proxy: "http://proxy.example:3128", NO_PROXY: "localhost" })).toThrow("Add 127.0.0.1 to NO_PROXY");
  expect(() => assertNoProxyFor(url, { ALL_PROXY: "socks5://proxy.example:1080" })).toThrow("ALL_PROXY");
  expect(() => assertNoProxyFor(url, { HTTP_PROXY: "http://proxy.example:3128", NO_PROXY: "example.org, 127.0.0.1" })).not.toThrow();
  expect(() => assertNoProxyFor(url, { http_proxy: "http://proxy.example:3128", no_proxy: "*" })).not.toThrow();
  expect(() => assertNoProxyFor(url, { HTTP_PROXY: "  " })).not.toThrow();
  expect(() => assertNoProxyFor(url, { HTTP_PROXY: "http://proxy.example:3128", NO_PROXY: "127.0.0.1", no_proxy: "example.org" })).toThrow("Add 127.0.0.1");
  expect(() => assertNoProxyFor(url, { HTTP_PROXY: "http://proxy.example:3128", NO_PROXY: "127.0.0.1", no_proxy: "" })).toThrow("Add 127.0.0.1");
});

test("with a real env proxy, the prompt reaches neither the proxy nor Ollama unless NO_PROXY exempts the host", async () => {
  const proxyHits: string[] = [];
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => (proxyHits.push(await request.text()), new Response("proxied", { status: 502 })) });
  const ollama = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      new URL(request.url).pathname === "/api/tags"
        ? Response.json({ models: [{ name: "bge-m3:latest", digest: DIGEST }] })
        : Response.json({ embeddings: ((await request.json()) as { input: string[] }).input.map(() => [0.5]) }),
  });
  const script = `import { connectOllamaEmbedder } from ${JSON.stringify(join(import.meta.dir, "..", "src", "router-embed.ts"))};
try { const e = await connectOllamaEmbedder({ host: "http://127.0.0.1:${ollama.port}" }); console.log((await e.embed(["PRIVATE"])).length); }
catch (error) { console.log("refused: " + error.message); }`;
  const run = async (noProxy: string, lowerNoProxy = noProxy): Promise<string> => {
    const child = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, http_proxy: `http://127.0.0.1:${proxy.port}`, NO_PROXY: noProxy, no_proxy: lowerNoProxy },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(child.stdout).text()).trim();
    await child.exited;
    return out;
  };
  try {
    expect(await run("")).toStartWith("refused: HTTP_PROXY, http_proxy is set");
    expect(await run("127.0.0.1")).toBe("1");
    // Bun prefers no_proxy; an exemption only in NO_PROXY must not count.
    expect(await run("127.0.0.1", "example.org")).toStartWith("refused:");
    expect(await run("127.0.0.1", "")).toStartWith("refused:");
    expect(proxyHits).toHaveLength(0);
  } finally {
    await proxy.stop(true);
    await ollama.stop(true);
  }
});

test("an empty or non-finite vector from Ollama is refused", async () => {
  const base = fakeOllama();
  const overflowing: FetchLike = async (input, init) =>
    new URL(input).pathname === "/api/embed" ? new Response('{"embeddings":[[1e400]]}', { headers: { "content-type": "application/json" } }) : base(input, init);
  const embedder = await connectOllamaEmbedder({ fetch: overflowing });
  await expect(embedder.embed(["a"])).rejects.toThrow("non-finite");
});

test("a model Ollama does not have is a clear error", async () => {
  await expect(connectOllamaEmbedder({ model: "nomic-embed-text", fetch: fakeOllama() })).rejects.toThrow("ollama pull nomic-embed-text");
});

test("the cache round-trips at float32 precision, owner-only, and only embeds what it lacks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soma-router-embed-"));
  try {
    const embedder = await connectOllamaEmbedder({ fetch: fakeOllama() });
    const cache = new Map<string, number[]>();
    expect(await fillEmbeddingCache(embedder, cache, ["a", "b", "a"])).toBe(2);
    expect(await fillEmbeddingCache(embedder, cache, ["a", "b", "c"])).toBe(1);

    const path = routerEmbeddingCachePath(dir, "bge-m3", DIGEST);
    expect(path).toEndWith(join("router", "embeddings", "bge-m3-790764642607.jsonl"));
    await writeEmbeddingCache(path, cache);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain('"a"');

    const reread = await readEmbeddingCache(path);
    expect(reread.size).toBe(3);
    const original = cache.get(textKey("c"))!;
    expect(reread.get(textKey("c"))).toEqual(Array.from(new Float32Array(original)));
    expect(await readEmbeddingCache(join(dir, "missing.jsonl"))).toEqual(new Map());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function row(overrides: Partial<RouterCorpusRow>): RouterCorpusRow {
  return {
    id: "u-1",
    sessionId: "s-1",
    project: "p",
    ts: "2026-09-28T10:00:00.000Z",
    source: "typed",
    prompt: "do it",
    replyTail: "Want me to open the PR?",
    hasPreviousReply: true,
    previousMode: "algorithm",
    previousEffort: "E2",
    regexAtTime: null,
    ...overrides,
  };
}

test("arm C features: prompt vector, reply-tail vector, then plain features", () => {
  const cache = new Map([
    [textKey("do it"), fakeVector("do it")],
    [textKey("Want me to open the PR?"), fakeVector("Want me to open the PR?")],
  ]);
  const features = routerArmCFeatures(row({}), cache)!;
  expect(features).toHaveLength(2 * DIM + 12);
  expect(features.slice(0, DIM)).toEqual(fakeVector("do it"));
  expect(features.slice(DIM, 2 * DIM)).toEqual(fakeVector("Want me to open the PR?"));
  expect(features.slice(2 * DIM)).toEqual([1, Math.log1p(5), 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]);

  const noReply = routerArmCFeatures(row({ replyTail: "", hasPreviousReply: false, previousMode: null, previousEffort: null }), cache)!;
  expect(noReply.slice(DIM, 2 * DIM)).toEqual(new Array(DIM).fill(0));
  expect(noReply.slice(2 * DIM)).toEqual([0, Math.log1p(5), 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);

  const afterE1 = routerArmCFeatures(row({ previousEffort: "E1" }), cache)!;
  const afterE5 = routerArmCFeatures(row({ previousEffort: "E5" }), cache)!;
  expect(afterE1).not.toEqual(afterE5);

  expect(routerArmCFeatures(row({ prompt: "not cached" }), cache)).toBeNull();
});

// End to end through the CLI, against a fake Ollama bound to loopback.
let server: ReturnType<typeof Bun.serve>;
let host: string;
beforeAll(() => {
  const handler = fakeOllama();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => request.text().then((body) => handler(request.url, { method: request.method, body: body || undefined })) });
  host = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

test("soma router embed + train: scores by session folds, writes private artifacts, never prints prompts", async () => {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-router-cli-"));
  try {
    const secret = "PRIVATE-PROMPT-MARKER";
    const rows: RouterCorpusRow[] = [];
    const labels: string[] = [];
    for (let session = 0; session < 6; session += 1) {
      for (let i = 0; i < 4; i += 1) {
        const id = `u-${session}-${i}`;
        const mode = i % 2 === 0 ? "native" : "algorithm";
        rows.push(row({ id, sessionId: `s-${session}`, prompt: `${secret} ${mode} ${session} ${i}`, replyTail: i === 0 ? "" : `tail ${session} ${i}` }));
        labels.push(JSON.stringify({ id, mode }));
      }
    }
    const corpus = join(somaHome, "corpus.jsonl");
    const labelsPath = join(somaHome, "labels.jsonl");
    await writeFile(corpus, rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await writeFile(labelsPath, labels.join("\n") + "\n");

    const embedOut = await runSomaCli(["router", "embed", "--soma-home", somaHome, "--corpus", corpus, "--host", host, "--json"]);
    const embed = JSON.parse(embedOut);
    expect(embed.added).toBe(24 + 18);
    expect(embedOut).not.toContain(secret);
    const again = JSON.parse(await runSomaCli(["router", "embed", "--soma-home", somaHome, "--corpus", corpus, "--host", host, "--json"]));
    expect(again.added).toBe(0);

    const trainOut = await runSomaCli(["router", "train", "--soma-home", somaHome, "--corpus", corpus, "--labels", labelsPath, "--folds", "3", "--host", host]);
    expect(trainOut).toContain("examples: 24 from 6 session(s), 3 session-split folds");
    expect(trainOut).toContain("majority baseline");
    expect(trainOut).not.toContain(secret);

    const artifactPath = createPaths(somaHome).state("router", "combiner", "arm-c-mode-790764642607.json");
    expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
    const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    expect(artifact).toMatchObject({ caller: "mode-router", arm: "C", axis: "mode", backend: "ollama:bge-m3", backendVersion: DIGEST, examples: 24 });
    expect(artifact.model.dimensions).toBe(2 * DIM + 12);
  } finally {
    await rm(somaHome, { recursive: true, force: true });
  }
});

test("soma router train refuses when labelled rows have no embeddings, and needs --labels", async () => {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-router-cli-"));
  try {
    const corpus = join(somaHome, "corpus.jsonl");
    const labelsPath = join(somaHome, "labels.jsonl");
    await writeFile(corpus, JSON.stringify(row({})) + "\n");
    await writeFile(labelsPath, JSON.stringify({ id: "u-1", mode: "native" }) + "\n");
    await expect(runSomaCli(["router", "train", "--soma-home", somaHome, "--corpus", corpus, "--labels", labelsPath, "--host", host])).rejects.toThrow(
      "Run `soma router embed` first",
    );
    await expect(runSomaCli(["router", "train", "--soma-home", somaHome])).rejects.toThrow("--labels is required");
    await expect(runSomaCli(["router", "embed", "--labels", labelsPath])).rejects.toThrow("Unknown option: --labels");
  } finally {
    await rm(somaHome, { recursive: true, force: true });
  }
});
