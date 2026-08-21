import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Projection, ProjectionInput, SomaAdapter } from "../../types";
import { activeVsaBundleFile } from "../../adapter-active-vsa";
import {
  communicationContractFile,
  renderAssistantCore,
  renderMemoryLayout,
  renderPolicyProjection,
  renderSkills,
  renderSubstrateInstructions,
  SELF_HEALING_DOCTRINE_ADVISORY,
  withProvenance,
} from "../shared";
import { behaviorPolicyAdvisory } from "../../policy/behavior-policy";

/** The repo-CLI invocation every projected command uses — one definition,
 * interpolated by both the entry skill and the lifecycle projection, so a
 * path or runner change is a single edit. */
const DSH_SOMA_CLI = "cd $(cat ~/.dsh/skills/soma/soma-repo.txt) && bun run soma";

/**
 * DeepSeek Harness (DSH) adapter. DSH is a cordis-plugin coding agent that
 * auto-loads `$DSH_HOME/AGENTS.md` into every session and auto-discovers
 * `<name>/SKILL.md` skills under `~/.dsh/skills` (plus `~/.agents/skills` and
 * project `.dsh/skills`). Design: docs/dsh-substrate.md.
 *
 * Skill discovery is DSH-native (`dsh-skill-filesystem` advertises its own
 * catalog), so this adapter is a `loader` substrate in the soma#638 sense:
 * the home bundle emits the Soma entry skill + colocated reference files and
 * NO portable-skill copies and NO catalog — install links the curated
 * `~/.soma/skills` registry into `~/.dsh/skills` as symlinks instead
 * (claude-code is the precedent). The `the-algorithm` skill therefore arrives
 * by symlink too; unlike codex/grok there is no static override here, because
 * a real file would collide with the symlink install creates in the same slot.
 */

export function isDshSkillProjectionPath(path: string): boolean {
  return path.startsWith("skills/");
}

function renderDshPolicy(input: ProjectionInput): string {
  return renderPolicyProjection("dsh", ["Filesystem sandbox and approval model when DSH exposes it"], [
    "Assistant behavior instructions",
    "Verification reporting",
    "Private context handling",
    ...behaviorPolicyAdvisory(input.behavior),
    ...SELF_HEALING_DOCTRINE_ADVISORY,
  ]);
}

function renderInstructions(input: ProjectionInput): string {
  return renderSubstrateInstructions({ substrate: "DSH", runtimeLabel: "DeepSeek Harness" }, input);
}

/**
 * The auto-discovered `soma` entry skill. DSH parses `name`/`description`/
 * `whenToUse` frontmatter (its loader renders a name+description catalog and
 * loads the body on invocation), so this carries a `whenToUse` hint — the one
 * frontmatter key no other substrate's renderer emits, because no other
 * substrate's loader reads one.
 */
function renderDshEntrySkill(input: ProjectionInput, somaHome: string): string {
  return [
    "---",
    "name: soma",
    "description: Use when work depends on portable personal assistant context, Soma identity, purpose, VSA criteria, memory layout, skills, policy, or default assistant behavior across substrates.",
    "whenToUse: Work involving personal assistant identity, purpose, memory, skills, policy, VSA criteria, or assistant continuity.",
    "metadata:",
    "  short-description: Portable personal assistant context",
    "---",
    "",
    "# Soma",
    "",
    "Soma is the portable personal assistant core. It keeps assistant identity, principal context, purpose, memory, skills, policy, and VSA semantics outside any one substrate.",
    "",
    `Source of truth: ${somaHome}`,
    "",
    "## Use",
    "",
    "- Treat `~/.dsh/AGENTS.md` as the orientation pointer, not as the context itself.",
    "- Read `~/.dsh/skills/soma/memory-layout.md` before using persistent memory.",
    "- Read `~/.dsh/skills/soma/policy.md` for the enforceable/advisory policy projection.",
    "- Read `~/.dsh/skills/soma/communication.md`, when present, for how to communicate: patterns, banned phrases, reference codes, and aliases.",
    "- When present, read `~/.dsh/skills/soma/memory-index.md` for the durable memory INDEX (Tier-0 orientation). It is a snapshot written whenever the DSH bundle is projected (e.g. `soma install`) from the index at that moment, and only when durable notes exist — so it may be absent (no index yet) or lag the live store between projections.",
    "- Read `~/.dsh/skills/soma/startup-context.md` for lifecycle-generated active work and recent learning context when present.",
    "- Read `~/.dsh/skills/soma/lifecycle.md` for lifecycle refresh commands.",
    `- Use ${DSH_SOMA_CLI} memory recall --query "..." before making durable claims that may depend on prior knowledge, learning, relationship, work, or imported context. This is note-aware retrieval; \`soma memory search\` remains as a legacy line-grep fallback.`,
    "- Do not assume a global `soma` binary exists; use lifecycle commands or the `bun run soma` commands in `lifecycle.md`.",
    "- Other skills in this loader (`the-algorithm`, `Memory`, `orienteer`, …) are Soma's canonical registry skills, linked in by `soma install dsh`.",
    "",
    "## Current Projection",
    "",
    renderAssistantCore(input),
  ].join("\n");
}

function renderDshLifecycleProjection(somaHome: string): string {
  return [
    "# Soma Lifecycle Projection",
    "",
    "Soma lifecycle is the substrate-neutral session writeback surface.",
    "",
    "## Live Commands",
    "",
    "Run from the Soma repo when lifecycle state should be refreshed:",
    "",
    "- `" + DSH_SOMA_CLI + " lifecycle session-start --substrate dsh`",
    "- `" + DSH_SOMA_CLI + " lifecycle algorithm-updated --substrate dsh`",
    "- `" + DSH_SOMA_CLI + " lifecycle session-end --substrate dsh`",
    "- `" + DSH_SOMA_CLI + " memory recall --query \"...\"` (note-aware; `soma memory search` is the legacy line-grep fallback)",
    "- `" + DSH_SOMA_CLI + " memory digest --session <id> --body \"8-15 lines\"` when a manual correction or replacement digest is needed",
    "",
    "Do not use `command -v soma`; Soma is installed as a repo CLI, not a global binary.",
    "",
    "## Session Writeback",
    "",
    "DSH has no in-process Stop hook; session writeback runs through the Soma DSH host plugin (`integrations/dsh/soma-host` in the Soma repo), which shells `soma lifecycle session-start` on `agent/session-start` and `soma lifecycle session-end` when the agent first goes idle. Without the plugin, run the lifecycle commands manually per the list above.",
    "",
    "## Source Files",
    "",
    `- Algorithm work index: ${somaHome}/memory/STATE/algorithm-work-index.json`,
    `- Lifecycle event log: ${somaHome}/memory/STATE/events.jsonl`,
    `- Completed Algorithm learnings: ${somaHome}/memory/LEARNING/ALGORITHM/`,
    "",
    "## DSH Use",
    "",
    "Read `startup-context.md` at session start when available. It is a generated snapshot; refresh it with `session-start` when stale.",
  ].join("\n");
}

/**
 * Tier-0 durable memory INDEX (M4 parity with codex). OMITTED when no index
 * exists yet — same `input.memory.indexContent` contract as codex's
 * `codexMemoryIndexFile` and Claude's `memoryIndexBundleFile`.
 */
export function dshMemoryIndexFile(input: ProjectionInput): { path: string; content: string }[] {
  const indexContent = input.memory?.indexContent;
  if (indexContent === undefined || indexContent.trim().length === 0) return [];
  return [{ path: "skills/soma/memory-index.md", content: indexContent }];
}

/**
 * Workspace projection: `.dsh/soma/` context overlay for a repo whose DSH
 * session should read Soma context without a home install. Mirrors codex's
 * workspace bundle shape.
 */
export function projectDsh(input: ProjectionInput): Projection {
  const instructions = renderInstructions(input);

  return {
    substrate: "dsh",
    instructions,
    files: [
      {
        path: ".dsh/soma/context.md",
        content: instructions,
      },
      {
        path: ".dsh/soma/memory-layout.md",
        content: renderMemoryLayout(input),
      },
      {
        path: ".dsh/soma/skills.md",
        content: renderSkills(input),
      },
      {
        path: ".dsh/soma/policy.md",
        content: renderDshPolicy(input),
      },
      // Communication contract — omitted when the home has none. Verbatim bytes.
      ...communicationContractFile(input, ".dsh/soma/communication.md"),
    ],
  };
}

/**
 * Home projection into `~/.dsh/` (or a workspace `.dsh/` when install points
 * `substrateHome` there — DSH discovers `<projectRoot>/.dsh/skills` natively,
 * so `soma install dsh --workspace` targets `<cwd>/.dsh` directly, not a
 * `soma`-suffixed subdir).
 */
export function projectDshHome(input: ProjectionInput, somaHome: string, _homeDir?: string, _somaRepoPath = ""): Projection {
  return {
    substrate: "dsh",
    instructions: renderInstructions(input),
    files: [
      {
        // Frontmatter skill file: no provenance header (it would break
        // frontmatter parsing), same exclusion as codex/grok SKILL.md.
        path: "skills/soma/SKILL.md",
        content: renderDshEntrySkill(input, somaHome),
      },
      {
        path: "skills/soma/memory-layout.md",
        content: withProvenance("dsh", renderMemoryLayout(input)),
      },
      {
        path: "skills/soma/policy.md",
        content: withProvenance("dsh", renderDshPolicy(input)),
      },
      {
        path: "skills/soma/lifecycle.md",
        content: withProvenance("dsh", renderDshLifecycleProjection(somaHome)),
      },
      // Communication contract — omitted when the home has none. Verbatim bytes.
      ...communicationContractFile(input, "skills/soma/communication.md"),
      // Tier-0 durable memory INDEX. OMITTED when no index exists yet.
      ...dshMemoryIndexFile(input),
      // Active-VSA projection (#37). OMITTED when no active VSA — AC-2.
      ...activeVsaBundleFile("dsh", input.activeVsa),
    ],
  };
}

export const dshAdapter: SomaAdapter = {
  name: "dsh",
  detect() {
    return Promise.resolve(Boolean(process.env.DSH_HOME) || existsSync(join(homedir(), ".dsh")));
  },
  project(input) {
    return Promise.resolve(projectDsh(input));
  },
};
