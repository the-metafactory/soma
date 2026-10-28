// `soma algorithm classify` on its own, for the Claude Code mode-classifier
// worker. Loading ./algorithm for it cost the hook about 100 ms of module load
// on every prompt, for run, store and VSA code classify never calls.
import { classifyAlgorithmPrompt, classifyPlaybookCard, type PlaybookCardHint } from "../algorithm/algorithm-classifier";
import type { AlgorithmPromptClassification } from "../algorithm/types";
import { defaultSomaHome, hashJudgmentInput, recordJudgment } from "../core/index";
import type { SubstrateId } from "../core/types";
import { regexClassifierVersion } from "../router/index";
import { readOption } from "./parse-utils";
import { parseSubstrate } from "./substrate";

export interface AlgorithmClassifyOptions {
  homeDir?: string;
  somaHome?: string;
  prompt?: string;
  substrate?: SubstrateId;
  json?: boolean;
  /** Append a `soma judge` ledger line for this classification. */
  record?: boolean;
  /** With `record`: the substrate session the prompt belongs to. */
  session?: string;
}

/**
 * Parse `algorithm classify` arguments as parseAlgorithmArgs does for the
 * options classify reads, with the same error for each. Any other flag is
 * refused; parseAlgorithmArgs accepts and ignores it. The hook never sends one.
 */
export function parseAlgorithmClassifyArgs(args: string[]): AlgorithmClassifyOptions {
  const [command, action, ...rest] = args;
  if (command !== "algorithm" || action !== "classify") throw new Error(`Expected algorithm classify, got: ${args.slice(0, 2).join(" ")}`);

  const options: AlgorithmClassifyOptions = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        break;
      case "--prompt":
        options.prompt = readOption(rest, index, arg);
        index += 1;
        break;
      case "--substrate":
        options.substrate = parseSubstrate(readOption(rest, index, arg));
        index += 1;
        break;
      case "--session":
        options.session = readOption(rest, index, arg);
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--record":
        options.record = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function formatAlgorithmClassification(classification: AlgorithmPromptClassification): string {
  return [
    "Soma Algorithm prompt classification",
    `mode: ${classification.mode}`,
    `effort: ${classification.effort ?? "none"}`,
    `source: ${classification.source}`,
    `reason: ${classification.reason}`,
  ].join("\n");
}

/** `card` is a hint for the substrate hook, outside the classification the pi-dev copy mirrors. */
function formatAlgorithmClassificationJson(classification: AlgorithmPromptClassification, card: PlaybookCardHint | undefined): string {
  return `${JSON.stringify(card === undefined ? classification : { ...classification, card })}\n`;
}

/**
 * Classify, and with `--record` append one `soma judge` ledger line. Recording
 * is best-effort and never changes the classification or its output.
 */
export async function runAlgorithmClassify(options: AlgorithmClassifyOptions): Promise<string> {
  const prompt = options.prompt;
  if (!prompt) throw new Error("--prompt is required.");

  const started = performance.now();
  const classification = classifyAlgorithmPrompt(prompt);
  const card = classifyPlaybookCard(prompt);
  const latencyMs = Math.round((performance.now() - started) * 1000) / 1000;

  if (options.record) {
    const decision: Record<string, string> = { mode: classification.mode };
    if (classification.effort) decision.effort = classification.effort;
    if (card) decision.card = card;
    await recordJudgment(defaultSomaHome(options), {
      v: 1,
      ts: new Date().toISOString(),
      caller: "mode-router",
      ...(options.substrate ? { substrate: options.substrate } : {}),
      ...(options.session ? { session: options.session } : {}),
      inputSha256: hashJudgmentInput(prompt),
      backend: "regex",
      backendVersion: regexClassifierVersion(),
      decision,
      source: classification.source,
      latencyMs,
    });
  }

  return options.json ? formatAlgorithmClassificationJson(classification, card) : formatAlgorithmClassification(classification);
}
