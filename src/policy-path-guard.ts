import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SomaProtectedPath } from "./types";

// ── Default Protected Paths ──
// Paths that should never be destructively modified or deleted by an LLM tool.
// These are Soma's opinionated defaults; operators can override or extend via
// `protectedPaths` in SomaPolicyCheckOptions.

export const SOMA_DEFAULT_PROTECTED_PATHS: readonly SomaProtectedPath[] = [
  { path: "~/.soma", description: "Soma portable assistant home" },
  { path: "~/.claude", description: "Claude Code / PAI home" },
  { path: "~/.pi", description: "Pi.dev home" },
  { path: "~/.config/cortex", description: "Cortex operator config" },
  { path: "~/.config/metafactory", description: "Metafactory ecosystem config" },
  { path: "~/.config/k", description: "kai-launcher config" },
];

// ── Destructive Bash Command Detection ──

export const DESTRUCTIVE_COMMANDS = new Set(["rm", "rmdir", "trash", "trash-put", "gtrash"]);

export const DESTRUCTIVE_MOVE_COMMANDS = new Set(["mv"]);

export const NON_DESTRUCTIVE_PREFIXES = new Set(["sudo", "bun", "node", "npx", "bunx", "time", "nice", "exec", "env", "nohup", "command"]);

const SHELL_WRAPPER_COMMANDS = new Set(["bash", "sh", "zsh"]);
const REPARSE_WRAPPER_COMMANDS = new Set(["eval"]);
const XARGS_COMMANDS = new Set(["xargs"]);

function cleanToken(token: string): string {
  let cleaned = token;
  if ((cleaned.startsWith("\u0022") && cleaned.endsWith("\u0022")) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }
  cleaned = cleaned.replace(/^[<>]+/, "").replace(/[<>]+$/, "");
  return cleaned;
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\u0022" | "'" | undefined;

  function pushCurrent(): void {
    if (current.length === 0) return;
    tokens.push(cleanToken(current));
    current = "";
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\u0022" || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if (char === "&" && next === "&") {
      pushCurrent();
      tokens.push("&&");
      i++;
      continue;
    }

    if (char === "|" && next === "|") {
      pushCurrent();
      tokens.push("||");
      i++;
      continue;
    }

    if (char === ";" || char === "|") {
      pushCurrent();
      tokens.push(char);
      continue;
    }

    current += char;
  }

  pushCurrent();
  return tokens;
}

function isFlag(token: string): boolean {
  return token.startsWith("-") && token.length > 1;
}

function isChainOperator(token: string): boolean {
  return token === ";" || token === "&&" || token === "||" || token === "|";
}

function isNonDestructivePrefix(token: string): boolean {
  return NON_DESTRUCTIVE_PREFIXES.has(token);
}

function expandHomeVariables(path: string): string {
  const home = homedir();
  return path
    .replace(/^\$\{HOME\}(?=\/|$)/, home)
    .replace(/^\$HOME(?=\/|$)/, home);
}

export function expandTilde(path: string): string {
  const expandedEnv = expandHomeVariables(path);
  if (expandedEnv !== path) return expandedEnv;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function resolvePath(token: string, cwd: string): string {
  const expanded = expandTilde(token);
  return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}

function findProtectedPath(resolvedPath: string, protectedPaths: readonly SomaProtectedPath[], action: "delete" | "modify"): SomaProtectedPath | undefined {
  const realResolvedPath = realScopePath(resolvedPath);
  for (const pp of protectedPaths) {
    if (action === "delete" && pp.guardDelete === false) continue;
    if (action === "modify" && pp.guardModify === false) continue;

    const protectedRoot = realScopePath(resolve(expandTilde(pp.path)));
    const rel = relative(protectedRoot, realResolvedPath);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return pp;
    }
  }

  return undefined;
}

function realScopePath(path: string): string {
  let cursor = path;
  const suffix: string[] = [];

  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return path;
    suffix.unshift(cursor.slice(parent.length + 1));
    cursor = parent;
  }

  try {
    const realCursor = realpathSync(cursor);
    return suffix.length > 0 ? resolve(realCursor, ...suffix) : realCursor;
  } catch {
    return path;
  }
}

export interface SomaBashCommandParseResult {
  command: string;
  targetPaths: string[];
}

function splitCommandSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (isChainOperator(token)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

function shellPayloadIndex(tokens: string[], cmdIndex: number): number | undefined {
  for (let i = cmdIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-c" || token === "-lc") return i + 1 < tokens.length ? i + 1 : undefined;
  }

  return undefined;
}

function skipPrefixes(tokens: string[]): number {
  let cmdIndex = 0;
  while (cmdIndex < tokens.length) {
    const token = tokens[cmdIndex];
    if (isNonDestructivePrefix(token) || /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(token)) {
      cmdIndex++;
      continue;
    }
    break;
  }
  return cmdIndex;
}

function parseTokenSegment(tokens: string[], cwd: string, depth: number): SomaBashCommandParseResult {
  if (tokens.length === 0) return { command: "", targetPaths: [] };
  const cmdIndex = skipPrefixes(tokens);
  if (cmdIndex >= tokens.length) return { command: "", targetPaths: [] };

  const mainCommand = basename(tokens[cmdIndex]);

  if (depth < 4 && SHELL_WRAPPER_COMMANDS.has(mainCommand)) {
    const payloadIndex = shellPayloadIndex(tokens, cmdIndex);
    if (payloadIndex !== undefined) {
      return parseBashDestructivePathsInternal(tokens.slice(payloadIndex).join(" "), cwd, depth + 1, mainCommand);
    }
  }

  if (depth < 4 && REPARSE_WRAPPER_COMMANDS.has(mainCommand)) {
    return parseBashDestructivePathsInternal(tokens.slice(cmdIndex + 1).join(" "), cwd, depth + 1, mainCommand);
  }

  if (depth < 4 && XARGS_COMMANDS.has(mainCommand)) {
    const nestedIndex = tokens.findIndex((token, index) => index > cmdIndex && (DESTRUCTIVE_COMMANDS.has(token) || DESTRUCTIVE_MOVE_COMMANDS.has(token)));
    if (nestedIndex !== -1) {
      return parseTokenSegment(tokens.slice(nestedIndex), cwd, depth + 1);
    }
  }

  const targetPaths: string[] = [];

  if (mainCommand === "find") {
    const hasDelete = tokens.slice(cmdIndex + 1).some((token) => token === "-delete" || token === "-exec");
    if (hasDelete) {
      for (let i = cmdIndex + 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === "-H" || token === "-L" || token === "-P") continue;
        if (isFlag(token)) break;
        targetPaths.push(resolvePath(token, cwd));
      }
    }
    return { command: mainCommand, targetPaths };
  }

  if (!DESTRUCTIVE_COMMANDS.has(mainCommand) && !DESTRUCTIVE_MOVE_COMMANDS.has(mainCommand)) {
    return { command: mainCommand, targetPaths: [] };
  }

  const pathArgs = tokens.slice(cmdIndex + 1).filter((token) => !isFlag(token));

  if (DESTRUCTIVE_MOVE_COMMANDS.has(mainCommand)) {
    const sources = pathArgs.length > 1 ? pathArgs.slice(0, -1) : pathArgs.slice(0, 1);
    return {
      command: mainCommand,
      targetPaths: sources.map((source) => resolvePath(source, cwd)),
    };
  }

  for (let i = cmdIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (isFlag(token)) continue;
    if (token.includes("*")) {
      targetPaths.push(cwd);
    } else {
      targetPaths.push(resolvePath(token, cwd));
    }
  }

  return { command: mainCommand, targetPaths };
}

function parseBashDestructivePathsInternal(command: string, cwd: string, depth: number, fallbackCommand = ""): SomaBashCommandParseResult {
  const segments = splitCommandSegments(tokenize(command));
  if (segments.length === 0) return { command: fallbackCommand, targetPaths: [] };

  let firstCommand = "";
  const targetPaths: string[] = [];

  for (const segment of segments) {
    const result = parseTokenSegment(segment, cwd, depth);
    if (!firstCommand && result.command) firstCommand = result.command;
    targetPaths.push(...result.targetPaths);
  }

  return { command: firstCommand || fallbackCommand, targetPaths };
}

export function parseBashDestructivePaths(command: string, cwd: string): SomaBashCommandParseResult {
  return parseBashDestructivePathsInternal(command, cwd, 0);
}

export interface SomaPathGuardOptions {
  targetPaths: string[];
  cwd: string;
  protectedPaths?: readonly SomaProtectedPath[];
  action: "delete" | "modify";
}

export interface SomaPathGuardResult {
  blocked: boolean;
  matchedPaths: string[];
  matchedDescriptions: string[];
}

export function evaluatePathGuard(options: SomaPathGuardOptions): SomaPathGuardResult {
  const protectedPaths = options.protectedPaths ?? SOMA_DEFAULT_PROTECTED_PATHS;
  const matchedPaths: string[] = [];
  const matchedDescriptions: string[] = [];

  for (const target of options.targetPaths) {
    const match = findProtectedPath(target, protectedPaths, options.action);
    if (match) {
      matchedPaths.push(target);
      matchedDescriptions.push(match.description ? `${match.path} (${match.description})` : match.path);
    }
  }

  return {
    blocked: matchedPaths.length > 0,
    matchedPaths,
    matchedDescriptions,
  };
}
