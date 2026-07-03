import {
  promoteAlgorithmRunMemory,
  recallMemory,
  searchSomaMemory,
  verifyMemoryNote,
  writeMemoryNote,
} from "../index";
import { WRITABLE_NOTE_TYPES, isWritableNoteType } from "../memory-write";
import type {
  SomaMemoryNoteType,
  SomaMemoryPromotionOptions,
  SomaMemoryPromotionResult,
  SomaMemoryPromotionStore,
  SomaMemoryRecallOptions,
  SomaMemoryRecallResult,
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

export interface ParsedMemoryRecallArgs {
  command: "memory";
  action: "recall";
  options: SomaMemoryRecallOptions;
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
  | ParsedMemoryRecallArgs
  | ParsedMemoryPromoteArgs
  | ParsedMemoryWriteArgs
  | ParsedMemoryVerifyArgs;

const MEMORY_ACTIONS = ["search", "recall", "promote", "write", "verify"] as const;
type MemoryAction = (typeof MEMORY_ACTIONS)[number];

export const MEMORY_COMMAND_HELP: { usage: string; subcommands: Record<MemoryAction, string> } = {
  usage: "Usage: soma memory <search|recall|promote|write|verify> ...",
  subcommands: {
    search: "Usage: soma memory search [query] [--query <text>] [--limit <n>] [--home-dir <dir>] [--soma-home <dir>]",
    recall:
      "Usage: soma memory recall <query> [--query <text>] [--limit <n>] [--home-dir <dir>] [--soma-home <dir>]. " +
      "Note-aware retrieval over durable notes: term-scored whole-file matches (limit 3) + 1-hop links, " +
      "superseded notes excluded, each result carrying a verification banner. Read-only.",
    promote: "Usage: soma memory promote --from-run <run-id> --store <learning|knowledge|relationship|work> --title <text> [--lesson <text>] [--applies-when <text>]",
    write:
      "Usage: soma memory write --trigger <principal-correction|import> --body <text> " +
      "(create: --id <slug> --type <semantic|procedural> [--force]) " +
      "(--merge <id> | --supersede <id>) " +
      "[--principal-authority] [--project <key>] [--source-of-truth <ref>] [--links a,b] " +
      "[--recall-trigger <text>] [--review <text>] " +
      "[--provenance <import|tool:name>] [--substrate <s>] [--home-dir <dir>] [--soma-home <dir>]. " +
      "Trust is DERIVED from --trigger; there is no --trust flag. principal-correction requires " +
      "--principal-authority. (The consolidation trigger, which mints assistant trust, is an internal " +
      "M6 SDK path and is not accepted on the public CLI.)",
    verify:
      "Usage: soma memory verify <id> [--id <id>] [--principal-authority] [--substrate <s>] [--home-dir <dir>] [--soma-home <dir>]. " +
      "Verifying a principal-trust note requires --principal-authority (assistant-trust notes are an internal SDK path).",
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
    case "recall":
      return { command, action, options: parseMemoryRecallArgs(rest) };
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

function parseMemoryRecallArgs(args: string[]): SomaMemoryRecallOptions {
  const options: Partial<SomaMemoryRecallOptions> = {};
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
          throw new Error(`soma memory recall accepts only one positional query; unexpected argument: ${arg}`);
        }
        positionalQuery = arg;
    }
  }

  options.query ??= positionalQuery;

  if (!options.query) {
    throw new Error("soma memory recall needs a query; pass it as the first argument or --query <text>.");
  }

  return options as SomaMemoryRecallOptions;
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
  // `consolidation` is a valid SDK trigger but not a public-CLI one — it needs
  // consolidationAuthority, which is SDK-only. Reject it here with a clear parse
  // error instead of letting it fail later inside the writer.
  if (value === "consolidation") {
    throw new Error("--trigger consolidation is an internal (M6) SDK path, not available on the public CLI.");
  }
  if (value === "principal-correction" || value === "import") {
    return value;
  }
  throw new Error(`--trigger must be principal-correction or import (consolidation is SDK-only).`);
}

function parseWriteType(value: string): SomaMemoryNoteType {
  if (!isWritableNoteType(value)) {
    throw new Error(`--type must be ${WRITABLE_NOTE_TYPES.join(" or ")} (episodic writes go through digest/action, M5).`);
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
      case "--recall-trigger":
        // Maps to the note's `hook` frontmatter field (M0 schema). The
        // user-facing flag avoids the reserved `hook` term (CONTEXT.md).
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
    throw new Error("soma memory write needs --trigger <principal-correction|import>.");
  }
  if (options.body === undefined) {
    throw new Error("soma memory write needs --body <text>.");
  }

  if (mergeTarget !== undefined) {
    // merge edits an existing note in place — it takes neither a new id nor a
    // type. Reject them rather than silently ignoring (the target is --merge <id>).
    if (options.id !== undefined || options.type !== undefined) {
      throw new Error("soma memory write --merge takes neither --id nor --type; the target is --merge <id>.");
    }
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
    case "recall":
      return formatMemoryRecallResult(await recallMemory(parsed.options));
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

function formatMemoryRecallResult(result: SomaMemoryRecallResult): string {
  const lines = [
    "Soma memory recall",
    `query: ${result.query}`,
    `terms: ${result.terms.length > 0 ? result.terms.join(", ") : "(none — needs a 3+char term)"}`,
    `somaHome: ${result.somaHome}`,
    "",
  ];

  if (result.matches.length === 0) {
    lines.push("No active notes matched.");
  } else {
    for (const match of result.matches) {
      const heading =
        match.via === "match"
          ? `━━ ${match.id} [${match.type}] · ${match.score} term${match.score === 1 ? "" : "s"} matched`
          : `━━ ${match.id} [${match.type}] · via link from ${match.linkedFrom}`;
      lines.push(heading, match.banner, "", match.note.body, "");
    }
  }

  // Surface both blind spots explicitly — recall never hides an unresolved link or
  // an unreadable corpus file behind a clean-looking result.
  if (result.unresolvedLinks.length > 0) {
    lines.push(`Unresolved 1-hop links (missing or superseded): ${result.unresolvedLinks.join(", ")}`);
  }
  if (result.unreadable.length > 0) {
    lines.push(`⚠ ${result.unreadable.length} corpus file(s) unreadable — recall was partial:`);
    for (const path of result.unreadable) lines.push(`  - ${path}`);
  }

  return lines.join("\n").trimEnd();
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
