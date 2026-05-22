import {
  installSomaForClaudeCode,
  planSomaForClaudeCodeInstall,
  uninstallSomaForClaudeCode,
  type UninstallClaudeCodeOptions,
} from "../index";
import { applySomaInit, diagnoseSomaDoctor, planSomaInit } from "../onboarding";
import type { SomaDoctorDiagnosis, SomaInitPlan, SomaInstallOptions, SomaOnboardingOptions } from "../types";
import {
  formatClaudeUninstallResult,
  formatInstallResult,
  formatPlan,
  parseOnboardingSubstrate,
} from "./substrate-lifecycle";
import { readOption } from "./parse-utils";

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
  "Usage: soma init [--dry-run] [--yes] [--home-dir <dir>] [--soma-home <dir>] [--substrate <codex|pi-dev|claude-code|cursor>]";
const DOCTOR_USAGE =
  "Usage: soma doctor [--home-dir <dir>] [--soma-home <dir>] [--substrate codex]";

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

export function parseDoctorArgs(args: string[]): ParsedDoctorArgs {
  const [, ...rest] = args;
  const options = parseOnboardingOptions(rest);
  if (options.substrate && options.substrate !== "codex") {
    throw new Error("soma doctor currently supports --substrate codex only.");
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
