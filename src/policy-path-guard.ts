import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { isInsidePath } from "./path-utils";
import type { SomaProtectedPath } from "./types";

// ── Default Protected Paths ──
// Paths that should never be destructively modified or deleted by an LLM tool.
// These are Soma's opinionated defaults; operators can override or extend via
// `protectedPaths` in SomaPolicyCheckOptions.

/**
 * Subpaths under `~/.soma` where `modify` is permitted. Exported so the
 * policy.ts root-protection wrapper and the Pi.dev path-guard extension
 * renderer share a single source of truth. Delete remains blocked everywhere
 * under the Soma home (allowedSubpaths is modify-only). See #79.
 */
export const SOMA_HOME_ALLOWED_MODIFY_SUBPATHS: readonly string[] = Object.freeze(["isa", "memory"]);

/**
 * Subpaths under `~/.claude` where `modify` is permitted (working memory and
 * legacy PAI memory layouts). See #79.
 */
export const CLAUDE_HOME_ALLOWED_MODIFY_SUBPATHS: readonly string[] = Object.freeze(["memory", "memories", "PAI/MEMORY"]);

/**
 * Subpaths under `~/.pi` where `modify` is permitted (agent working memory).
 * See #79.
 */
export const PI_HOME_ALLOWED_MODIFY_SUBPATHS: readonly string[] = Object.freeze(["agent/memory"]);

export const SOMA_DEFAULT_PROTECTED_PATHS: readonly SomaProtectedPath[] = Object.freeze([
  // ~/.soma is the Soma portable home. Modify-guarded by default to keep the
  // profile and other private roots safe, but ISA + memory subtrees are the
  // assistant's working surface and must remain writable. Delete remains
  // blocked everywhere under ~/.soma.
  { path: "~/.soma", description: "Soma portable assistant home", allowedSubpaths: [...SOMA_HOME_ALLOWED_MODIFY_SUBPATHS] },
  // Claude Code / PAI home — same shape: protect the root, allow legitimate
  // memory writes (memory/, memories/, PAI/MEMORY/).
  { path: "~/.claude", description: "Claude Code / PAI home", allowedSubpaths: [...CLAUDE_HOME_ALLOWED_MODIFY_SUBPATHS] },
  // Pi.dev home — only the agent's memory subtree is a known write target.
  { path: "~/.pi", description: "Pi.dev home", allowedSubpaths: [...PI_HOME_ALLOWED_MODIFY_SUBPATHS] },
  { path: "~/.config/cortex", description: "Cortex operator config" },
  { path: "~/.config/metafactory", description: "Metafactory ecosystem config" },
  { path: "~/.config/k", description: "kai-launcher config" },
].map((protectedPath) => Object.freeze(protectedPath)));

// ── Destructive Bash Command Detection ──

export const DESTRUCTIVE_COMMANDS = new Set(["rm", "rmdir", "trash", "trash-put", "gtrash"]);

export const DESTRUCTIVE_MOVE_COMMANDS = new Set(["mv"]);

const DESTRUCTIVE_WRITE_COMMANDS = new Set(["cp", "dd", "tee"]);

export const NON_DESTRUCTIVE_PREFIXES = new Set(["sudo", "bun", "node", "npx", "bunx", "time", "nice", "exec", "env", "nohup", "command"]);

const SHELL_WRAPPER_COMMANDS = new Set(["bash", "sh", "zsh"]);
const REPARSE_WRAPPER_COMMANDS = new Set(["eval"]);
const XARGS_COMMANDS = new Set(["xargs"]);

function cleanToken(token: string): string {
  let cleaned = token;
  if (cleaned.startsWith("$(")) {
    cleaned = cleaned.slice(2);
    if (cleaned.endsWith(")")) cleaned = cleaned.slice(0, -1);
  }
  if (cleaned.startsWith("`")) {
    cleaned = cleaned.slice(1);
    if (cleaned.endsWith("`")) cleaned = cleaned.slice(0, -1);
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
    const token = cleanToken(current);
    if (token.length > 0) tokens.push(token);
    current = "";
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];

    if (quote) {
      if (char === "\\" && quote !== "'" && i + 1 < command.length) {
        current += next;
        i++;
      } else if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\\" && i + 1 < command.length) {
      current += next;
      i++;
      continue;
    }

    if (char === "\u0022" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "\n" || char === "\r") {
      pushCurrent();
      tokens.push(";");
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

    if (char === ">") {
      pushCurrent();
      tokens.push(next === ">" ? ">>" : ">");
      if (next === ">") i++;
      continue;
    }

    if (char === "<") {
      pushCurrent();
      if (next === "<" && command[i + 2] === "<") {
        tokens.push("<<<");
        i += 2;
      } else if (next === "<") {
        tokens.push("<<");
        i++;
      } else {
        tokens.push("<");
      }
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

export function resolvePath(token: string, cwd: string): string {
  const expanded = expandTilde(token);
  return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}

function findProtectedPath(resolvedPath: string, protectedPaths: readonly SomaProtectedPath[], action: "delete" | "modify", realScopeCache: Map<string, string>, protectedRootCache: Map<string, string>): SomaProtectedPath | undefined {
  const realResolvedPath = realScopePath(resolvedPath, realScopeCache);
  for (const pp of protectedPaths) {
    if (action === "delete" && pp.guardDelete === false) continue;
    if (action === "modify" && pp.guardModify === false) continue;

    const protectedRoot = realProtectedRoot(resolve(expandTilde(pp.path)), realScopeCache, protectedRootCache);
    if (!isInsidePath(realResolvedPath, protectedRoot)) continue;

    // allowedSubpaths only relaxes `modify` (writes/edits). Destructive
    // operations against any descendant of a protected root remain blocked
    // regardless of subpath — `rm -rf ~/.soma/memory` should still fail.
    // Unsafe subpath values (absolute, tilde-prefixed, or `..`-traversing)
    // are silently dropped to prevent escape from the protected root.
    if (action === "modify" && pp.allowedSubpaths && pp.allowedSubpaths.length > 0) {
      const insideAllowed = pp.allowedSubpaths.filter(isSafeAllowedSubpath).some((subpath) => {
        const allowedRoot = realProtectedRoot(resolve(protectedRoot, subpath), realScopeCache, protectedRootCache);
        // Defense in depth: re-verify the resolved allowed root stays inside
        // the protected root even after symlink resolution.
        if (!isInsidePath(allowedRoot, protectedRoot)) return false;
        return isInsidePath(realResolvedPath, allowedRoot);
      });
      if (insideAllowed) continue;
    }

    return pp;
  }

  return undefined;
}

/**
 * Return true iff `subpath` is a safe relative descendant of a protected
 * root: not absolute, no tilde expansion, no `..` traversal after
 * normalization, and non-empty. Defends `allowedSubpaths` (a public option)
 * against operators or callers passing values that would escape the
 * protected root and silently allow all modifies inside it.
 */
function isSafeAllowedSubpath(subpath: string): boolean {
  if (typeof subpath !== "string" || subpath.length === 0) return false;
  if (isAbsolute(subpath)) return false;
  if (subpath.startsWith("~")) return false;
  const normalized = normalize(subpath).replace(/\/+$/, "");
  if (normalized === "" || normalized === "." || normalized === "..") return false;
  if (normalized.startsWith("..")) return false;
  return true;
}

function realProtectedRoot(path: string, realScopeCache: Map<string, string>, protectedRootCache: Map<string, string>): string {
  const cached = protectedRootCache.get(path);
  if (cached) return cached;
  const realPath = realScopePath(path, realScopeCache);
  protectedRootCache.set(path, realPath);
  return realPath;
}

function realScopePath(path: string, realScopeCache: Map<string, string>): string {
  const cached = realScopeCache.get(path);
  if (cached) return cached;

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
    const realPath = suffix.length > 0 ? resolve(realCursor, ...suffix) : realCursor;
    realScopeCache.set(path, realPath);
    return realPath;
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

function redirectTargets(tokens: string[], cwd: string): string[] {
  const targets: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (token !== ">" && token !== ">>") continue;
    const target = tokens[i + 1];
    if (!target || isChainOperator(target)) continue;
    targets.push(resolvePath(target, cwd));
  }
  return targets;
}

function resolveGlobPath(token: string, cwd: string): string {
  if (!token.includes("*")) return resolvePath(token, cwd);
  const base = token.replace(/\/\*.*$/, "");
  return base ? resolvePath(base, cwd) : cwd;
}

const VALUE_TAKING_FLAGS = new Set(["-t", "--target-directory", "-S", "--suffix", "--trash-dir"]);

function targetDirectoryArg(tokens: string[], startIndex: number): string | undefined {
  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-t" || token === "--target-directory") return tokens[i + 1];
    if (token.startsWith("--target-directory=")) return token.slice("--target-directory=".length);
  }
  return undefined;
}

function pathArguments(tokens: string[], startIndex: number): string[] {
  const args: string[] = [];
  let parseFlags = true;
  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i];
    if (parseFlags && token === "--") {
      parseFlags = false;
      continue;
    }
    if (parseFlags && isFlag(token)) {
      if (VALUE_TAKING_FLAGS.has(token)) i++;
      continue;
    }
    if (token === ">" || token === ">>") {
      i++;
      continue;
    }
    args.push(token);
  }
  return args;
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
  const redirectedPaths = redirectTargets(tokens, cwd);

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
    const nestedIndex = tokens.findIndex((token, index) => {
      const nestedCommand = basename(token);
      return index > cmdIndex && (DESTRUCTIVE_COMMANDS.has(nestedCommand) || DESTRUCTIVE_MOVE_COMMANDS.has(nestedCommand) || DESTRUCTIVE_WRITE_COMMANDS.has(nestedCommand));
    });
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
    return { command: mainCommand, targetPaths: [...targetPaths, ...redirectedPaths] };
  }

  if (!DESTRUCTIVE_COMMANDS.has(mainCommand) && !DESTRUCTIVE_MOVE_COMMANDS.has(mainCommand) && !DESTRUCTIVE_WRITE_COMMANDS.has(mainCommand)) {
    return { command: mainCommand, targetPaths: redirectedPaths };
  }

  const pathArgs = pathArguments(tokens, cmdIndex + 1);

  if (DESTRUCTIVE_MOVE_COMMANDS.has(mainCommand)) {
    return {
      command: mainCommand,
      targetPaths: [...pathArgs.map((pathArg) => resolvePath(pathArg, cwd)), ...redirectedPaths],
    };
  }

  if (DESTRUCTIVE_WRITE_COMMANDS.has(mainCommand)) {
    if (mainCommand === "dd") {
      const output = tokens.find((token) => token.startsWith("of="));
      return {
        command: mainCommand,
        targetPaths: output ? [resolvePath(output.slice("of=".length), cwd), ...redirectedPaths] : redirectedPaths,
      };
    }
    if (mainCommand === "cp") {
      const targetDirectory = targetDirectoryArg(tokens, cmdIndex + 1);
      if (targetDirectory) {
        return {
          command: mainCommand,
          targetPaths: [resolvePath(targetDirectory, cwd), ...redirectedPaths],
        };
      }
    }
    const targets = mainCommand === "tee" ? pathArgs : pathArgs.slice(-1);
    return {
      command: mainCommand,
      targetPaths: [...targets.map((target) => resolvePath(target, cwd)), ...redirectedPaths],
    };
  }

  targetPaths.push(...pathArgs.map((token) => resolveGlobPath(token, cwd)));

  return { command: mainCommand, targetPaths: [...targetPaths, ...redirectedPaths] };
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
  const realScopeCache = new Map<string, string>();
  const protectedRootCache = new Map<string, string>();
  const matchedPaths: string[] = [];
  const matchedDescriptions: string[] = [];

  for (const target of options.targetPaths) {
    const resolvedTarget = resolvePath(target, options.cwd);
    const match = findProtectedPath(resolvedTarget, protectedPaths, options.action, realScopeCache, protectedRootCache);
    if (match) {
      matchedPaths.push(resolvedTarget);
      matchedDescriptions.push(match.description ? `${match.path} (${match.description})` : match.path);
    }
  }

  return {
    blocked: matchedPaths.length > 0,
    matchedPaths,
    matchedDescriptions,
  };
}
