import {
  DESTRUCTIVE_COMMANDS,
  DESTRUCTIVE_MOVE_COMMANDS,
  NON_DESTRUCTIVE_PREFIXES,
  SOMA_DEFAULT_PROTECTED_PATHS,
} from "../policy-path-guard";

/**
 * Render a pi.dev extension that guards against destructive operations on
 * protected paths (Soma home, PAI home, Pi home, etc.).
 *
 * The extension intercepts tool_call events for bash commands and blocks
 * destructive operations targeting protected directories. It also guards
 * write/edit tools targeting paths inside protected directories.
 *
 * SUBSTRATE-SPECIFIC: This renders pi.dev extension code. Other substrates
 * (Claude Code, Codex) get their own enforcement generators.
 */
export function renderPathGuardExtension(somaHome: string): string {
  return `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isAbsolute, relative, resolve } from "node:path";

const SOMA_HOME = ${JSON.stringify(somaHome)};
const PROTECTED_PATHS = ${JSON.stringify(SOMA_DEFAULT_PROTECTED_PATHS, null, 2)};
const DESTRUCTIVE_DELETE = new Set(${JSON.stringify(Array.from(DESTRUCTIVE_COMMANDS))});
const DESTRUCTIVE_MOVE = new Set(${JSON.stringify(Array.from(DESTRUCTIVE_MOVE_COMMANDS))});
const PREFIXES = new Set(${JSON.stringify(Array.from(NON_DESTRUCTIVE_PREFIXES))});
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh"]);
const REPARSE_WRAPPERS = new Set(["eval"]);

function expandTilde(path: string): string {
  const home = process.env.HOME || "/";
  if (path.startsWith("\${HOME}/")) return home + path.slice("\${HOME}".length);
  if (path.startsWith("$HOME/")) return home + path.slice("$HOME".length);
  if (path === "~") return home;
  if (path.startsWith("~/")) return home + path.slice(1);
  return path;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isProtected(target: string): { blocked: boolean; detail: string } {
  const resolved = resolve(expandTilde(target));
  for (const pp of PROTECTED_PATHS) {
    const root = resolve(expandTilde(pp.path));
    if (isInside(resolved, root)) {
      return { blocked: true, detail: target + " is under " + pp.path + " (" + pp.description + ")" };
    }
  }
  return { blocked: false, detail: "" };
}

function cleanToken(token: string): string {
  let cleaned = token;
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned.replace(/^[<>]+/, "").replace(/[<>]+$/, "");
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  function pushCurrent(): void {
    if (current.length === 0) return;
    tokens.push(cleanToken(current));
    current = "";
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];

    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\\s/.test(char)) {
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

function isChainOperator(token: string): boolean {
  return token === ";" || token === "&&" || token === "||" || token === "|";
}

function splitSegments(tokens: string[]): string[][] {
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

function skipPrefixes(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (PREFIXES.has(token) || /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(token)) {
      index++;
      continue;
    }
    break;
  }
  return index;
}

function resolveTarget(token: string, cwd: string): string {
  const expanded = expandTilde(token);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function shellPayloadIndex(tokens: string[], cmdIndex: number): number | undefined {
  for (let i = cmdIndex + 1; i < tokens.length; i++) {
    if (tokens[i] === "-c" || tokens[i] === "-lc") return i + 1 < tokens.length ? i + 1 : undefined;
  }
  return undefined;
}

function extractFromSegment(tokens: string[], cwd: string, depth: number): string[] {
  const cmdIndex = skipPrefixes(tokens);
  if (cmdIndex >= tokens.length) return [];
  const command = tokens[cmdIndex];

  if (depth < 4 && SHELL_WRAPPERS.has(command)) {
    const payloadIndex = shellPayloadIndex(tokens, cmdIndex);
    return payloadIndex === undefined ? [] : extractDestructiveTargets(tokens.slice(payloadIndex).join(" "), cwd, depth + 1);
  }

  if (depth < 4 && REPARSE_WRAPPERS.has(command)) {
    return extractDestructiveTargets(tokens.slice(cmdIndex + 1).join(" "), cwd, depth + 1);
  }

  if (depth < 4 && command === "xargs") {
    const nestedIndex = tokens.findIndex((token, index) => index > cmdIndex && (DESTRUCTIVE_DELETE.has(token) || DESTRUCTIVE_MOVE.has(token)));
    return nestedIndex === -1 ? [] : extractFromSegment(tokens.slice(nestedIndex), cwd, depth + 1);
  }

  if (command === "find") {
    if (!tokens.slice(cmdIndex + 1).some((token) => token === "-delete" || token === "-exec")) return [];
    const targets: string[] = [];
    for (let i = cmdIndex + 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith("-")) break;
      targets.push(resolveTarget(token, cwd));
    }
    return targets;
  }

  const isDelete = DESTRUCTIVE_DELETE.has(command);
  const isMove = DESTRUCTIVE_MOVE.has(command);
  if (!isDelete && !isMove) return [];

  const targets: string[] = [];
  for (let i = cmdIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) continue;
    if (isMove) {
      targets.push(resolveTarget(token, cwd));
      break;
    }
    targets.push(token.includes("*") ? cwd : resolveTarget(token, cwd));
  }
  return targets;
}

function extractDestructiveTargets(command: string, cwd: string, depth = 0): string[] {
  return splitSegments(tokenize(command)).flatMap((segment) => extractFromSegment(segment, cwd, depth));
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" || event.toolName === "Bash") {
      const input = (event as { input?: { command?: string; timeout?: number } }).input;
      if (!input?.command) return;

      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const targets = extractDestructiveTargets(input.command, cwd);
      const blockedTargets: string[] = [];
      const blockDetails: string[] = [];

      for (const target of targets) {
        const result = isProtected(target);
        if (result.blocked) {
          blockedTargets.push(target);
          blockDetails.push(result.detail);
        }
      }

      if (blockedTargets.length > 0) {
        const detail = blockDetails.join("; ");
        const msg = "Soma path guard blocked destructive command: " + input.command + ". Protected: " + detail + ".";
        ctx.ui?.notify?.(msg, "error");
        return { block: true, reason: msg };
      }
    }

    if (event.toolName === "write" || event.toolName === "Write" ||
        event.toolName === "edit" || event.toolName === "Edit") {
      const input = (event as { input?: { file_path?: string; path?: string } }).input;
      const targetPath = input?.file_path ?? input?.path;
      if (!targetPath) return;

      const result = isProtected(targetPath);
      if (result.blocked) {
        const msg = "Soma path guard blocked write to protected path: " + result.detail + ".";
        ctx.ui?.notify?.(msg, "error");
        return { block: true, reason: msg };
      }
    }
  });
}
`;
}
