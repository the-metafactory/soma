import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPaths, defaultSomaHome } from "../paths";
import { type CombinerExample, crossValidateCombiner, trainCombiner } from "../router-combiner";
import {
  ROUTER_CORPUS_DEFAULT_SAMPLE,
  ROUTER_CORPUS_DEFAULT_SEED,
  ROUTER_CORPUS_SKIP_REASONS,
  buildRouterCorpus,
  readRouterCorpus,
  routerCorpusPath,
  writePrivateJsonl,
  writeRouterCorpus,
} from "../router-corpus";
import {
  ROUTER_EMBED_DEFAULT_HOST,
  ROUTER_EMBED_DEFAULT_MODEL,
  connectOllamaEmbedder,
  fillEmbeddingCache,
  readEmbeddingCache,
  routerArmCFeatures,
  routerEmbedTexts,
  routerEmbeddingCachePath,
  writeEmbeddingCache,
} from "../router-embed";
import { readOption } from "./parse-utils";

const ROUTER_ACTIONS = ["corpus", "embed", "train"] as const;
type RouterCliAction = (typeof ROUTER_ACTIONS)[number];
const ROUTER_AXES = ["mode", "effort"] as const;
type RouterAxis = (typeof ROUTER_AXES)[number];

export interface ParsedRouterArgs {
  command: "router";
  action: RouterCliAction;
  options: {
    homeDir?: string;
    somaHome?: string;
    projectsDir?: string;
    corpus?: string;
    out?: string;
    sample?: number;
    seed?: string;
    dryRun?: boolean;
    json?: boolean;
    host?: string;
    model?: string;
    labels?: string;
    axis?: RouterAxis;
    folds?: number;
  };
}

export const ROUTER_COMMAND_HELP: { usage: string; subcommands: Record<RouterCliAction, string> } = {
  usage: "Usage: soma router <corpus|embed|train> ...",
  subcommands: {
    corpus: `Usage: soma router corpus [--projects-dir <dir>] [--sample <n>] [--seed <text>] [--out <path>] [--dry-run] [--json] [--home-dir <dir>] [--soma-home <dir>]\nExtracts the principal's typed Claude Code prompts, each with the tail of the reply before it, into a private sample (default ${ROUTER_CORPUS_DEFAULT_SAMPLE}, seed "${ROUTER_CORPUS_DEFAULT_SEED}"). Prints counts only, never prompts.`,
    embed: `Usage: soma router embed [--corpus <path>] [--host <url>] [--model <name>] [--json] [--soma-home <dir>]\nEmbeds each corpus prompt and reply tail with a local Ollama model (default ${ROUTER_EMBED_DEFAULT_MODEL} at ${ROUTER_EMBED_DEFAULT_HOST}) into a private cache, for the router's arm C. The host must be loopback. Prints counts only.`,
    train: `Usage: soma router train --labels <path> [--axis mode|effort] [--folds <n>] [--corpus <path>] [--host <url>] [--model <name>] [--out <path>] [--dry-run] [--json] [--soma-home <dir>]\nTrains arm C (embeddings + combiner) on labelled corpus rows. --labels is JSONL of {"id", "mode"?, "effort"?}. Scores by session-split folds against the majority baseline, then writes the model trained on every labelled row to the private state directory. Prints scores only, never prompts.`,
  },
};

const isAction = (value: string | undefined): value is RouterCliAction => ROUTER_ACTIONS.includes(value as RouterCliAction);

export function parseRouterArgs(args: string[]): ParsedRouterArgs {
  const [command, action, ...rest] = args;

  if (command !== "router" || !isAction(action)) {
    throw new Error(ROUTER_COMMAND_HELP.usage);
  }

  const options: ParsedRouterArgs["options"] = {};
  const allowed: Record<RouterCliAction, readonly string[]> = {
    corpus: ["--home-dir", "--soma-home", "--projects-dir", "--out", "--sample", "--seed", "--dry-run", "--json"],
    embed: ["--soma-home", "--corpus", "--host", "--model", "--json"],
    train: ["--soma-home", "--corpus", "--host", "--model", "--labels", "--axis", "--folds", "--out", "--dry-run", "--json"],
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!allowed[action].includes(arg)) throw new Error(`Unknown option: ${arg}\n${ROUTER_COMMAND_HELP.subcommands[action]}`);

    switch (arg) {
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        break;
      case "--projects-dir":
        options.projectsDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--corpus":
        options.corpus = readOption(rest, index, arg);
        index += 1;
        break;
      case "--out":
        options.out = readOption(rest, index, arg);
        index += 1;
        break;
      case "--sample": {
        const value = Number(readOption(rest, index, arg));
        if (!Number.isInteger(value) || value < 0) throw new Error("--sample must be a non-negative integer.");
        options.sample = value;
        index += 1;
        break;
      }
      case "--seed":
        options.seed = readOption(rest, index, arg);
        index += 1;
        break;
      case "--host":
        options.host = readOption(rest, index, arg);
        index += 1;
        break;
      case "--model":
        options.model = readOption(rest, index, arg);
        index += 1;
        break;
      case "--labels":
        options.labels = readOption(rest, index, arg);
        index += 1;
        break;
      case "--axis": {
        const value = readOption(rest, index, arg);
        if (!ROUTER_AXES.includes(value as RouterAxis)) throw new Error("--axis must be mode or effort.");
        options.axis = value as RouterAxis;
        index += 1;
        break;
      }
      case "--folds": {
        const value = Number(readOption(rest, index, arg));
        if (!Number.isInteger(value) || value < 2) throw new Error("--folds must be an integer of at least 2.");
        options.folds = value;
        index += 1;
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
    }
  }

  if (action === "train" && !options.labels) throw new Error(`--labels is required.\n${ROUTER_COMMAND_HELP.subcommands.train}`);

  return { command, action, options };
}

export async function runRouterCli(parsed: ParsedRouterArgs): Promise<string> {
  if (parsed.action === "embed") return runRouterEmbed(parsed.options);
  if (parsed.action === "train") return runRouterTrain(parsed.options);
  return runRouterCorpus(parsed.options);
}

async function runRouterCorpus(options: ParsedRouterArgs["options"]): Promise<string> {
  const projectsDir = options.projectsDir ?? join(options.homeDir ?? homedir(), ".claude", "projects");
  const out = options.out ?? routerCorpusPath(defaultSomaHome(options));

  const result = await buildRouterCorpus({ projectsDir, sample: options.sample, seed: options.seed });
  if (!options.dryRun) await writeRouterCorpus(out, result.rows);

  const summary = {
    projectsDir,
    out: options.dryRun ? null : out,
    transcripts: result.transcripts,
    candidates: result.candidates,
    sampled: result.rows.length,
    sessions: result.sessions,
    withPreviousReply: result.rows.filter((row) => row.hasPreviousReply).length,
    queued: result.rows.filter((row) => row.source === "queued").length,
    withRegexAtTime: result.rows.filter((row) => row.regexAtTime !== null).length,
    skipped: result.skipped,
  };

  if (options.json) return `${JSON.stringify(summary, null, 2)}\n`;

  return [
    "Soma router corpus",
    `projects: ${projectsDir}`,
    `written: ${summary.out ?? "no (dry run)"}`,
    `transcripts: ${summary.transcripts}`,
    `candidate prompts: ${summary.candidates}`,
    `sampled: ${summary.sampled} from ${summary.sessions} session(s)`,
    `  with a previous reply: ${summary.withPreviousReply}`,
    `  typed mid-turn (queued): ${summary.queued}`,
    `  with the mode hook's decision at the time: ${summary.withRegexAtTime}`,
    "skipped:",
    ...ROUTER_CORPUS_SKIP_REASONS.filter((reason) => result.skipped[reason] > 0).map((reason) => `  ${reason}: ${result.skipped[reason]}`),
  ].join("\n");
}

async function runRouterEmbed(options: ParsedRouterArgs["options"]): Promise<string> {
  const somaHome = defaultSomaHome(options);
  const rows = await readRouterCorpus(options.corpus ?? routerCorpusPath(somaHome));
  const embedder = await connectOllamaEmbedder({ host: options.host, model: options.model });
  const cachePath = routerEmbeddingCachePath(somaHome, embedder.model, embedder.digest);
  const cache = await readEmbeddingCache(cachePath);
  const before = cache.size;

  const texts = rows.flatMap((row) => {
    const { prompt, replyTail } = routerEmbedTexts(row);
    return replyTail === null ? [prompt] : [prompt, replyTail];
  });
  const started = performance.now();
  const added = await fillEmbeddingCache(embedder, cache, texts);
  const elapsedMs = Math.round(performance.now() - started);
  if (added > 0) await writeEmbeddingCache(cachePath, cache);

  const summary = { rows: rows.length, model: embedder.model, digest: embedder.digest, cache: cachePath, cachedBefore: before, added, cached: cache.size, elapsedMs };
  if (options.json) return `${JSON.stringify(summary, null, 2)}\n`;
  return [
    "Soma router embed",
    `model: ${embedder.model} (${embedder.digest.slice(0, 12)})`,
    `cache: ${cachePath}`,
    `corpus rows: ${rows.length}`,
    `vectors: ${cache.size} (${added} new, ${elapsedMs} ms)`,
  ].join("\n");
}

interface LabelLine {
  id: string;
  mode?: string;
  effort?: string;
}

async function readLabels(path: string): Promise<Map<string, LabelLine>> {
  const labels = new Map<string, LabelLine>();
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as LabelLine;
    if (typeof parsed.id !== "string") throw new Error("Every label line needs a string id.");
    labels.set(parsed.id, parsed);
  }
  return labels;
}

async function runRouterTrain(options: ParsedRouterArgs["options"]): Promise<string> {
  const somaHome = defaultSomaHome(options);
  const axis = options.axis ?? "mode";
  const rows = await readRouterCorpus(options.corpus ?? routerCorpusPath(somaHome));
  if (!options.labels) throw new Error(`--labels is required.\n${ROUTER_COMMAND_HELP.subcommands.train}`);
  const labels = await readLabels(options.labels);
  const embedder = await connectOllamaEmbedder({ host: options.host, model: options.model });
  const cache = await readEmbeddingCache(routerEmbeddingCachePath(somaHome, embedder.model, embedder.digest));

  const examples: CombinerExample[] = [];
  let unembedded = 0;
  for (const row of rows) {
    const label = labels.get(row.id)?.[axis];
    if (typeof label !== "string") continue;
    const features = routerArmCFeatures(row, cache);
    if (!features) {
      unembedded += 1;
      continue;
    }
    examples.push({ session: row.sessionId, features, label });
  }
  if (unembedded > 0) throw new Error(`${unembedded} labelled row(s) have no cached embedding. Run \`soma router embed\` first.`);
  if (examples.length === 0) throw new Error(`No corpus row has a ${axis} label.`);

  const folds = options.folds ?? 5;
  const cv = crossValidateCombiner(examples, { folds });
  const model = trainCombiner(examples, cv.classes);
  const artifact = {
    caller: "mode-router",
    arm: "C",
    axis,
    backend: `ollama:${embedder.model}`,
    backendVersion: embedder.digest,
    trainedAt: new Date().toISOString(),
    examples: examples.length,
    crossValidation: { folds, accuracy: cv.accuracy, majorityAccuracy: cv.majorityAccuracy },
    model,
  };
  const out = options.out ?? createPaths(somaHome).state("router", "combiner", `arm-c-${axis}-${embedder.digest.slice(0, 12)}.json`);
  if (!options.dryRun) await writePrivateJsonl(out, [artifact]);

  const summary = {
    axis,
    examples: examples.length,
    sessions: new Set(examples.map((example) => example.session)).size,
    folds: cv.folds,
    accuracy: cv.accuracy,
    majorityAccuracy: cv.majorityAccuracy,
    confusion: cv.confusion,
    out: options.dryRun ? null : out,
  };
  if (options.json) return `${JSON.stringify(summary, null, 2)}\n`;
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  return [
    "Soma router train (arm C)",
    `axis: ${axis} · model: ${embedder.model} (${embedder.digest.slice(0, 12)})`,
    `examples: ${summary.examples} from ${summary.sessions} session(s), ${folds} session-split folds`,
    `accuracy: ${pct(cv.accuracy)} · majority baseline: ${pct(cv.majorityAccuracy)}`,
    ...cv.folds.map((fold) => `  fold ${fold.fold}: ${fold.correct}/${fold.examples}`),
    "confusion (truth → predicted):",
    ...cv.classes.map((truth) => `  ${truth}: ${cv.classes.map((predicted) => `${predicted} ${cv.confusion[truth][predicted]}`).join(", ")}`),
    `written: ${summary.out ?? "no (dry run)"}`,
  ].join("\n");
}
