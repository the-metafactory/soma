import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  activateGoalRecord, addGoalRecord, listGoalRecords, setGoalStatus,
  type AddGoalOptions, type InactiveGoalStatus,
} from "../goal-records";
import { FEED_SENSOR_DEFAULTS, runFeedSensor, type FeedSensorDeps, type FeedSensorOptions } from "../goal-sense";
import { runGoalOutline, type GoalOutlineDeps, type GoalOutlineOptions } from "../goal-outline";
import { announceRefusal, runGoalAnnounce, type GoalAnnounceDeps, type GoalAnnounceOptions } from "../goal-announce";
import { runGoalSweep, type GoalSweepDeps } from "../goal-sweep";
import { defaultSomaHome, type SomaPathsOptions } from "../core/index";
import { loadSomaConfig } from "../soma-config";
import { SomaCliError } from "./errors";
import { readOption } from "./parse-utils";
import type { GoalProposeDeps, GoalProposeOptions } from "../goal-propose";
import type { GoalAcceptDeps } from "../goal-accept";

type GoalAction = "add" | "activate" | "set-status" | "list" | "sense" | "outline" | "announce" | "kinds" | "sweep" | "propose";

export interface ParsedGoalArgs {
  command: "goal";
  action: GoalAction;
  options: SomaPathsOptions & {
    id?: string;
    status?: InactiveGoalStatus;
    add: AddGoalOptions;
    includeWording: boolean;
    json?: boolean;
    feed?: FeedSensorOptions;
    outline?: GoalOutlineOptions;
    announce?: GoalAnnounceOptions;
    propose?: GoalProposeOptions;
    acceptHash?: string;
  };
}

const ACTIVATIONS_DIRECTORY_HELP = "(REFLEX_ACTIVATIONS_DIR overrides goals.activations_dir in <soma-home>/config.yaml; default: ~/.config/reflex/personal-activations)";

export const GOAL_COMMAND_HELP = {
  usage: `Usage: soma goal <add|activate|set-status|list|sense|outline|announce|kinds|sweep|propose> ... [--home-dir <dir>] [--soma-home <dir>] ${ACTIVATIONS_DIRECTORY_HELP}`,
  subcommands: {
    propose: "Usage: soma goal propose --wording <text> [--hint <text>] [--param <key=value>]... [--json] [--home-dir <dir>] [--soma-home <dir>]",
    add: "Usage: soma goal add (--accept <hash> | --wording <text> [--supports M<n>...] [--sensor <activation-id>] [--review-by YYYY-MM-DD]) [--home-dir <dir>] [--soma-home <dir>]",
    activate: `Usage: soma goal activate G<n> [--home-dir <dir>] [--soma-home <dir>] ${ACTIVATIONS_DIRECTORY_HELP}`,
    "set-status": "Usage: soma goal set-status G<n> <paused|achieved|dropped|draft> [--home-dir <dir>] [--soma-home <dir>]",
    list: "Usage: soma goal list [--wording] [--home-dir <dir>] [--soma-home <dir>]",
    kinds: "Usage: soma goal kinds [--json] [--home-dir <dir>] [--soma-home <dir>]",
    sweep: `Usage: soma goal sweep [--home-dir <dir>] [--soma-home <dir>] ${ACTIVATIONS_DIRECTORY_HELP} (SOMA_PRINCIPAL unset: print checks without publishing)`,
    sense: `Usage: soma goal sense feed --goal G<n> --url <https-url> [--window-days ${FEED_SENSOR_DEFAULTS.windowDays}] [--min ${FEED_SENSOR_DEFAULTS.min}] [--link-match <substring>] [--home-dir <dir>] [--soma-home <dir>] (SOMA_PRINCIPAL unset: nothing is published)`,
    outline: "Usage: soma goal outline --goal G<n> --tana-tag <tag> --drafts-dir <dir> [--days 7] [--slot-minutes <n>] [--home-dir <dir>] [--soma-home <dir>] (SOMA_PRINCIPAL unset: nothing is published)",
    announce: "Usage: soma goal announce --goal G<n> --url <https-url> --channels <a,b,...> [--home-dir <dir>] [--soma-home <dir>] (drafts only; SOMA_PRINCIPAL unset: no ledger publication)",
  },
};

function parseAcceptArgs(rest: string[], options: ParsedGoalArgs["options"]): void {
  const usage = (reason: string) => new SomaCliError(`soma goal add: ${reason}. ${GOAL_COMMAND_HELP.subcommands.add}`, 2);
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!["--accept", "--home-dir", "--soma-home"].includes(arg)) throw usage("--accept cannot be combined with goal fields or unsupported arguments");
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw usage(`${arg} requires a value`);
    if (arg === "--accept") {
      if (options.acceptHash !== undefined) throw usage("--accept may only be supplied once");
      if (!/^[a-f0-9]{64}$/.test(value)) throw usage("--accept requires a SHA-256 hex digest");
      options.acceptHash = value;
    }
    if (arg === "--home-dir") options.homeDir = value;
    if (arg === "--soma-home") options.somaHome = value;
  }
}

function parseProposeArgs(rest: string[], options: ParsedGoalArgs["options"]): void {
  const usage = (reason: string) => new SomaCliError(`soma goal propose: ${reason}. ${GOAL_COMMAND_HELP.subcommands.propose}`, 2);
  const propose: GoalProposeOptions = { wording: "" };
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--json") { options.json = true; continue; }
    if (!["--wording", "--hint", "--param", "--home-dir", "--soma-home"].includes(arg)) throw usage("unsupported argument");
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw usage(`${arg} requires a value`);
    if (arg === "--wording") propose.wording = value;
    if (arg === "--hint") propose.hint = value;
    if (arg === "--home-dir") options.homeDir = value;
    if (arg === "--soma-home") options.somaHome = value;
    if (arg === "--param") {
      const equal = value.indexOf("=");
      if (equal < 1 || equal === value.length - 1 || !/^[a-z][a-z0-9_.-]*$/.test(value.slice(0, equal))) throw usage("--param requires key=value");
      params[value.slice(0, equal)] = value.slice(equal + 1);
    }
  }
  if (!propose.wording.trim()) throw usage("--wording is required");
  options.propose = { ...propose, params };
}

function parseAnnounceArgs(rest: string[], options: ParsedGoalArgs["options"]): void {
  const usage = (reason: string) => new SomaCliError(`soma goal announce: ${reason}. ${GOAL_COMMAND_HELP.subcommands.announce}`, 2);
  const announce: Partial<GoalAnnounceOptions> = {};
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    const value = rest[index + 1];
    if (!["--goal", "--url", "--channels", "--home-dir", "--soma-home"].includes(arg)) throw usage("unsupported argument");
    if (!value || value.startsWith("--")) throw usage(`${arg} requires a value`);
    index++;
    if (arg === "--goal") announce.goal = value;
    if (arg === "--url") announce.url = value;
    if (arg === "--channels") announce.channels = [...new Set(value.split(",").map((channel) => channel.trim()))];
    if (arg === "--home-dir") options.homeDir = value;
    if (arg === "--soma-home") options.somaHome = value;
  }
  if (!announce.goal) throw usage("--goal is required");
  if (!announce.url) throw usage("--url is required");
  if (!announce.channels) throw usage("--channels is required");
  const complete = announce as GoalAnnounceOptions;
  const refused = announceRefusal(complete);
  if (refused) throw usage(refused);
  options.announce = complete;
}

function parseOutlineArgs(rest: string[], options: ParsedGoalArgs["options"]): void {
  const usage = (reason: string) => new SomaCliError(`soma goal outline: ${reason}. ${GOAL_COMMAND_HELP.subcommands.outline}`, 2);
  const outline: Partial<GoalOutlineOptions> = { days: 7 };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    const value = rest[index + 1];
    if (!["--goal", "--tana-tag", "--drafts-dir", "--days", "--slot-minutes", "--home-dir", "--soma-home"].includes(arg)) {
      throw usage("unsupported argument");
    }
    if (!value || value.startsWith("--")) throw usage(`${arg} requires a value`);
    index++;
    if (arg === "--goal") outline.goal = value;
    if (arg === "--tana-tag") outline.tanaTag = value;
    if (arg === "--drafts-dir") outline.draftsDir = value;
    if (arg === "--days") outline.days = Number(value);
    if (arg === "--slot-minutes") outline.slotMinutes = Number(value);
    if (arg === "--home-dir") options.homeDir = value;
    if (arg === "--soma-home") options.somaHome = value;
  }
  const { goal, tanaTag, draftsDir, days = 7, slotMinutes } = outline;
  if (!goal?.trim()) throw usage("--goal is required");
  if (!tanaTag?.trim()) throw usage("--tana-tag is required");
  if (!draftsDir?.trim()) throw usage("--drafts-dir is required");
  if (!/^G\d+$/.test(goal)) throw usage("--goal must match G<n>");
  if (!Number.isSafeInteger(days) || days < 1) throw usage("--days must be a positive integer");
  if (slotMinutes !== undefined && (!Number.isSafeInteger(slotMinutes) || slotMinutes < 1)) {
    throw usage("--slot-minutes must be a positive integer");
  }
  options.outline = { goal, tanaTag, draftsDir, days, ...(slotMinutes === undefined ? {} : { slotMinutes }) };
}

/** Usage errors exit 2, like the sensor's own refusals. */
function parseSenseArgs(rest: string[], options: ParsedGoalArgs["options"]): void {
  const usage = (reason: string) => new SomaCliError(`soma goal sense feed: ${reason}. ${GOAL_COMMAND_HELP.subcommands.sense}`, 2);
  if (rest.shift() !== "feed") throw usage("the only sensor kind is feed");
  const feed: Partial<FeedSensorOptions> = { ...FEED_SENSOR_DEFAULTS };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    const value = rest[index + 1];
    if (!["--goal", "--url", "--window-days", "--min", "--link-match", "--home-dir", "--soma-home"].includes(arg)) {
      // Do not echo unknown arguments, as for the other goal verbs.
      throw usage("unsupported argument");
    }
    if (!value || value.startsWith("--")) throw usage(`${arg} requires a value`);
    index++;
    if (arg === "--goal") feed.goal = value;
    if (arg === "--url") feed.url = value;
    if (arg === "--link-match") feed.linkMatch = value;
    // The sensor refuses anything that is not a positive integer.
    if (arg === "--window-days") feed.windowDays = Number(value);
    if (arg === "--min") feed.min = Number(value);
    if (arg === "--home-dir") options.homeDir = value;
    if (arg === "--soma-home") options.somaHome = value;
  }
  if (feed.goal === undefined) throw usage("--goal is required");
  if (feed.url === undefined) throw usage("--url is required");
  options.feed = feed as FeedSensorOptions;
}

export function parseGoalArgs(args: string[]): ParsedGoalArgs {
  const [command, action, ...rest] = args;
  if (command !== "goal" || !["add", "activate", "set-status", "list", "sense", "outline", "announce", "kinds", "sweep", "propose"].includes(action)) {
    throw new Error(GOAL_COMMAND_HELP.usage);
  }
  const options: ParsedGoalArgs["options"] = { add: { wording: "", supports: [] }, includeWording: false };
  if (action === "add" && rest.includes("--accept")) {
    parseAcceptArgs(rest, options);
    return { command: "goal", action, options };
  }
  if (action === "propose") {
    parseProposeArgs(rest, options);
    return { command: "goal", action, options };
  }
  if (action === "announce") {
    parseAnnounceArgs(rest, options);
    return { command: "goal", action, options };
  }
  if (action === "outline") {
    parseOutlineArgs(rest, options);
    return { command: "goal", action, options };
  }
  if (action === "sense") {
    parseSenseArgs(rest, options);
    return { command: "goal", action, options };
  }
  if (action === "activate" || action === "set-status") {
    options.id = rest.shift();
    if (!options.id || !/^G\d+$/.test(options.id)) throw new Error("Goal id must match G<n>");
  }
  if (action === "set-status") {
    const status = rest.shift();
    if (status !== "paused" && status !== "achieved" && status !== "dropped" && status !== "draft") {
      throw new Error("set-status accepts paused, achieved, dropped or draft; use activate to become active");
    }
    options.status = status;
  }
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--home-dir" || arg === "--soma-home") {
      const value = readOption(rest, index++, arg);
      if (arg === "--home-dir") options.homeDir = value;
      else options.somaHome = value;
    } else if (arg === "--wording" && action === "list") {
      options.includeWording = true;
    } else if (arg === "--json" && action === "kinds") {
      options.json = true;
    } else if (action === "add" && ["--wording", "--supports", "--sensor", "--review-by"].includes(arg)) {
      const value = readOption(rest, index++, arg);
      if (arg === "--wording") options.add.wording = value;
      if (arg === "--supports") options.add.supports.push(value);
      if (arg === "--sensor") options.add.sensor = value;
      if (arg === "--review-by") options.add.reviewBy = value;
    } else {
      // Do not echo unknown arguments: they can contain private goal wording.
      throw new Error(`Unsupported argument for goal ${action}. ${GOAL_COMMAND_HELP.usage}`);
    }
  }
  if (action === "add" && !options.add.wording) throw new Error("goal add requires --wording");
  return { command: "goal", action: action as GoalAction, options };
}

export async function runGoalCli(
  parsed: ParsedGoalArgs,
  dependencies: { activationsDir?: string; env?: Readonly<Record<string, string | undefined>>; feedSensor?: Partial<FeedSensorDeps>; outline?: Partial<GoalOutlineDeps>; announce?: Partial<GoalAnnounceDeps>; sweep?: Partial<GoalSweepDeps>; propose?: Partial<GoalProposeDeps>; accept?: GoalAcceptDeps } = {},
): Promise<string> {
  const { action, options } = parsed;
  const goalsDir = join(defaultSomaHome(options), "profile", "goals");
  switch (action) {
    case "propose": {
      if (!options.propose) throw new SomaCliError(GOAL_COMMAND_HELP.subcommands.propose, 2);
      const { proposeGoal, formatGoalProposal } = await import("../goal-propose");
      const result = await proposeGoal({
        ...dependencies.propose, ...options.propose, somaHome: defaultSomaHome(options),
      });
      return options.json ? JSON.stringify(result, null, 2) : formatGoalProposal(result);
    }
    case "sweep": {
      const lines: string[] = [];
      const result = await runGoalSweep({
        somaHome: defaultSomaHome(options), env: dependencies.env,
        activationsDir: dependencies.activationsDir ?? (dependencies.env ?? process.env).REFLEX_ACTIVATIONS_DIR
          ?? await goalActivationsDir(options),
        ...dependencies.sweep, stdout: (line) => lines.push(line),
      });
      if (result.exitCode !== 0) {
        // Preserve the unaffected checks on stdout even if another check failed.
        console.log(lines.join("\n"));
        throw new SomaCliError("soma goal sweep: one or more checks or publications failed", result.exitCode);
      }
      return lines.join("\n");
    }
    case "announce": {
      if (!options.announce) throw new SomaCliError(GOAL_COMMAND_HELP.subcommands.announce, 2);
      const lines: string[] = [];
      const result = await runGoalAnnounce({
        ...options.announce, somaHome: defaultSomaHome(options), env: dependencies.env,
        ...dependencies.announce, stdout: (line) => lines.push(line),
        stderr: dependencies.announce?.stderr ?? (() => undefined),
      });
      if (result.exitCode !== 0) throw new SomaCliError(result.error ?? "soma goal announce failed", result.exitCode);
      return lines.join("\n");
    }
    case "outline": {
      if (!options.outline) throw new SomaCliError(GOAL_COMMAND_HELP.subcommands.outline, 2);
      const lines: string[] = [];
      const result = await runGoalOutline({
        ...options.outline, somaHome: defaultSomaHome(options), env: dependencies.env,
        ...dependencies.outline, stdout: (line) => lines.push(line),
        // The executable CLI reports SomaCliError to stderr once.
        stderr: dependencies.outline?.stderr ?? (() => undefined),
      });
      if (result.exitCode !== 0) throw new SomaCliError(result.error ?? "soma goal outline failed", result.exitCode);
      return lines.join("\n");
    }
    case "kinds": {
      // Keep catalog/Zod loading off the other goal commands' startup path.
      const { listGoalKinds } = await import("../goal-kinds/registry");
      const kinds = listGoalKinds();
      return options.json ? JSON.stringify(kinds, null, 2)
        : kinds.map((kind) => `${kind.id}\t${kind.role}\t${kind.description}`).join("\n");
    }
    case "sense": {
      if (!options.feed) throw new SomaCliError(GOAL_COMMAND_HELP.subcommands.sense, 2);
      const lines: string[] = [];
      const result = await runFeedSensor(options.feed, {
        somaHome: defaultSomaHome(options),
        ...dependencies.feedSensor,
        stdout: (line) => lines.push(line),
      });
      if (result.exitCode !== 0) throw new SomaCliError(result.error ?? "soma goal sense feed failed", result.exitCode);
      return lines.join("\n");
    }
    case "add": {
      if (options.acceptHash !== undefined) {
        const { acceptGoalProposal } = await import("../goal-accept");
        const result = await acceptGoalProposal(goalsDir, options.acceptHash, dependencies.accept);
        return [result.goalId, ...result.activationIds].join("\n");
      }
      return addGoalRecord(goalsDir, options.add);
    }
    case "activate":
      if (!options.id) throw new Error("Goal id must match G<n>");
      await activateGoalRecord(goalsDir, options.id, dependencies.activationsDir
        ?? (dependencies.env ?? process.env).REFLEX_ACTIVATIONS_DIR ?? await goalActivationsDir(options));
      return `${options.id}: active`;
    case "set-status":
      if (!options.id) throw new Error("Goal id must match G<n>");
      if (!options.status) throw new Error("Goal status is required");
      await setGoalStatus(goalsDir, options.id, options.status);
      return `${options.id}: ${options.status}`;
    case "list":
      return (await listGoalRecords(goalsDir)).map((goal) =>
        `${goal.id}\t${goal.status}\tsupports: [${goal.supports.join(", ")}]\tsensor: ${goal.sensor ?? "-"}`
        + (options.includeWording ? `\t${goal.wording}` : ""),
      ).join("\n");
  }
}

async function goalActivationsDir(options: SomaPathsOptions): Promise<string> {
  const homeDir = options.homeDir ?? homedir();
  const configured = (await loadSomaConfig(options)).goals?.activations_dir;
  if (configured === undefined) return join(homeDir, ".config", "reflex", "personal-activations");
  if (configured === "~") return resolve(homeDir);
  if (configured.startsWith("~/")) return resolve(homeDir, configured.slice(2));
  return resolve(defaultSomaHome(options), configured);
}
