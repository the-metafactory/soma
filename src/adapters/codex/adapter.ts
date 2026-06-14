import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SomaAdapter, Projection, ProjectionInput, SomaTask } from "../../types";
import { defaultSomaRepoPath } from "../../repo-path";
import { resolveBunExecutable } from "../../bun-probe";
import { readCodexHookAsset, renderCodexPolicyHook, renderCodexPolicyTargets } from "./hooks/assets";
import { renderFeedbackHookModule } from "../shared/feedback-helper";
import { projectableSkills, renderAssistantCore, renderMemoryLayout, renderPolicyProjection, renderSkills } from "../shared";
import { activeIsaBundleFile } from "../../adapter-active-isa";
import { somaPolicyPrivateMarkers } from "../../policy";
import { somaMemoryPrivateRoots, somaProjectionPrivateRoots } from "../../projection-private-roots";
import { defaultInboundContentSecurityConfig } from "../../inbound-security";
import { rewriteSubstrateProjectionContent } from "../../substrate-projection-rewrites";

/**
 * Compute the runtime config the soma-lifecycle.mjs hook reads at
 * startup from a colocated soma-lifecycle.config.json. Replaces the
 * previous install-time string-template in `renderCodexLifecycleHook`
 * (deleted in soma#73). bunPath stays in the config (not eliminated
 * via the shebang) because child spawns rely on a stable explicit
 * binary path for detached-survival on Bun/macOS.
 */
function codexLifecycleConfig(somaHome: string, homeDir?: string, somaRepoPath = defaultSomaRepoPath()): {
  somaHome: string;
  trustedSomaRepo: string;
  bunPath: string;
  privateRoots: string[];
  policyMarkers: string[];
  inboundSecurity: {
    untrustedRoots: string[];
    traceRoot: string;
  };
} {
  const home = resolve(homeDir ?? homedir());
  const privateRoots = [
    ...somaProjectionPrivateRoots({ homeDir, substrate: "codex" }),
    ...somaMemoryPrivateRoots({ homeDir, substrate: "codex" }),
    join(home, ".claude", "memory"),
    join(home, ".claude", "memories"),
    join(home, ".claude", "PAI", "MEMORY"),
  ].map((path) => resolve(path));
  const policyMarkers = somaPolicyPrivateMarkers(somaHome, homeDir, privateRoots);
  return {
    somaHome,
    trustedSomaRepo: somaRepoPath,
    bunPath: resolveBunExecutable(),
    privateRoots,
    policyMarkers,
    inboundSecurity: defaultInboundContentSecurityConfig({ somaHome }),
  };
}

function renderCodexPolicy(): string {
  return renderPolicyProjection("codex", ["Filesystem sandbox and approval model when Codex exposes it"], [
    "Assistant behavior instructions",
    "Verification reporting",
    "Private context handling",
  ]);
}

function renderInstructions(input: ProjectionInput): string {
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

function renderHomeRules(input: ProjectionInput, somaHome: string): string {
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

function renderHomeSkill(input: ProjectionInput, somaHome: string): string {
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
    "- Read `~/.codex/memories/soma/startup-context.md` for lifecycle-generated active work and recent learning context when present.",
    "- Read `~/.codex/memories/soma/lifecycle.md` for lifecycle refresh commands.",
    "- Use `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma memory search --query \"...\"` before making durable claims that may depend on prior knowledge, learning, relationship, work, or imported PAI context.",
    "- Use `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma memory promote --from-run <id> --store learning --title \"...\" --substrate codex` when verified Algorithm work should become durable recall.",
    "- Do not assume a global `soma` binary exists; use lifecycle hooks or the `bun run soma` commands in `lifecycle.md`.",
    "- Read `~/.codex/memories/soma/memory-layout.md` before using persistent memory.",
    "- Treat project-local `.codex/soma/` context as an overlay.",
    "",
    "## Current Projection",
    "",
    renderAssistantCore(input),
  ].join("\n");
}

function renderAlgorithmRenderingContract(): string {
  return [
    "---",
    "name: the-algorithm",
    'description: "Use when work should run through Soma Algorithm mode with seven-phase rendering, ISA criteria, verification, and learning capture."',
    "metadata:",
    "  short-description: Soma Algorithm rendering contract for Codex",
    "---",
    "",
    "# The Algorithm",
    "",
    "Use this skill whenever Soma classifies the prompt as ALGORITHM or the user explicitly asks for the Algorithm, ISA, ideal state, criteria, or verification-first work.",
    "",
    "## Execution Harness",
    "",
    "Start with `Workflows/RunAlgorithm.md`. That workflow is the executable Algorithm contract.",
    "",
    "When the Soma CLI is available, create or update a harness run with `bun run soma algorithm ...` before doing substantial work. The harness is mutable run state; the rendering contract below is only the Codex-visible phase display.",
    "",
    "Use `algorithm advance` as the deterministic phase gate. If it rejects a transition, fill the missing capabilities, plan steps, build changes, verification, or learning evidence before trying again.",
    "",
    "Capability selections are binding. Use registered capability names only; after selecting one, record invocation evidence with `algorithm invoke` or remove it with `algorithm remove-capability` before completion.",
    "",
    "## Codex Rendering Contract",
    "",
    "When entering ALGORITHM mode, emit these banners as you progress through each phase. Stream each phase header BEFORE producing the phase content.",
    "",
    "Use the phase names, emoji headers, Unicode bars, and phase numbering exactly:",
    "",
    "```text",
    "♻︎ Entering the PAI ALGORITHM… (Soma) ═════════════",
    "🗒️ TASK: <task summary>",
    "🎯 INTENT: <intent>",
    "",
    "━━━ 👁️ OBSERVE ━━━ 1/7",
    "━━━ 🧠 THINK ━━━ 2/7",
    "━━━ 📋 PLAN ━━━ 3/7",
    "━━━ 🛠️ BUILD ━━━ 4/7",
    "━━━ ⚡ EXECUTE ━━━ 5/7",
    "━━━ ✅ VERIFY ━━━ 6/7",
    "━━━ 📚 LEARN ━━━ 7/7",
    "━━━ 📃 SUMMARY ━━━ 7/7",
    "```",
    "",
    "## Phase Rules",
    "",
    "- OBSERVE: restate task, current state, ideal state, effort, criteria.",
    "- THINK: name assumptions, tradeoffs, and selected registered capabilities.",
    "- PLAN: list concrete steps mapped to criteria.",
    "- BUILD: describe artifacts being changed or created.",
    "- EXECUTE: run the work and keep status moving.",
    "- VERIFY: report each criterion and evidence.",
    "- LEARN: capture reusable decisions or lessons.",
    "- SUMMARY: close with outcome, verification, and any residual risk.",
    "",
    "## Canonical Example",
    "",
    "```text",
    "♻︎ Entering the PAI ALGORITHM… (Soma) ═════════════",
    "🗒️ TASK: Fix the Codex adapter projection",
    "🎯 INTENT: Make the change verifiable and substrate-portable",
    "",
    "━━━ 👁️ OBSERVE ━━━ 1/7",
    "Current state, goal, and criteria are identified.",
    "",
    "━━━ 🧠 THINK ━━━ 2/7",
    "The adapter boundary and filesystem projection constraints are considered.",
    "",
    "━━━ 📋 PLAN ━━━ 3/7",
    "P1 maps to C1, P2 maps to C2, verification follows implementation.",
    "",
    "━━━ 🛠️ BUILD ━━━ 4/7",
    "Files are edited in the smallest safe scope.",
    "",
    "━━━ ⚡ EXECUTE ━━━ 5/7",
    "Commands and checks are run.",
    "",
    "━━━ ✅ VERIFY ━━━ 6/7",
    "C1: passed — test output or source evidence.",
    "",
    "━━━ 📚 LEARN ━━━ 7/7",
    "The durable lesson is recorded when useful.",
    "",
    "━━━ 📃 SUMMARY ━━━ 7/7",
    "The task is complete, with verification evidence.",
    "```",
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

function renderLifecycleProjection(somaHome: string): string {
  return [
    "# Soma Lifecycle Projection",
    "",
    "Soma lifecycle is the substrate-neutral replacement for PAI's Claude hooks.",
    "",
    "## Live Commands",
    "",
    "Run from the Soma repo when lifecycle state should be refreshed:",
    "",
    "- `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma lifecycle session-start --substrate codex`",
    "- `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma lifecycle algorithm-updated --substrate codex`",
    "- `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma lifecycle session-end --substrate codex`",
    "- `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma algorithm new --prompt \"...\" --intent \"...\" --current-state \"...\" --goal \"...\" --criterion \"C1:...\"`",
    "- `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma memory search --query \"...\"`",
    "- `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma memory promote --from-run <id> --store learning --title \"...\" --substrate codex`",
    "",
    "Do not use `command -v soma`; Soma is installed as a repo CLI, not a global binary.",
    "",
    "## Source Files",
    "",
    `- Algorithm work index: ${somaHome}/memory/STATE/algorithm-work-index.json`,
    `- Lifecycle event log: ${somaHome}/memory/STATE/events.jsonl`,
    `- Completed Algorithm learnings: ${somaHome}/memory/LEARNING/ALGORITHM/`,
    "",
    "## Codex Use",
    "",
    "Read `startup-context.md` at session start when available. It is a generated snapshot; refresh it with `session-start` when stale.",
  ].join("\n");
}

function renderCodexHooksJson(): string {
  return `${JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume|clear",
            hooks: [
              {
                type: "command",
                command: "bun ~/.codex/hooks/soma-lifecycle.mjs session-start",
                timeout: 30,
                statusMessage: "Loading Soma lifecycle context",
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: "bun ~/.codex/hooks/soma-lifecycle.mjs prompt-submit",
                timeout: 30,
                statusMessage: "Classifying Soma Algorithm mode",
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: "Read|Edit|Write|MultiEdit|apply_patch|Bash|Shell|exec_command",
            hooks: [
              {
                type: "command",
                command: "bun ~/.codex/hooks/soma-lifecycle.mjs pre-tool-use",
                timeout: 30,
                statusMessage: "Checking Soma private context policy",
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "Edit|Write|apply_patch",
            hooks: [
              {
                type: "command",
                command: "bun ~/.codex/hooks/soma-lifecycle.mjs algorithm-updated",
                timeout: 30,
                statusMessage: "Refreshing Soma work index",
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "bun ~/.codex/hooks/soma-lifecycle.mjs session-end",
                timeout: 30,
                statusMessage: "Capturing Soma lifecycle learning",
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

function renderCodexFeedbackHook(): string {
  return renderFeedbackHookModule({
    functionName: "runSomaFeedbackCapture",
    leadingParameters: ["config"],
    promptParameter: "prompt",
    // soma#73: bunPath still lives in config (now in
    // soma-lifecycle.config.json rather than embedded by code-gen).
    // We tried process.execPath but discovered the feedback child
    // gets killed when the bun parent process.exit()s — keeping an
    // explicit known-good bun binary path is more reliable for
    // detached-survival on macOS/Bun than process.execPath.
    bunPathExpression: "config.bunPath",
    cwdExpression: "config.trustedSomaRepo",
    somaHomeExpression: "config.somaHome",
    substrate: "codex",
    source: "prompt-submit",
    failureComment: "Feedback capture is best-effort and must never break prompt classification.",
  });
}

interface CodexHookEntryExtension {
  importLine: string;
  fallbackStartMarker: string;
  fallbackEndMarker: string;
}

function applyCodexHookEntryExtensions(source: string, extensions: CodexHookEntryExtension[]): string {
  const importMarker = "// __SOMA_HOOK_MODULE_IMPORTS__";
  if (!source.includes(importMarker)) {
    throw new Error("Codex hook entry is missing the Soma hook module import marker.");
  }

  const imports = extensions.map((extension) => extension.importLine).join("\n");
  let rendered = source.replace(importMarker, imports);
  for (const extension of extensions) {
    const fallbackStart = rendered.indexOf(extension.fallbackStartMarker);
    const fallbackEnd = rendered.indexOf(extension.fallbackEndMarker);
    if (fallbackStart === -1 || fallbackEnd === -1 || fallbackEnd < fallbackStart) {
      throw new Error("Codex hook entry is missing a Soma hook extension fallback marker.");
    }
    rendered = `${rendered.slice(0, fallbackStart)}${rendered.slice(fallbackEnd + extension.fallbackEndMarker.length)}`;
  }
  return rendered;
}

function renderCodexHookEntry(): string {
  return applyCodexHookEntryExtensions(readCodexHookAsset("codex-hook-entry.mjs"), [
    {
      importLine: 'import { runSomaFeedbackCapture } from "./soma-feedback-capture.mjs";',
      fallbackStartMarker: "// __SOMA_PROMPT_SUBMIT_EXTENSION_START__",
      fallbackEndMarker: "// __SOMA_PROMPT_SUBMIT_EXTENSION_END__",
    },
  ]);
}

export function projectCodex(input: ProjectionInput): Projection {
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

export function projectCodexHome(input: ProjectionInput, somaHome: string, homeDir?: string, somaRepoPath = defaultSomaRepoPath()): Projection {
  const instructions = renderHomeRules(input, somaHome);
  const portableSkillFiles = projectableSkills(input.profile.skills).flatMap((skill) =>
    (skill.files ?? []).map((file) => ({
      path: `skills/${skill.name}/${file.path}`,
      content: rewriteSubstrateProjectionContent({
        substrate: "codex",
        path: file.path,
        content: file.content,
      }),
    })),
  );

  return {
    substrate: "codex",
    instructions,
    files: [
      {
        path: "rules/soma.rules",
        content: instructions,
      },
      {
        path: "hooks.json",
        content: renderCodexHooksJson(),
      },
      // soma#73: soma-lifecycle.mjs ships verbatim under `#!/usr/bin/env bun`;
      // install-time config lives in soma-lifecycle.config.json beside it.
      // executable:true is mandatory — Codex execs the hook via its
      // shebang (sage r2 finding on PR #75).
      {
        path: "hooks/soma-lifecycle.mjs",
        content: readCodexHookAsset("soma-lifecycle.mjs"),
        executable: true,
      },
      {
        path: "hooks/soma-lifecycle.config.json",
        content: `${JSON.stringify(codexLifecycleConfig(somaHome, homeDir, somaRepoPath), null, 2)}\n`,
      },
      {
        path: "hooks/codex-hook-entry.mjs",
        content: renderCodexHookEntry(),
      },
      {
        path: "hooks/soma-feedback-capture.mjs",
        content: renderCodexFeedbackHook(),
      },
      {
        path: "hooks/codex-policy-hook.mjs",
        content: renderCodexPolicyHook(),
      },
      {
        path: "hooks/codex-policy-targets.mjs",
        content: renderCodexPolicyTargets(),
      },
      {
        path: "hooks/policy-marker.mjs",
        content: readCodexHookAsset("policy-marker.mjs"),
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
        path: "memories/soma/lifecycle.md",
        content: renderLifecycleProjection(somaHome),
      },
      {
        path: "memories/soma/skills.md",
        content: renderSkills(input),
      },
      {
        path: "memories/soma/policy.md",
        content: renderCodexPolicy(),
      },
      ...portableSkillFiles,
      {
        path: "skills/the-algorithm/SKILL.md",
        content: renderAlgorithmRenderingContract(),
      },
      // Active-ISA projection (#37). OMITTED when no active ISA — AC-2.
      ...activeIsaBundleFile("codex", input.activeIsa),
    ],
  };
}

export const codexAdapter: SomaAdapter = {
  name: "codex",
  detect() {
    return Promise.resolve(Boolean(process.env.CODEX_SANDBOX ?? process.env.CODEX_HOME));
  },
  project(input) {
    return Promise.resolve(projectCodex(input));
  },
  run(task: SomaTask) {
    return Promise.resolve({
      taskId: task.id,
      substrate: "codex",
      status: "failed",
      summary: "Codex execution is not implemented yet; use project() to generate the substrate bundle.",
    });
  },
};
