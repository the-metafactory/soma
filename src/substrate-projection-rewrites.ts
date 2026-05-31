import { normalizeSkillContent } from "./pai-pack-normalizer";
import type { SubstrateId } from "./types";

const CLAUDE_HOME = "~/" + ".claude";
const SOMA_HOME = "~/" + ".soma";
const RELATIVE_CLAUDE_HOME = "." + "claude";
const CLAUDE_ONLY_LINE = /\b(?:ISASync\.hook\.ts|ISA[- ]Tool(?![A-Za-z]))/i;

function replaceAllLiteral(content: string, from: string, to: string): string {
  return content.split(from).join(to);
}

function rewriteKnownMemoryRoots(content: string): string {
  let next = content;
  // Run these first because the pack normalizer intentionally maps
  // unknown Claude memory roots to an UNMAPPED placeholder. Projection
  // consumers need legacy memory bootstrap refs to land on Soma memory.
  for (const root of [
    `${CLAUDE_HOME}/PAI/MEMORY/`,
    `${CLAUDE_HOME}/memory/`,
    `${CLAUDE_HOME}/memories/`,
    `${RELATIVE_CLAUDE_HOME}/PAI/MEMORY/`,
    `${RELATIVE_CLAUDE_HOME}/memory/`,
    `${RELATIVE_CLAUDE_HOME}/memories/`,
    `./${RELATIVE_CLAUDE_HOME}/PAI/MEMORY/`,
    `./${RELATIVE_CLAUDE_HOME}/memory/`,
    `./${RELATIVE_CLAUDE_HOME}/memories/`,
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
