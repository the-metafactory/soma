import type { SomaAdapter, Projection, ProjectionInput, SomaTask } from "../types";
import { renderAssistantCore, renderMemoryLayout, renderPolicyProjection, renderSkills } from "./shared";
import { activeIsaBundleFile } from "../adapter-active-isa";

function renderInstructions(input: ProjectionInput): string {
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

function renderClaudeMd(input: ProjectionInput): string {
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

export function projectClaudeCode(input: ProjectionInput): Projection {
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
      // Active-ISA projection (#37). OMITTED when no active ISA — AC-2.
      // Note: project bundle uses `.claude/soma/active-isa.md` (workspace
      // overlay path), not `PAI/ACTIVE_ISA.md` (the home path used by
      // projectClaudeCodeHome + activeIsaProjectionPath).
      ...(input.activeIsa
        ? [{ path: ".claude/soma/active-isa.md", content: activeIsaBundleFile("claude-code", input.activeIsa)[0].content }]
        : []),
    ],
  };
}

function renderClaudeRulesReadme(): string {
  return [
    "# Soma Claude Code Projection",
    "",
    "This directory is **generated** by Soma. The portable source of truth is `~/.soma/`.",
    "",
    "Claude Code auto-discovers files under `.claude/rules/` and loads them as session context. Per the architectural pivot recorded in soma issue #64, Soma writes here instead of relying on home-directory `@`-imports from `~/.claude/CLAUDE.md` (which fail silently in some Claude Code versions).",
    "",
    "## What lives here",
    "",
    "- `CONTEXT.md` — assistant identity, principal, telos, operating rules",
    "- `PROFILE.md` — assistant + principal profile detail",
    "- `TELOS.md` — mission, goals, principles, commitments",
    "- `MEMORY_LAYOUT.md` — pointers into the soma memory tree",
    "- `SKILLS.md` — discovered Soma skills",
    "- `POLICY.md` — substrate policy projection",
    "- `ACTIVE_ISA.md` — current active ISA (omitted when none set)",
    "",
    "## Lifecycle",
    "",
    "- Re-projected by `soma install claude-code`.",
    "- Removed cleanly by `soma uninstall claude-code` (untouched: anything outside `soma/`).",
    "- Idempotent: re-running install with no source changes writes the same bytes.",
    "",
    "## Do not edit by hand",
    "",
    "Manual edits are overwritten on the next install. Author changes in `~/.soma/` and re-project.",
  ].join("\n");
}

function renderClaudeRulesContext(input: ProjectionInput): string {
  return [
    "# Soma Context (Claude Code)",
    "",
    renderInstructions(input),
  ].join("\n");
}

function renderClaudeProfile(input: ProjectionInput): string {
  return ["# Soma Profile Projection", "", renderAssistantCore(input)].join("\n");
}

function renderClaudeTelos(input: ProjectionInput): string {
  const t = input.profile.telos;
  return [
    "# Soma Telos Projection",
    "",
    t.mission ? `## Mission\n\n${t.mission}` : "## Mission\n\nNone declared.",
    "",
    "## Goals",
    "",
    t.goals.length === 0 ? "- None declared" : t.goals.map((g) => `- ${g}`).join("\n"),
    "",
    "## Principles",
    "",
    t.principles.length === 0 ? "- None declared" : t.principles.map((p) => `- ${p}`).join("\n"),
    "",
    "## Commitments",
    "",
    t.commitments.length === 0 ? "- None declared" : t.commitments.map((c) => `- ${c}`).join("\n"),
  ].join("\n");
}

function renderClaudePolicy(): string {
  return renderPolicyProjection(
    "claude-code",
    ["Hooks when installed (deferred to follow-up)", "Claude Code permission prompts"],
    [
      "Prompt-level behavior constraints",
      "Verification reporting when hooks are absent",
      "Treat the active ISA as the verification contract",
    ],
  );
}

/**
 * Single source of truth for the Claude Code rules/soma/ file set
 * (sage r1: planner + writer used to drift). The planner imports this
 * constant; the writer assembles content for each path via the
 * accessor map below. Adding a file = update the map AND this array.
 */
export const CLAUDE_CODE_RULES_FILES = [
  "rules/soma/README.md",
  "rules/soma/CONTEXT.md",
  "rules/soma/PROFILE.md",
  "rules/soma/TELOS.md",
  "rules/soma/MEMORY_LAYOUT.md",
  "rules/soma/SKILLS.md",
  "rules/soma/POLICY.md",
  "rules/soma/ACTIVE_ISA.md",
] as const;

const CLAUDE_RULES_CONTENT_BUILDERS: Record<
  Exclude<(typeof CLAUDE_CODE_RULES_FILES)[number], "rules/soma/ACTIVE_ISA.md">,
  (input: ProjectionInput) => string
> = {
  "rules/soma/README.md": () => renderClaudeRulesReadme(),
  "rules/soma/CONTEXT.md": (input) => renderClaudeRulesContext(input),
  "rules/soma/PROFILE.md": (input) => renderClaudeProfile(input),
  "rules/soma/TELOS.md": (input) => renderClaudeTelos(input),
  "rules/soma/MEMORY_LAYOUT.md": (input) => renderMemoryLayout(input),
  "rules/soma/SKILLS.md": (input) => renderSkills(input),
  "rules/soma/POLICY.md": () => renderClaudePolicy(),
};

/**
 * Claude Code home projection (#29). Writes the Soma context under
 * `.claude/rules/soma/` so Claude Code's auto-discovery picks it up
 * without depending on home `@`-import behavior (see soma#64 for the
 * architectural rationale).
 *
 * The bundle is shape-stable: the same input always produces the same
 * file set in the same order, so a second install with unchanged
 * input writes byte-identical content (AC-4 idempotency).
 *
 * Hook scripts and settings patching are installed by the Claude Code
 * install spec postProjection step, not by this pure projection bundle.
 * Active CLAUDE.md modification remains dropped by the #64 pivot.
 */
export function projectClaudeCodeHome(input: ProjectionInput): Projection {
  const skeleton = (Object.keys(CLAUDE_RULES_CONTENT_BUILDERS) as (keyof typeof CLAUDE_RULES_CONTENT_BUILDERS)[]).map((path) => ({
    path,
    content: CLAUDE_RULES_CONTENT_BUILDERS[path](input),
  }));
  return {
    substrate: "claude-code",
    instructions: renderInstructions(input),
    files: [
      ...skeleton,
      // Active ISA — omitted when no active ISA set (preserves #37 AC-2).
      ...activeIsaBundleFile("claude-code", input.activeIsa),
    ],
  };
}

export const claudeCodeAdapter: SomaAdapter = {
  name: "claude-code",
  detect() {
    return Promise.resolve(Boolean(process.env.CLAUDE_CODE ?? process.env.CLAUDECODE));
  },
  project(input) {
    return Promise.resolve(projectClaudeCode(input));
  },
  run(task: SomaTask) {
    return Promise.resolve({
      taskId: task.id,
      substrate: "claude-code",
      status: "failed",
      summary: "Claude Code execution is not implemented yet; use project() to generate the context projection.",
    });
  },
};
