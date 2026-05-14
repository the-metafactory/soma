import {
  createAlgorithmRun,
  importAlgorithm,
  importPaiIdentity,
  installSomaForCodex,
  installSomaForPiDev,
  planAlgorithmImport,
  planPaiImport,
  planSomaForCodexInstall,
  planSomaForPiDevInstall,
  runSomaLifecycleAlgorithmUpdated,
  runSomaLifecycleSessionEnd,
  runSomaLifecycleSessionStart,
  writeAlgorithmRun,
} from "./index";
import type {
  AlgorithmEffortTier,
  AlgorithmImportOptions,
  AlgorithmImportPlan,
  AlgorithmImportResult,
  AlgorithmRunInput,
  PaiImportOptions,
  PaiImportPlan,
  PaiImportResult,
  SomaInstallOptions,
  SomaInstallPlan,
  SomaInstallResult,
  SomaLifecycleOptions,
  SomaLifecycleResult,
  SubstrateId,
} from "./types";

interface ParsedInstallArgs {
  command: "install";
  substrate: "codex" | "pi-dev";
  apply: boolean;
  options: SomaInstallOptions;
}

interface ParsedImportArgs {
  command: "import";
  source: "pai" | "algorithm";
  apply: boolean;
  options: PaiImportOptions | AlgorithmImportOptions;
}

interface ParsedAlgorithmArgs {
  command: "algorithm";
  action: "new";
  options: {
    homeDir?: string;
    somaHome?: string;
    run: AlgorithmRunInput;
  };
}

interface ParsedLifecycleArgs {
  command: "lifecycle";
  event: "session-start" | "algorithm-updated" | "session-end";
  options: SomaLifecycleOptions;
}

type ParsedArgs = ParsedInstallArgs | ParsedImportArgs | ParsedAlgorithmArgs | ParsedLifecycleArgs;

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

  if (command !== "import" || (source !== "pai" && source !== "algorithm")) {
    throw new Error(
      [
        "Usage:",
        "  soma import pai [--dry-run] [--apply] [--home-dir <dir>] [--claude-home <dir>] [--soma-home <dir>]",
        "  soma import algorithm [--dry-run] [--apply] [--home-dir <dir>] [--pai-algorithm-dir <dir>] [--soma-home <dir>]",
      ].join("\n"),
    );
  }

  const options: PaiImportOptions & AlgorithmImportOptions = {};
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
        if (source !== "pai") {
          throw new Error("--claude-home is only valid for soma import pai.");
        }
        options.claudeHome = readOption(rest, index, arg);
        index += 1;
        break;
      case "--pai-algorithm-dir":
        if (source !== "algorithm") {
          throw new Error("--pai-algorithm-dir is only valid for soma import algorithm.");
        }
        options.paiAlgorithmDir = readOption(rest, index, arg);
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

function parseCriterion(value: string): { id: string; text: string; verification?: string } {
  const separator = value.indexOf(":");

  if (separator === -1) {
    throw new Error("--criterion requires id:text.");
  }

  return {
    id: value.slice(0, separator).trim(),
    text: value.slice(separator + 1).trim(),
  };
}

function parseEffort(value: string): AlgorithmEffortTier {
  if (value === "E1" || value === "E2" || value === "E3" || value === "E4" || value === "E5") {
    return value;
  }

  throw new Error("--effort must be one of E1, E2, E3, E4, or E5.");
}

function parseSubstrate(value: string): SubstrateId {
  if (value === "codex" || value === "pi-dev" || value === "claude-code" || value === "cortex" || value === "custom") {
    return value;
  }

  throw new Error("--substrate must be one of codex, pi-dev, claude-code, cortex, or custom.");
}

function parseAlgorithmArgs(args: string[]): ParsedAlgorithmArgs {
  const [command, action, ...rest] = args;

  if (command !== "algorithm" || action !== "new") {
    throw new Error(
      "Usage: soma algorithm new --prompt <text> --intent <text> --current-state <text> --goal <text> --criterion <id:text> [--effort <E1|E2|E3|E4|E5>] [--home-dir <dir>] [--soma-home <dir>]",
    );
  }

  const run: Partial<AlgorithmRunInput> & { criteria: AlgorithmRunInput["criteria"] } = {
    criteria: [],
  };
  const options: ParsedAlgorithmArgs["options"] = {
    run: run as AlgorithmRunInput,
  };

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
      case "--prompt":
        run.prompt = readOption(rest, index, arg);
        index += 1;
        break;
      case "--intent":
        run.intent = readOption(rest, index, arg);
        index += 1;
        break;
      case "--current-state":
        run.currentState = readOption(rest, index, arg);
        index += 1;
        break;
      case "--goal":
        run.goal = readOption(rest, index, arg);
        index += 1;
        break;
      case "--effort":
        run.effort = parseEffort(readOption(rest, index, arg));
        index += 1;
        break;
      case "--criterion":
        run.criteria.push(parseCriterion(readOption(rest, index, arg)));
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!run.prompt || !run.intent || !run.currentState || !run.goal || run.criteria.length === 0) {
    throw new Error(
      "Usage: soma algorithm new --prompt <text> --intent <text> --current-state <text> --goal <text> --criterion <id:text> [--effort <E1|E2|E3|E4|E5>] [--home-dir <dir>] [--soma-home <dir>]",
    );
  }

  options.run = run as AlgorithmRunInput;

  return {
    command,
    action,
    options,
  };
}

function parseLifecycleArgs(args: string[]): ParsedLifecycleArgs {
  const [command, event, ...rest] = args;

  if (command !== "lifecycle" || (event !== "session-start" && event !== "algorithm-updated" && event !== "session-end")) {
    throw new Error(
      "Usage: soma lifecycle <session-start|algorithm-updated|session-end> [--home-dir <dir>] [--soma-home <dir>] [--substrate <id>] [--session-id <id>]",
    );
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

function parseArgs(args: string[]): ParsedArgs {
  if (args[0] === "lifecycle") {
    return parseLifecycleArgs(args);
  }

  if (args[0] === "algorithm") {
    return parseAlgorithmArgs(args);
  }

  if (args[0] === "install") {
    return parseInstallArgs(args);
  }

  if (args[0] === "import") {
    return parseImportArgs(args);
  }

  throw new Error(
    [
      "Usage:",
      "  soma algorithm new --prompt <text> --intent <text> --current-state <text> --goal <text> --criterion <id:text> [--effort <E1|E2|E3|E4|E5>] [--home-dir <dir>] [--soma-home <dir>]",
      "  soma lifecycle <session-start|algorithm-updated|session-end> [--home-dir <dir>] [--soma-home <dir>] [--substrate <id>] [--session-id <id>]",
      "  soma install <codex|pi-dev> [--dry-run] [--apply] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
      "  soma import pai [--dry-run] [--apply] [--home-dir <dir>] [--claude-home <dir>] [--soma-home <dir>]",
      "  soma import algorithm [--dry-run] [--apply] [--home-dir <dir>] [--pai-algorithm-dir <dir>] [--soma-home <dir>]",
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

function formatAlgorithmImportPlan(plan: AlgorithmImportPlan): string {
  return [
    "Soma Algorithm import plan",
    "source: algorithm",
    `mode: ${plan.apply ? "apply" : "dry-run"}`,
    `paiAlgorithmDir: ${plan.paiAlgorithmDir}`,
    `somaHome: ${plan.somaHome}`,
    "",
    "Source files:",
    ...plan.sourceFiles.map((path) => `- ${path}`),
    "",
    "Target files:",
    ...plan.targetFiles.map((path) => `- ${path}`),
  ].join("\n");
}

function formatAlgorithmImportResult(result: AlgorithmImportResult): string {
  return [
    "Soma Algorithm import applied",
    `paiAlgorithmDir: ${result.paiAlgorithmDir}`,
    `somaHome: ${result.somaHome}`,
    "",
    "Files:",
    ...result.files.map((path) => `- ${path}`),
  ].join("\n");
}

function formatAlgorithmRunResult(result: { path: string; run: { id: string; phase: string; effort: string } }): string {
  return [
    "Soma Algorithm run created",
    `id: ${result.run.id}`,
    `phase: ${result.run.phase}`,
    `effort: ${result.run.effort}`,
    `path: ${result.path}`,
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

export async function runSomaCli(args: string[]): Promise<string> {
  const parsed = parseArgs(args);

  if (parsed.command === "lifecycle") {
    if (parsed.event === "session-start") {
      return formatLifecycleResult(await runSomaLifecycleSessionStart(parsed.options));
    }

    if (parsed.event === "algorithm-updated") {
      return formatLifecycleResult(await runSomaLifecycleAlgorithmUpdated(parsed.options));
    }

    return formatLifecycleResult(await runSomaLifecycleSessionEnd(parsed.options));
  }

  if (parsed.command === "algorithm") {
    return formatAlgorithmRunResult(
      await writeAlgorithmRun(createAlgorithmRun(parsed.options.run), {
        homeDir: parsed.options.homeDir,
        somaHome: parsed.options.somaHome,
      }),
    );
  }

  if (parsed.command === "import") {
    if (parsed.source === "algorithm") {
      const options = parsed.options as AlgorithmImportOptions;

      if (!parsed.apply) {
        return formatAlgorithmImportPlan(planAlgorithmImport(options));
      }

      return formatAlgorithmImportResult(await importAlgorithm(options));
    }

    const options = parsed.options as PaiImportOptions;

    if (!parsed.apply) {
      return formatPaiImportPlan(planPaiImport(options));
    }

    return formatPaiImportResult(await importPaiIdentity(options));
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
