import type { SomaAdapter, SomaContextBundle, SomaContextInput, SomaTask } from "../types";
import { renderAssistantCore, renderMemoryLayout, renderPolicyProjection, renderSkills } from "./shared";

function renderCodexPolicy(): string {
  return renderPolicyProjection("codex", ["Filesystem sandbox and approval model when Codex exposes it"], [
    "Assistant behavior instructions",
    "Verification reporting",
    "Private context handling",
  ]);
}

function renderInstructions(input: SomaContextInput): string {
  return [
    "# Soma Codex Context",
    "",
    "You are running inside Codex with Soma-projected assistant context.",
    "Treat Soma as the source of truth for personal assistant identity, telos, memory layout, skills, policy, and active ISA context.",
    "Treat Codex as the execution substrate. Keep substrate-specific behavior behind adapter boundaries.",
    "",
    renderAssistantCore(input),
    "",
    "## Operating Rules",
    "- Use the active ISA as the verification contract when present.",
    "- Read memory from the declared file layout before inventing persistent facts.",
    "- Keep personal context out of public templates unless explicitly requested.",
    "- Report verification performed and any substrate limitation encountered.",
  ].join("\n");
}

function renderHomeRules(input: SomaContextInput, somaHome: string): string {
  const contextLines = [
    "# Soma default availability",
    "",
    "Use Soma as the portable personal assistant context when the task involves identity, telos, ISA, skills, memory, policy, or assistant continuity.",
    `Soma source of truth: ${somaHome}`,
    "This Codex home projection is generated from Soma and should not become the source of truth.",
    "",
    renderAssistantCore(input),
    "",
    "## Codex Home Rules",
    "- Prefer the Soma source files for durable identity, telos, memory, and skill context.",
    "- Treat project-local `.codex/soma/` files as overlays on this home projection.",
    "- Keep substrate-specific behavior behind Codex adapter boundaries.",
    "- Record verification and any Codex-specific limitation in the task result.",
  ];

  const context = contextLines.join("\n");

  return [
    "# This file is parsed by Codex as Starlark permission rules.",
    "# Soma keeps it comment-only so it can mark the projection without changing permissions.",
    "# The actual assistant context lives in ~/.codex/skills/soma/SKILL.md and ~/.codex/memories/soma/.",
    "",
    ...context.split("\n").map((line) => (line === "" ? "#" : `# ${line}`)),
  ].join("\n");
}

function renderHomeSkill(input: SomaContextInput, somaHome: string): string {
  return [
    "---",
    "name: soma",
    "description: Use when work depends on portable personal assistant context, Soma identity, telos, ISA criteria, memory layout, skills, policy, or default assistant behavior across substrates.",
    "metadata:",
    "  short-description: Portable personal assistant context",
    "---",
    "",
    "# Soma",
    "",
    "Soma is the portable personal assistant core. It keeps assistant identity, principal context, telos, memory, skills, policy, and ISA semantics outside any one substrate.",
    "",
    `Source of truth: ${somaHome}`,
    "",
    "## Use",
    "",
    "- Treat `~/.codex/rules/soma.rules` as a parse-safe manifest marker, not as natural-language model context.",
    "- Read `~/.codex/memories/soma/profile.md` for the current projected assistant profile.",
    "- Read `~/.codex/memories/soma/pai-imports.md` when the task needs detailed migrated PAI identity, voice, relationship, telos, or decision-context material.",
    "- Read `~/.codex/memories/soma/memory-layout.md` before using persistent memory.",
    "- Treat project-local `.codex/soma/` context as an overlay.",
    "",
    "## Current Projection",
    "",
    renderAssistantCore(input),
  ].join("\n");
}

function renderPaiImportIndex(somaHome: string): string {
  const importRoot = `${somaHome}/profile/imports/claude`;

  return [
    "# Soma PAI Import Index",
    "",
    "The projected profile is intentionally concise. Detailed migrated PAI source snapshots remain in Soma and should be read when the task depends on personal identity, assistant voice, telos, values, goals, strategies, or decision context.",
    "",
    "## Source Root",
    "",
    importRoot,
    "",
    "## Read For Detail",
    "",
    `- Principal identity: ${importRoot}/PRINCIPAL_IDENTITY.md`,
    `- Ivy assistant identity and voice: ${importRoot}/DA_IDENTITY.md`,
    `- Mission: ${importRoot}/TELOS/MISSION.md`,
    `- Goals: ${importRoot}/TELOS/GOALS.md`,
    `- Strategies: ${importRoot}/TELOS/STRATEGIES.md`,
    `- Beliefs and values: ${importRoot}/TELOS/BELIEFS.md`,
    "",
    "## Use Rule",
    "",
    "Use `profile.md` for fast orientation. Read the imported source files before making durable claims about Jens-Christian, Ivy, values, goals, priorities, or preferred collaboration style.",
  ].join("\n");
}

export function buildCodexContext(input: SomaContextInput): SomaContextBundle {
  const instructions = renderInstructions(input);

  return {
    substrate: "codex",
    instructions,
    files: [
      {
        path: ".codex/soma/context.md",
        content: instructions,
      },
      {
        path: ".codex/soma/memory-layout.md",
        content: renderMemoryLayout(input),
      },
      {
        path: ".codex/soma/skills.md",
        content: renderSkills(input),
      },
      {
        path: ".codex/soma/policy.md",
        content: renderCodexPolicy(),
      },
    ],
  };
}

export function buildCodexHomeContext(input: SomaContextInput, somaHome: string): SomaContextBundle {
  const instructions = renderHomeRules(input, somaHome);

  return {
    substrate: "codex",
    instructions,
    files: [
      {
        path: "rules/soma.rules",
        content: instructions,
      },
      {
        path: "skills/soma/SKILL.md",
        content: renderHomeSkill(input, somaHome),
      },
      {
        path: "memories/soma/profile.md",
        content: ["# Soma Profile Projection", "", renderAssistantCore(input)].join("\n"),
      },
      {
        path: "memories/soma/memory-layout.md",
        content: renderMemoryLayout(input),
      },
      {
        path: "memories/soma/pai-imports.md",
        content: renderPaiImportIndex(somaHome),
      },
      {
        path: "memories/soma/skills.md",
        content: renderSkills(input),
      },
      {
        path: "memories/soma/policy.md",
        content: renderCodexPolicy(),
      },
    ],
  };
}

export const codexAdapter: SomaAdapter = {
  name: "codex",
  detect() {
    return Promise.resolve(Boolean(process.env.CODEX_SANDBOX ?? process.env.CODEX_HOME));
  },
  buildContext(input) {
    return Promise.resolve(buildCodexContext(input));
  },
  run(task: SomaTask) {
    return Promise.resolve({
      taskId: task.id,
      substrate: "codex",
      status: "failed",
      summary: "Codex execution is not implemented yet; use buildContext() to generate the substrate bundle.",
    });
  },
};
