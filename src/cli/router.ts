import { homedir } from "node:os";
import { join } from "node:path";
import { defaultSomaHome } from "../paths";
import {
  ROUTER_CORPUS_DEFAULT_SAMPLE,
  ROUTER_CORPUS_DEFAULT_SEED,
  ROUTER_CORPUS_SKIP_REASONS,
  buildRouterCorpus,
  routerCorpusPath,
  writeRouterCorpus,
} from "../router-corpus";
import { readOption } from "./parse-utils";

type RouterCliAction = "corpus";

export interface ParsedRouterArgs {
  command: "router";
  action: RouterCliAction;
  options: {
    homeDir?: string;
    somaHome?: string;
    projectsDir?: string;
    out?: string;
    sample?: number;
    seed?: string;
    dryRun?: boolean;
    json?: boolean;
  };
}

export const ROUTER_COMMAND_HELP: { usage: string; subcommands: Record<RouterCliAction, string> } = {
  usage: "Usage: soma router <corpus> ...",
  subcommands: {
    corpus: `Usage: soma router corpus [--projects-dir <dir>] [--sample <n>] [--seed <text>] [--out <path>] [--dry-run] [--json] [--home-dir <dir>] [--soma-home <dir>]\nExtracts the principal's typed Claude Code prompts, each with the tail of the reply before it, into a private sample (default ${ROUTER_CORPUS_DEFAULT_SAMPLE}, seed "${ROUTER_CORPUS_DEFAULT_SEED}"). Prints counts only, never prompts.`,
  },
};

export function parseRouterArgs(args: string[]): ParsedRouterArgs {
  const [command, action, ...rest] = args;

  if (command !== "router" || action !== "corpus") {
    throw new Error(ROUTER_COMMAND_HELP.usage);
  }

  const options: ParsedRouterArgs["options"] = {};
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
      case "--projects-dir":
        options.projectsDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--out":
        options.out = readOption(rest, index, arg);
        index += 1;
        break;
      case "--sample": {
        const value = Number(readOption(rest, index, arg));
        if (!Number.isInteger(value) || value < 0) throw new Error("--sample must be a non-negative integer.");
        options.sample = value;
        index += 1;
        break;
      }
      case "--seed":
        options.seed = readOption(rest, index, arg);
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n${ROUTER_COMMAND_HELP.subcommands.corpus}`);
    }
  }

  return { command, action, options };
}

export async function runRouterCli(parsed: ParsedRouterArgs): Promise<string> {
  const { options } = parsed;
  const projectsDir = options.projectsDir ?? join(options.homeDir ?? homedir(), ".claude", "projects");
  const out = options.out ?? routerCorpusPath(defaultSomaHome(options));

  const result = await buildRouterCorpus({ projectsDir, sample: options.sample, seed: options.seed });
  if (!options.dryRun) await writeRouterCorpus(out, result.rows);

  const summary = {
    projectsDir,
    out: options.dryRun ? null : out,
    transcripts: result.transcripts,
    candidates: result.candidates,
    sampled: result.rows.length,
    sessions: result.sessions,
    withPreviousReply: result.rows.filter((row) => row.hasPreviousReply).length,
    queued: result.rows.filter((row) => row.source === "queued").length,
    withRegexAtTime: result.rows.filter((row) => row.regexAtTime !== null).length,
    skipped: result.skipped,
  };

  if (options.json) return `${JSON.stringify(summary, null, 2)}\n`;

  return [
    "Soma router corpus",
    `projects: ${projectsDir}`,
    `written: ${summary.out ?? "no (dry run)"}`,
    `transcripts: ${summary.transcripts}`,
    `candidate prompts: ${summary.candidates}`,
    `sampled: ${summary.sampled} from ${summary.sessions} session(s)`,
    `  with a previous reply: ${summary.withPreviousReply}`,
    `  typed mid-turn (queued): ${summary.queued}`,
    `  with the mode hook's decision at the time: ${summary.withRegexAtTime}`,
    "skipped:",
    ...ROUTER_CORPUS_SKIP_REASONS.filter((reason) => result.skipped[reason] > 0).map((reason) => `  ${reason}: ${result.skipped[reason]}`),
  ].join("\n");
}
