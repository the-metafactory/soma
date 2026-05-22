import { checkSomaPolicy, checkSomaPolicyBatch } from "../index";
import type { SomaPolicyBatchTarget, SomaPolicyCheckOptions, SomaPolicyCheckResult } from "../types";
import { readOption } from "./parse-utils";
import { parseSubstrate } from "./substrate";

export interface ParsedPolicyArgs {
  command: "policy";
  action: "check";
  options: SomaPolicyCheckOptions;
  targetsEnv?: string;
  json: boolean;
}

const POLICY_CHECK_USAGE =
  "Usage: soma policy check --action write --destination <path> [--content <text>|--content-env <name>] [--source <path>] [--substrate <id>] [--record <all|deny|none>] [--json]";

export const POLICY_COMMAND_HELP: { usage: string; subcommands: Record<ParsedPolicyArgs["action"], string> } = {
  usage: POLICY_CHECK_USAGE,
  subcommands: {
    check: POLICY_CHECK_USAGE,
  },
};

export function parsePolicyArgs(args: string[]): ParsedPolicyArgs {
  const [command, action, ...rest] = args;

  if (command !== "policy" || action !== "check") {
    throw new Error(POLICY_COMMAND_HELP.subcommands.check);
  }

  const options: Partial<SomaPolicyCheckOptions> = {};
  let json = false;
  let targetsEnv = "";

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
      case "--action": {
        const value = readOption(rest, index, arg);
        if (value !== "write" && value !== "delete" && value !== "modify") throw new Error("--action must be one of write, delete, or modify.");
        options.action = value;
        index += 1;
        break;
      }
      case "--destination":
        options.destinationPath = readOption(rest, index, arg);
        index += 1;
        break;
      case "--source":
        options.sourcePath = readOption(rest, index, arg);
        index += 1;
        break;
      case "--content":
        options.content = readOption(rest, index, arg);
        index += 1;
        break;
      case "--content-env": {
        const envName = readOption(rest, index, arg);
        const envContent = process.env[envName];
        if (envContent === undefined) {
          throw new Error(`--content-env ${envName} is not set.`);
        }
        options.content = envContent;
        index += 1;
        break;
      }
      case "--record": {
        const value = readOption(rest, index, arg);
        if (value !== "all" && value !== "deny" && value !== "none") {
          throw new Error("--record must be one of all, deny, or none.");
        }
        options.record = value;
        index += 1;
        break;
      }
      case "--protected-path": {
        const protectedPath = readOption(rest, index, arg);
        (options.protectedPaths ??= []).push({ path: protectedPath, description: protectedPath });
        index += 1;
        break;
      }
      case "--protected-path-name": {
        const name = readOption(rest, index, arg);
        if (!options.protectedPaths || options.protectedPaths.length === 0) {
          throw new Error("--protected-path-name requires a preceding --protected-path.");
        }
        options.protectedPaths[options.protectedPaths.length - 1].description = name;
        index += 1;
        break;
      }
      case "--private-root": {
        (options.privateRoots ??= []).push(readOption(rest, index, arg));
        index += 1;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--targets-env":
        targetsEnv = readOption(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  const missing: string[] = [];
  if (!options.action) missing.push("--action");
  if (!options.destinationPath && !targetsEnv) missing.push("--destination");
  if (missing.length > 0) {
    throw new Error(`soma policy ${action} is missing required option(s): ${missing.join(", ")}.`);
  }

  return {
    command,
    action,
    options: options as SomaPolicyCheckOptions,
    targetsEnv: targetsEnv || undefined,
    json,
  };
}

export async function runPolicyCli(parsed: ParsedPolicyArgs): Promise<string> {
  if (parsed.targetsEnv) {
    const targets = readPolicyTargetsEnv(parsed.targetsEnv);
    const result = await checkSomaPolicyBatch({
      homeDir: parsed.options.homeDir,
      somaHome: parsed.options.somaHome,
      substrate: parsed.options.substrate,
      action: parsed.options.action,
      record: parsed.options.record,
      timestamp: parsed.options.timestamp,
      privateRoots: parsed.options.privateRoots,
      protectedPaths: parsed.options.protectedPaths,
      targets,
    });

    return parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.decision}: ${result.reason}\n`;
  }

  const result = await checkSomaPolicy(parsed.options);
  return parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatPolicyCheckResult(result);
}

function formatPolicyCheckResult(result: SomaPolicyCheckResult): string {
  return [
    "Soma policy check",
    `decision: ${result.decision}`,
    `reason: ${result.reason}`,
    `somaHome: ${result.somaHome}`,
    result.event ? `event: ${result.event.id}` : undefined,
    "",
    "Findings:",
    ...(result.findings.length > 0 ? result.findings.map((finding) => `- ${finding.kind}: ${finding.detail}`) : ["- none"]),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function readPolicyTargetsEnv(envName: string): SomaPolicyBatchTarget[] {
  const envContent = process.env[envName];
  if (envContent === undefined) {
    throw new Error(`--targets-env ${envName} is not set.`);
  }

  let targets: unknown;
  try {
    targets = JSON.parse(envContent);
  } catch {
    throw new Error(`--targets-env ${envName} must contain valid JSON targets.`);
  }

  if (
    !Array.isArray(targets) ||
    targets.some(
      (target) =>
        !target ||
        typeof target !== "object" ||
        typeof (target as SomaPolicyBatchTarget).filePath !== "string" ||
        ((target as SomaPolicyBatchTarget).action !== undefined &&
          (typeof (target as SomaPolicyBatchTarget).action !== "string" ||
            !["write", "delete", "modify"].includes((target as SomaPolicyBatchTarget).action ?? ""))) ||
        ((target as SomaPolicyBatchTarget).content !== undefined && typeof (target as SomaPolicyBatchTarget).content !== "string") ||
        ((target as SomaPolicyBatchTarget).sourcePath !== undefined && typeof (target as SomaPolicyBatchTarget).sourcePath !== "string"),
    )
  ) {
    throw new Error(
      `--targets-env ${envName} must contain an array of targets with string filePath values and optional string content/sourcePath values. Optional action must be one of write, delete, or modify.`,
    );
  }

  return targets as SomaPolicyBatchTarget[];
}
