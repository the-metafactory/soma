import { createReadStream } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { isEnoent } from "../fs-errors";
import { applySomaMemoryEventWritebacks, applySomaWriteback, type SomaWritebackResult } from "../writeback";
import type { SomaMemoryEventInput } from "../types";
import { readOption } from "./parse-utils";
import { parseSubstrate } from "./substrate";

const WRITEBACK_QUEUE_BATCH_SIZE = 500;

interface ParsedWritebackEventArgs {
  command: "writeback";
  action: "event";
  options: {
    somaHome: string;
    substrate?: SomaMemoryEventInput["substrate"];
    timestamp?: string;
    event: Omit<SomaMemoryEventInput, "substrate" | "timestamp"> & {
      substrate?: SomaMemoryEventInput["substrate"];
      timestamp?: string;
    };
  };
}

interface ParsedWritebackEventsArgs {
  command: "writeback";
  action: "events";
  options: {
    somaHome: string;
    queueFile: string;
    checkpointFile?: string;
    substrate?: SomaMemoryEventInput["substrate"];
  };
}

export type ParsedWritebackArgs = ParsedWritebackEventArgs | ParsedWritebackEventsArgs;

export const WRITEBACK_COMMAND_HELP: { usage: string; subcommands: Record<ParsedWritebackArgs["action"], string> } = {
  usage:
    "Usage: soma writeback <event|events> --soma-home <dir> ...",
  subcommands: {
    event:
      "Usage: soma writeback event --soma-home <dir> --kind <kind> --summary <text> [--substrate <id>] [--timestamp <iso>] [--metadata-env <env>] [--artifact-path <path>...]",
    events:
      "Usage: soma writeback events --soma-home <dir> --queue-file <path> [--checkpoint-file <path>] [--substrate <id>]",
  },
};

interface CommonWritebackOptions {
  somaHome?: string;
  substrate?: SomaMemoryEventInput["substrate"];
}

function readCommonWritebackOption(rest: string[], index: number, options: CommonWritebackOptions): number | undefined {
  const arg = rest[index];
  switch (arg) {
    case "--soma-home":
      options.somaHome = readOption(rest, index, arg);
      return index + 1;
    case "--substrate":
      options.substrate = parseSubstrate(readOption(rest, index, arg));
      return index + 1;
    default:
      return undefined;
  }
}

function parseWritebackOptions(
  rest: string[],
  readSpecificOption: (arg: string, index: number) => number | undefined,
): CommonWritebackOptions {
  const common: CommonWritebackOptions = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const nextIndex = readCommonWritebackOption(rest, index, common) ?? readSpecificOption(arg, index);
    if (nextIndex === undefined) throw new Error(`Unknown option: ${arg}`);
    index = nextIndex;
  }
  return common;
}

export function parseWritebackArgs(args: string[]): ParsedWritebackArgs {
  const [command, action, ...rest] = args;
  if (command !== "writeback") {
    throw new Error(WRITEBACK_COMMAND_HELP.usage);
  }
  if (action === "events") {
    return parseWritebackEventsArgs(command, action, rest);
  }
  if (action !== "event") {
    throw new Error(WRITEBACK_COMMAND_HELP.usage);
  }
  return parseWritebackEventArgs(command, action, rest);
}

function parseWritebackEventArgs(command: "writeback", action: "event", rest: string[]): ParsedWritebackEventArgs {
  let timestamp: string | undefined;
  let kind: string | undefined;
  let summary: string | undefined;
  let metadata: Record<string, unknown> | undefined;
  const artifactPaths: string[] = [];

  const common = parseWritebackOptions(rest, (arg, index) => {
    switch (arg) {
      case "--timestamp":
        timestamp = readOption(rest, index, arg);
        return index + 1;
      case "--kind":
        kind = readOption(rest, index, arg);
        return index + 1;
      case "--summary":
        summary = readOption(rest, index, arg);
        return index + 1;
      case "--metadata-env": {
        const envName = readOption(rest, index, arg);
        metadata = parseMetadataEnv(envName);
        return index + 1;
      }
      case "--artifact-path":
        artifactPaths.push(readOption(rest, index, arg));
        return index + 1;
      default:
        return undefined;
    }
  });

  if (!common.somaHome) throw new Error("soma writeback event is missing required option: --soma-home.");
  if (!kind) throw new Error("soma writeback event is missing required option: --kind.");
  if (!summary) throw new Error("soma writeback event is missing required option: --summary.");

  return {
    command,
    action,
    options: {
      somaHome: common.somaHome,
      substrate: common.substrate,
      timestamp,
      event: {
        kind,
        summary,
        metadata,
        artifactPaths: artifactPaths.length > 0 ? artifactPaths : undefined,
      },
    },
  };
}

function parseWritebackEventsArgs(command: "writeback", action: "events", rest: string[]): ParsedWritebackEventsArgs {
  let queueFile: string | undefined;
  let checkpointFile: string | undefined;

  const common = parseWritebackOptions(rest, (arg, index) => {
    switch (arg) {
      case "--queue-file":
        queueFile = readOption(rest, index, arg);
        return index + 1;
      case "--checkpoint-file":
        checkpointFile = readOption(rest, index, arg);
        return index + 1;
      default:
        return undefined;
    }
  });

  if (!common.somaHome) throw new Error("soma writeback events is missing required option: --soma-home.");
  if (!queueFile) throw new Error("soma writeback events is missing required option: --queue-file.");
  return { command, action, options: { somaHome: common.somaHome, queueFile, checkpointFile, substrate: common.substrate } };
}

function parseMetadataEnv(envName: string): Record<string, unknown> {
  const raw = process.env[envName];
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Metadata env ${envName} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export async function runWritebackCli(parsed: ParsedWritebackArgs): Promise<string> {
  if (parsed.action === "events") {
    return runWritebackEventsCli(parsed);
  }
  return formatWritebackResult(await applySomaWriteback({
    somaHome: parsed.options.somaHome,
    substrate: parsed.options.substrate,
    timestamp: parsed.options.timestamp,
    operation: {
      kind: "memory-event",
      event: parsed.options.event,
    },
  }));
}

async function runWritebackEventsCli(parsed: ParsedWritebackEventsArgs): Promise<string> {
  const queueFilePath = parsed.options.queueFile;
  const checkpointPath = parsed.options.checkpointFile ?? `${queueFilePath}.checkpoint`;
  const checkpoint = await readQueueCheckpoint(checkpointPath);
  const result = await drainQueuedEvents(parsed, { queueFilePath, checkpointPath, checkpoint });
  if (result.drained) await removeDrainedQueueFiles(queueFilePath, checkpointPath);
  return formatWritebackQueueResult(result.applied, result.writes);
}

async function drainQueuedEvents(
  parsed: ParsedWritebackEventsArgs,
  options: { queueFilePath: string; checkpointPath: string; checkpoint: number },
): Promise<{ applied: number; writes: string[]; drained: boolean }> {
  const writes = new Set<string>();
  let batch: ParsedWritebackEventArgs["options"]["event"][] = [];
  let eventIndex = 0;
  let applied = 0;
  let nextCheckpoint = options.checkpoint;

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    const batchSize = batch.length;
    const result = await applyQueuedEventBatch(parsed, batch);
    result.writes.forEach((write) => writes.add(write));
    applied += batchSize;
    nextCheckpoint += batchSize;
    await writeQueueCheckpoint(options.checkpointPath, nextCheckpoint);
    batch = [];
  };

  for await (const line of readQueuedEventLines(options.queueFilePath)) {
    if (line.trim().length === 0) throw new Error("Queued writeback event line must not be blank.");
    if (eventIndex < options.checkpoint) {
      eventIndex += 1;
      continue;
    }
    const event = parseQueuedEvent(line, parsed.options.substrate);
    batch.push(event);
    eventIndex += 1;
    if (batch.length >= WRITEBACK_QUEUE_BATCH_SIZE) {
      await flushBatch();
    }
  }

  await flushBatch();
  return { applied, writes: Array.from(writes), drained: true };
}

async function removeDrainedQueueFiles(queueFilePath: string, checkpointPath: string): Promise<void> {
  await rm(queueFilePath, { force: true });
  await rm(checkpointPath, { force: true });
}

function applyQueuedEventBatch(
  parsed: ParsedWritebackEventsArgs,
  events: ParsedWritebackEventArgs["options"]["event"][],
): Promise<SomaWritebackResult> {
  return applySomaMemoryEventWritebacks({
    somaHome: parsed.options.somaHome,
    substrate: parsed.options.substrate,
    events,
  });
}

async function* readQueuedEventLines(path: string): AsyncGenerator<string> {
  const exists = await stat(path).then(
    () => true,
    (error: unknown) => {
      if (isEnoent(error)) return false;
      throw error;
    },
  );
  if (!exists) throw new Error(`Queued writeback file does not exist: ${path}`);

  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    yield line;
  }
}

async function readQueueCheckpoint(path: string): Promise<number> {
  const raw = await readFile(path, "utf8").catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (raw === undefined) return 0;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function writeQueueCheckpoint(path: string, appliedEvents: number): Promise<void> {
  await writeFile(path, `${appliedEvents}`, "utf8");
}

function parseQueuedEvent(line: string, defaultSubstrate?: SomaMemoryEventInput["substrate"]): ParsedWritebackEventArgs["options"]["event"] {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Queued writeback event must be a JSON object.");
  }
  const event = parsed as Record<string, unknown>;
  if (typeof event.kind !== "string" || event.kind.trim().length === 0) {
    throw new Error("Queued writeback event is missing required field: kind.");
  }
  if (typeof event.summary !== "string" || event.summary.trim().length === 0) {
    throw new Error("Queued writeback event is missing required field: summary.");
  }
  const substrate = typeof event.substrate === "string" ? parseSubstrate(event.substrate) : defaultSubstrate;
  const artifactPaths = Array.isArray(event.artifactPaths)
    ? event.artifactPaths.filter((path): path is string => typeof path === "string")
    : undefined;
  const metadata = typeof event.metadata === "object" && event.metadata !== null && !Array.isArray(event.metadata)
    ? event.metadata as Record<string, unknown>
    : undefined;
  return {
    kind: event.kind,
    summary: event.summary,
    substrate,
    timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
    artifactPaths: artifactPaths && artifactPaths.length > 0 ? artifactPaths : undefined,
    metadata,
  };
}

function formatWritebackResult(result: SomaWritebackResult): string {
  return [
    "Soma writeback applied",
    `merge: ${result.merge}`,
    "",
    "Writes:",
    ...result.writes.map((path: string) => `- ${path}`),
  ].join("\n");
}

function formatWritebackQueueResult(count: number, writes: string[]): string {
  return [
    "Soma writeback queue applied",
    `events: ${count}`,
    "",
    "Writes:",
    ...writes.map((path: string) => `- ${path}`),
  ].join("\n");
}
