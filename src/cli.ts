import packageJson from "../package.json";
import { SomaCliError } from "./cli/errors";
import type { SubstrateLifecycleCliInternals } from "./cli/substrate-lifecycle";

interface CommandHelp { usage: string; subcommands?: Record<string, string> }
type CommandRunner = (args: string[], internals: SubstrateLifecycleCliInternals) => Promise<string>;

// Each command imports its module only when it runs. Hooks call `policy guard`
// on every tool call and `algorithm classify` on every prompt; importing all
// command modules up front cost them about 100 ms of the ~230 ms start.
const COMMANDS = {
  adopt: async () => {
    const { parseAdoptArgs, runOnboardingCli } = await import("./cli/onboarding");
    return (args) => runOnboardingCli(parseAdoptArgs(args));
  },
  algorithm: async () => {
    const { parseAlgorithmArgs, runAlgorithmCli } = await import("./cli/algorithm");
    return (args) => runAlgorithmCli(parseAlgorithmArgs(args));
  },
  daemon: async () => {
    const { parseDaemonArgs, runSubstrateLifecycleCli } = await import("./cli/substrate-lifecycle");
    return (args, internals) => runSubstrateLifecycleCli(parseDaemonArgs(args), internals);
  },
  doctor: async () => {
    const { parseDoctorArgs, runOnboardingCli } = await import("./cli/onboarding");
    return (args) => runOnboardingCli(parseDoctorArgs(args));
  },
  export: async () => {
    const { parseExportArgs, runSubstrateLifecycleCli } = await import("./cli/substrate-lifecycle");
    return (args, internals) => runSubstrateLifecycleCli(parseExportArgs(args), internals);
  },
  errata: async () => {
    const { parseErrataArgs, runErrataCli } = await import("./cli/errata");
    return (args) => runErrataCli(parseErrataArgs(args));
  },
  feedback: async () => {
    const { parseFeedbackArgs, runFeedbackCli } = await import("./cli/feedback");
    return (args) => runFeedbackCli(parseFeedbackArgs(args));
  },
  graph: async () => {
    const { parseGraphArgs, runGraphCli } = await import("./cli/graph");
    return (args) => runGraphCli(parseGraphArgs(args));
  },
  goal: async () => {
    const { parseGoalArgs, runGoalCli } = await import("./cli/goal");
    return (args) => runGoalCli(parseGoalArgs(args));
  },
  history: async () => {
    const { parseHistoryArgs, runSnapshotCli } = await import("./cli/snapshots");
    return (args) => runSnapshotCli(parseHistoryArgs(args));
  },
  inference: loadToolCommand,
  install: async () => {
    const { parseInstallArgs, runSubstrateLifecycleCli } = await import("./cli/substrate-lifecycle");
    return (args, internals) => runSubstrateLifecycleCli(parseInstallArgs(args), internals);
  },
  init: async () => {
    const { parseInitArgs, runOnboardingCli } = await import("./cli/onboarding");
    return (args) => runOnboardingCli(parseInitArgs(args));
  },
  judge: async () => {
    const { parseJudgeArgs, runJudgeCli } = await import("./cli/judge");
    return (args) => runJudgeCli(parseJudgeArgs(args));
  },
  vsa: () => loadVsaCommand(false),
  isa: () => loadVsaCommand(true),
  learning: loadToolCommand,
  lifecycle: async () => {
    const { parseLifecycleArgs, runLifecycleCli } = await import("./cli/lifecycle");
    return (args) => runLifecycleCli(parseLifecycleArgs(args));
  },
  memory: async () => {
    const { parseMemoryArgs, runMemoryCli } = await import("./cli/memory");
    return (args) => runMemoryCli(parseMemoryArgs(args));
  },
  metrics: loadToolCommand,
  migrate: async () => {
    const { parseMigrateArgs, runMigrateCli } = await import("./cli/migrate");
    return (args) => runMigrateCli(parseMigrateArgs(args));
  },
  opinion: loadToolCommand,
  policy: async () => {
    const { parsePolicyArgs, runPolicyCli } = await import("./cli/policy");
    return (args) => runPolicyCli(parsePolicyArgs(args));
  },
  precompact: async () => {
    const { parsePreCompactArgs, runPreCompactCli } = await import("./cli/precompact");
    return (args) => runPreCompactCli(parsePreCompactArgs(args));
  },
  "project-skill": async () => {
    const { parseProjectSkillArgs, runProjectSkillCli } = await import("./cli/skill-projection-cli");
    return (args) => runProjectSkillCli(parseProjectSkillArgs(args));
  },
  redact: async () => {
    const { parseRedactArgs, runRedactCli } = await import("./cli/redact");
    return (args) => runRedactCli(parseRedactArgs(args));
  },
  relationship: loadToolCommand,
  reproject: async () => {
    const { parseReprojectArgs, runSubstrateLifecycleCli } = await import("./cli/substrate-lifecycle");
    return (args, internals) => runSubstrateLifecycleCli(parseReprojectArgs(args), internals);
  },
  "unproject-skill": async () => {
    const { parseUnprojectSkillArgs, runUnprojectSkillCli } = await import("./cli/skill-projection-cli");
    return (args) => runUnprojectSkillCli(parseUnprojectSkillArgs(args));
  },
  result: async () => {
    const { parseResultArgs, runResultCli } = await import("./cli/result");
    return (args) => runResultCli(parseResultArgs(args));
  },
  router: async () => {
    const { parseRouterArgs, runRouterCli } = await import("./cli/router");
    return (args) => runRouterCli(parseRouterArgs(args));
  },
  runtime: async () => {
    const { parseRuntimeArgs, runRuntimeCli } = await import("./cli/runtime");
    return (args) => runRuntimeCli(parseRuntimeArgs(args));
  },
  rollback: async () => {
    const { parseRollbackArgs, runSnapshotCli } = await import("./cli/snapshots");
    return (args) => runSnapshotCli(parseRollbackArgs(args));
  },
  // `soma run` parses its own flags: a bad flag must not fail the job that called it (node #821).
  run: async () => {
    const { runRunCli } = await import("./cli/run");
    return (args) => runRunCli(args.slice(1));
  },
  session: loadToolCommand,
  stats: loadTelemetryCommand,
  snapshot: async () => {
    const { parseSnapshotArgs, runSnapshotCli } = await import("./cli/snapshots");
    return (args) => runSnapshotCli(parseSnapshotArgs(args));
  },
  telemetry: loadTelemetryCommand,
  uninstall: async () => {
    const { parseUninstallArgs, runSubstrateLifecycleCli } = await import("./cli/substrate-lifecycle");
    return (args, internals) => runSubstrateLifecycleCli(parseUninstallArgs(args), internals);
  },
  upgrade: async () => {
    const { parseUpgradeArgs, runSubstrateLifecycleCli } = await import("./cli/substrate-lifecycle");
    return (args, internals) => runSubstrateLifecycleCli(parseUpgradeArgs(args), internals);
  },
  writeback: async () => {
    const { parseWritebackArgs, runWritebackCli } = await import("./cli/writeback");
    return (args) => runWritebackCli(parseWritebackArgs(args));
  },
  wisdom: loadToolCommand,
} satisfies Record<string, () => Promise<CommandRunner>>;

type TopLevelCommand = keyof typeof COMMANDS;

const TOP_LEVEL_COMMANDS = Object.keys(COMMANDS) as TopLevelCommand[];

function isTopLevelCommand(command: string): command is TopLevelCommand {
  return Object.hasOwn(COMMANDS, command);
}

async function loadToolCommand(): Promise<CommandRunner> {
  const { parseToolArgs, runToolCli } = await import("./cli/tools");
  return (args) => runToolCli(parseToolArgs(args));
}

async function loadTelemetryCommand(): Promise<CommandRunner> {
  const { parseTelemetryArgs, runTelemetryCli } = await import("./cli/telemetry");
  return (args) => runTelemetryCli(parseTelemetryArgs(args));
}

async function loadVsaCommand(viaIsaAlias: boolean): Promise<CommandRunner> {
  const { runVsaCli } = await import("./cli/vsa");
  return async (args) => {
    if (viaIsaAlias) {
      process.stderr.write("Warning: `soma isa` is deprecated; use `soma vsa` (soma#329).\n");
    }
    const result = await runVsaCli(args.slice(1));
    if (result.exitCode !== 0) {
      // Propagate non-zero exit via the same SomaCliError pattern used
      // elsewhere — bubble up to process.exit at the top-level harness.
      throw new SomaCliError(result.text, result.exitCode);
    }
    return result.text;
  };
}

/** Help needs every command's usage, so it is the one path that loads all modules. */
async function loadCommandHelp(): Promise<Record<string, CommandHelp>> {
  const [
    algorithm, graph, goal, memory, telemetry, feedback, errata, judge, router, redact, tools, result, policy,
    writeback, lifecycle, precompact, substrateLifecycle, skillProjection, onboarding, migrate, snapshots, run, runtime, vsa,
  ] = await Promise.all([
    import("./cli/algorithm"), import("./cli/graph"), import("./cli/goal"), import("./cli/memory"), import("./cli/telemetry"),
    import("./cli/feedback"), import("./cli/errata"), import("./cli/judge"), import("./cli/router"), import("./cli/redact"),
    import("./cli/tools"), import("./cli/result"), import("./cli/policy"), import("./cli/writeback"), import("./cli/lifecycle"),
    import("./cli/precompact"), import("./cli/substrate-lifecycle"), import("./cli/skill-projection-cli"), import("./cli/onboarding"),
    import("./cli/migrate"), import("./cli/snapshots"), import("./cli/run"), import("./cli/runtime"), import("./cli/vsa"),
  ]);
  return {
    algorithm: algorithm.ALGORITHM_COMMAND_HELP,
    graph: graph.GRAPH_COMMAND_HELP,
    goal: goal.GOAL_COMMAND_HELP,
    memory: memory.MEMORY_COMMAND_HELP,
    telemetry: telemetry.TELEMETRY_COMMAND_HELP,
    stats: telemetry.STATS_COMMAND_HELP,
    feedback: feedback.FEEDBACK_COMMAND_HELP,
    errata: errata.ERRATA_COMMAND_HELP,
    judge: judge.JUDGE_COMMAND_HELP,
    router: router.ROUTER_COMMAND_HELP,
    redact: redact.REDACT_COMMAND_HELP,
    ...tools.TOOL_COMMAND_HELP,
    result: result.RESULT_COMMAND_HELP,
    policy: policy.POLICY_COMMAND_HELP,
    writeback: writeback.WRITEBACK_COMMAND_HELP,
    lifecycle: lifecycle.LIFECYCLE_COMMAND_HELP,
    precompact: precompact.PRECOMPACT_COMMAND_HELP,
    install: substrateLifecycle.SUBSTRATE_LIFECYCLE_COMMAND_HELP.install,
    uninstall: substrateLifecycle.SUBSTRATE_LIFECYCLE_COMMAND_HELP.uninstall,
    reproject: substrateLifecycle.SUBSTRATE_LIFECYCLE_COMMAND_HELP.reproject,
    "project-skill": skillProjection.PROJECT_SKILL_COMMAND_HELP,
    "unproject-skill": skillProjection.UNPROJECT_SKILL_COMMAND_HELP,
    upgrade: substrateLifecycle.SUBSTRATE_LIFECYCLE_COMMAND_HELP.upgrade,
    export: substrateLifecycle.SUBSTRATE_LIFECYCLE_COMMAND_HELP.export,
    daemon: substrateLifecycle.SUBSTRATE_LIFECYCLE_COMMAND_HELP.daemon,
    init: onboarding.ONBOARDING_COMMAND_HELP.init,
    doctor: onboarding.ONBOARDING_COMMAND_HELP.doctor,
    migrate: migrate.MIGRATE_COMMAND_HELP,
    ...snapshots.SNAPSHOT_COMMAND_HELP,
    run: run.RUN_COMMAND_HELP,
    runtime: runtime.RUNTIME_COMMAND_HELP,
    adopt: onboarding.ONBOARDING_COMMAND_HELP.adopt,
    vsa: {
      // Single source of truth lives in `./cli/vsa.ts` (Sage round-1 dedup).
      usage: vsa.VSA_USAGE_HEADER,
      subcommands: vsa.VSA_SUBCOMMAND_HELP,
    },
    // soma#329: `isa` is the deprecated alias for `vsa`; same help surface.
    isa: {
      usage: vsa.VSA_USAGE_HEADER,
      subcommands: vsa.VSA_SUBCOMMAND_HELP,
    },
  };
}

function commandUsage(commandHelp: Record<string, CommandHelp>, command: string, action?: string): string {
  const help = commandHelp[command] as CommandHelp | undefined;
  return (action ? help?.subcommands?.[action] : undefined) ?? help?.usage ?? `Usage: soma ${command} ...`;
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

function renderUsage(commandHelp: Record<string, CommandHelp>): string {
  const usageLines = [...new Set(Object.values(commandHelp).flatMap((help) =>
    [help.usage, ...Object.values(help.subcommands ?? {})].map((line) => `  ${line.slice("Usage: ".length)}`),
  ))];

  return [
    "Usage:",
    ...usageLines,
    "",
    "Global flags:",
    "  --version, -v   Print the soma version and exit",
  ].join("\n");
}

async function renderHelp(topic: string[]): Promise<string> {
  const [command, action] = topic;
  const commandHelp = await loadCommandHelp();

  if (!command) {
    return renderUsage(commandHelp);
  }

  return commandUsage(commandHelp, command, action);
}

async function renderUnknownCommand(command: string): Promise<string> {
  const suggestion = suggestTopLevelCommand(command);

  return [
    `Unknown command: ${command}`,
    suggestion ? `Did you mean: ${suggestion}?` : undefined,
    "",
    renderUsage(await loadCommandHelp()),
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

/**
 * Run one soma command in-process. `internals` are test seams (node #914) that
 * argv cannot set; the CLI entry below never passes them.
 */
export async function runSomaCli(args: string[], internals: SubstrateLifecycleCliInternals = {}): Promise<string> {
  if (args.length === 0) {
    return renderHelp([]);
  }

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    return `soma ${packageJson.version}`;
  }

  if (isHelpRequest(args)) {
    const topic = helpTopic(args);
    const [command] = topic;

    if (command && !isTopLevelCommand(command)) {
      throw new Error(await renderUnknownCommand(command));
    }

    return renderHelp(topic);
  }

  const [command = ""] = args;
  if (!isTopLevelCommand(command)) {
    throw new Error(await renderUnknownCommand(command));
  }

  const run: CommandRunner = await COMMANDS[command]();
  return run(args, internals);
}

if (import.meta.main) {
  try {
    console.log(await runSomaCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof SomaCliError ? error.exitCode : 1;
  }
}
