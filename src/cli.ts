import { readSync } from "node:fs";
import {
  captureSomaFeedback,
  installSomaForClaudeCode,
  planSomaForClaudeCodeInstall,
  uninstallSomaForClaudeCode,
  type UninstallClaudeCodeOptions,
  runSomaLifecycleAlgorithmUpdated,
  runSomaLifecycleSessionEnd,
  runSomaLifecycleSessionStart,
} from "./index";
import type {
  SomaInstallOptions,
  SomaDoctorDiagnosis,
  SomaInitPlan,
  SomaOnboardingOptions,
  SomaFeedbackCaptureOptions,
  SomaFeedbackCaptureResult,
  SomaLifecycleOptions,
  SomaLifecycleResult,
} from "./types";
import { SOMA_FEEDBACK_STDIN_MAX_BYTES } from "./feedback-contract";
import { ISA_SUBCOMMAND_HELP, ISA_USAGE_HEADER, runIsaCli } from "./cli-isa";
import { readOption } from "./cli/parse-utils";
import { parseSubstrate } from "./cli/substrate";
import {
  ALGORITHM_COMMAND_HELP,
  parseAlgorithmArgs,
  runAlgorithmCli,
  type ParsedAlgorithmArgs,
} from "./cli/algorithm";
import { SomaCliError } from "./cli/errors";
import {
  SUBSTRATE_LIFECYCLE_COMMAND_HELP,
  formatClaudeUninstallResult,
  formatInstallResult,
  formatPlan,
  parseDaemonArgs,
  parseExportArgs,
  parseInstallArgs,
  parseOnboardingSubstrate,
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
import { runInferenceCli } from "./tools/inference/cli";
import { runLearningCli, runMetricsCli, runOpinionCli, runSessionCli } from "./tools/learning/cli";
import { RELATIONSHIP_REFLECT_USAGE, runRelationshipCli } from "./tools/relationship/cli";
import { runWisdomCli } from "./tools/wisdom/cli";
import { applySomaInit, diagnoseSomaDoctor, planSomaInit } from "./onboarding";

export { SomaCliError } from "./cli/errors";

interface ParsedInitArgs {
  command: "init";
  apply: boolean;
  options: SomaOnboardingOptions;
}

interface ParsedDoctorArgs {
  command: "doctor";
  options: SomaOnboardingOptions;
}

interface ParsedAdoptArgs {
  command: "adopt";
  substrate: "claude";
  mode: "plan" | "apply" | "uninstall";
  options: SomaInstallOptions & UninstallClaudeCodeOptions;
}

interface ParsedLifecycleArgs {
  command: "lifecycle";
  event: "session-start" | "algorithm-updated" | "session-end";
  options: SomaLifecycleOptions;
}

interface ParsedFeedbackArgs {
  command: "feedback";
  action: "capture";
  options: SomaFeedbackCaptureOptions;
  readTextFromStdin: boolean;
}

interface ParsedHelpArgs {
  command: "help";
  topic: string[];
}

interface ParsedIsaArgs {
  command: "isa";
  args: string[];
}

interface ParsedInferenceArgs {
  command: "inference";
  args: string[];
}

interface ParsedRawToolArgs {
  command: "learning" | "opinion" | "metrics" | "session" | "relationship" | "wisdom";
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
  | ParsedInitArgs
  | ParsedDoctorArgs
  | ParsedImportArgs
  | ParsedMigrateArgs
  | ParsedAdoptArgs
  | ParsedAlgorithmArgs
  | ParsedLifecycleArgs
  | ParsedMemoryArgs
  | ParsedFeedbackArgs
  | ParsedResultArgs
  | ParsedPolicyArgs
  | ParsedIsaArgs
  | ParsedInferenceArgs
  | ParsedRawToolArgs;

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

const ADOPT_CLAUDE_USAGE =
  "Usage: soma adopt claude [--dry-run] [--apply] [--uninstall] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]";
const INIT_USAGE =
  "Usage: soma init [--dry-run] [--yes] [--home-dir <dir>] [--soma-home <dir>] [--substrate <codex|pi-dev|claude-code|cursor>]";
const DOCTOR_USAGE =
  "Usage: soma doctor [--home-dir <dir>] [--soma-home <dir>] [--substrate codex]";
const COMMAND_HELP: Record<string, { usage: string; subcommands?: Record<string, string> }> = {
  algorithm: ALGORITHM_COMMAND_HELP,
  memory: MEMORY_COMMAND_HELP,
  feedback: {
    usage: "Usage: soma feedback capture (--text <text> | --stdin) [--substrate <id>] [--source <source>] [--store-excerpt]",
    subcommands: {
      capture: "Usage: soma feedback capture (--text <text> | --stdin) [--substrate <id>] [--source <source>] [--store-excerpt]",
    },
  },
  inference: {
    usage: "Usage: soma inference [--level <fast|standard|smart>] [--mode <inference|advisor>] [--backend <auto|claude-code|anthropic-api>] [--allow-network] [--json] [--timeout <ms>] [--auto-state] [--home-dir <dir>] [--soma-home <dir>] [prompt...]",
  },
  learning: {
    usage: "Usage: soma learning <synthesize|capture-failure|harvest> ...",
    subcommands: {
      synthesize: "Usage: soma learning synthesize [--week|--month|--all] [--dry-run] [--home-dir <dir>] [--soma-home <dir>]",
      "capture-failure": "Usage: soma learning capture-failure <transcript-path> <rating> <summary> [detailed-context] [--home-dir <dir>] [--soma-home <dir>]",
      harvest: "Usage: soma learning harvest [--recent <n>|--all|--session <id>] [--session-dir <dir>] [--dry-run] [--home-dir <dir>] [--soma-home <dir>]",
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
      update: "Usage: soma wisdom update --domain <domain> --type <principle|contextual-rule|prediction|anti-pattern|evolution> --observation <text> [--home-dir <dir>] [--soma-home <dir>]",
      synthesize: "Usage: soma wisdom synthesize [--dry-run] [--home-dir <dir>] [--soma-home <dir>]",
      health: "Usage: soma wisdom health [--dry-run] [--home-dir <dir>] [--soma-home <dir>]",
    },
  },
  result: RESULT_COMMAND_HELP,
  policy: POLICY_COMMAND_HELP,
  lifecycle: {
    usage: "Usage: soma lifecycle <session-start|algorithm-updated|session-end> [--home-dir <dir>] [--soma-home <dir>] [--substrate <id>] [--session-id <id>]",
  },
  install: SUBSTRATE_LIFECYCLE_COMMAND_HELP.install,
  uninstall: SUBSTRATE_LIFECYCLE_COMMAND_HELP.uninstall,
  reproject: SUBSTRATE_LIFECYCLE_COMMAND_HELP.reproject,
  upgrade: SUBSTRATE_LIFECYCLE_COMMAND_HELP.upgrade,
  export: SUBSTRATE_LIFECYCLE_COMMAND_HELP.export,
  daemon: SUBSTRATE_LIFECYCLE_COMMAND_HELP.daemon,
  init: {
    usage: INIT_USAGE,
  },
  doctor: {
    usage: DOCTOR_USAGE,
  },
  import: IMPORT_COMMAND_HELP,
  migrate: MIGRATE_COMMAND_HELP,
  adopt: {
    usage: ADOPT_CLAUDE_USAGE,
    subcommands: { claude: ADOPT_CLAUDE_USAGE },
  },
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

function parseLifecycleArgs(args: string[]): ParsedLifecycleArgs {
  const [command, event, ...rest] = args;

  if (command !== "lifecycle" || (event !== "session-start" && event !== "algorithm-updated" && event !== "session-end")) {
    throw new Error(commandUsage("lifecycle"));
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

function parseFeedbackCaptureArgs(args: string[]): { options: SomaFeedbackCaptureOptions; readTextFromStdin: boolean } {
  const options: Partial<SomaFeedbackCaptureOptions> = {};
  let readTextFromStdin = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--home-dir":
        options.homeDir = readOption(args, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(args, index, arg);
        index += 1;
        break;
      case "--substrate":
        options.substrate = parseSubstrate(readOption(args, index, arg));
        index += 1;
        break;
      case "--text":
        options.text = readOption(args, index, arg);
        index += 1;
        break;
      case "--stdin":
        readTextFromStdin = true;
        break;
      case "--no-excerpt":
        options.storeExcerpt = false;
        break;
      case "--store-excerpt":
        options.storeExcerpt = true;
        break;
      case "--source":
        options.source = readOption(args, index, arg);
        index += 1;
        break;
      case "--timestamp":
        options.timestamp = readOption(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.text && !readTextFromStdin) {
    throw new Error("soma feedback capture is missing required option: --text or --stdin.");
  }
  if (options.text && readTextFromStdin) {
    throw new Error("soma feedback capture accepts either --text or --stdin, not both.");
  }

  const parsedOptions: SomaFeedbackCaptureOptions = {
    ...options,
    text: options.text ?? "",
  };

  return {
    options: parsedOptions,
    readTextFromStdin,
  };
}

function parseFeedbackArgs(args: string[]): ParsedFeedbackArgs {
  const [command, action, ...rest] = args;

  if (command !== "feedback" || action !== "capture") {
    throw new Error(commandUsage("feedback", "capture"));
  }

  const parsed = parseFeedbackCaptureArgs(rest);

  return {
    command,
    action,
    options: parsed.options,
    readTextFromStdin: parsed.readTextFromStdin,
  };
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

  if (args[0] === "inference") {
    return { command: "inference", args: args.slice(1) };
  }

  if (args[0] === "learning" || args[0] === "opinion" || args[0] === "metrics" || args[0] === "session" || args[0] === "relationship" || args[0] === "wisdom") {
    return { command: args[0], args: args.slice(1) };
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

function parseOnboardingOptions(rest: string[]): SomaOnboardingOptions {
  const options: SomaOnboardingOptions = {};
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
        options.substrate = parseOnboardingSubstrate(readOption(rest, index, arg));
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseInitArgs(args: string[]): ParsedInitArgs {
  const [, ...rest] = args;
  let apply = false;
  const optionArgs: string[] = [];
  for (const arg of rest) {
    if (arg === "--yes") {
      apply = true;
    } else if (arg === "--dry-run") {
      apply = false;
    } else {
      optionArgs.push(arg);
    }
  }
  return { command: "init", apply, options: parseOnboardingOptions(optionArgs) };
}

function parseDoctorArgs(args: string[]): ParsedDoctorArgs {
  const [, ...rest] = args;
  const options = parseOnboardingOptions(rest);
  if (options.substrate && options.substrate !== "codex") {
    throw new Error("soma doctor currently supports --substrate codex only.");
  }
  return { command: "doctor", options };
}

function parseAdoptArgs(args: string[]): ParsedAdoptArgs {
  const [command, substrate, ...rest] = args;
  if (command !== "adopt" || substrate !== "claude") {
    throw new Error(commandUsage("adopt", substrate));
  }
  const options: SomaInstallOptions & UninstallClaudeCodeOptions = {};
  let mode: "plan" | "apply" | "uninstall" = "plan";
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--dry-run":
        mode = "plan";
        break;
      case "--apply":
        mode = "apply";
        break;
      case "--uninstall":
        mode = "uninstall";
        break;
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        break;
      case "--substrate-home":
        options.substrateHome = readOption(rest, index, arg);
        index += 1;
        break;
      case "--help":
        // Defensive: parseArgs intercepts --help at the top, but keep
        // this branch so the parser surfaces usage if called directly
        // (sage r1 on #72 — blocker bar).
        throw new Error(ADOPT_CLAUDE_USAGE);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { command: "adopt", substrate: "claude", mode, options };
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

function readLimitedFeedbackStdin(): string {
  const chunks: Buffer[] = [];
  let total = 0;

  for (;;) {
    const buffer = Buffer.alloc(Math.min(8192, SOMA_FEEDBACK_STDIN_MAX_BYTES + 1 - total));
    const bytesRead = readSync(0, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > SOMA_FEEDBACK_STDIN_MAX_BYTES) {
      throw new Error(`soma feedback capture --stdin exceeds ${SOMA_FEEDBACK_STDIN_MAX_BYTES} byte limit.`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function formatSomaInitPlan(plan: SomaInitPlan): string {
  return [
    `soma init — ${plan.mode === "apply" ? "apply plan" : "plan (dry-run; pass --yes to execute)"}`,
    "",
    `Home:       ${plan.homeDir}`,
    `Soma home:  ${plan.somaHome}`,
    `Substrate:  ${plan.substrate}`,
    "",
    "Detected:",
    `  - PAI install:    ${plan.detected.paiInstall ?? "not found"}`,
    `  - Claude skills:  ${plan.detected.claudeSkillsDir ?? "not found"}`,
    `  - CORE_USER:      ${plan.detected.coreUserDir ?? "not found"}`,
    "",
    "Soma state:",
    `  - exists:          ${plan.soma.exists ? "yes" : "no"}`,
    `  - starter profile: ${plan.soma.starterProfile ? "yes" : "no"}`,
    `  - skills:          ${plan.soma.skillsPopulated ? "populated" : "empty"}`,
    `  - Algorithm skill: ${plan.soma.algorithmSkillPresent ? "present" : "missing"}`,
    "",
    "Steps:",
    ...plan.steps.map((step, index) => `${index + 1}. ${step.command}`),
    "",
  ].join("\n");
}

function formatSomaInitApplied(results: { id: string; status: "applied" | "skipped"; detail: string }[]): string {
  return [
    "soma init — applied",
    "",
    ...results.map((result) => `${result.id}: ${result.status}${result.detail ? ` (${result.detail})` : ""}`),
    "",
  ].join("\n");
}

function formatSomaDoctorDiagnosis(diagnosis: SomaDoctorDiagnosis): string {
  if (diagnosis.status === "ok") {
    return [
      "soma doctor — ok",
      "",
      `Home:      ${diagnosis.homeDir}`,
      `Soma home: ${diagnosis.somaHome}`,
      "No onboarding drift detected.",
      "",
    ].join("\n");
  }
  return [
    "soma doctor — drift detected",
    "",
    `Home:      ${diagnosis.homeDir}`,
    `Soma home: ${diagnosis.somaHome}`,
    "",
    "Findings:",
    ...diagnosis.findings.map((finding) => `- ${finding.id}: ${finding.message}\n  action: ${finding.action}`),
    "",
  ].join("\n");
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

function formatFeedbackCaptureResult(result: SomaFeedbackCaptureResult): string {
  return [
    "Soma feedback capture",
    `captured: ${result.captured ? "yes" : "no"}`,
    `kind: ${result.classification.kind}`,
    `confidence: ${result.classification.confidence}`,
    `reason: ${result.classification.reason}`,
    result.event?.metadata?.excerptStored === true
      ? "warning: --store-excerpt persists a best-effort redacted excerpt; redaction is not a secret scanner."
      : undefined,
    result.event ? `event: ${result.event.id}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export async function runSomaCli(args: string[]): Promise<string> {
  const parsed = parseArgs(args);

  if (parsed.command === "help") {
    return renderHelp(parsed.topic);
  }

  if (parsed.command === "lifecycle") {
    if (parsed.event === "session-start") {
      return formatLifecycleResult(await runSomaLifecycleSessionStart(parsed.options));
    }

    if (parsed.event === "algorithm-updated") {
      return formatLifecycleResult(await runSomaLifecycleAlgorithmUpdated(parsed.options));
    }

    return formatLifecycleResult(await runSomaLifecycleSessionEnd(parsed.options));
  }

  if (parsed.command === "doctor") {
    return formatSomaDoctorDiagnosis(await diagnoseSomaDoctor(parsed.options));
  }

  if (parsed.command === "init") {
    if (!parsed.apply) {
      return formatSomaInitPlan(await planSomaInit(parsed.options));
    }
    return formatSomaInitApplied((await applySomaInit(parsed.options)).steps);
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
    const options = parsed.readTextFromStdin ? { ...parsed.options, text: readLimitedFeedbackStdin() } : parsed.options;
    return formatFeedbackCaptureResult(await captureSomaFeedback(options));
  }

  if (parsed.command === "inference") {
    return runInferenceCli(parsed.args);
  }

  if (parsed.command === "learning") {
    return runLearningCli(parsed.args);
  }

  if (parsed.command === "opinion") {
    return runOpinionCli(parsed.args);
  }

  if (parsed.command === "metrics") {
    return runMetricsCli(parsed.args);
  }

  if (parsed.command === "session") {
    return runSessionCli(parsed.args);
  }

  if (parsed.command === "relationship") {
    return runRelationshipCli(parsed.args);
  }

  if (parsed.command === "wisdom") {
    return runWisdomCli(parsed.args);
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

  if (parsed.command === "adopt") {
    if (parsed.mode === "uninstall") {
      return formatClaudeUninstallResult(await uninstallSomaForClaudeCode(parsed.options));
    }
    if (parsed.mode === "plan") {
      return formatPlan(planSomaForClaudeCodeInstall(parsed.options));
    }
    return formatInstallResult(await installSomaForClaudeCode(parsed.options));
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
