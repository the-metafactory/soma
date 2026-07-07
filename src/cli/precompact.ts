import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildSomaStartupContext, resolveSomaHome } from "../lifecycle";
import { isEnoent } from "../fs-errors";
import type { SomaLifecycleOptions } from "../types";
import { readOption } from "./parse-utils";
import { parseSubstrate } from "./substrate";

/**
 * `soma precompact` — the compaction-survival handover for substrates (notably
 * Claude Code) whose context window is compressed mid-session.
 *
 * `capture` (fired on the substrate's pre-compaction event) snapshots the
 * live work-state — active Algorithm runs, recent learning — into a durable,
 * session-scoped file AND prints it to stdout (some substrates surface the
 * hook's stdout directly). `resurface` (fired on the next user prompt after
 * compaction) prints that file once and consumes it, re-injecting the handover
 * into the compacted context. Compaction does not re-run SessionStart, so the
 * persist+resurface pair is what carries work-state across the boundary.
 */

export interface ParsedPreCompactArgs {
  command: "precompact";
  action: "capture" | "resurface";
  options: SomaLifecycleOptions;
}

const PRECOMPACT_USAGE =
  "Usage: soma precompact <capture|resurface> [--home-dir <dir>] [--soma-home <dir>] [--substrate <id>] [--session-id <id>] [--cwd <dir>]";

export const PRECOMPACT_COMMAND_HELP: { usage: string; subcommands: Record<ParsedPreCompactArgs["action"], string> } = {
  usage: PRECOMPACT_USAGE,
  subcommands: {
    capture: PRECOMPACT_USAGE,
    resurface: PRECOMPACT_USAGE,
  },
};

export function parsePreCompactArgs(args: string[]): ParsedPreCompactArgs {
  const [command, action, ...rest] = args;

  if (command !== "precompact" || (action !== "capture" && action !== "resurface")) {
    throw new Error(PRECOMPACT_COMMAND_HELP.usage);
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
      case "--cwd":
        options.cwd = readOption(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { command: "precompact", action, options };
}

// Session ids come from the substrate (Claude Code sends a UUID). Restrict to a
// filename-safe alphabet so a hostile/odd id can never escape memory/STATE.
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function preCompactHandoverPath(somaHome: string, sessionId?: string): string {
  const scoped = sessionId !== undefined && sessionId.trim().length > 0;
  const name = scoped ? `precompact-handover-${sanitizeSessionId(sessionId)}.md` : "precompact-handover.md";
  return join(somaHome, "memory/STATE", name);
}

function renderHandover(input: { context: string; timestamp: string; sessionId?: string; cwd?: string }): string {
  const header = [
    "# Pre-Compaction Handover",
    `*Captured: ${input.timestamp}*`,
    input.sessionId ? `Session: ${input.sessionId}` : undefined,
    input.cwd ? `Working directory: \`${input.cwd}\`` : undefined,
    "",
    input.context,
  ].filter((line): line is string => line !== undefined);
  return `${header.join("\n")}\n`;
}

async function runCapture(options: SomaLifecycleOptions): Promise<string> {
  const startup = await buildSomaStartupContext(options);
  const handover = renderHandover({
    context: startup.context,
    timestamp: startup.timestamp,
    sessionId: startup.sessionId,
    cwd: options.cwd,
  });
  const path = preCompactHandoverPath(startup.somaHome, startup.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, handover, "utf8");
  // stdout is the emit surface — printed AND persisted (JC: the pre-compaction
  // output is cleared before it can be read, so persistence is what survives).
  return handover.trimEnd();
}

async function runResurface(options: SomaLifecycleOptions): Promise<string> {
  const somaHome = resolveSomaHome(options);
  const path = preCompactHandoverPath(somaHome, options.sessionId);
  const content = await readFile(path, "utf8").catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (content === undefined) return "";
  // Consume-once: delete after reading so the handover is re-injected exactly
  // on the first prompt after compaction, not on every subsequent prompt.
  await rm(path, { force: true });
  return content.trimEnd();
}

export async function runPreCompactCli(parsed: ParsedPreCompactArgs): Promise<string> {
  if (parsed.action === "capture") {
    return runCapture(parsed.options);
  }
  return runResurface(parsed.options);
}
