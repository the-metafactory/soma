import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  activateGoalRecord, addGoalRecord, listGoalRecords, setGoalStatus,
  type AddGoalOptions, type InactiveGoalStatus,
} from "../goal-records";
import { defaultSomaHome, type SomaPathsOptions } from "../paths";
import { loadSomaConfig } from "../soma-config";
import { readOption } from "./parse-utils";

type GoalAction = "add" | "activate" | "set-status" | "list";

export interface ParsedGoalArgs {
  command: "goal";
  action: GoalAction;
  options: SomaPathsOptions & {
    id?: string;
    status?: InactiveGoalStatus;
    add: AddGoalOptions;
    includeWording: boolean;
  };
}

const ACTIVATIONS_DIRECTORY_HELP = "(REFLEX_ACTIVATIONS_DIR overrides goals.activations_dir in <soma-home>/config.yaml; default: ~/.config/reflex/personal-activations)";

export const GOAL_COMMAND_HELP = {
  usage: `Usage: soma goal <add|activate|set-status|list> ... [--home-dir <dir>] [--soma-home <dir>] ${ACTIVATIONS_DIRECTORY_HELP}`,
  subcommands: {
    add: "Usage: soma goal add --wording <text> [--supports M<n>...] [--sensor <activation-id>] [--review-by YYYY-MM-DD] [--home-dir <dir>] [--soma-home <dir>]",
    activate: `Usage: soma goal activate G<n> [--home-dir <dir>] [--soma-home <dir>] ${ACTIVATIONS_DIRECTORY_HELP}`,
    "set-status": "Usage: soma goal set-status G<n> <paused|achieved|dropped|draft> [--home-dir <dir>] [--soma-home <dir>]",
    list: "Usage: soma goal list [--wording] [--home-dir <dir>] [--soma-home <dir>]",
  },
};

export function parseGoalArgs(args: string[]): ParsedGoalArgs {
  const [command, action, ...rest] = args;
  if (command !== "goal" || !["add", "activate", "set-status", "list"].includes(action)) {
    throw new Error(GOAL_COMMAND_HELP.usage);
  }
  const options: ParsedGoalArgs["options"] = { add: { wording: "", supports: [] }, includeWording: false };
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
  dependencies: { activationsDir?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<string> {
  const { action, options } = parsed;
  const goalsDir = join(defaultSomaHome(options), "profile", "goals");
  switch (action) {
    case "add":
      return addGoalRecord(goalsDir, options.add);
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
