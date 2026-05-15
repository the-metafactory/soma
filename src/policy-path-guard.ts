import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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

const DESTRUCTIVE_COMMANDS = new Set(["rm", "rmdir", "trash", "trash-put", "gtrash"]);

const DESTRUCTIVE_MOVE_COMMANDS = new Set(["mv"]);

function cleanToken(token: string): string {
  let cleaned = token;
  if ((cleaned.startsWith("\u0022") && cleaned.endsWith("\u0022")) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }
  cleaned = cleaned.replace(/^[<>]+/, "").replace(/>$/, "");
  return cleaned;
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  // Match double-quoted, single-quoted, or unquoted tokens
  const regex = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(command)) !== null) {
    const raw: string = match[1] || match[2] || match[0];
    tokens.push(cleanToken(raw));
  }

  return tokens;
}

function isFlag(token: string): boolean {
  return token.startsWith("-") && token.length > 1;
}

function isChainOperator(token: string): boolean {
  return token === ";" || token === "&&" || token === "||" || token === "|";
}

const NON_DESTRUCTIVE_PREFIXES = new Set(["sudo", "bun", "node", "npx", "bunx", "time", "nice", "exec", "env", "nohup"]);

function isNonDestructivePrefix(token: string): boolean {
  return NON_DESTRUCTIVE_PREFIXES.has(token);
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function resolvePath(token: string, cwd: string): string {
  const expanded = expandTilde(token);
  return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}

function findProtectedPath(resolvedPath: string, protectedPaths: readonly SomaProtectedPath[], action: "delete" | "modify"): SomaProtectedPath | undefined {
  for (const pp of protectedPaths) {
    if (action === "delete" && pp.guardDelete === false) continue;
    if (action === "modify" && pp.guardModify === false) continue;

    const protectedRoot = resolve(expandTilde(pp.path));
    const rel = relative(protectedRoot, resolvedPath);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return pp;
    }
  }

  return undefined;
}

export interface SomaBashCommandParseResult {
  command: string;
  targetPaths: string[];
}

export function parseBashDestructivePaths(command: string, cwd: string): SomaBashCommandParseResult {
  const tokens = tokenize(command);
  if (tokens.length === 0) return { command: "", targetPaths: [] };

  let cmdIndex = 0;
  while (cmdIndex < tokens.length && isNonDestructivePrefix(tokens[cmdIndex])) {
    cmdIndex++;
  }

  if (cmdIndex >= tokens.length) return { command: "", targetPaths: [] };

  const mainCommand = tokens[cmdIndex];

  // Collect path arguments (non-flag tokens after the destructive command)
  const pathArgs: string[] = [];
  for (let i = cmdIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (isChainOperator(token)) break;
    if (isFlag(token)) continue;
    pathArgs.push(token);
  }

  const targetPaths: string[] = [];

  if (DESTRUCTIVE_COMMANDS.has(mainCommand)) {
    for (const arg of pathArgs) {
      targetPaths.push(resolvePath(arg, cwd));
    }
    // Check for glob patterns
    if (targetPaths.length === 0) {
      // rm * or rm -rf * — check if cwd is under a protected path
      const globRegex = /\b(?:rm|rmdir|trash|trash-put|gtrash)\s+.*?(\*)\b/;
      const globMatch = globRegex.exec(command);
      if (globMatch) {
        targetPaths.push(cwd);
      }
    }
  } else if (DESTRUCTIVE_MOVE_COMMANDS.has(mainCommand)) {
    if (pathArgs.length >= 1) {
      targetPaths.push(resolvePath(pathArgs[0], cwd));
    }
  }

  return { command: mainCommand, targetPaths };
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
      matchedDescriptions.push(`${match.path} (${match.description})`);
    }
  }

  return {
    blocked: matchedPaths.length > 0,
    matchedPaths,
    matchedDescriptions,
  };
}
