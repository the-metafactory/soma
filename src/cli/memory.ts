import {
  promoteAlgorithmRunMemory,
  searchSomaMemory,
  verifyMemoryNote,
  writeMemoryNote,
} from "../index";
import { SOMA_MEMORY_WRITE_TRIGGERS } from "../types";
import type {
  SomaMemoryNoteType,
  SomaMemoryPromotionOptions,
  SomaMemoryPromotionResult,
  SomaMemoryPromotionStore,
  SomaMemorySearchOptions,
  SomaMemorySearchResult,
  SomaMemoryVerifyOptions,
  SomaMemoryVerifyResult,
  SomaMemoryWriteOptions,
  SomaMemoryWriteResult,
  SomaMemoryWriteTrigger,
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

export interface ParsedMemoryWriteArgs {
  command: "memory";
  action: "write";
  options: SomaMemoryWriteOptions;
}

export interface ParsedMemoryVerifyArgs {
  command: "memory";
  action: "verify";
  options: SomaMemoryVerifyOptions;
}

export type ParsedMemoryArgs =
  | ParsedMemorySearchArgs
  | ParsedMemoryPromoteArgs
  | ParsedMemoryWriteArgs
  | ParsedMemoryVerifyArgs;

const MEMORY_ACTIONS = ["search", "promote", "write", "verify"] as const;
type MemoryAction = (typeof MEMORY_ACTIONS)[number];

export const MEMORY_COMMAND_HELP: { usage: string; subcommands: Record<MemoryAction, string> } = {
  usage: "Usage: soma memory <search|promote|write|verify> ...",
  subcommands: {
    search: "Usage: soma memory search [query] [--query <text>] [--limit <n>] [--home-dir <dir>] [--soma-home <dir>]",
    promote: "Usage: soma memory promote --from-run <run-id> --store <learning|knowledge|relationship|work> --title <text> [--lesson <text>] [--applies-when <text>]",
    write:
      "Usage: soma memory write --trigger <principal-correction|import|consolidation> --body <text> " +
      "(create: --id <slug> --type <semantic|procedural> [--force]) " +
      "(--merge <id> | --supersede <id>) " +
      "[--principal-authority] [--project <key>] [--source-of-truth <ref>] [--links a,b] [--hook <text>] [--review <text>] " +
      "[--provenance <import|tool:name>] [--substrate <s>] [--home-dir <dir>] [--soma-home <dir>]. " +
      "Trust is DERIVED from --trigger; there is no --trust flag. principal-correction " +
      "additionally requires --principal-authority (a deliberate, logged escalation to principal trust).",
    verify:
      "Usage: soma memory verify <id> [--id <id>] [--principal-authority] [--substrate <s>] [--home-dir <dir>] [--soma-home <dir>]. " +
      "Verifying a principal-trust note requires --principal-authority.",
  },
};

function isMemoryAction(value: string): value is MemoryAction {
  return (MEMORY_ACTIONS as readonly string[]).includes(value);
}

export function parseMemoryArgs(args: string[]): ParsedMemoryArgs {
  const [command, action, ...rest] = args;

  if (command !== "memory" || !isMemoryAction(action)) {
    throw new Error(MEMORY_COMMAND_HELP.usage);
  }

  switch (action) {
    case "search":
      return { command, action, options: parseMemorySearchArgs(rest) };
    case "promote":
      return { command, action, options: parseMemoryPromoteArgs(rest) };
    case "write":
      return { command, action, options: parseMemoryWriteArgs(rest) };
    case "verify":
      return { command, action, options: parseMemoryVerifyArgs(rest) };
  }
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

function parseWriteTrigger(value: string): SomaMemoryWriteTrigger {
  if ((SOMA_MEMORY_WRITE_TRIGGERS as readonly string[]).includes(value)) {
    return value as SomaMemoryWriteTrigger;
  }
  throw new Error(`--trigger must be one of ${SOMA_MEMORY_WRITE_TRIGGERS.join(", ")}.`);
}

function parseWriteType(value: string): SomaMemoryNoteType {
  if (value !== "semantic" && value !== "procedural") {
    throw new Error(`--type must be semantic or procedural (episodic writes go through digest/action, M5).`);
  }
  return value;
}

function parseMemoryWriteArgs(args: string[]): SomaMemoryWriteOptions {
  const options: Partial<SomaMemoryWriteOptions> = {};
  let mergeTarget: string | undefined;
  let supersedeTarget: string | undefined;

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
      case "--trigger":
        options.trigger = parseWriteTrigger(readOption(args, index, arg));
        index += 1;
        break;
      case "--id":
        options.id = readOption(args, index, arg);
        index += 1;
        break;
      case "--type":
        options.type = parseWriteType(readOption(args, index, arg));
        index += 1;
        break;
      case "--body":
        options.body = readOption(args, index, arg);
        index += 1;
        break;
      case "--project":
        options.project = readOption(args, index, arg);
        index += 1;
        break;
      case "--source-of-truth":
        options.sourceOfTruth = readOption(args, index, arg);
        index += 1;
        break;
      case "--links":
        options.links = readOption(args, index, arg)
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        index += 1;
        break;
      case "--hook":
        options.hook = readOption(args, index, arg);
        index += 1;
        break;
      case "--review":
        options.review = readOption(args, index, arg);
        index += 1;
        break;
      case "--provenance":
        options.provenance = readOption(args, index, arg);
        index += 1;
        break;
      case "--merge":
        mergeTarget = readOption(args, index, arg);
        index += 1;
        break;
      case "--supersede":
        supersedeTarget = readOption(args, index, arg);
        index += 1;
        break;
      case "--force":
        options.force = true;
        break;
      case "--principal-authority":
        options.principalAuthority = true;
        break;
      case "--trust":
        throw new Error(
          "soma memory write has no --trust flag: trust is derived from --trigger " +
            "(principal-correction→principal, import→quarantined, consolidation→assistant).",
        );
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (mergeTarget !== undefined && supersedeTarget !== undefined) {
    throw new Error("soma memory write accepts --merge or --supersede, not both.");
  }
  if (!options.trigger) {
    throw new Error("soma memory write needs --trigger <principal-correction|import|consolidation>.");
  }
  if (options.body === undefined) {
    throw new Error("soma memory write needs --body <text>.");
  }

  if (mergeTarget !== undefined) {
    options.mode = "merge";
    options.targetId = mergeTarget;
  } else if (supersedeTarget !== undefined) {
    options.mode = "supersede";
    options.targetId = supersedeTarget;
  } else {
    options.mode = "create";
  }

  // create + supersede both mint a new note and need id + type.
  if (options.mode !== "merge") {
    const missing: string[] = [];
    if (!options.id) missing.push("--id");
    if (!options.type) missing.push("--type");
    if (missing.length > 0) {
      throw new Error(`soma memory ${options.mode} is missing required option(s): ${missing.join(", ")}.`);
    }
  }

  return options as SomaMemoryWriteOptions;
}

function parseMemoryVerifyArgs(args: string[]): SomaMemoryVerifyOptions {
  const options: Partial<SomaMemoryVerifyOptions> = {};
  let positionalId: string | undefined;

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
      case "--id":
        options.id = readOption(args, index, arg);
        index += 1;
        break;
      case "--principal-authority":
        options.principalAuthority = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        if (positionalId !== undefined) {
          throw new Error(`soma memory verify accepts only one positional id; unexpected argument: ${arg}`);
        }
        positionalId = arg;
    }
  }

  // Reject a conflicting positional + --id rather than silently preferring one —
  // verify is a mutating command, so an ignored id must not slip through.
  if (options.id !== undefined && positionalId !== undefined && options.id !== positionalId) {
    throw new Error(`soma memory verify got two different ids ("${positionalId}" and --id "${options.id}"); pass only one.`);
  }
  options.id ??= positionalId;
  if (!options.id) {
    throw new Error("soma memory verify needs a note id; pass it as the first argument or --id <id>.");
  }

  return options as SomaMemoryVerifyOptions;
}

export async function runMemoryCli(parsed: ParsedMemoryArgs): Promise<string> {
  switch (parsed.action) {
    case "promote":
      return formatMemoryPromotionResult(await promoteAlgorithmRunMemory(parsed.options));
    case "write":
      return formatMemoryWriteResult(await writeMemoryNote(parsed.options));
    case "verify":
      return formatMemoryVerifyResult(await verifyMemoryNote(parsed.options));
    case "search":
      return formatMemorySearchResult(await searchSomaMemory(parsed.options));
  }
}

function formatMemoryWriteResult(result: SomaMemoryWriteResult): string {
  const lines = [
    `Soma memory ${result.mode}`,
    `id: ${result.note.id}`,
    `type: ${result.note.type}`,
    `trust: ${result.note.trust}`,
    `provenance: ${result.note.provenance}`,
    `path: ${result.path}`,
  ];
  if (result.supersededId) lines.push(`superseded: ${result.supersededId} (valid_until set)`);
  lines.push(`event: ${result.event.id}`);
  return lines.join("\n");
}

function formatMemoryVerifyResult(result: SomaMemoryVerifyResult): string {
  return [
    "Soma memory verify",
    `id: ${result.note.id}`,
    `last_verified: ${result.note.last_verified}`,
    `resurface_count: ${result.note.resurface_count}`,
    `path: ${result.path}`,
    `event: ${result.event.id}`,
  ].join("\n");
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
