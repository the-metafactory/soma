import type { SomaAdapter, SomaContextBundle, SomaContextInput, SomaTask } from "../types";
import { renderAssistantCore, renderMemoryLayout, renderPolicyProjection, renderSkills } from "./shared";

function renderInstructions(input: SomaContextInput): string {
  return [
    "# Soma Claude Code Context",
    "",
    "You are running inside Claude Code with Soma-projected assistant context.",
    "Treat Soma as the source of truth. Treat CLAUDE.md, hooks, skills, agents, slash commands, and statusline entries as projections.",
    "",
    renderAssistantCore(input),
    "",
    "## Operating Rules",
    "- Use the active ISA as the verification contract.",
    "- Treat Claude Code hooks and skills as enhancements, not core storage requirements.",
    "- Keep Soma skills portable unless a capability is explicitly Claude-only.",
    "- Record any Claude-only behavior as an adapter limitation.",
  ].join("\n");
}

function renderClaudeMd(input: SomaContextInput): string {
  return [
    "# Claude Code Soma Projection",
    "",
    "This file is generated context for Claude Code. The portable source of truth is Soma.",
    "",
    "Read `.claude/soma/context.md`, `.claude/soma/memory-layout.md`, `.claude/soma/skills.md`, and `.claude/soma/policy.md` before acting as the Soma assistant.",
    "",
    input.prompt ? "## Current Prompt\n\n" + input.prompt : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderHooksPlan(): string {
  return [
    "# Soma Claude Code Hooks Plan",
    "",
    "Hooks are optional adapter enhancements. The core must still work without them.",
    "",
    "- PreToolUse: advisory policy check before risky tools.",
    "- PostToolUse: capture verification signals and changed artifacts.",
    "- Stop: suggest learning capture when task criteria changed.",
  ].join("\n");
}

export function buildClaudeCodeContext(input: SomaContextInput): SomaContextBundle {
  const instructions = renderInstructions(input);

  return {
    substrate: "claude-code",
    instructions,
    files: [
      {
        path: "CLAUDE.md",
        content: renderClaudeMd(input),
      },
      {
        path: ".claude/soma/context.md",
        content: instructions,
      },
      {
        path: ".claude/soma/memory-layout.md",
        content: renderMemoryLayout(input),
      },
      {
        path: ".claude/soma/skills.md",
        content: renderSkills(input),
      },
      {
        path: ".claude/soma/hooks.md",
        content: renderHooksPlan(),
      },
      {
        path: ".claude/soma/policy.md",
        content: renderPolicyProjection("claude-code", ["Hooks when installed", "Claude Code permission prompts"], [
          "Prompt-level behavior constraints",
          "Verification reporting when hooks are absent",
        ]),
      },
    ],
  };
}

export const claudeCodeAdapter: SomaAdapter = {
  name: "claude-code",
  detect() {
    return Promise.resolve(Boolean(process.env.CLAUDE_CODE ?? process.env.CLAUDECODE));
  },
  buildContext(input) {
    return Promise.resolve(buildClaudeCodeContext(input));
  },
  run(task: SomaTask) {
    return Promise.resolve({
      taskId: task.id,
      substrate: "claude-code",
      status: "failed",
      summary: "Claude Code execution is not implemented yet; use buildContext() to generate the context projection.",
    });
  },
};
