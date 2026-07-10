import type { SomaAdapter, Projection, ProjectionInput } from "../types";
import { buildPortableSkillFiles, renderAssistantCore, renderMemoryLayout, renderPolicyProjection, renderSkills, withProvenance } from "./shared";
import { activeVsaBundleFile } from "../adapter-active-vsa";

// Every `skills/<name>/` file claude-code's home projection emits is a portable
// bundled skill (the-algorithm, Memory, …). Unlike codex/grok, claude-code has
// no dedicated `skills/soma/` home skill and no static the-algorithm render, so
// the whole `skills/` surface is dynamic — this predicate serves both the
// codeOnly filter and the install manifest that round-trips them on uninstall.
// `skills/VSA/` is excluded: the loop never emits it (projectableSkills filters
// VSA) and it has its own managed installer + `skills/VSA` uninstall entry, so
// the manifest/codeOnly filter must not treat it as a dynamic bundled skill.
export function isClaudeCodeSkillProjectionPath(path: string): boolean {
  return path.startsWith("skills/") && !path.startsWith("skills/VSA/");
}

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
    "- Use the active VSA as the verification contract.",
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
      // Active-VSA projection (#37). OMITTED when no active VSA — AC-2.
      // Note: project bundle uses `.claude/soma/active-vsa.md` (workspace
      // overlay path), not `PAI/ACTIVE_VSA.md` (the home path used by
      // projectClaudeCodeHome + activeVsaProjectionPath).
      ...(input.activeVsa
        ? [{ path: ".claude/soma/active-vsa.md", content: activeVsaBundleFile("claude-code", input.activeVsa)[0].content }]
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
    "- `CONTEXT.md` — assistant identity, principal, purpose, operating rules",
    "- `PROFILE.md` — assistant + principal profile detail",
    "- `PURPOSE.md` — mission, goals, principles, commitments",
    "- `MEMORY_LAYOUT.md` — pointers into the soma memory tree",
    "- `SKILLS.md` — discovered Soma skills",
    "- `POLICY.md` — substrate policy projection",
    "- `ACTIVE_VSA.md` — current active VSA (omitted when none set)",
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

function renderClaudePurpose(input: ProjectionInput): string {
  const t = input.profile.purpose;
  return [
    "# Soma Purpose Projection",
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
      "Treat the active VSA as the verification contract",
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
  "rules/soma/PURPOSE.md",
  "rules/soma/MEMORY_LAYOUT.md",
  "rules/soma/SKILLS.md",
  "rules/soma/POLICY.md",
  "rules/soma/ACTIVE_VSA.md",
  // Memory index (M4). Conditional like ACTIVE_VSA — omitted when memory is
  // disabled or no index exists — so it is declared here (for the planner /
  // doctor / owned-subtree reconcile) but excluded from the always-on builders
  // map below and appended by memoryIndexBundleFile.
  "rules/soma/MEMORY.md",
] as const;

// The conditionally-projected rules files (ACTIVE_VSA + MEMORY): both are omitted
// when their source is absent, so neither has an always-on content builder.
type ConditionalRulesFile = "rules/soma/ACTIVE_VSA.md" | "rules/soma/MEMORY.md";

const CLAUDE_RULES_CONTENT_BUILDERS: Record<
  Exclude<(typeof CLAUDE_CODE_RULES_FILES)[number], ConditionalRulesFile>,
  (input: ProjectionInput) => string
> = {
  "rules/soma/README.md": () => renderClaudeRulesReadme(),
  "rules/soma/CONTEXT.md": (input) => renderClaudeRulesContext(input),
  "rules/soma/PROFILE.md": (input) => renderClaudeProfile(input),
  "rules/soma/PURPOSE.md": (input) => renderClaudePurpose(input),
  "rules/soma/MEMORY_LAYOUT.md": (input) => renderMemoryLayout(input),
  "rules/soma/SKILLS.md": (input) => renderSkills(input),
  "rules/soma/POLICY.md": () => renderClaudePolicy(),
};

/**
 * The always-loaded memory index file (M4), or `[]` when no memory index is set.
 * Content is the VERBATIM rendered `memory/INDEX.md` — no provenance header (like
 * ACTIVE_VSA, it is derived content, and wrapping it would diverge from the stored
 * bytes) and no wall clock (ages were baked at index rebuild time, AC-4). The file
 * is `rules/soma/MEMORY.md`; `MEMORY_LAYOUT.md` is a separate, untouched file.
 */
export function memoryIndexBundleFile(input: ProjectionInput): { path: string; content: string }[] {
  const indexContent = input.memory?.indexContent;
  if (indexContent === undefined || indexContent.trim().length === 0) return [];
  return [{ path: "rules/soma/MEMORY.md", content: indexContent }];
}

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
  // Portable bundled skills project as invocable dirs under `skills/<name>/`,
  // the dir Claude Code auto-discovers, so `the-algorithm`/`Memory` are present
  // for `Skill(...)` invocation via install — making the manual symlink
  // redundant once a fresh session confirms invocation (not verified here; this
  // is install-side file projection, not proof of end-to-end skill loading). VSA is
  // excluded (its dedicated edit-preserving installer owns it). Content takes
  // the default substrate rewrite (Claude memory roots stay, Claude-only lines
  // kept), same shape as codex/grok. The `skills/` dir is SHARED (principal-authored + PAI-migrated
  // skills), so it is NOT an owned subtree; removals round-trip via the install
  // manifest (installClaudeCodeHomeProjection), not the owned-subtree reconcile.
  const portableSkillFiles = buildPortableSkillFiles(input.profile.skills, input.bundledSkillNames, "claude-code");
  return {
    substrate: "claude-code",
    instructions: renderInstructions(input),
    files: [
      ...portableSkillFiles,
      // soma#370: each generated rules/soma skeleton file carries a byte-stable
      // provenance header so `soma doctor` can tell a managed projection from a
      // hand-replaced one. The header has no timestamp, preserving AC-4
      // byte-idempotency. The active-vsa file is deliberately excluded: it is a
      // byte-portable cross-substrate artifact (adapter-active-vsa AC-4) with
      // its own leading frontmatter, so a claude-only header would break both.
      ...skeleton.map((file) => ({ ...file, content: withProvenance("claude-code", file.content) })),
      // Active VSA — omitted when no active VSA set (preserves #37 AC-2).
      ...activeVsaBundleFile("claude-code", input.activeVsa),
      // Memory index (M4) — omitted when memory disabled / no index. Verbatim bytes.
      ...memoryIndexBundleFile(input),
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
};
