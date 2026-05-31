import { normalizeSkillContent } from "./pai-pack-normalizer";
import type { SubstrateId } from "./types";

const CLAUDE_HOME = "~/" + ".claude";
const SOMA_HOME = "~/" + ".soma";
const RELATIVE_CLAUDE_HOME = "." + "claude";
const MEMORY_ROOT_PREFIXES = [CLAUDE_HOME, `./${RELATIVE_CLAUDE_HOME}`, RELATIVE_CLAUDE_HOME] as const;
const MEMORY_ROOT_SUFFIXES = ["PAI/MEMORY", "memory", "memories"] as const;
const CLAUDE_ONLY_LINE = /\b(?:ISASync\.hook\.ts|ISA[- ]Tool(?![A-Za-z]))/i;

function replaceAllLiteral(content: string, from: string, to: string): string {
  return content.split(from).join(to);
}

function rewriteKnownMemoryRoots(content: string): string {
  let next = content;
  // Run these first because the pack normalizer intentionally maps
  // unknown Claude memory roots to an UNMAPPED placeholder. Projection
  // consumers need legacy memory bootstrap refs to land on Soma memory.
  for (const prefix of MEMORY_ROOT_PREFIXES) {
    for (const suffix of MEMORY_ROOT_SUFFIXES) {
      next = replaceAllLiteral(next, `${prefix}/${suffix}/`, `${SOMA_HOME}/memory/`);
      next = replaceAllLiteral(next, `${prefix}/${suffix}`, `${SOMA_HOME}/memory`);
    }
  }
  return next;
}

function stripClaudeOnlyInstructionLines(content: string): string {
  return content
    .split("\n")
    .filter((line) => !CLAUDE_ONLY_LINE.test(line))
    .join("\n");
}

function isMarkdownInstructionFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === "skill.md" || lower.endsWith(".md");
}

export function rewriteSubstrateProjectionContent(input: {
  substrate: SubstrateId;
  path: string;
  content: string;
}): string {
  if (input.substrate === "claude-code") return input.content;

  const withoutKnownMemoryRoots = rewriteKnownMemoryRoots(input.content);
  const withoutClaudeOnlyLines = isMarkdownInstructionFile(input.path)
    ? stripClaudeOnlyInstructionLines(withoutKnownMemoryRoots)
    : withoutKnownMemoryRoots;
  return normalizeSkillContent(input.path, withoutClaudeOnlyLines).content;
}
