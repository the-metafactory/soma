import { isAbsolute, resolve } from "node:path";
import { hasSomaPolicyPrivateMarker } from "./policy-marker";
import type { SomaPolicyAction, SomaPolicyBatchTarget } from "./types";

export type SomaToolPolicyAction = SomaPolicyAction | "read";

export interface SomaPolicyTargetConfig {
  somaHome: string;
  policyMarkers: readonly string[];
  inboundSecurity?: {
    untrustedRoots?: readonly string[];
  };
}

export interface SomaToolPolicyExtractionOptions {
  maxTargets?: number;
}

export interface SomaToolPolicyTargetInput {
  action: SomaToolPolicyAction;
  destinations: readonly string[];
  sourcePath?: string;
  content?: string;
}

export interface SomaToolPolicyExtraction {
  action: SomaToolPolicyAction;
  targets: SomaPolicyBatchTarget[];
  blockReason?: string;
}

export interface SomaPolicyToolInvocation {
  toolName: string;
  rawToolInput: unknown;
  toolInput: Record<string, unknown>;
  cwd: string;
  filePath: string;
  sourcePath?: string;
  command: string;
}

function hasSomaPolicyMarker(config: SomaPolicyTargetConfig, content: string | undefined): boolean {
  return config.policyMarkers.some((marker) => hasSomaPolicyPrivateMarker(content, marker));
}

function hasPotentialPrivateSourceReference(config: SomaPolicyTargetConfig, content: string | undefined): boolean {
  if (!content) return false;
  if (hasSomaPolicyMarker(config, content)) return true;
  return config.policyMarkers.some((marker) => marker.startsWith("/") && content.includes(marker.slice(marker.lastIndexOf("/"))));
}

function policyRelevantContent(config: SomaPolicyTargetConfig, content: string | undefined): string {
  if (!hasSomaPolicyMarker(config, content)) return "";
  return (content ?? "")
    .split("\n")
    .filter((line) => hasSomaPolicyMarker(config, line))
    .join("\n");
}

function resolveToolPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toolText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function resolveShellPath(config: SomaPolicyTargetConfig, path: string, cwd: string): string {
  if (path.startsWith("~/.soma")) {
    return `${config.somaHome}${path.slice("~/.soma".length)}`;
  }

  const home = config.somaHome.endsWith("/.soma") ? config.somaHome.slice(0, -"/.soma".length) : process.env.HOME ?? "";
  if (home && path.startsWith("$HOME/")) {
    return `${home}/${path.slice("$HOME/".length)}`;
  }
  if (home && path.startsWith("${HOME}/")) {
    return `${home}/${path.slice("${HOME}/".length)}`;
  }

  if (path.startsWith("~/") && config.somaHome.endsWith("/.soma")) {
    return `${config.somaHome.slice(0, -"/.soma".length)}/${path.slice(2)}`;
  }

  return path.startsWith("~/") ? path : resolveToolPath(path, cwd);
}

function cleanShellToken(token: string): string {
  return token.replace(/^[<>"']+|[>"']+$/g, "");
}

function tokenizeShellCommand(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/g)]
    .map((match) => {
      const groups = match as unknown as (string | undefined)[];
      return cleanShellToken(groups[1] ?? groups[2] ?? match[0]);
    })
    .filter(Boolean);
}

function hasPrivatePathReference(config: SomaPolicyTargetConfig, token: string | undefined, cwd: string): boolean {
  if (!token) return false;
  if (hasSomaPolicyMarker(config, token)) return true;
  if (token === ".soma" || token.startsWith(".soma/") || token.startsWith("./.soma/")) return true;
  if (token.startsWith(".codex/memories/soma/") || token.startsWith("./.codex/memories/soma/")) return true;
  if (token.startsWith(".pi/agent/soma/") || token.startsWith("./.pi/agent/soma/")) return true;
  const resolved = resolveShellPath(config, token, cwd);
  return config.policyMarkers.some((marker) => {
    if (!marker.startsWith("/")) return false;
    const root = marker.endsWith("/") ? marker.slice(0, -1) : marker;
    return resolved === root || resolved.startsWith(`${root}/`);
  });
}

function isProtectedPathReference(config: SomaPolicyTargetConfig, token: string | undefined, cwd: string): boolean {
  if (!token) return false;
  if (hasPrivatePathReference(config, token, cwd)) return true;
  if (token === ".codex/memories" || token.startsWith(".codex/memories/") || token.startsWith("./.codex/memories/")) return true;
  if (token === ".claude" || token.startsWith(".claude/") || token.startsWith("./.claude/")) return true;
  return false;
}

function protectedPathTokens(config: SomaPolicyTargetConfig, tokens: string[], cwd: string): string[] {
  return tokens.filter((token) => isProtectedPathReference(config, token, cwd));
}

function firstPrivatePathToken(config: SomaPolicyTargetConfig, tokens: string[], cwd: string): string | undefined {
  return tokens.find((token) => hasPrivatePathReference(config, token, cwd));
}

function absoluteProtectedRoots(config: SomaPolicyTargetConfig): string[] {
  return Array.from(new Set(config.policyMarkers.filter((marker) => marker.startsWith("/")).map((marker) => resolve(marker))));
}

function lastPathToken(tokens: string[]): string | undefined {
  return [...tokens].reverse().find((token) => token && !token.startsWith("-") && token !== "--");
}

function redirectionTarget(tokens: string[]): string | undefined {
  const redirectIndex = tokens.findIndex((token) => token === ">" || token === ">>");
  if (redirectIndex !== -1) return tokens[redirectIndex + 1];
  const redirectToken = tokens.find((token) => token.startsWith(">") && token.length > 1);
  return redirectToken ? redirectToken.replace(/^>+/, "") : undefined;
}

function isShellOperator(token: string): boolean {
  return token === "&&" || token === "||" || token === "|" || token === ";";
}

function shellSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (isShellOperator(token)) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function shellSegmentsWithOperators(tokens: string[]): { tokens: string[]; operatorAfter?: string }[] {
  const segments: { tokens: string[]; operatorAfter?: string }[] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (isShellOperator(token)) {
      if (current.length > 0) segments.push({ tokens: current, operatorAfter: token });
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segments.push({ tokens: current, operatorAfter: undefined });
  return segments;
}

function shellCommandName(token: string | undefined): string {
  return token?.split("/").pop() ?? "";
}

function skipShellPrefixes(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(token) || ["command", "exec", "time", "nice", "nohup"].includes(token)) {
      index += 1;
      continue;
    }
    if (token === "sudo") {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith("-")) {
        const option = tokens[index];
        index += 1;
        if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-T", "--command-timeout"].includes(option)) {
          index += 1;
        }
      }
      continue;
    }
    if (token === "env") {
      index += 1;
      while (index < tokens.length && (tokens[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(tokens[index]))) {
        index += 1;
      }
      continue;
    }
    break;
  }
  return index;
}

function shellPathArguments(tokens: string[], startIndex: number): string[] {
  const args: string[] = [];
  let parseFlags = true;
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (parseFlags && token === "--") {
      parseFlags = false;
      continue;
    }
    if (parseFlags && token.startsWith("-") && token.length > 1) continue;
    if (token === ">" || token === ">>") {
      i += 1;
      continue;
    }
    args.push(token);
  }
  return args;
}

function findSearchRoots(tokens: string[], startIndex: number): string[] {
  const roots: string[] = [];
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "-H" || token === "-L" || token === "-P") continue;
    if (token === "(" || token === "!" || token.startsWith("-")) break;
    roots.push(token);
  }
  return roots.length > 0 ? roots : ["."];
}

function findNamePredicates(tokens: string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "-name" || tokens[i] === "-iname") {
      const name = tokens[i + 1];
      if (name) names.push(name);
      i += 1;
    }
  }
  return names;
}

function findDeleteParentTargets(config: SomaPolicyTargetConfig, segment: string[], commandIndex: number, cwd: string): string[] {
  const names = findNamePredicates(segment);
  const roots = absoluteProtectedRoots(config);
  const targets: string[] = [];

  for (const searchRoot of findSearchRoots(segment, commandIndex + 1)) {
    const resolvedSearchRoot = resolveShellPath(config, searchRoot, cwd);
    for (const root of roots) {
      if (root === resolvedSearchRoot || !root.startsWith(`${resolvedSearchRoot}/`)) continue;
      const rootBasename = root.slice(root.lastIndexOf("/") + 1);
      if (names.length === 0 || names.includes(rootBasename)) {
        targets.push(root);
      }
    }
  }

  return targets;
}

function shellPayload(tokens: string[], commandIndex: number): string | undefined {
  const shellOptionsWithValues = new Set(["--command-timeout"]);
  for (let i = commandIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "-c" || token === "--command") return tokens[i + 1];
    if (shellOptionsWithValues.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("--")) continue;
    if (/^-[A-Za-z]+$/.test(token) && token.includes("c")) return tokens[i + 1];
  }
  return undefined;
}

function extractDestructiveShellTargets(config: SomaPolicyTargetConfig, tokens: string[], cwd: string, depth = 0): SomaPolicyBatchTarget[] {
  const destructiveTargets: SomaPolicyBatchTarget[] = [];
  for (const segment of shellSegments(tokens)) {
    const commandIndex = skipShellPrefixes(segment);
    const command = shellCommandName(segment[commandIndex]);

    if (depth < 4 && (command === "bash" || command === "sh" || command === "zsh")) {
      const payload = shellPayload(segment, commandIndex);
      if (payload) destructiveTargets.push(...extractDestructiveShellTargets(config, tokenizeShellCommand(payload), cwd, depth + 1));
      continue;
    }

    if (depth < 4 && command === "eval") {
      destructiveTargets.push(...extractDestructiveShellTargets(config, segment.slice(commandIndex + 1), cwd, depth + 1));
      continue;
    }

    if (command === "find" && (segment.includes("-delete") || segment.includes("-exec"))) {
      for (const token of protectedPathTokens(config, shellPathArguments(segment, commandIndex + 1), cwd)) {
        destructiveTargets.push({ action: "delete", filePath: resolveShellPath(config, token, cwd) });
      }
      for (const target of findDeleteParentTargets(config, segment, commandIndex, cwd)) {
        destructiveTargets.push({ action: "delete", filePath: target });
      }
      continue;
    }

    if (["rm", "rmdir", "trash", "trash-put", "gtrash", "unlink"].includes(command)) {
      for (const token of protectedPathTokens(config, shellPathArguments(segment, commandIndex + 1), cwd)) {
        destructiveTargets.push({ action: "delete", filePath: resolveShellPath(config, token, cwd) });
      }
    }

    if (command === "mv") {
      const args = shellPathArguments(segment, commandIndex + 1);
      const sourceArgs = args.length > 1 ? args.slice(0, -1) : args;
      for (const token of protectedPathTokens(config, sourceArgs, cwd)) {
        destructiveTargets.push({ action: "modify", filePath: resolveShellPath(config, token, cwd) });
      }
    }
  }
  return destructiveTargets;
}

function extractPrivateShellTransferTargets(config: SomaPolicyTargetConfig, tokens: string[], cwd: string, depth = 0): SomaPolicyBatchTarget[] {
  const targets: SomaPolicyBatchTarget[] = [];
  for (const segment of shellSegments(tokens)) {
    const commandIndex = skipShellPrefixes(segment);
    const command = shellCommandName(segment[commandIndex]);

    if (depth < 4 && (command === "bash" || command === "sh" || command === "zsh")) {
      const payload = shellPayload(segment, commandIndex);
      if (payload) targets.push(...extractPrivateShellTransferTargets(config, tokenizeShellCommand(payload), cwd, depth + 1));
      continue;
    }

    if (depth < 4 && command === "eval") {
      targets.push(...extractPrivateShellTransferTargets(config, segment.slice(commandIndex + 1), cwd, depth + 1));
      continue;
    }

    if (!["cp", "mv", "install", "rsync", "cat"].includes(command)) continue;
    const args = shellPathArguments(segment, commandIndex + 1);
    if (args.length === 0) continue;
    const redirect = redirectionTarget(segment);
    const sources = command === "cat" && redirect ? args : args.slice(0, -1);
    const destination = command === "cat" && redirect ? redirect : lastPathToken(args);
    const privateSource = sources.find((token) => hasPrivatePathReference(config, token, cwd));
    if (privateSource && destination) {
      targets.push({
        action: command === "mv" ? "modify" : "write",
        filePath: resolveShellPath(config, destination, cwd),
        sourcePath: resolveShellPath(config, privateSource, cwd),
      });
    }
  }
  return targets;
}

function extractPipedPrivateShellTransferTargets(config: SomaPolicyTargetConfig, tokens: string[], cwd: string, depth = 0): SomaPolicyBatchTarget[] {
  const targets: SomaPolicyBatchTarget[] = [];
  let pipedPrivateSource: string | undefined;

  for (const { tokens: segment, operatorAfter } of shellSegmentsWithOperators(tokens)) {
    const commandIndex = skipShellPrefixes(segment);
    const command = shellCommandName(segment[commandIndex]);

    if (depth < 4 && (command === "bash" || command === "sh" || command === "zsh")) {
      const payload = shellPayload(segment, commandIndex);
      if (payload) targets.push(...extractPipedPrivateShellTransferTargets(config, tokenizeShellCommand(payload), cwd, depth + 1));
      pipedPrivateSource = operatorAfter === "|" ? pipedPrivateSource : undefined;
      continue;
    }

    if (depth < 4 && command === "eval") {
      targets.push(...extractPipedPrivateShellTransferTargets(config, segment.slice(commandIndex + 1), cwd, depth + 1));
      pipedPrivateSource = operatorAfter === "|" ? pipedPrivateSource : undefined;
      continue;
    }

    if (pipedPrivateSource) {
      const destination = command === "tee" ? lastPathToken(shellPathArguments(segment, commandIndex + 1)) : redirectionTarget(segment);
      if (destination) {
        targets.push({
          action: "write",
          filePath: resolveShellPath(config, destination, cwd),
          sourcePath: resolveShellPath(config, pipedPrivateSource, cwd),
        });
      }
    }

    const privateSource = firstPrivatePathToken(config, segment, cwd);
    pipedPrivateSource = operatorAfter === "|" ? privateSource ?? pipedPrivateSource : undefined;
  }

  return targets;
}

function pushPatchTarget(config: SomaPolicyTargetConfig, targets: SomaPolicyBatchTarget[], target: (SomaPolicyBatchTarget & { lines: string[] }) | undefined): void {
  if (!target) return;
  targets.push({
    action: target.action,
    filePath: target.filePath,
    sourcePath: target.sourcePath,
    content: target.lines.filter((line) => hasSomaPolicyMarker(config, line)).join("\n"),
  });
}

function extractPatchTargets(config: SomaPolicyTargetConfig, patch: string, cwd: string): SomaPolicyBatchTarget[] {
  const targets: SomaPolicyBatchTarget[] = [];
  let current: (SomaPolicyBatchTarget & { lines: string[] }) | undefined;
  const pattern = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
  const movePattern = /^\*\*\* Move to: (.+)$/;

  for (const line of patch.split("\n")) {
    const moveMatch = movePattern.exec(line);
    if (moveMatch) {
      if (current) {
        const originalFilePath = current.filePath;
        current.filePath = resolveToolPath(moveMatch[1].trim(), cwd);
        current.sourcePath = current.sourcePath ?? originalFilePath;
      } else {
        current = { filePath: resolveToolPath(moveMatch[1].trim(), cwd), sourcePath: config.somaHome, lines: [] };
      }
      continue;
    }

    const fileMatch = pattern.exec(line);
    if (fileMatch) {
      pushPatchTarget(config, targets, current);
      const operation = fileMatch[1];
      current = {
        filePath: resolveToolPath(fileMatch[2].trim(), cwd),
        action: operation === "Delete" ? "delete" : "write",
        lines: [],
      };
      continue;
    }

    if (current && line.startsWith("+") && !line.startsWith("+++")) {
      current.lines.push(line.slice(1));
    }
  }

  pushPatchTarget(config, targets, current);
  return targets;
}

export function extractWritePolicyTargets(config: SomaPolicyTargetConfig, context: SomaPolicyToolInvocation): SomaPolicyBatchTarget[] {
  return [{ filePath: context.filePath, sourcePath: context.sourcePath, content: policyRelevantContent(config, toolText(context.toolInput.content)) }];
}

export function extractEditPolicyTargets(config: SomaPolicyTargetConfig, context: SomaPolicyToolInvocation): SomaPolicyBatchTarget[] {
  const content = stringValue(context.toolInput.new_string) ?? stringValue(context.toolInput.newString) ?? "";
  return [{ filePath: context.filePath, sourcePath: context.sourcePath, content: policyRelevantContent(config, content) }];
}

export function extractMultiEditPolicyTargets(config: SomaPolicyTargetConfig, context: SomaPolicyToolInvocation): SomaPolicyBatchTarget[] {
  const edits = Array.isArray(context.toolInput.edits) ? context.toolInput.edits : [];
  return edits.map((edit) => {
    const entry = edit && typeof edit === "object" ? edit as Record<string, unknown> : {};
    return {
      filePath: context.filePath,
      sourcePath: context.sourcePath,
      content: policyRelevantContent(config, stringValue(entry.new_string) ?? stringValue(entry.newString) ?? ""),
    };
  });
}

export function extractApplyPatchPolicyTargets(config: SomaPolicyTargetConfig, context: SomaPolicyToolInvocation): SomaPolicyBatchTarget[] {
  const content =
    typeof context.rawToolInput === "string"
      ? context.rawToolInput
      : stringValue(context.toolInput.patch) ?? stringValue(context.toolInput.command) ?? stringValue(context.toolInput.cmd) ?? toolText(context.toolInput);
  if (!hasPotentialPrivateSourceReference(config, content) && !content.includes("*** Move to:")) return [];
  const targets = extractPatchTargets(config, content, context.cwd);
  return targets.length > 0 ? targets : [{ filePath: context.cwd, content: policyRelevantContent(config, content) }];
}

export function extractShellPolicyTargets(config: SomaPolicyTargetConfig, context: SomaPolicyToolInvocation): SomaPolicyBatchTarget[] {
  const tokens = tokenizeShellCommand(context.command);
  const destructiveTargets = extractDestructiveShellTargets(config, tokens, context.cwd);
  const transferTargets = extractPrivateShellTransferTargets(config, tokens, context.cwd);
  const pipedTransferTargets = extractPipedPrivateShellTransferTargets(config, tokens, context.cwd);
  return [...destructiveTargets, ...transferTargets, ...pipedTransferTargets];
}

export function shouldCheckSomaPolicyTarget(config: SomaPolicyTargetConfig, target: SomaPolicyBatchTarget): boolean {
  return target.action === "delete" || target.action === "modify" || Boolean(target.sourcePath) || hasSomaPolicyMarker(config, target.content);
}

export function somaPolicyActionForToolAction(action: SomaToolPolicyAction): SomaPolicyAction {
  return action === "read" ? "modify" : action;
}

export function extractToolCallPolicyTargets(input: SomaToolPolicyTargetInput, options: SomaToolPolicyExtractionOptions = {}): SomaToolPolicyExtraction {
  const destinations = Array.from(new Set(input.destinations));
  const maxTargets = options.maxTargets ?? Number.POSITIVE_INFINITY;
  if (destinations.length > maxTargets) {
    return {
      action: input.action,
      targets: [],
      blockReason: `Soma policy blocked tool_call with ${destinations.length} destinations; maximum is ${maxTargets}.`,
    };
  }

  if (destinations.length === 0) {
    return {
      action: input.action,
      targets: [],
      blockReason: input.action === "read" ? undefined : "Soma policy blocked mutating tool_call without a parseable destination.",
    };
  }

  return {
    action: input.action,
    targets: destinations.map((destination) => ({
      filePath: destination,
      sourcePath: input.sourcePath,
      content: input.content,
    })),
  };
}
