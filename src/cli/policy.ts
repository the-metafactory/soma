import { checkSomaPolicy, checkSomaPolicyBatch, evaluateToolCallPolicyGuard, inspectRuntimePolicy, promoteInboundContent, RUNTIME_POLICY_SURFACES, scanInboundContent } from "../index";
import type { ToolCallPolicyGuardOptions } from "../tool-policy-guard";
import type {
  InboundContentScanOptions,
  RuntimePolicyConfigChange,
  RuntimePolicyInspectOptions,
  RuntimePolicyPermissionRequest,
  RuntimePolicySurface,
  SomaPolicyBatchTarget,
  SomaPolicyCheckOptions,
  SomaPolicyCheckResult,
} from "../types";
import { readOption } from "./parse-utils";
import { parseSubstrate } from "./substrate";

export interface ParsedPolicyCheckArgs {
  command: "policy";
  action: "check";
  options: SomaPolicyCheckOptions;
  targetsEnv?: string;
  json: boolean;
}

export interface ParsedPolicyScanArgs {
  command: "policy";
  action: "scan";
  options: InboundContentScanOptions;
  json: boolean;
}

export interface ParsedPolicyPromoteArgs {
  command: "policy";
  action: "promote";
  options: InboundContentScanOptions & { sourcePath: string };
  json: boolean;
}

export interface ParsedPolicyInspectArgs {
  command: "policy";
  action: "inspect";
  options: RuntimePolicyInspectOptions;
  json: boolean;
}

export interface ParsedPolicyGuardArgs {
  command: "policy";
  action: "guard";
  options: ToolCallPolicyGuardOptions;
  json: boolean;
}

export type ParsedPolicyArgs = ParsedPolicyCheckArgs | ParsedPolicyScanArgs | ParsedPolicyPromoteArgs | ParsedPolicyInspectArgs | ParsedPolicyGuardArgs;

const POLICY_CHECK_USAGE =
  "Usage: soma policy check --action write --destination <path> [--content <text>|--content-env <name>] [--source <path>] [--substrate <id>] [--record <all|deny|none>] [--json]";
const POLICY_SCAN_USAGE =
  "Usage: soma policy scan (--path <path>|--content <text>|--content-env <name>) [--source-uri <uri>] [--substrate <id>] [--record <all|deny|none>] [--json]";
const POLICY_PROMOTE_USAGE =
  "Usage: soma policy promote --path <path> [--source-uri <uri>] [--substrate <id>] [--record <all|deny|none>] [--json]";
const POLICY_INSPECT_USAGE =
  "Usage: soma policy inspect --surface <prompt|tool_call|permission_request|config_change|governance_event> [--prompt <text>|--prompt-env <name>] [--tool-name <name> --tool-input-env <name>] [--permission-request-env <name>] [--config-change-env <name>] [--substrate <id>] [--record <all|deny|none>] [--json]";
const POLICY_GUARD_USAGE =
  "Usage: soma policy guard --substrate <id> --tool-name <name> --tool-input-env <name> [--cwd <dir>] [--soma-home <dir>] [--home-dir <dir>] [--private-root <dir>]… [--record <all|deny|none>] [--json]";

export const POLICY_COMMAND_HELP: { usage: string; subcommands: Record<ParsedPolicyArgs["action"], string> } = {
  usage: [POLICY_CHECK_USAGE, POLICY_SCAN_USAGE, POLICY_PROMOTE_USAGE, POLICY_INSPECT_USAGE, POLICY_GUARD_USAGE].join("\n"),
  subcommands: {
    check: POLICY_CHECK_USAGE,
    scan: POLICY_SCAN_USAGE,
    promote: POLICY_PROMOTE_USAGE,
    inspect: POLICY_INSPECT_USAGE,
    guard: POLICY_GUARD_USAGE,
  },
};

export function parsePolicyArgs(args: string[]): ParsedPolicyArgs {
  const [command, action, ...rest] = args;

  if (command !== "policy") {
    throw new Error(POLICY_COMMAND_HELP.subcommands.check);
  }

  if (action === "scan") return parsePolicyScanArgs(command, action, rest);
  if (action === "promote") return parsePolicyPromoteArgs(command, action, rest);
  if (action === "inspect") return parsePolicyInspectArgs(command, action, rest);
  if (action === "guard") return parsePolicyGuardArgs(command, action, rest);
  if (action !== "check") throw new Error(POLICY_COMMAND_HELP.usage);

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

function parsePolicyGuardArgs(command: "policy", action: "guard", rest: string[]): ParsedPolicyGuardArgs {
  const options: Partial<ToolCallPolicyGuardOptions> = { privateRoots: [] };
  let json = false;

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
      case "--cwd":
        options.cwd = readOption(rest, index, arg);
        index += 1;
        break;
      case "--tool-name":
        options.toolName = readOption(rest, index, arg);
        index += 1;
        break;
      case "--tool-input-env": {
        const envName = readOption(rest, index, arg);
        const envInput = process.env[envName];
        if (envInput === undefined) throw new Error(`--tool-input-env ${envName} is not set.`);
        let input: unknown;
        try {
          input = JSON.parse(envInput);
        } catch {
          throw new Error(`--tool-input-env ${envName} must contain a JSON object.`);
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new Error(`--tool-input-env ${envName} must contain a JSON object.`);
        }
        options.toolInput = input as Record<string, unknown>;
        index += 1;
        break;
      }
      case "--private-root":
        options.privateRoots = [...(options.privateRoots ?? []), readOption(rest, index, arg)];
        index += 1;
        break;
      case "--record": {
        const value = readOption(rest, index, arg);
        if (value !== "all" && value !== "deny" && value !== "none") {
          throw new Error("--record must be one of all, deny, or none.");
        }
        options.record = value;
        index += 1;
        break;
      }
      case "--json":
        json = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.substrate) throw new Error("soma policy guard is missing required option: --substrate.");
  if (!options.toolName) throw new Error("soma policy guard is missing required option: --tool-name.");
  if (!options.toolInput) throw new Error("soma policy guard requires --tool-input-env.");

  return { command, action, options: options as ToolCallPolicyGuardOptions, json };
}

export async function runPolicyCli(parsed: ParsedPolicyArgs): Promise<string> {
  if (parsed.action === "guard") {
    const result = await evaluateToolCallPolicyGuard(parsed.options);
    return parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.decision}: ${result.reason}\n`;
  }

  if (parsed.action === "inspect") {
    const result = await inspectRuntimePolicy(parsed.options);
    return parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatRuntimePolicyInspectResult(result);
  }

  if (parsed.action === "scan") {
    const result = await scanInboundContent(parsed.options);
    return parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatInboundScanResult(result);
  }

  if (parsed.action === "promote") {
    const result = await promoteInboundContent(parsed.options);
    return parsed.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [`Soma inbound content promotion`, `decision: ${result.scan.decision}`, `contentRef: sha256:${result.contentRef.hash}`, `sourcePath: ${result.sourcePath}`].join("\n");
  }

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

function parseInboundPolicyOptions(rest: string[], requirePath: boolean): { options: InboundContentScanOptions; json: boolean } {
  const options: Partial<InboundContentScanOptions> = {};
  let json = false;

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
      case "--path":
        options.sourcePath = readOption(rest, index, arg);
        index += 1;
        break;
      case "--source-uri":
        options.sourceUri = readOption(rest, index, arg);
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
      case "--json":
        json = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (requirePath && !options.sourcePath) {
    throw new Error("soma policy promote is missing required option: --path.");
  }
  if (!requirePath && !options.sourcePath && options.content === undefined) {
    throw new Error("soma policy scan requires --path, --content, or --content-env.");
  }

  return { options, json };
}

function parsePolicyScanArgs(command: "policy", action: "scan", rest: string[]): ParsedPolicyScanArgs {
  const parsed = parseInboundPolicyOptions(rest, false);
  return { command, action, ...parsed };
}

function parsePolicyPromoteArgs(command: "policy", action: "promote", rest: string[]): ParsedPolicyPromoteArgs {
  const parsed = parseInboundPolicyOptions(rest, true);
  return { command, action, options: parsed.options as InboundContentScanOptions & { sourcePath: string }, json: parsed.json };
}

function parsePolicyInspectArgs(command: "policy", action: "inspect", rest: string[]): ParsedPolicyInspectArgs {
  const options: Partial<RuntimePolicyInspectOptions> = {};
  let json = false;

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
      case "--surface": {
        const surface = readOption(rest, index, arg);
        if (!RUNTIME_POLICY_SURFACES.includes(surface as RuntimePolicySurface)) {
          throw new Error("--surface must be one of prompt, tool_call, permission_request, config_change, or governance_event.");
        }
        options.surface = surface as RuntimePolicySurface;
        index += 1;
        break;
      }
      case "--prompt":
        options.prompt = readOption(rest, index, arg);
        index += 1;
        break;
      case "--prompt-env": {
        const envName = readOption(rest, index, arg);
        const envPrompt = process.env[envName];
        if (envPrompt === undefined) {
          throw new Error(`--prompt-env ${envName} is not set.`);
        }
        options.prompt = envPrompt;
        index += 1;
        break;
      }
      case "--tool-name":
        options.toolCall = { ...(options.toolCall ?? { toolName: "" }), toolName: readOption(rest, index, arg) };
        index += 1;
        break;
      case "--tool-input-env": {
        const envName = readOption(rest, index, arg);
        const envInput = process.env[envName];
        if (envInput === undefined) {
          throw new Error(`--tool-input-env ${envName} is not set.`);
        }
        let input: unknown;
        try {
          input = JSON.parse(envInput);
        } catch {
          throw new Error(`--tool-input-env ${envName} must contain a JSON object.`);
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new Error(`--tool-input-env ${envName} must contain a JSON object.`);
        }
        options.toolCall = { ...(options.toolCall ?? { toolName: "" }), input: input as Record<string, unknown> };
        index += 1;
        break;
      }
      case "--config-change-env": {
        const envName = readOption(rest, index, arg);
        const envInput = process.env[envName];
        if (envInput === undefined) {
          throw new Error(`--config-change-env ${envName} is not set.`);
        }
        let input: unknown;
        try {
          input = JSON.parse(envInput);
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(`--config-change-env ${envName} must contain a JSON object: ${detail}`, { cause: err });
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new Error(`--config-change-env ${envName} must contain a JSON object.`);
        }
        options.configChange = input as RuntimePolicyConfigChange;
        index += 1;
        break;
      }
      case "--permission-request-env": {
        const envName = readOption(rest, index, arg);
        const envInput = process.env[envName];
        if (envInput === undefined) {
          throw new Error(`--permission-request-env ${envName} is not set.`);
        }
        let input: unknown;
        try {
          input = JSON.parse(envInput);
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(`--permission-request-env ${envName} must contain a JSON object: ${detail}`, { cause: err });
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new Error(`--permission-request-env ${envName} must contain a JSON object.`);
        }
        options.permissionRequest = input as RuntimePolicyPermissionRequest;
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
      case "--json":
        json = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.surface) {
    throw new Error("soma policy inspect is missing required option: --surface.");
  }
  if (options.surface === "prompt" && options.prompt === undefined) {
    throw new Error("soma policy inspect --surface prompt requires --prompt or --prompt-env.");
  }
  if (options.surface === "tool_call" && (!options.toolCall?.toolName || !options.toolCall.input)) {
    throw new Error("soma policy inspect --surface tool_call requires --tool-name and --tool-input-env.");
  }
  if (options.surface === "config_change" && !options.configChange) {
    throw new Error("soma policy inspect --surface config_change requires --config-change-env.");
  }
  if (options.surface === "permission_request" && !options.permissionRequest) {
    throw new Error("soma policy inspect --surface permission_request requires --permission-request-env.");
  }

  return { command, action, options: options as RuntimePolicyInspectOptions, json };
}

function formatInboundScanResult(result: Awaited<ReturnType<typeof scanInboundContent>>): string {
  return [
    "Soma inbound content scan",
    `decision: ${result.decision}`,
    `reason: ${result.reason}`,
    `scanner: ${result.scanner}`,
    `contentRef: sha256:${result.contentHash}`,
    `somaHome: ${result.somaHome}`,
    result.audit?.event ? `event: ${result.audit.event.id}` : undefined,
    result.audit?.tracePath ? `trace: ${result.audit.tracePath}` : undefined,
    "",
    "Findings:",
    ...(result.findings.length > 0 ? result.findings.map((finding) => `- ${finding.kind}: ${finding.detail}`) : ["- none"]),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function formatRuntimePolicyInspectResult(result: Awaited<ReturnType<typeof inspectRuntimePolicy>>): string {
  return [
    "Soma runtime policy inspection",
    `surface: ${result.surface}`,
    `decision: ${result.decision}`,
    `reason: ${result.reason}`,
    `somaHome: ${result.somaHome}`,
    result.audit?.event ? `event: ${result.audit.event.id}` : undefined,
    result.audit?.tracePath ? `trace: ${result.audit.tracePath}` : undefined,
    "",
    "Findings:",
    ...(result.findings.length > 0 ? result.findings.map((finding) => `- ${finding.severity} ${finding.kind}: ${finding.detail}`) : ["- none"]),
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
