import { runInferenceCli } from "../tools/inference/cli";
import { runLearningCli, runMetricsCli, runOpinionCli, runSessionCli } from "../tools/learning/cli";
import { RELATIONSHIP_REFLECT_USAGE, runRelationshipCli } from "../tools/relationship/cli";
import { runWisdomCli } from "../tools/wisdom/cli";

export interface ParsedInferenceArgs {
  command: "inference";
  args: string[];
}

export interface ParsedRawToolArgs {
  command: "learning" | "opinion" | "metrics" | "session" | "relationship" | "wisdom";
  args: string[];
}

export type ParsedToolArgs = ParsedInferenceArgs | ParsedRawToolArgs;

export const TOOL_COMMANDS = ["inference", "learning", "opinion", "metrics", "session", "relationship", "wisdom"] as const;

export const TOOL_COMMAND_HELP: Record<ParsedToolArgs["command"], { usage: string; subcommands?: Record<string, string> }> = {
  inference: {
    usage:
      "Usage: soma inference [--level <fast|standard|smart>] [--mode <inference|advisor>] [--backend <auto|claude-code|anthropic-api>] [--allow-network] [--json] [--timeout <ms>] [--auto-state] [--home-dir <dir>] [--soma-home <dir>] [prompt...]",
  },
  learning: {
    usage: "Usage: soma learning <synthesize|capture-failure|harvest> ...",
    subcommands: {
      synthesize: "Usage: soma learning synthesize [--week|--month|--all] [--dry-run] [--home-dir <dir>] [--soma-home <dir>]",
      "capture-failure": "Usage: soma learning capture-failure <transcript-path> <rating> <summary> [detailed-context] [--home-dir <dir>] [--soma-home <dir>]",
      harvest: "Usage: soma learning harvest [--recent <n>|--all|--session <id>] [--session-dir <dir>] [--dry-run] [--home-dir <dir>] [--soma-home <dir>] (default: work registry; --session-dir: raw transcript JSONL)",
    },
  },
  opinion: {
    usage: "Usage: soma opinion <add|evidence|list|show> ...",
    subcommands: {
      add: "Usage: soma opinion add <statement> [--category <communication|technical|relationship|work_style>] [--home-dir <dir>] [--soma-home <dir>]",
      evidence: "Usage: soma opinion evidence <statement> (--supporting|--counter|--confirmation|--contradiction) <description> [--home-dir <dir>] [--soma-home <dir>]",
      list: "Usage: soma opinion list [--home-dir <dir>] [--soma-home <dir>]",
      show: "Usage: soma opinion show <statement> [--home-dir <dir>] [--soma-home <dir>]",
    },
  },
  metrics: {
    usage: "Usage: soma metrics [--shell] [--single <key>] [--home-dir <dir>] [--soma-home <dir>]",
  },
  session: {
    usage: "Usage: soma session <create|decision|work|blocker|next|handoff|resume|list|complete> ...",
  },
  relationship: {
    usage: RELATIONSHIP_REFLECT_USAGE,
    subcommands: {
      reflect: RELATIONSHIP_REFLECT_USAGE,
    },
  },
  wisdom: {
    usage: "Usage: soma wisdom <classify|list|update|synthesize|health> ...",
    subcommands: {
      classify: "Usage: soma wisdom classify <text> [--home-dir <dir>] [--soma-home <dir>]",
      list: "Usage: soma wisdom list [--home-dir <dir>] [--soma-home <dir>]",
      update:
        "Usage: soma wisdom update --domain <domain> --type <principle|contextual-rule|prediction|anti-pattern|evolution> --observation <text> [--home-dir <dir>] [--soma-home <dir>]",
      synthesize: "Usage: soma wisdom synthesize [--dry-run] [--threshold <0..1>] [--home-dir <dir>] [--soma-home <dir>]",
      health: "Usage: soma wisdom health [--dry-run] [--threshold <0..1>] [--home-dir <dir>] [--soma-home <dir>]",
    },
  },
};

const TOOL_RUNNERS: Record<ParsedToolArgs["command"], (args: string[]) => Promise<string> | string> = {
  inference: runInferenceCli,
  learning: runLearningCli,
  opinion: runOpinionCli,
  metrics: runMetricsCli,
  session: runSessionCli,
  relationship: runRelationshipCli,
  wisdom: runWisdomCli,
};

export function isToolCommand(command: string): command is ParsedToolArgs["command"] {
  return (TOOL_COMMANDS as readonly string[]).includes(command);
}

export function isParsedToolArgs(parsed: { command: string }): parsed is ParsedToolArgs {
  return isToolCommand(parsed.command);
}

export function parseToolArgs(args: string[]): ParsedToolArgs {
  const [command, ...rest] = args;
  if (!command || !isToolCommand(command)) {
    throw new Error("Usage: soma <tool> ...");
  }

  return { command, args: rest };
}

export async function runToolCli(parsed: ParsedToolArgs): Promise<string> {
  return TOOL_RUNNERS[parsed.command](parsed.args);
}
