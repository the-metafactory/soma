import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPaths } from "./paths";
import { writePrivateJsonl, type RouterCorpusRow } from "./router-corpus";

/**
 * Arm C of the front-door router: local embeddings of the prompt and of the
 * previous reply's tail, fed to the shared combiner. No Python, no Laya, and no
 * prompt leaves the machine — the Ollama host must be loopback (R1).
 *
 * The prompt and the reply tail are embedded separately and concatenated, so
 * the combiner can weigh "what was asked" against "what it answers" (L3)
 * instead of seeing one blurred vector.
 *
 * Embeddings are derived from private prompts, so the cache is as private as
 * the corpus: owner-only, in the Soma home's state directory, never committed.
 *
 * Design: Plans/2026-09-28-front-door-router-design.md (§6.1 arm C, D5).
 */

export const ROUTER_EMBED_DEFAULT_HOST = "http://127.0.0.1:11434";
export const ROUTER_EMBED_DEFAULT_MODEL = "bge-m3";
const EMBED_BATCH = 32;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Refuse any embedding host that is not this machine: a remote one would ship private prompts. */
export function assertLoopbackHost(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Embedding host is not a URL: ${url}`);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`Embedding host must be loopback (127.0.0.1, localhost or ::1), got ${parsed.hostname}. Prompts must not leave the machine.`);
  }
  return parsed;
}

const PROXY_VARIABLES = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];

/**
 * Bun's `fetch` (and its `node:http`) send even a loopback request through an
 * environment proxy, and read `NO_PROXY` only at startup. So refuse whenever a
 * proxy is configured, unless `NO_PROXY` exempts this exact host or everything
 * (`*`) — the forms verified to keep the request local. `localhost` in
 * `NO_PROXY` does not cover `127.0.0.1`, so no looser matching is attempted.
 * Bun prefers `no_proxy` over `NO_PROXY` when both are set; rather than mirror
 * that precedence, every exemption variable that is defined (even empty) must exempt the host.
 */
export function assertNoProxyFor(url: URL, env: Record<string, string | undefined> = process.env): void {
  const configured = PROXY_VARIABLES.filter((name) => env[name]?.trim());
  if (configured.length === 0) return;
  const exemptions = [env.NO_PROXY, env.no_proxy].filter((value): value is string => value !== undefined);
  const exempts = (value: string): boolean =>
    value.split(",").map((entry) => entry.trim()).some((entry) => entry === "*" || entry === url.hostname);
  const exempt = exemptions.length > 0 && exemptions.every(exempts);
  if (!exempt) {
    throw new Error(
      `${configured.join(", ")} is set, and Bun would send the prompts through that proxy. Add ${url.hostname} to NO_PROXY, or unset the proxy for this command.`,
    );
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OllamaEmbedder {
  model: string;
  /** Full sha256 digest of the model. `embed` re-checks it, so a re-pulled model never files vectors under a stale digest. */
  digest: string;
  embed(texts: string[]): Promise<number[][]>;
}

export async function connectOllamaEmbedder(
  options: { host?: string; model?: string; fetch?: FetchLike; env?: Record<string, string | undefined> } = {},
): Promise<OllamaEmbedder> {
  const base = assertLoopbackHost(options.host ?? ROUTER_EMBED_DEFAULT_HOST);
  assertNoProxyFor(base, options.env);
  const model = options.model ?? ROUTER_EMBED_DEFAULT_MODEL;
  const doFetch = options.fetch ?? fetch;
  const wanted = model.includes(":") ? model : `${model}:latest`;

  // `redirect: "error"`: the loopback check covers only the first hop, and a 307/308
  // from a local endpoint would otherwise forward the prompt-bearing body elsewhere.
  const currentDigest = async (): Promise<string> => {
    const response = await doFetch(new URL("/api/tags", base).toString(), { redirect: "error" });
    if (!response.ok) throw new Error(`Ollama /api/tags failed: HTTP ${response.status}`);
    const tags = (await response.json()) as { models?: { name: string; digest: string }[] };
    const entry = tags.models?.find((candidate) => candidate.name === wanted);
    if (!entry) throw new Error(`Ollama has no model ${wanted}. Pull it with \`ollama pull ${model}\`.`);
    return entry.digest;
  };
  const digest = await currentDigest();

  return {
    model,
    digest,
    async embed(texts: string[]): Promise<number[][]> {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += EMBED_BATCH) {
        const input = texts.slice(start, start + EMBED_BATCH);
        const response = await doFetch(new URL("/api/embed", base).toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, input }),
          redirect: "error",
        });
        if (!response.ok) throw new Error(`Ollama /api/embed failed: HTTP ${response.status}`);
        const body = (await response.json()) as { embeddings?: number[][] };
        const embeddings = body.embeddings ?? [];
        if (embeddings.length !== input.length) throw new Error("Ollama /api/embed returned the wrong number of vectors.");
        if (!embeddings.every((vector) => vector.length > 0 && vector.every(Number.isFinite))) {
          throw new Error("Ollama /api/embed returned an empty or non-finite vector.");
        }
        vectors.push(...embeddings);
      }
      // Ollama embeds by name, not digest. If the name was re-pulled mid-run, these
      // vectors belong to a different model than the cache they would be filed under.
      if ((await currentDigest()) !== digest) throw new Error(`Ollama model ${wanted} changed while embedding; nothing was cached. Run again.`);
      return vectors;
    },
  };
}

export function textKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** One cache file per model digest: a new model starts an empty cache instead of mixing vector spaces. */
export function routerEmbeddingCachePath(somaHome: string, model: string, digest: string): string {
  const safeModel = model.replace(/[^A-Za-z0-9._-]/g, "_");
  return createPaths(somaHome).state("router", "embeddings", `${safeModel}-${digest.slice(0, 12)}.jsonl`);
}

interface CacheLine {
  k: string;
  /** Float32 little-endian, base64: a quarter of the size of JSON numbers, and exact to float32. */
  f32: string;
}

function encodeVector(vector: readonly number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}

function decodeVector(encoded: string): number[] {
  const bytes = Buffer.from(encoded, "base64");
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
}

export async function readEmbeddingCache(path: string): Promise<Map<string, number[]>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const cache = new Map<string, number[]>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as CacheLine;
    cache.set(parsed.k, decodeVector(parsed.f32));
  }
  return cache;
}

export async function writeEmbeddingCache(path: string, cache: Map<string, number[]>): Promise<void> {
  const lines: CacheLine[] = [...cache.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, vector]) => ({ k, f32: encodeVector(vector) }));
  await writePrivateJsonl(path, lines);
}

/** The texts arm C embeds for one row. An absent reply tail is not embedded; it becomes a zero vector. */
export function routerEmbedTexts(row: Pick<RouterCorpusRow, "prompt" | "replyTail">): { prompt: string; replyTail: string | null } {
  return { prompt: row.prompt, replyTail: row.replyTail.trim() ? row.replyTail : null };
}

/** Embed every text the cache lacks. Returns how many were new. */
export async function fillEmbeddingCache(embedder: OllamaEmbedder, cache: Map<string, number[]>, texts: Iterable<string>): Promise<number> {
  const missing = [...new Set([...texts].filter((text) => !cache.has(textKey(text))))];
  if (missing.length === 0) return 0;
  const vectors = await embedder.embed(missing);
  missing.forEach((text, index) => cache.set(textKey(text), vectors[index]));
  return missing.length;
}

const PREVIOUS_MODES = ["minimal", "native", "algorithm"] as const;
const PREVIOUS_EFFORTS = ["E1", "E2", "E3", "E4", "E5"] as const;

/**
 * Arm C's feature vector:
 * `[prompt embedding, reply-tail embedding (zeros if none), has previous reply,
 * log prompt length, previous mode one-hot (minimal, native, algorithm, unknown),
 * previous effort one-hot (E1–E5, none)]`. Previous effort is what lets
 * "do it" after an E4 plan differ from "do it" after an E1 fix (rule 4).
 * Returns null when a needed vector is not in the cache.
 */
export function routerArmCFeatures(
  row: Pick<RouterCorpusRow, "prompt" | "replyTail" | "hasPreviousReply" | "previousMode" | "previousEffort">,
  cache: Map<string, number[]>,
): number[] | null {
  const texts = routerEmbedTexts(row);
  const promptVector = cache.get(textKey(texts.prompt));
  if (!promptVector) return null;
  let tailVector: number[];
  if (texts.replyTail === null) {
    tailVector = new Array<number>(promptVector.length).fill(0);
  } else {
    const cached = cache.get(textKey(texts.replyTail));
    if (!cached) return null;
    tailVector = cached;
  }
  const modeOneHot = [...PREVIOUS_MODES.map((mode) => (row.previousMode === mode ? 1 : 0)), row.previousMode === null ? 1 : 0];
  const effort = PREVIOUS_EFFORTS.find((value) => value === row.previousEffort);
  const effortOneHot = [...PREVIOUS_EFFORTS.map((value) => (effort === value ? 1 : 0)), effort ? 0 : 1];
  return [...promptVector, ...tailVector, row.hasPreviousReply ? 1 : 0, Math.log1p(row.prompt.length), ...modeOneHot, ...effortOneHot];
}
