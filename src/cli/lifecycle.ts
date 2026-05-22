import {
  runSomaLifecycleAlgorithmUpdated,
  runSomaLifecycleSessionEnd,
  runSomaLifecycleSessionStart,
} from "../index";
import type { SomaLifecycleOptions, SomaLifecycleResult } from "../types";
import { readOption } from "./parse-utils";
import { parseSubstrate } from "./substrate";

export interface ParsedLifecycleArgs {
  command: "lifecycle";
  event: "session-start" | "algorithm-updated" | "session-end";
  options: SomaLifecycleOptions;
}

const LIFECYCLE_USAGE =
  "Usage: soma lifecycle <session-start|algorithm-updated|session-end> [--home-dir <dir>] [--soma-home <dir>] [--substrate <id>] [--session-id <id>]";

export const LIFECYCLE_COMMAND_HELP: { usage: string; subcommands: Record<ParsedLifecycleArgs["event"], string> } = {
  usage: LIFECYCLE_USAGE,
  subcommands: {
    "session-start": LIFECYCLE_USAGE,
    "algorithm-updated": LIFECYCLE_USAGE,
    "session-end": LIFECYCLE_USAGE,
  },
};

export function parseLifecycleArgs(args: string[]): ParsedLifecycleArgs {
  const [command, event, ...rest] = args;

  if (command !== "lifecycle" || (event !== "session-start" && event !== "algorithm-updated" && event !== "session-end")) {
    throw new Error(LIFECYCLE_COMMAND_HELP.usage);
  }

  const options: SomaLifecycleOptions = {};

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
      case "--substrate":
        options.substrate = parseSubstrate(readOption(rest, index, arg));
        index += 1;
        break;
      case "--session-id":
        options.sessionId = readOption(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    command,
    event,
    options,
  };
}

export async function runLifecycleCli(parsed: ParsedLifecycleArgs): Promise<string> {
  if (parsed.event === "session-start") {
    return formatLifecycleResult(await runSomaLifecycleSessionStart(parsed.options));
  }

  if (parsed.event === "algorithm-updated") {
    return formatLifecycleResult(await runSomaLifecycleAlgorithmUpdated(parsed.options));
  }

  return formatLifecycleResult(await runSomaLifecycleSessionEnd(parsed.options));
}

function formatLifecycleResult(result: SomaLifecycleResult): string {
  const lines = [
    "Soma lifecycle event handled",
    `event: ${result.event}`,
    `somaHome: ${result.somaHome}`,
    `timestamp: ${result.timestamp}`,
    "",
    "Files:",
    ...result.files.map((path) => `- ${path}`),
  ];

  if (result.context) {
    lines.push("", result.context);
  }

  return lines.join("\n");
}
