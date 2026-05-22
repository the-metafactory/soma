import { ISA_SUBCOMMAND_HELP, ISA_USAGE_HEADER, runIsaCli } from "./cli-isa";
import {
  ALGORITHM_COMMAND_HELP,
  parseAlgorithmArgs,
  runAlgorithmCli,
  type ParsedAlgorithmArgs,
} from "./cli/algorithm";
import { SomaCliError } from "./cli/errors";
import {
  SUBSTRATE_LIFECYCLE_COMMAND_HELP,
  parseDaemonArgs,
  parseExportArgs,
  parseInstallArgs,
  parseReprojectArgs,
  parseUninstallArgs,
  parseUpgradeArgs,
  runSubstrateLifecycleCli,
  type ParsedDaemonArgs,
  type ParsedExportArgs,
  type ParsedInstallArgs,
  type ParsedReprojectArgs,
  type ParsedSubstrateLifecycleArgs,
  type ParsedUninstallArgs,
  type ParsedUpgradeArgs,
} from "./cli/substrate-lifecycle";
import {
  MIGRATE_COMMAND_HELP,
  parseMigrateArgs,
  runMigrateCli,
  type ParsedMigrateArgs,
} from "./cli/migrate";
import {
  IMPORT_COMMAND_HELP,
  parseImportArgs,
  runImportCli,
  type ParsedImportArgs,
} from "./cli/import";
import {
  MEMORY_COMMAND_HELP,
  parseMemoryArgs,
  runMemoryCli,
  type ParsedMemoryArgs,
} from "./cli/memory";
import {
  RESULT_COMMAND_HELP,
  parseResultArgs,
  runResultCli,
  type ParsedResultArgs,
} from "./cli/result";
import {
  POLICY_COMMAND_HELP,
  parsePolicyArgs,
  runPolicyCli,
  type ParsedPolicyArgs,
} from "./cli/policy";
import {
  FEEDBACK_COMMAND_HELP,
  parseFeedbackArgs,
  runFeedbackCli,
  type ParsedFeedbackArgs,
} from "./cli/feedback";
import {
  LIFECYCLE_COMMAND_HELP,
  parseLifecycleArgs,
  runLifecycleCli,
  type ParsedLifecycleArgs,
} from "./cli/lifecycle";
import {
  ONBOARDING_COMMAND_HELP,
  parseAdoptArgs,
  parseDoctorArgs,
  parseInitArgs,
  runOnboardingCli,
  type ParsedOnboardingArgs,
} from "./cli/onboarding";
import {
  TOOL_COMMAND_HELP,
  isParsedToolArgs,
  isToolCommand,
  parseToolArgs,
  runToolCli,
  type ParsedToolArgs,
} from "./cli/tools";

export { SomaCliError } from "./cli/errors";

interface ParsedHelpArgs {
  command: "help";
  topic: string[];
}

interface ParsedIsaArgs {
  command: "isa";
  args: string[];
}

type ParsedArgs =
  | ParsedHelpArgs
  | ParsedInstallArgs
  | ParsedUninstallArgs
  | ParsedReprojectArgs
  | ParsedUpgradeArgs
  | ParsedExportArgs
  | ParsedDaemonArgs
  | ParsedOnboardingArgs
  | ParsedImportArgs
  | ParsedMigrateArgs
  | ParsedAlgorithmArgs
  | ParsedLifecycleArgs
  | ParsedMemoryArgs
  | ParsedFeedbackArgs
  | ParsedResultArgs
  | ParsedPolicyArgs
  | ParsedIsaArgs
  | ParsedToolArgs;

const TOP_LEVEL_COMMANDS = [
  "adopt",
  "algorithm",
  "daemon",
  "doctor",
  "export",
  "feedback",
  "import",
  "inference",
  "install",
  "init",
  "isa",
  "learning",
  "lifecycle",
  "memory",
  "metrics",
  "migrate",
  "opinion",
  "policy",
  "relationship",
  "reproject",
  "result",
  "session",
  "uninstall",
  "upgrade",
  "wisdom",
] as const;

const COMMAND_HELP: Record<string, { usage: string; subcommands?: Record<string, string> }> = {
  algorithm: ALGORITHM_COMMAND_HELP,
  memory: MEMORY_COMMAND_HELP,
  feedback: FEEDBACK_COMMAND_HELP,
  ...TOOL_COMMAND_HELP,
  result: RESULT_COMMAND_HELP,
  policy: POLICY_COMMAND_HELP,
  lifecycle: LIFECYCLE_COMMAND_HELP,
  install: SUBSTRATE_LIFECYCLE_COMMAND_HELP.install,
  uninstall: SUBSTRATE_LIFECYCLE_COMMAND_HELP.uninstall,
  reproject: SUBSTRATE_LIFECYCLE_COMMAND_HELP.reproject,
  upgrade: SUBSTRATE_LIFECYCLE_COMMAND_HELP.upgrade,
  export: SUBSTRATE_LIFECYCLE_COMMAND_HELP.export,
  daemon: SUBSTRATE_LIFECYCLE_COMMAND_HELP.daemon,
  init: ONBOARDING_COMMAND_HELP.init,
  doctor: ONBOARDING_COMMAND_HELP.doctor,
  import: IMPORT_COMMAND_HELP,
  migrate: MIGRATE_COMMAND_HELP,
  adopt: ONBOARDING_COMMAND_HELP.adopt,
  isa: {
    // Single source of truth lives in `./cli-isa.ts` (Sage round-1 dedup).
    usage: ISA_USAGE_HEADER,
    subcommands: ISA_SUBCOMMAND_HELP,
  },
};

function commandUsage(command: string, action?: string): string {
  const commandHelp = COMMAND_HELP[command] as { usage: string; subcommands?: Record<string, string> } | undefined;
  return (action ? commandHelp?.subcommands?.[action] : undefined) ?? commandHelp?.usage ?? `Usage: soma ${command} ...`;
}

function parseArgs(args: string[]): ParsedArgs {
  if (args.length === 0) {
    return { command: "help", topic: [] };
  }

  if (isHelpRequest(args)) {
    const topic = helpTopic(args);
    const [command] = topic;

    if (command && !TOP_LEVEL_COMMANDS.includes(command as (typeof TOP_LEVEL_COMMANDS)[number])) {
      throw new Error(renderUnknownCommand(command));
    }

    return { command: "help", topic };
  }

  if (args[0] === "isa") {
    return { command: "isa", args: args.slice(1) };
  }

  if (args[0] === "lifecycle") {
    return parseLifecycleArgs(args);
  }

  if (args[0] === "memory") {
    return parseMemoryArgs(args);
  }

  if (args[0] === "feedback") {
    return parseFeedbackArgs(args);
  }

  if (isToolCommand(args[0])) {
    return parseToolArgs(args);
  }

  if (args[0] === "result") {
    return parseResultArgs(args);
  }

  if (args[0] === "algorithm") {
    return parseAlgorithmArgs(args);
  }

  if (args[0] === "policy") {
    return parsePolicyArgs(args);
  }

  if (args[0] === "install") {
    return parseInstallArgs(args);
  }

  if (args[0] === "uninstall") {
    return parseUninstallArgs(args);
  }

  if (args[0] === "reproject") {
    return parseReprojectArgs(args);
  }

  if (args[0] === "upgrade") {
    return parseUpgradeArgs(args);
  }

  if (args[0] === "export") {
    return parseExportArgs(args);
  }

  if (args[0] === "daemon") {
    return parseDaemonArgs(args);
  }

  if (args[0] === "init") {
    return parseInitArgs(args);
  }

  if (args[0] === "doctor") {
    return parseDoctorArgs(args);
  }

  if (args[0] === "import") {
    return parseImportArgs(args);
  }

  if (args[0] === "migrate") {
    return parseMigrateArgs(args);
  }

  if (args[0] === "adopt") {
    return parseAdoptArgs(args);
  }

  throw new Error(renderUnknownCommand(args[0]));
}

function isSubstrateLifecycleArgs(parsed: ParsedArgs): parsed is ParsedSubstrateLifecycleArgs {
  return (
    parsed.command === "install" ||
    parsed.command === "uninstall" ||
    parsed.command === "reproject" ||
    parsed.command === "upgrade" ||
    parsed.command === "export" ||
    parsed.command === "daemon"
  );
}

function helpTopic(args: string[]): string[] {
  const helpIndex = args.indexOf("--help");
  const topicArgs = helpIndex === 0 ? args.slice(1) : args.slice(0, helpIndex);

  const firstFlagIndex = topicArgs.findIndex((arg) => arg.startsWith("--"));
  return (firstFlagIndex === -1 ? topicArgs : topicArgs.slice(0, firstFlagIndex)).slice(0, 2);
}

function isHelpRequest(args: string[]): boolean {
  const helpIndex = args.indexOf("--help");
  if (helpIndex === -1) return false;
  if (helpIndex === 0) return true;

  return args.slice(0, helpIndex).every((arg) => !arg.startsWith("--"));
}

function renderUsage(): string {
  const usageLines = [...new Set(Object.values(COMMAND_HELP).flatMap((commandHelp) =>
    [commandHelp.usage, ...Object.values(commandHelp.subcommands ?? {})].map((line) => `  ${line.slice("Usage: ".length)}`),
  ))];

  return [
    "Usage:",
    ...usageLines,
  ].join("\n");
}

function renderHelp(topic: string[]): string {
  const [command, action] = topic;

  if (!command) {
    return renderUsage();
  }

  return commandUsage(command, action);
}

function renderUnknownCommand(command: string): string {
  const suggestion = suggestTopLevelCommand(command);

  return [
    `Unknown command: ${command}`,
    suggestion ? `Did you mean: ${suggestion}?` : undefined,
    "",
    renderUsage(),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function suggestTopLevelCommand(command: string): string | undefined {
  const ranked = TOP_LEVEL_COMMANDS.map((candidate) => ({
    candidate,
    distance: editDistance(command, candidate),
  })).sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate));

  const best = ranked[0];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!best) return undefined;

  const threshold = Math.max(2, Math.floor(best.candidate.length / 3));
  return best.distance <= threshold ? best.candidate : undefined;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array<number>(right.length + 1);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? left.length;
}

export async function runSomaCli(args: string[]): Promise<string> {
  const parsed = parseArgs(args);

  if (parsed.command === "help") {
    return renderHelp(parsed.topic);
  }

  if (parsed.command === "lifecycle") {
    return runLifecycleCli(parsed);
  }

  if (parsed.command === "doctor" || parsed.command === "init" || parsed.command === "adopt") {
    return runOnboardingCli(parsed);
  }

  if (parsed.command === "algorithm") {
    return runAlgorithmCli(parsed);
  }

  if (parsed.command === "isa") {
    const result = await runIsaCli(parsed.args);
    if (result.exitCode !== 0) {
      // Propagate non-zero exit via the same SomaCliError pattern used
      // elsewhere — bubble up to process.exit at the top-level harness.
      throw new SomaCliError(result.text, result.exitCode);
    }
    return result.text;
  }

  if (parsed.command === "memory") {
    return runMemoryCli(parsed);
  }

  if (parsed.command === "feedback") {
    return runFeedbackCli(parsed);
  }

  if (isParsedToolArgs(parsed)) {
    return runToolCli(parsed);
  }

  if (parsed.command === "result") {
    return runResultCli(parsed);
  }

  if (parsed.command === "policy") {
    return runPolicyCli(parsed);
  }

  if (parsed.command === "import") {
    return runImportCli(parsed);
  }

  if (parsed.command === "migrate") {
    return runMigrateCli(parsed);
  }

  if (isSubstrateLifecycleArgs(parsed)) {
    return runSubstrateLifecycleCli(parsed);
  }

  throw new Error("Unhandled command.");
}

if (import.meta.main) {
  try {
    console.log(await runSomaCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof SomaCliError ? error.exitCode : 1;
  }
}
