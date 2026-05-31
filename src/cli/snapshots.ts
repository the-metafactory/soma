import {
  createSomaSnapshot,
  listSomaSnapshots,
  rollbackSomaSnapshot,
} from "../snapshots";
import type {
  SomaSnapshotListOptions,
  SomaSnapshotOptions,
  SomaSnapshotRollbackOptions,
} from "../types";
import { readOption } from "./parse-utils";

export const SNAPSHOT_USAGE =
  "Usage: soma snapshot [--name <name>] [--trigger <trigger>] [--home-dir <dir>] [--soma-home <dir>]";
export const HISTORY_USAGE =
  "Usage: soma history [--limit <n>] [--home-dir <dir>] [--soma-home <dir>]";
export const ROLLBACK_USAGE =
  "Usage: soma rollback <snapshot> [--home-dir <dir>] [--soma-home <dir>]";

export const SNAPSHOT_COMMAND_HELP = {
  snapshot: { usage: SNAPSHOT_USAGE },
  history: { usage: HISTORY_USAGE },
  rollback: { usage: ROLLBACK_USAGE },
} as const;

export interface ParsedSnapshotArgs {
  command: "snapshot";
  options: SomaSnapshotOptions;
}

export interface ParsedHistoryArgs {
  command: "history";
  options: SomaSnapshotListOptions;
}

export interface ParsedRollbackArgs {
  command: "rollback";
  options: SomaSnapshotRollbackOptions;
}

export type ParsedSnapshotCommandArgs = ParsedSnapshotArgs | ParsedHistoryArgs | ParsedRollbackArgs;

export function parseSnapshotArgs(args: string[]): ParsedSnapshotArgs {
  const [, ...rest] = args;
  const options: SomaSnapshotOptions = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--name":
        options.name = readOption(rest, index, arg);
        index += 1;
        break;
      case "--trigger":
        options.trigger = readOption(rest, index, arg);
        index += 1;
        break;
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { command: "snapshot", options };
}

export function parseHistoryArgs(args: string[]): ParsedHistoryArgs {
  const [, ...rest] = args;
  const options: SomaSnapshotListOptions = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--limit": {
        const raw = readOption(rest, index, arg);
        index += 1;
        const limit = Number(raw);
        if (!Number.isInteger(limit) || limit < 1) {
          throw new Error("--limit must be a positive integer.");
        }
        options.limit = limit;
        break;
      }
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { command: "history", options };
}

export function parseRollbackArgs(args: string[]): ParsedRollbackArgs {
  const [, snapshot, ...rest] = args;
  if (!snapshot || snapshot.startsWith("--")) {
    throw new Error(ROLLBACK_USAGE);
  }
  const options: SomaSnapshotRollbackOptions = { snapshot };
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
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { command: "rollback", options };
}

export async function runSnapshotCli(parsed: ParsedSnapshotCommandArgs): Promise<string> {
  if (parsed.command === "snapshot") {
    const snapshot = await createSomaSnapshot(parsed.options);
    return [
      "soma snapshot — created",
      `id: ${snapshot.id}`,
      `name: ${snapshot.name}`,
      `trigger: ${snapshot.trigger}`,
      `somaHome: ${snapshot.somaHome}`,
      "",
    ].join("\n");
  }
  if (parsed.command === "history") {
    const entries = await listSomaSnapshots(parsed.options);
    if (entries.length === 0) {
      return "soma history — no snapshots found\n";
    }
    return [
      "soma history",
      "",
      ...entries.map((entry) => `${entry.id.slice(0, 12)}  ${entry.createdAt}  ${entry.name}`),
      "",
    ].join("\n");
  }
  const rollback = await rollbackSomaSnapshot(parsed.options);
  return [
    "soma rollback — restored",
    `id: ${rollback.id}`,
    `name: ${rollback.name}`,
    `somaHome: ${rollback.somaHome}`,
    "",
  ].join("\n");
}
