import { JUDGE_REGISTRY, labelJudgment, summarizeJudgments } from "../router/index";
import { judgeLedgerPath, readJudgmentLabels, readJudgments, type PrincipalJudgmentLabel } from "../core/index";
import { defaultSomaHome } from "../core/index";
import { readOption } from "./parse-utils";

type JudgeCliAction = "stats" | "registry" | "label";

export type ParsedJudgeArgs = {
  command: "judge";
  options: {
    homeDir?: string;
    somaHome?: string;
    caller?: string;
    since?: string;
    json?: boolean;
  };
} & ({ action: "stats" | "registry" } | { action: "label"; judgmentId: string; verdict: PrincipalJudgmentLabel["verdict"] });

export const JUDGE_COMMAND_HELP: { usage: string; subcommands: Record<JudgeCliAction, string> } = {
  usage: "Usage: soma judge <stats|registry|label> ...",
  subcommands: {
    stats: "Usage: soma judge stats [--caller <id>] [--since <YYYY-MM-DD>] [--json] [--home-dir <dir>] [--soma-home <dir>]",
    registry: "Usage: soma judge registry [--json]",
    label: "Usage: soma judge label <judgment-id> <--right|--wrong> [--json] [--home-dir <dir>] [--soma-home <dir>] (requires SOMA_PRINCIPAL)",
  },
};

function parseLabelArgs(rest: string[]): ParsedJudgeArgs & { action: "label" } {
  const [judgmentId, ...args] = rest;
  if (!judgmentId || judgmentId.startsWith("--")) throw new Error(JUDGE_COMMAND_HELP.subcommands.label);
  const options: ParsedJudgeArgs["options"] = {};
  let verdict: PrincipalJudgmentLabel["verdict"] | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--right":
      case "--wrong":
        if (verdict !== undefined) throw new Error(JUDGE_COMMAND_HELP.subcommands.label);
        verdict = arg === "--right" ? "right" : "wrong";
        break;
      case "--home-dir":
        options.homeDir = readOption(args, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(args, index, arg);
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n${JUDGE_COMMAND_HELP.subcommands.label}`);
    }
  }
  if (!verdict) throw new Error(JUDGE_COMMAND_HELP.subcommands.label);
  return { command: "judge", action: "label", options, judgmentId, verdict };
}

export function parseJudgeArgs(args: string[]): ParsedJudgeArgs {
  const [command, action, ...rest] = args;

  if (command !== "judge" || (action !== "stats" && action !== "registry" && action !== "label")) {
    throw new Error(JUDGE_COMMAND_HELP.usage);
  }

  if (action === "label") return parseLabelArgs(rest);
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

  if (parsed.action === "label") {
    const label = await labelJudgment({ somaHome: defaultSomaHome(options), judgmentId: parsed.judgmentId, verdict: parsed.verdict });
    return options.json ? `${JSON.stringify(label, null, 2)}\n` : `Labeled ${label.judgmentId} ${label.verdict} by principal ${label.principal}`;
  }

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
  const filter = { caller: options.caller, since: options.since };
  const { records, malformed } = await readJudgments(somaHome, filter);
  const { labels, malformed: malformedLabels } = await readJudgmentLabels(somaHome);
  const stats = summarizeJudgments(records, filter, labels);

  if (options.json) return `${JSON.stringify({ ledger: judgeLedgerPath(somaHome), malformed, malformedLabels, callers: stats, judgments: records }, null, 2)}\n`;

  const lines = ["Soma judge stats", `ledger: ${judgeLedgerPath(somaHome)}`];
  if (malformed > 0) lines.push(`malformed lines skipped: ${malformed}`);
  if (malformedLabels > 0) lines.push(`malformed labels skipped: ${malformedLabels}`);
  if (stats.length === 0) {
    lines.push("No judgments recorded.");
    return lines.join("\n");
  }

  for (const caller of stats) {
    lines.push("", `${caller.caller} (${caller.state}): ${caller.total} judgment(s), median ${caller.medianLatencyMs ?? "n/a"} ms`);
    lines.push(`  principal labels: ${caller.labeled} labeled, ${caller.right} right, ${caller.wrong} wrong; agreement: ${caller.agreement === null ? "n/a" : `${Math.round(caller.agreement * 100)}%`}`);
    for (const [key, values] of Object.entries(caller.decisions)) {
      const parts = Object.entries(values)
        .sort(([, left], [, right]) => right - left)
        .map(([value, count]) => `${value} ${count} (${Math.round((count / caller.total) * 100)}%)`);
      lines.push(`  ${key}: ${parts.join(", ")}`);
    }
  }

  return lines.join("\n");
}
