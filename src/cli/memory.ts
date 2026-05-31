import { promoteAlgorithmRunMemory, searchSomaMemory } from "../index";
import type {
  SomaMemoryPromotionOptions,
  SomaMemoryPromotionResult,
  SomaMemoryPromotionStore,
  SomaMemorySearchOptions,
  SomaMemorySearchResult,
} from "../types";
import { readOption } from "./parse-utils";
import { parseSubstrate } from "./substrate";

export interface ParsedMemorySearchArgs {
  command: "memory";
  action: "search";
  options: SomaMemorySearchOptions;
}

export interface ParsedMemoryPromoteArgs {
  command: "memory";
  action: "promote";
  options: SomaMemoryPromotionOptions;
}

export type ParsedMemoryArgs = ParsedMemorySearchArgs | ParsedMemoryPromoteArgs;

export const MEMORY_COMMAND_HELP: { usage: string; subcommands: Record<ParsedMemoryArgs["action"], string> } = {
  usage: "Usage: soma memory <search|promote> ...",
  subcommands: {
    search: "Usage: soma memory search [query] [--query <text>] [--limit <n>] [--home-dir <dir>] [--soma-home <dir>]",
    promote: "Usage: soma memory promote --from-run <run-id> --store <learning|knowledge|relationship|work> --title <text> [--lesson <text>] [--applies-when <text>]",
  },
};

export function parseMemoryArgs(args: string[]): ParsedMemoryArgs {
  const [command, action, ...rest] = args;

  if (command !== "memory" || (action !== "search" && action !== "promote")) {
    throw new Error(MEMORY_COMMAND_HELP.usage);
  }

  if (action === "search") {
    return {
      command,
      action,
      options: parseMemorySearchArgs(rest),
    };
  }

  return {
    command,
    action,
    options: parseMemoryPromoteArgs(rest),
  };
}

function parseMemorySearchArgs(args: string[]): SomaMemorySearchOptions {
  const options: Partial<SomaMemorySearchOptions> = {};
  let positionalQuery: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--home-dir":
        options.homeDir = readOption(args, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(args, index, arg);
        index += 1;
        break;
      case "--query":
        options.query = readOption(args, index, arg);
        index += 1;
        break;
      case "--limit":
        options.limit = Number.parseInt(readOption(args, index, arg), 10);
        if (!Number.isFinite(options.limit) || options.limit < 1) {
          throw new Error("--limit must be a positive integer.");
        }
        index += 1;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        if (positionalQuery !== undefined) {
          throw new Error(`soma memory search accepts only one positional query; unexpected argument: ${arg}`);
        }
        positionalQuery = arg;
    }
  }

  options.query ??= positionalQuery;

  if (!options.query) {
    throw new Error("soma memory search needs a query; pass it as the first argument or --query <text>.");
  }

  return options as SomaMemorySearchOptions;
}

function parseMemoryPromoteArgs(args: string[]): SomaMemoryPromotionOptions {
  const options: Partial<SomaMemoryPromotionOptions> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--home-dir":
        options.homeDir = readOption(args, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(args, index, arg);
        index += 1;
        break;
      case "--substrate":
        options.substrate = parseSubstrate(readOption(args, index, arg));
        index += 1;
        break;
      case "--from-run":
        options.fromRun = readOption(args, index, arg);
        index += 1;
        break;
      case "--store":
        options.store = parseMemoryPromotionStore(readOption(args, index, arg));
        index += 1;
        break;
      case "--title":
        options.title = readOption(args, index, arg);
        index += 1;
        break;
      case "--lesson":
        options.lesson = readOption(args, index, arg);
        index += 1;
        break;
      case "--applies-when":
        options.appliesWhen = readOption(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  const missing: string[] = [];
  if (!options.fromRun) missing.push("--from-run");
  if (!options.store) missing.push("--store");
  if (!options.title) missing.push("--title");
  if (missing.length > 0) {
    throw new Error(`soma memory promote is missing required option(s): ${missing.join(", ")}.`);
  }

  return options as SomaMemoryPromotionOptions;
}

function parseMemoryPromotionStore(value: string): SomaMemoryPromotionStore {
  if (value === "learning" || value === "knowledge" || value === "relationship" || value === "work") {
    return value;
  }

  throw new Error("--store must be one of learning, knowledge, relationship, or work.");
}

export async function runMemoryCli(parsed: ParsedMemoryArgs): Promise<string> {
  if (parsed.action === "promote") {
    return formatMemoryPromotionResult(await promoteAlgorithmRunMemory(parsed.options));
  }

  return formatMemorySearchResult(await searchSomaMemory(parsed.options));
}

function formatMemorySearchResult(result: SomaMemorySearchResult): string {
  return [
    "Soma memory search",
    `query: ${result.query}`,
    `somaHome: ${result.somaHome}`,
    "",
    "Matches:",
    ...(result.matches.length > 0
      ? result.matches.map((match) => `- ${match.path}:${match.line} [score ${match.score}] ${match.snippet}`)
      : ["- none"]),
  ].join("\n");
}

function formatMemoryPromotionResult(result: SomaMemoryPromotionResult): string {
  return [
    "Soma memory promotion created",
    `store: ${result.store}`,
    `path: ${result.path}`,
    `sourceRunPath: ${result.sourceRunPath}`,
    `event: ${result.event.id}`,
  ].join("\n");
}
