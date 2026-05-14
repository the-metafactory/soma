import {
  importPaiIdentity,
  installSomaForCodex,
  installSomaForPiDev,
  planPaiImport,
  planSomaForCodexInstall,
  planSomaForPiDevInstall,
} from "./index";
import type { PaiImportOptions, PaiImportPlan, PaiImportResult, SomaInstallOptions, SomaInstallPlan, SomaInstallResult } from "./types";

interface ParsedInstallArgs {
  command: "install";
  substrate: "codex" | "pi-dev";
  apply: boolean;
  options: SomaInstallOptions;
}

interface ParsedImportArgs {
  command: "import";
  source: "pai";
  apply: boolean;
  options: PaiImportOptions;
}

type ParsedArgs = ParsedInstallArgs | ParsedImportArgs;

function readOption(args: string[], index: number, name: string): string {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
}

function parseInstallArgs(args: string[]): ParsedInstallArgs {
  const [command, substrate, ...rest] = args;

  if (command !== "install" || (substrate !== "codex" && substrate !== "pi-dev")) {
    throw new Error("Usage: soma install <codex|pi-dev> [--dry-run] [--apply] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]");
  }

  const options: SomaInstallOptions = {};
  let apply = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--dry-run":
        apply = false;
        break;
      case "--apply":
        apply = true;
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
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    command,
    substrate,
    apply,
    options,
  };
}

function parseImportArgs(args: string[]): ParsedImportArgs {
  const [command, source, ...rest] = args;

  if (command !== "import" || source !== "pai") {
    throw new Error("Usage: soma import pai [--dry-run] [--apply] [--home-dir <dir>] [--claude-home <dir>] [--soma-home <dir>]");
  }

  const options: PaiImportOptions = {};
  let apply = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--dry-run":
        apply = false;
        break;
      case "--apply":
        apply = true;
        break;
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--claude-home":
        options.claudeHome = readOption(rest, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    command,
    source,
    apply,
    options,
  };
}

function parseArgs(args: string[]): ParsedArgs {
  if (args[0] === "install") {
    return parseInstallArgs(args);
  }

  if (args[0] === "import") {
    return parseImportArgs(args);
  }

  throw new Error(
    [
      "Usage:",
      "  soma install <codex|pi-dev> [--dry-run] [--apply] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
      "  soma import pai [--dry-run] [--apply] [--home-dir <dir>] [--claude-home <dir>] [--soma-home <dir>]",
    ].join("\n"),
  );
}

function formatPlan(plan: SomaInstallPlan): string {
  return [
    "Soma install plan",
    `substrate: ${plan.substrate}`,
    `mode: ${plan.apply ? "apply" : "dry-run"}`,
    `somaHome: ${plan.somaHome}`,
    `substrateHome: ${plan.substrateHome}`,
    "",
    "Soma directories:",
    ...plan.somaDirectories.map((path) => `- ${path}`),
    "",
    "Soma files:",
    ...plan.somaFiles.map((path) => `- ${path}`),
    "",
    "Substrate files:",
    ...plan.substrateFiles.map((path) => `- ${path}`),
  ].join("\n");
}

function formatInstallResult(result: SomaInstallResult): string {
  return [
    "Soma install applied",
    `substrate: ${result.substrate}`,
    `somaHome: ${result.somaHome.somaHome}`,
    `substrateHome: ${result.substrateHome.rootDir}`,
    "",
    "Soma files:",
    ...result.somaHome.files.map((path) => `- ${path}`),
    "",
    "Substrate files:",
    ...result.substrateHome.files.map((path) => `- ${path}`),
  ].join("\n");
}

function formatPaiImportPlan(plan: PaiImportPlan): string {
  return [
    "Soma PAI import plan",
    "source: pai",
    `mode: ${plan.apply ? "apply" : "dry-run"}`,
    `claudeHome: ${plan.claudeHome}`,
    `somaHome: ${plan.somaHome}`,
    "",
    "Source files:",
    ...plan.sourceFiles.map((path) => `- ${path}`),
    "",
    "Target files:",
    ...plan.targetFiles.map((path) => `- ${path}`),
  ].join("\n");
}

function formatPaiImportResult(result: PaiImportResult): string {
  return [
    "Soma PAI import applied",
    `claudeHome: ${result.claudeHome}`,
    `somaHome: ${result.somaHome}`,
    "",
    "Files:",
    ...result.files.map((path) => `- ${path}`),
  ].join("\n");
}

export async function runSomaCli(args: string[]): Promise<string> {
  const parsed = parseArgs(args);

  if (parsed.command === "import") {
    if (!parsed.apply) {
      return formatPaiImportPlan(planPaiImport(parsed.options));
    }

    return formatPaiImportResult(await importPaiIdentity(parsed.options));
  }

  if (!parsed.apply) {
    return formatPlan(
      parsed.substrate === "codex" ? planSomaForCodexInstall(parsed.options) : planSomaForPiDevInstall(parsed.options),
    );
  }

  return formatInstallResult(
    parsed.substrate === "codex" ? await installSomaForCodex(parsed.options) : await installSomaForPiDev(parsed.options),
  );
}

if (import.meta.main) {
  try {
    console.log(await runSomaCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
