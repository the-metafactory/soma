import { captureSomaResult, searchSomaResults } from "../index";
import { isSomaResultEventKind } from "../result-capture";
import { SOMA_RESULT_EVENT_KINDS } from "../types";
import type {
  SomaResultCaptureOptions,
  SomaResultCaptureResult,
  SomaResultEventKind,
  SomaResultSearchOptions,
  SomaResultSearchResult,
} from "../types";
import { readOption } from "./parse-utils";
import { parseSubstrate } from "./substrate";

export interface ParsedResultCaptureArgs {
  command: "result";
  action: "capture";
  options: SomaResultCaptureOptions;
}

export interface ParsedResultSearchArgs {
  command: "result";
  action: "search";
  options: SomaResultSearchOptions;
}

export type ParsedResultArgs = ParsedResultCaptureArgs | ParsedResultSearchArgs;

export const RESULT_COMMAND_HELP: { usage: string; subcommands: Record<ParsedResultArgs["action"], string> } = {
  usage: "Usage: soma result <capture|search> ...",
  subcommands: {
    capture:
      "Usage: soma result capture --substrate <id> --source <source> --summary <text> [--artifact-path <path>...] [--skill <id>] [--session-id <id>] [--kind <kind>] [--home-dir <dir>] [--soma-home <dir>]",
    search: "Usage: soma result search --query <text> [--limit <n>] [--home-dir <dir>] [--soma-home <dir>]",
  },
};

export function parseResultArgs(args: string[]): ParsedResultArgs {
  const [command, action, ...rest] = args;

  if (command !== "result" || (action !== "capture" && action !== "search")) {
    throw new Error(RESULT_COMMAND_HELP.usage);
  }

  if (action === "capture") {
    return {
      command,
      action,
      options: parseResultCaptureArgs(rest),
    };
  }

  return {
    command,
    action,
    options: parseResultSearchArgs(rest),
  };
}

function parseResultKind(value: string): SomaResultEventKind {
  if (isSomaResultEventKind(value)) {
    return value;
  }

  throw new Error(`Unsupported result kind '${value}'. Expected one of: ${SOMA_RESULT_EVENT_KINDS.join(", ")}.`);
}

function readResultSharedOption(
  options: Pick<Partial<SomaResultCaptureOptions & SomaResultSearchOptions>, "homeDir" | "somaHome">,
  args: string[],
  index: number,
  arg: string,
): number | undefined {
  switch (arg) {
    case "--home-dir":
      options.homeDir = readOption(args, index, arg);
      return index + 1;
    case "--soma-home":
      options.somaHome = readOption(args, index, arg);
      return index + 1;
    default:
      return undefined;
  }
}

function parsePositiveIntegerOption(args: string[], index: number, arg: string): number {
  const raw = readOption(args, index, arg);
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${arg} must be a positive integer.`);
  }

  return Number(raw);
}

function parseResultCaptureArgs(args: string[]): SomaResultCaptureOptions {
  const options: Partial<SomaResultCaptureOptions> = {};
  const artifactPaths: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const sharedOptionIndex = readResultSharedOption(options, args, index, arg);
    if (sharedOptionIndex !== undefined) {
      index = sharedOptionIndex;
      continue;
    }

    switch (arg) {
      case "--substrate":
        options.substrate = parseSubstrate(readOption(args, index, arg));
        index += 1;
        break;
      case "--source":
        options.source = readOption(args, index, arg);
        index += 1;
        break;
      case "--summary":
        options.summary = readOption(args, index, arg);
        index += 1;
        break;
      case "--artifact-path":
        artifactPaths.push(readOption(args, index, arg));
        index += 1;
        break;
      case "--skill":
        options.skill = readOption(args, index, arg);
        index += 1;
        break;
      case "--session-id":
        options.sessionId = readOption(args, index, arg);
        index += 1;
        break;
      case "--kind":
        options.kind = parseResultKind(readOption(args, index, arg));
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  const missing: string[] = [];
  if (!options.substrate) missing.push("--substrate");
  if (!options.source) missing.push("--source");
  if (!options.summary) missing.push("--summary");
  if (missing.length > 0) {
    throw new Error(`soma result capture is missing required option(s): ${missing.join(", ")}.`);
  }

  return {
    ...options,
    artifactPaths: artifactPaths.length > 0 ? artifactPaths : undefined,
  } as SomaResultCaptureOptions;
}

function parseResultSearchArgs(args: string[]): SomaResultSearchOptions {
  const options: Partial<SomaResultSearchOptions> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const sharedOptionIndex = readResultSharedOption(options, args, index, arg);
    if (sharedOptionIndex !== undefined) {
      index = sharedOptionIndex;
      continue;
    }

    switch (arg) {
      case "--query":
        options.query = readOption(args, index, arg);
        index += 1;
        break;
      case "--limit":
        options.limit = parsePositiveIntegerOption(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.query) {
    throw new Error("soma result search is missing required option: --query.");
  }

  return options as SomaResultSearchOptions;
}

export async function runResultCli(parsed: ParsedResultArgs): Promise<string> {
  if (parsed.action === "capture") {
    return formatResultCaptureResult(await captureSomaResult(parsed.options));
  }

  return formatResultSearchResult(await searchSomaResults(parsed.options));
}

function formatResultCaptureResult(result: SomaResultCaptureResult): string {
  return [
    "Soma result capture",
    `event: ${result.event.id}`,
    `kind: ${result.event.kind}`,
    `somaHome: ${result.somaHome}`,
    result.event.artifactPaths && result.event.artifactPaths.length > 0
      ? `artifactPaths: ${result.event.artifactPaths.map((artifactPath) => sanitizeTerminalText(artifactPath)).join(", ")}`
      : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function sanitizeTerminalText(value: string): string {
  const escapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  const controlPattern = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, "g");
  return value.replace(escapePattern, "").replace(controlPattern, " ");
}

function formatResultSearchResult(result: SomaResultSearchResult): string {
  return [
    "Soma result search",
    `query: ${sanitizeTerminalText(result.query)}`,
    `somaHome: ${result.somaHome}`,
    "",
    "Matches:",
    ...(result.matches.length > 0
      ? result.matches.map((match) =>
          [
            `- ${match.eventPath}:${match.line}`,
            `[event ${match.eventId}]`,
            `[kind ${match.kind}]`,
            `[score ${match.score}]`,
            sanitizeTerminalText(match.summary),
            match.artifactPaths.length > 0
              ? `(artifacts: ${match.artifactPaths.map((artifactPath) => sanitizeTerminalText(artifactPath)).join(", ")})`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        )
      : ["- none"]),
  ].join("\n");
}
