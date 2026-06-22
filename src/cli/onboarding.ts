import {
  installSomaForClaudeCode,
  planSomaForClaudeCodeInstall,
  uninstallSomaForClaudeCode,
  type UninstallClaudeCodeOptions,
} from "../index";
import { DOCTOR_SUPPORTED_SUBSTRATES, DOCTOR_UNSUPPORTED_SUBSTRATE_MESSAGE, isDoctorSubstrate } from "../adapters/doctor";
import { applySomaInit, diagnoseSomaDoctor, planSomaInit } from "../onboarding";
import type { SomaDoctorDiagnosis, SomaInitPlan, SomaInstallOptions, SomaOnboardingOptions } from "../types";
import {
  formatClaudeUninstallResult,
  formatInstallResult,
  formatPlan,
  parseOnboardingSubstrate,
} from "./substrate-lifecycle";
import { readOption } from "./parse-utils";
import { warnDeprecatedYesFlag } from "./deprecated-flags";

export interface ParsedInitArgs {
  command: "init";
  apply: boolean;
  options: SomaOnboardingOptions;
}

export interface ParsedDoctorArgs {
  command: "doctor";
  options: SomaOnboardingOptions;
}

export interface ParsedAdoptArgs {
  command: "adopt";
  substrate: "claude";
  mode: "plan" | "apply" | "uninstall";
  options: SomaInstallOptions & UninstallClaudeCodeOptions;
}

export type ParsedOnboardingArgs = ParsedInitArgs | ParsedDoctorArgs | ParsedAdoptArgs;

const ADOPT_CLAUDE_USAGE =
  "Usage: soma adopt claude [--dry-run] [--apply] [--uninstall] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]";
const INIT_USAGE =
  "Usage: soma init [--dry-run] [--apply] [--home-dir <dir>] [--soma-home <dir>] [--substrate <codex|pi-dev|claude-code|cursor|grok>]";
const DOCTOR_USAGE =
  `Usage: soma doctor [--home-dir <dir>] [--soma-home <dir>] [--substrate <${DOCTOR_SUPPORTED_SUBSTRATES.join("|")}>]`;

export const ONBOARDING_COMMAND_HELP: Record<ParsedOnboardingArgs["command"], { usage: string; subcommands?: Record<string, string> }> = {
  init: {
    usage: INIT_USAGE,
  },
  doctor: {
    usage: DOCTOR_USAGE,
  },
  adopt: {
    usage: ADOPT_CLAUDE_USAGE,
    subcommands: { claude: ADOPT_CLAUDE_USAGE },
  },
};

export function parseInitArgs(args: string[]): ParsedInitArgs {
  const [, ...rest] = args;
  let apply = false;
  const optionArgs: string[] = [];
  for (const arg of rest) {
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--yes") {
      // Deprecated alias — `--apply` aligns init with install/adopt/migrate.
      warnDeprecatedYesFlag();
      apply = true;
    } else if (arg === "--dry-run") {
      apply = false;
    } else {
      optionArgs.push(arg);
    }
  }
  return { command: "init", apply, options: parseOnboardingOptions(optionArgs) };
}

export function parseDoctorArgs(args: string[]): ParsedDoctorArgs {
  const [, ...rest] = args;
  const options = parseOnboardingOptions(rest);
  if (options.substrate && !isDoctorSubstrate(options.substrate)) {
    throw new Error(DOCTOR_UNSUPPORTED_SUBSTRATE_MESSAGE);
  }
  return { command: "doctor", options };
}

export function parseAdoptArgs(args: string[]): ParsedAdoptArgs {
  const [command, substrate, ...rest] = args;
  if (command !== "adopt" || substrate !== "claude") {
    throw new Error(ONBOARDING_COMMAND_HELP.adopt.subcommands?.[substrate] ?? ONBOARDING_COMMAND_HELP.adopt.usage);
  }
  const options: SomaInstallOptions & UninstallClaudeCodeOptions = {};
  let mode: "plan" | "apply" | "uninstall" = "plan";
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const sharedOptionIndex = readCommonDirOption(options, rest, index, arg);
    if (sharedOptionIndex !== undefined) {
      index = sharedOptionIndex;
      continue;
    }

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

function parseOnboardingOptions(rest: string[]): SomaOnboardingOptions {
  const options: SomaOnboardingOptions = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const sharedOptionIndex = readCommonDirOption(options, rest, index, arg);
    if (sharedOptionIndex !== undefined) {
      index = sharedOptionIndex;
      continue;
    }

    switch (arg) {
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

function readCommonDirOption(
  options: Pick<Partial<SomaInstallOptions & SomaOnboardingOptions>, "homeDir" | "somaHome">,
  args: string[],
  index: number,
  arg: string,
): number | undefined {
  switch (arg) {
    case "--home-dir":
      options.homeDir = readOption(args, index, arg);
      return index + 1;
    case "--soma-home":
      options.somaHome = readOption(args, index, arg);
      return index + 1;
    default:
      return undefined;
  }
}

export async function runOnboardingCli(parsed: ParsedOnboardingArgs): Promise<string> {
  if (parsed.command === "doctor") {
    return formatSomaDoctorDiagnosis(await diagnoseSomaDoctor(parsed.options));
  }

  if (parsed.command === "init") {
    if (!parsed.apply) {
      return formatSomaInitPlan(await planSomaInit(parsed.options));
    }
    return formatSomaInitApplied((await applySomaInit(parsed.options)).steps);
  }

  if (parsed.mode === "uninstall") {
    return formatClaudeUninstallResult(await uninstallSomaForClaudeCode(parsed.options));
  }
  if (parsed.mode === "plan") {
    return formatPlan(planSomaForClaudeCodeInstall(parsed.options));
  }
  return formatInstallResult(await installSomaForClaudeCode(parsed.options));
}

function formatClaudeSkillsDetection(plan: SomaInitPlan): string {
  const dir = plan.detected.claudeSkillsDir;
  if (!dir) return "not found";
  switch (plan.detected.claudeSkillsStatus) {
    case "importable":
      return dir;
    case "empty":
      return `${dir} (empty — nothing to import)`;
    case "unreadable":
      // sage cycle 2 on #309: a read failure is not a structural verdict.
      return `${dir} (could not be read — check permissions, then run \`soma migrate claude-skills --from ${dir}\` for details)`;
    default:
      // sage review on #309: a non-flat tree must not be labeled
      // "empty" — point at the command that explains why.
      return `${dir} (found, but not an importable flat skills tree — run \`soma migrate claude-skills --from ${dir}\` for details)`;
  }
}

function formatSomaInitPlan(plan: SomaInitPlan): string {
  const claudeSkillsStatus = plan.detected.claudeSkillsStatus;
  const freshMachine =
    !plan.detected.paiInstall && (claudeSkillsStatus === "missing" || claudeSkillsStatus === "empty");
  return [
    `soma init — ${plan.mode === "apply" ? "apply plan" : "plan (dry-run; pass --apply to execute)"}`,
    "",
    "Creates the Soma home (identity, telos, memory, skills, policy) and",
    "imports context from an existing Claude Code / PAI installation when one",
    "is detected.",
    "",
    `Home:       ${plan.homeDir}`,
    `Soma home:  ${plan.somaHome}`,
    `Substrate:  ${plan.substrate}`,
    "",
    "Detected import sources:",
    `  - PAI install:    ${plan.detected.paiInstall ?? "not found"}`,
    `  - Claude skills:  ${formatClaudeSkillsDetection(plan)}`,
    `  - CORE_USER:      ${plan.detected.coreUserDir ?? "not found"}`,
    ...(freshMachine
      ? ["", "No existing installation to import — starting from the Soma starter profile."]
      : []),
    "",
    "Soma state:",
    `  - exists:          ${plan.soma.exists ? "yes" : "no"}`,
    `  - starter profile: ${plan.soma.starterProfile ? "yes" : "no"}`,
    `  - skills:          ${plan.soma.skillsPopulated ? "populated" : "empty"}`,
    `  - Algorithm skill: ${plan.soma.algorithmSkillPresent ? "present" : "missing"}`,
    "",
    "Steps:",
    ...plan.steps.map((step, index) => `${index + 1}. ${step.kind === "command" ? step.command : step.action}`),
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
      // Informational findings don't constitute drift but are still worth
      // surfacing (e.g. discovery checks skipped because grok is absent).
      ...(diagnosis.findings.length > 0
        ? ["", "Notes:", ...diagnosis.findings.map((finding) => `- ${finding.id}: ${finding.message}\n  action: ${finding.action}`)]
        : []),
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
