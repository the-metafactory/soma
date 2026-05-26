import { querySomaTelemetryEvents, summarizeSomaTelemetry } from "../index";
import type {
  SomaMemoryEvent,
  SomaTelemetryQueryOptions,
  SomaTelemetryQueryResult,
  SomaTelemetrySummary,
  SomaTelemetrySummaryOptions,
} from "../types";
import { readOption } from "./parse-utils";
import { parseSubstrate } from "./substrate";

export interface ParsedTelemetryListArgs {
  command: "telemetry";
  action: "list";
  options: SomaTelemetryQueryOptions & { json?: boolean };
}

export interface ParsedTelemetryStatsArgs {
  command: "telemetry" | "stats";
  action: "stats";
  options: SomaTelemetrySummaryOptions & { json?: boolean };
}

export type ParsedTelemetryArgs = ParsedTelemetryListArgs | ParsedTelemetryStatsArgs;

const TELEMETRY_LIST_USAGE =
  "Usage: soma telemetry list [--limit <n>] [--substrate <id>] [--kind <event-kind>] [--json] [--home-dir <dir>] [--soma-home <dir>]";
const TELEMETRY_STATS_USAGE = "Usage: soma telemetry stats [--json] [--home-dir <dir>] [--soma-home <dir>]";

export const TELEMETRY_COMMAND_HELP: { usage: string; subcommands: Record<"list" | "stats", string> } = {
  usage: "Usage: soma telemetry <list|stats> ...",
  subcommands: {
    list: TELEMETRY_LIST_USAGE,
    stats: TELEMETRY_STATS_USAGE,
  },
};

export const STATS_COMMAND_HELP: { usage: string } = {
  usage: "Usage: soma stats [--json] [--home-dir <dir>] [--soma-home <dir>]",
};

export function parseTelemetryArgs(args: string[]): ParsedTelemetryArgs {
  const [command, action, ...rest] = args;

  if (command === "stats") {
    return {
      command,
      action: "stats",
      options: parseTelemetryStatsOptions(args.slice(1)),
    };
  }

  if (command !== "telemetry" || (action !== "list" && action !== "stats")) {
    throw new Error(TELEMETRY_COMMAND_HELP.usage);
  }

  if (action === "list") {
    return {
      command,
      action,
      options: parseTelemetryListOptions(rest),
    };
  }

  return {
    command,
    action,
    options: parseTelemetryStatsOptions(rest),
  };
}

function parseTelemetryListOptions(args: string[]): SomaTelemetryQueryOptions & { json?: boolean } {
  const options: SomaTelemetryQueryOptions & { json?: boolean } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const commonIndex = parseTelemetryCommonOption(options, args, index, arg);
    if (commonIndex !== undefined) {
      index = commonIndex;
      continue;
    }

    switch (arg) {
      case "--substrate":
        options.substrate = parseSubstrate(readOption(args, index, arg));
        index += 1;
        break;
      case "--kind":
        options.kind = readOption(args, index, arg);
        index += 1;
        break;
      case "--limit":
        options.limit = parsePositiveInteger(readOption(args, index, arg), "--limit");
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${option} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return parsed;
}

function parseTelemetryStatsOptions(args: string[]): SomaTelemetrySummaryOptions & { json?: boolean } {
  const options: SomaTelemetrySummaryOptions & { json?: boolean } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const commonIndex = parseTelemetryCommonOption(options, args, index, arg);
    if (commonIndex !== undefined) {
      index = commonIndex;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function parseTelemetryCommonOption(
  options: SomaTelemetrySummaryOptions & { json?: boolean },
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
    case "--json":
      options.json = true;
      return index;
    default:
      return undefined;
  }
}

export async function runTelemetryCli(parsed: ParsedTelemetryArgs): Promise<string> {
  if (parsed.action === "list") {
    const result = await querySomaTelemetryEvents(parsed.options);
    return parsed.options.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatTelemetryList(result);
  }

  const summary = await summarizeSomaTelemetry(parsed.options);
  return parsed.options.json === true ? `${JSON.stringify(summary, null, 2)}\n` : formatTelemetryStats(summary);
}

function formatTelemetryList(result: SomaTelemetryQueryResult): string {
  return [
    "Soma telemetry events",
    `somaHome: ${result.somaHome}`,
    `eventPath: ${result.eventPath}`,
    `totalEvents: ${result.totalEvents}`,
    `skippedMalformedLines: ${result.skippedMalformedLines}`,
    "",
    "Events:",
    ...(result.events.length > 0 ? result.events.map(formatEventLine) : ["- none"]),
  ].join("\n");
}

function formatEventLine(event: SomaMemoryEvent): string {
  return `- ${event.timestamp} ${event.substrate} ${event.kind} ${event.id} - ${event.summary}`;
}

function formatCountMap(record: Record<string, number> | Partial<Record<string, number>>): string[] {
  const entries = Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
  return entries.length > 0 ? entries.map(([key, value]) => `- ${key}: ${value}`) : ["- none"];
}

function formatTelemetryStats(summary: SomaTelemetrySummary): string {
  return [
    "Soma telemetry stats",
    `somaHome: ${summary.somaHome}`,
    `eventPath: ${summary.eventPath}`,
    `totalEvents: ${summary.totalEvents}`,
    `skippedMalformedLines: ${summary.skippedMalformedLines}`,
    `firstTimestamp: ${summary.firstTimestamp ?? "n/a"}`,
    `lastTimestamp: ${summary.lastTimestamp ?? "n/a"}`,
    "",
    "Sessions:",
    `- started: ${summary.sessions.started}`,
    `- ended: ${summary.sessions.ended}`,
    `- completedWithDuration: ${summary.sessions.completedWithDuration}`,
    `- averageDurationMs: ${summary.sessions.averageDurationMs ?? "n/a"}`,
    ...formatSessionSubstrateStats(summary.sessions.bySubstrate),
    "",
    "Skills:",
    `- events: ${summary.skills.events}`,
    ...formatCountMap(summary.skills.byName).map((line) => `  ${line}`),
    "",
    "Substrates:",
    ...formatCountMap(summary.bySubstrate),
    "",
    "Kinds:",
    ...formatCountMap(summary.byKind),
    "",
    "Algorithm:",
    `- events: ${summary.algorithm.events}`,
    ...formatCountMap(summary.algorithm.byPhase).map((line) => `  ${line}`),
    "",
    "Writeback:",
    `- events: ${summary.writeback.events}`,
    `- failures: ${summary.writeback.failures}`,
  ].join("\n");
}

function formatSessionSubstrateStats(stats: SomaTelemetrySummary["sessions"]["bySubstrate"]): string[] {
  const entries = Object.entries(stats).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return ["- bySubstrate: none"];

  return [
    "- bySubstrate:",
    ...entries.map(([substrate, value]) =>
      `  - ${substrate}: started=${value.started} ended=${value.ended} completedWithDuration=${value.completedWithDuration} averageDurationMs=${value.averageDurationMs ?? "n/a"}`,
    ),
  ];
}
