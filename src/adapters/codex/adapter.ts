import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SomaAdapter, Projection, ProjectionInput, SomaTask } from "../../types";
import { defaultSomaRepoPath } from "../../repo-path";
import { resolveBunExecutable } from "../../bun-probe";
import { readCodexHookAsset, renderCodexPolicyHook, renderCodexPolicyTargets } from "./hooks/assets";
import { renderFeedbackHookModule } from "../shared/feedback-helper";
import { projectableSkills, renderAlgorithmRenderingContract, renderAssistantCore, renderMemoryLayout, renderPolicyProjection, renderSkills, renderSubstrateInstructions } from "../shared";
import { activeVsaBundleFile } from "../../adapter-active-vsa";
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
  return renderSubstrateInstructions({ substrate: "Codex", runtimeLabel: "Codex" }, input);
}

/**
 * Codex Tier-0 memory injection: project the durable memory INDEX as a static
 * file. Codex has no runtime tool to pull `memory/INDEX.md` live (unlike Pi), so
 * it rides along as a projected file. Reads the same `input.memory.indexContent`
 * field the Claude adapter's `memoryIndexBundleFile` consumes, and omits when it
 * is empty/absent. A test pins that narrow contract — the presence/absence toggle
 * and that the projected content is the verbatim `indexContent` — against Claude's
 * bundle helper (it does NOT assert INDEX rendering semantics or install-time
 * regeneration, which are the index renderer's and installer's concerns). It is
 * "regenerated at consolidation" only in the sense that consolidation rebuilds
 * INDEX.md and the next `soma install` re-projects it — a recorded degradation.
 */
export function codexMemoryIndexFile(input: ProjectionInput): { path: string; content: string }[] {
  const indexContent = input.memory?.indexContent;
  if (indexContent === undefined || indexContent.trim().length === 0) return [];
  return [{ path: "memories/soma/memory-index.md", content: indexContent }];
}

function renderHomeRules(input: ProjectionInput, somaHome: string): string {
  const contextLines = [
    "# Soma default availability",
    "",
    "Use Soma as the portable personal assistant context when the task involves identity, purpose, VSA, skills, memory, policy, or assistant continuity.",
    `Soma source of truth: ${somaHome}`,
    "This Codex home projection is generated from Soma and should not become the source of truth.",
    "",
    renderAssistantCore(input),
    "",
    "## Codex Home Rules",
    "- Prefer the Soma source files for durable identity, purpose, memory, and skill context.",
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
    "description: Use when work depends on portable personal assistant context, Soma identity, purpose, VSA criteria, memory layout, skills, policy, or default assistant behavior across substrates.",
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
    "- Treat `~/.codex/rules/soma.rules` as a parse-safe manifest marker, not as natural-language model context.",
    "- Read `~/.codex/memories/soma/profile.md` for the current projected assistant profile.",
    "- Read `~/.codex/memories/soma/pai-imports.md` when the task needs detailed migrated PAI identity, voice, relationship, purpose, or decision-context material.",
    "- Read `~/.codex/memories/soma/startup-context.md` for lifecycle-generated active work and recent learning context when present.",
    "- When present, read `~/.codex/memories/soma/memory-index.md` for the durable memory INDEX (Tier-0 orientation). It is a snapshot written whenever the Codex bundle is projected (e.g. `soma install`) from the index at that moment, and only when durable notes exist — so it may be absent (no index yet) or lag the live store between projections.",
    "- Read `~/.codex/memories/soma/lifecycle.md` for lifecycle refresh commands.",
    "- Use `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma memory recall --query \"...\"` before making durable claims that may depend on prior knowledge, learning, relationship, work, or imported PAI context. This is note-aware retrieval; `soma memory search` remains as a legacy line-grep fallback.",
    "- `soma memory promote --from-run <id> --store learning --title \"...\" --substrate codex --principal-authority` mints a principal-trust durable note from verified Algorithm work. Add `--principal-authority` ONLY on explicit principal request — it is a deliberate caller opt-in (soma can prove caller opt-in, not that the principal directed it), never from automated task steering. Without the flag, promotion refuses (fail-closed).",
    "- Do not assume a global `soma` binary exists; use lifecycle hooks or the `bun run soma` commands in `lifecycle.md`.",
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
    "The projected profile is intentionally concise. Detailed migrated PAI source snapshots remain in Soma and should be read when the task depends on personal identity, assistant voice, purpose, values, goals, strategies, or decision context.",
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
    "- `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma memory recall --query \"...\"` (note-aware; `soma memory search` is the legacy line-grep fallback)",
    "- `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma memory digest --session <id> --body \"8-15 lines\"` when a manual correction or replacement digest is needed",
    "- `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma memory promote --from-run <id> --store learning --title \"...\" --substrate codex --principal-authority` (explicit principal request only; refuses without --principal-authority)",
    "",
    "Do not use `command -v soma`; Soma is installed as a repo CLI, not a global binary.",
    "",
    "## Session Digest Capture",
    "",
    "Codex Stop hooks run `soma lifecycle session-end --substrate codex` with the session id, cwd, and a bounded transcript path when the hook payload exposes one. Without an explicit path, the hook only checks an exact `<session-id>.jsonl` direct child of the Codex session root. The Codex adapter writes one deterministic `hook: session-end` digest for qualifying transcripts and no-ops when a digest already exists. Short or unreadable transcripts are skipped without blocking lifecycle metadata capture.",
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
      // Tier-0 durable memory INDEX (M4 parity). OMITTED when no index exists yet.
      ...codexMemoryIndexFile(input),
      ...portableSkillFiles,
      {
        path: "skills/the-algorithm/SKILL.md",
        content: renderAlgorithmRenderingContract("Codex"),
      },
      // Active-VSA projection (#37). OMITTED when no active VSA — AC-2.
      ...activeVsaBundleFile("codex", input.activeVsa),
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
