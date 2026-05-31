import { normalizeSkillContent } from "./pai-pack-normalizer";
import type { SubstrateId } from "./types";

const CLAUDE_HOME = "~/" + ".claude";
const SOMA_HOME = "~/" + ".soma";
const CLAUDE_ONLY_LINE = /\b(?:ISASync\.hook\.ts|ISA[- ]Tool)\b/i;

function replaceAllLiteral(content: string, from: string, to: string): string {
  return content.split(from).join(to);
}

function rewriteKnownMemoryRoots(content: string): string {
  let next = content;
  for (const root of [
    `${CLAUDE_HOME}/PAI/MEMORY/`,
    `${CLAUDE_HOME}/memory/`,
    `${CLAUDE_HOME}/memories/`,
    "." + "claude/PAI/MEMORY/",
    "." + "claude/memory/",
    "." + "claude/memories/",
    "./." + "claude/PAI/MEMORY/",
    "./." + "claude/memory/",
    "./." + "claude/memories/",
  ]) {
    next = replaceAllLiteral(next, root, `${SOMA_HOME}/memory/`);
  }
  return next;
}

function stripClaudeOnlyInstructionLines(content: string): string {
  return content
    .split("\n")
    .filter((line) => !CLAUDE_ONLY_LINE.test(line))
    .join("\n");
}

export function rewriteSubstrateProjectionContent(input: {
  substrate: SubstrateId;
  path: string;
  content: string;
}): string {
  if (input.substrate === "claude-code") return input.content;

  const withoutKnownMemoryRoots = rewriteKnownMemoryRoots(input.content);
  const withoutClaudeOnlyLines = stripClaudeOnlyInstructionLines(withoutKnownMemoryRoots);
  return normalizeSkillContent(input.path, withoutClaudeOnlyLines).content;
}
