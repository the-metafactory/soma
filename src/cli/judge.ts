import { JUDGE_REGISTRY, judgeLedgerPath, readJudgments, summarizeJudgments } from "../judge";
import { defaultSomaHome } from "../paths";
import { readOption } from "./parse-utils";

type JudgeCliAction = "stats" | "registry";

export interface ParsedJudgeArgs {
  command: "judge";
  action: JudgeCliAction;
  options: {
    homeDir?: string;
    somaHome?: string;
    caller?: string;
    since?: string;
    json?: boolean;
  };
}

export const JUDGE_COMMAND_HELP: { usage: string; subcommands: Record<JudgeCliAction, string> } = {
  usage: "Usage: soma judge <stats|registry> ...",
  subcommands: {
    stats: "Usage: soma judge stats [--caller <id>] [--since <YYYY-MM-DD>] [--json] [--home-dir <dir>] [--soma-home <dir>]",
    registry: "Usage: soma judge registry [--json]",
  },
};

export function parseJudgeArgs(args: string[]): ParsedJudgeArgs {
  const [command, action, ...rest] = args;

  if (command !== "judge" || (action !== "stats" && action !== "registry")) {
    throw new Error(JUDGE_COMMAND_HELP.usage);
  }

  const options: ParsedJudgeArgs["options"] = {};
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
      case "--caller":
        options.caller = readOption(rest, index, arg);
        index += 1;
        break;
      case "--since":
        options.since = readOption(rest, index, arg);
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n${JUDGE_COMMAND_HELP.subcommands[action]}`);
    }
  }

  return { command, action, options };
}

export async function runJudgeCli(parsed: ParsedJudgeArgs): Promise<string> {
  const { options } = parsed;

  if (parsed.action === "registry") {
    if (options.json) return `${JSON.stringify(JUDGE_REGISTRY, null, 2)}\n`;
    return [
      "Soma judge registry",
      ...JUDGE_REGISTRY.map((caller) => {
        const measured = caller.measuredOn
          ? `measured ${caller.measuredOn.agreement} on ${caller.measuredOn.date} (${caller.measuredOn.backend} ${caller.measuredOn.backendVersion})`
          : "not measured";
        return `- ${caller.id}: ${caller.state}, ${measured} — ${caller.description}`;
      }),
    ].join("\n");
  }

  const somaHome = defaultSomaHome(options);
  const { records, malformed } = await readJudgments(somaHome);
  const stats = summarizeJudgments(records, { caller: options.caller, since: options.since });

  if (options.json) return `${JSON.stringify({ ledger: judgeLedgerPath(somaHome), malformed, callers: stats }, null, 2)}\n`;

  const lines = ["Soma judge stats", `ledger: ${judgeLedgerPath(somaHome)}`];
  if (malformed > 0) lines.push(`malformed lines skipped: ${malformed}`);
  if (stats.length === 0) {
    lines.push("No judgments recorded.");
    return lines.join("\n");
  }

  for (const caller of stats) {
    lines.push("", `${caller.caller} (${caller.state}): ${caller.total} judgment(s), median ${caller.medianLatencyMs ?? "n/a"} ms`);
    for (const [key, values] of Object.entries(caller.decisions)) {
      const parts = Object.entries(values)
        .sort(([, left], [, right]) => right - left)
        .map(([value, count]) => `${value} ${count} (${Math.round((count / caller.total) * 100)}%)`);
      lines.push(`  ${key}: ${parts.join(", ")}`);
    }
  }

  return lines.join("\n");
}
