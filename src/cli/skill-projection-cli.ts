import {
  planProjectSkill,
  projectSkill,
  unprojectSkill,
  type ProjectSkillOptions,
  type SkillProjectionResult,
  type UnprojectSkillOptions,
} from "../skill-projection";
import { INSTALL_SUBSTRATES, isInstallSubstrate, type InstallSubstrate } from "./substrate-lifecycle";
import { readOption } from "./parse-utils";

export interface ParsedProjectSkillArgs {
  command: "project-skill";
  skillDir: string;
  substrates: InstallSubstrate[];
  apply: boolean;
  options: { homeDir?: string; somaHome?: string; substrateHome?: string; force?: boolean };
}

export interface ParsedUnprojectSkillArgs {
  command: "unproject-skill";
  skill: string;
  substrates: InstallSubstrate[];
  options: { homeDir?: string; somaHome?: string; substrateHome?: string; force?: boolean };
}

const SUBSTRATE_LIST = INSTALL_SUBSTRATES.join("|");
const SKILL_OPTIONS = "[--substrate <id[,id…]>] [--dry-run] [--apply] [--force] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]";

export const PROJECT_SKILL_COMMAND_HELP = {
  usage: `Usage: soma project-skill <skill-dir> ${SKILL_OPTIONS}  (--substrate defaults to claude-code; ${SUBSTRATE_LIST})`,
};

export const UNPROJECT_SKILL_COMMAND_HELP = {
  usage: `Usage: soma unproject-skill <skill-dir|name> ${SKILL_OPTIONS}  (--substrate defaults to claude-code; ${SUBSTRATE_LIST})`,
};

function parseSubstrateCsv(value: string): InstallSubstrate[] {
  const ids = value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (ids.length === 0) throw new Error("--substrate requires at least one substrate id.");
  for (const id of ids) {
    if (!isInstallSubstrate(id)) {
      throw new Error(`--substrate must be one of ${INSTALL_SUBSTRATES.join(", ")} (got "${id}").`);
    }
  }
  return ids as InstallSubstrate[];
}

interface SkillCommonParse {
  positional: string;
  substrates: InstallSubstrate[];
  apply: boolean;
  options: { homeDir?: string; somaHome?: string; substrateHome?: string; force?: boolean };
}

function parseSkillArgs(verb: string, usage: string, args: string[]): SkillCommonParse {
  const [command, positional, ...rest] = args;
  if (command !== verb || !positional || positional.startsWith("--")) {
    throw new Error(usage);
  }

  const options: { homeDir?: string; somaHome?: string; substrateHome?: string; force?: boolean } = {};
  let substrates: InstallSubstrate[] = ["claude-code"];
  let apply = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--substrate":
        substrates = parseSubstrateCsv(readOption(rest, index, arg));
        index += 1;
        continue;
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        continue;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        continue;
      case "--substrate-home":
        options.substrateHome = readOption(rest, index, arg);
        index += 1;
        continue;
      case "--force":
        options.force = true;
        continue;
      case "--apply":
        apply = true;
        continue;
      case "--dry-run":
        apply = false;
        continue;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { positional, substrates, apply, options };
}

export function parseProjectSkillArgs(args: string[]): ParsedProjectSkillArgs {
  const { positional, substrates, apply, options } = parseSkillArgs(
    "project-skill",
    PROJECT_SKILL_COMMAND_HELP.usage,
    args,
  );
  return { command: "project-skill", skillDir: positional, substrates, apply, options };
}

export function parseUnprojectSkillArgs(args: string[]): ParsedUnprojectSkillArgs {
  const { positional, substrates, options } = parseSkillArgs(
    "unproject-skill",
    UNPROJECT_SKILL_COMMAND_HELP.usage,
    args,
  );
  return { command: "unproject-skill", skill: positional, substrates, options };
}

export async function runProjectSkillCli(parsed: ParsedProjectSkillArgs): Promise<string> {
  const options: ProjectSkillOptions = {
    skillDir: parsed.skillDir,
    substrates: parsed.substrates,
    ...parsed.options,
  };

  if (!parsed.apply) {
    const plan = await planProjectSkill(options);
    return [
      "Soma project-skill PLAN (no changes written) - pass --apply to apply",
      `skill: ${plan.skill}`,
      `source: ${plan.skillDir}`,
      "",
      "Links:",
      ...plan.links.map((link) =>
        `- ${link.scope === "registry" ? "registry" : link.substrate} → ${link.path}`,
      ),
      "",
      `Catalog refresh: ${plan.catalogRefresh.join(", ")}`,
      "",
      "No changes were written. Re-run with --apply to apply this plan.",
    ].join("\n");
  }

  return formatProjectionResult("Soma project-skill applied", await projectSkill(options));
}

export async function runUnprojectSkillCli(parsed: ParsedUnprojectSkillArgs): Promise<string> {
  const options: UnprojectSkillOptions = {
    skill: parsed.skill,
    substrates: parsed.substrates,
    ...parsed.options,
  };
  return formatProjectionResult("Soma unproject-skill applied", await unprojectSkill(options));
}

function formatProjectionResult(title: string, result: SkillProjectionResult): string {
  return [
    title,
    `skill: ${result.skill}`,
    "",
    "Links:",
    ...result.links.map((link) =>
      `- ${link.scope === "registry" ? "registry" : link.substrate}: ${link.status} ${link.path}`,
    ),
    "",
    "Catalog:",
    ...result.catalogFiles.map((catalog) => `- ${catalog.substrate}: ${catalog.path}`),
  ].join("\n");
}
