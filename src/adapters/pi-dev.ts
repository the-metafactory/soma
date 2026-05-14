import type { SomaAdapter, SomaContextBundle, SomaContextInput, SomaTask } from "../types";
import { renderAssistantCore, renderMemoryLayout, renderPolicyProjection, renderSkills } from "./shared";

function renderInstructions(input: SomaContextInput): string {
  return [
    "# Soma Pi.dev Context",
    "",
    "You are running inside Pi.dev with Soma-projected assistant context.",
    "Treat Soma as the portable assistant kernel. Treat Pi.dev extensions and tools as the host execution surface.",
    "",
    renderAssistantCore(input),
    "",
    "## Operating Rules",
    "- Use Soma tools for ISA, memory, learning, and policy operations when available.",
    "- Keep model-provider settings outside the Soma core.",
    "- Prefer file-backed memory paths from the bundle over substrate-local hidden state.",
    "- Report extension/tool limitations as adapter limitations.",
  ].join("\n");
}

function renderExtensionManifest(): string {
  return `${JSON.stringify(
    {
      name: "soma-core",
      version: "0.1.0",
      description: "Pi.dev projection for Soma personal assistant context.",
      tools: [
        "isa_create",
        "isa_update",
        "memory_search",
        "capture_learning",
        "policy_check",
      ],
    },
    null,
    2,
  )}\n`;
}

function renderToolContract(): string {
  return [
    "# Soma Pi.dev Tool Contract",
    "",
    "The first Pi.dev adapter projects the tool surface only. Implementations stay outside the portable core until Pi.dev execution is wired.",
    "",
    "- `isa_create`: create a personal/task ISA in Soma memory.",
    "- `isa_update`: update an existing ISA criterion, phase, or verification record.",
    "- `memory_search`: search the declared file-backed memory layout.",
    "- `capture_learning`: append a learning note through an explicit write path.",
    "- `policy_check`: report enforceable and advisory policy status for a requested action.",
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

function renderHomeExtension(somaHome: string): string {
  return [
    'import { readFileSync } from "node:fs";',
    'import { StringEnum } from "@mariozechner/pi-ai";',
    'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";',
    'import { Type } from "@sinclair/typebox";',
    "",
    `const SOMA_HOME = ${JSON.stringify(somaHome)};`,
    'const PI_SOMA_HOME = `${process.env.HOME}/.pi/agent/soma`;',
    "",
    "const SomaContextParams = Type.Object({",
    '\taction: StringEnum(["profile", "memory_layout", "pai_imports", "source_file"] as const),',
    '\tpath: Type.Optional(Type.String({ description: "Absolute Soma source file path for action=source_file" })),',
    "});",
    "",
    "function readText(path: string): string {",
    '\treturn readFileSync(path, "utf8");',
    "}",
    "",
    "function readOptional(path: string): string {",
    "\ttry {",
    "\t\treturn readText(path);",
    "\t} catch {",
    '\t\treturn "";',
    "\t}",
    "}",
    "",
    "export default function (pi: ExtensionAPI) {",
    '\tpi.on("before_agent_start", async (event) => {',
    '\t\tconst profile = readOptional(`${PI_SOMA_HOME}/profile.md`);',
    '\t\tconst paiImports = readOptional(`${PI_SOMA_HOME}/pai-imports.md`);',
    '\t\tconst context = readOptional(`${PI_SOMA_HOME}/context.md`);',
    '\t\tconst somaPrompt = `',
    "## Soma Personal Assistant Context",
    "",
    "Soma is the portable personal assistant source of truth for this Pi.dev session.",
    "When the user asks who you are, answer as the Soma-projected assistant identity, while acknowledging Pi.dev as the execution substrate when useful.",
    "When the user asks who they are, answer from the Soma-projected principal identity.",
    "Use the soma_context tool or read paths listed below when deeper migrated PAI identity, values, goals, strategies, or decision context matters.",
    "",
    "${profile}",
    "",
    "${paiImports}",
    "",
    "${context}",
    "`;",
    "",
    "\t\treturn {",
    "\t\t\tsystemPrompt: `${event.systemPrompt}\\n\\n${somaPrompt}`,",
    "\t\t};",
    "\t});",
    "",
    "\tpi.registerTool({",
    '\t\tname: "soma_context",',
    '\t\tlabel: "Soma Context",',
    '\t\tdescription: "Read projected Soma personal assistant context and migrated PAI source snapshots.",',
    "\t\tparameters: SomaContextParams,",
    "",
    "\t\tasync execute(_toolCallId, params) {",
    "\t\t\tconst target =",
    '\t\t\t\tparams.action === "profile"',
    '\t\t\t\t\t? `${PI_SOMA_HOME}/profile.md`',
    '\t\t\t\t\t: params.action === "memory_layout"',
    '\t\t\t\t\t\t? `${PI_SOMA_HOME}/memory-layout.md`',
    '\t\t\t\t\t\t: params.action === "pai_imports"',
    '\t\t\t\t\t\t\t? `${PI_SOMA_HOME}/pai-imports.md`',
    "\t\t\t\t\t\t\t: params.path;",
    "",
    "\t\t\tif (!target) {",
    '\t\t\t\treturn { content: [{ type: "text", text: "Error: path is required for source_file" }] };',
    "\t\t\t}",
    "",
    "\t\t\tif (params.action === \"source_file\" && !target.startsWith(SOMA_HOME)) {",
    '\t\t\t\treturn { content: [{ type: "text", text: `Error: refusing to read outside Soma home: ${target}` }] };',
    "\t\t\t}",
    "",
    "\t\t\ttry {",
    '\t\t\t\treturn { content: [{ type: "text", text: readText(target) }] };',
    "\t\t\t} catch (error) {",
    '\t\t\t\treturn { content: [{ type: "text", text: `Error reading ${target}: ${error instanceof Error ? error.message : String(error)}` }] };',
    "\t\t\t}",
    "\t\t},",
    "\t});",
    "",
    '\tpi.registerCommand("soma", {',
    '\t\tdescription: "Show Soma profile, memory layout, and PAI import pointers",',
    "\t\thandler: async (_args, ctx) => {",
    '\t\t\tconst text = [readText(`${PI_SOMA_HOME}/profile.md`), "", readText(`${PI_SOMA_HOME}/pai-imports.md`)].join("\\n");',
    "\t\t\tctx.ui.notify(text, \"info\");",
    "\t\t},",
    "\t});",
    "}",
  ].join("\n");
}

function renderHomeSkill(input: SomaContextInput, somaHome: string): string {
  return [
    "---",
    "name: soma",
    "description: Use when work depends on Soma portable personal assistant context, Ivy assistant identity, Jens-Christian principal identity, telos, PAI imports, memory layout, or cross-substrate continuity.",
    "metadata:",
    "  short-description: Portable personal assistant context",
    "---",
    "",
    "# Soma",
    "",
    `Source of truth: ${somaHome}`,
    "",
    "## Use",
    "",
    "- Use the `soma_context` tool with `action: profile` for fast orientation.",
    "- Use the `soma_context` tool with `action: pai_imports` to find detailed migrated PAI source files.",
    "- Use the `soma_context` tool with `action: source_file` for detailed identity, voice, telos, values, goals, strategies, and decision-context source files under Soma.",
    "- Treat Pi.dev as the execution substrate, not the source of truth.",
    "",
    "## Current Projection",
    "",
    renderAssistantCore(input),
  ].join("\n");
}

export function buildPiDevContext(input: SomaContextInput): SomaContextBundle {
  const instructions = renderInstructions(input);

  return {
    substrate: "pi-dev",
    instructions,
    files: [
      {
        path: ".pi/extensions/soma-core/extension.json",
        content: renderExtensionManifest(),
      },
      {
        path: ".pi/extensions/soma-core/context.md",
        content: instructions,
      },
      {
        path: ".pi/extensions/soma-core/tools.md",
        content: renderToolContract(),
      },
      {
        path: ".pi/extensions/soma-core/memory-layout.md",
        content: renderMemoryLayout(input),
      },
      {
        path: ".pi/extensions/soma-core/skills.md",
        content: renderSkills(input),
      },
      {
        path: ".pi/extensions/soma-core/policy.md",
        content: renderPolicyProjection("pi-dev", ["Registered extension tools once installed"], [
          "Model-provider behavior",
          "Host permission prompts",
          "Verification reporting",
        ]),
      },
    ],
  };
}

export function buildPiDevHomeContext(input: SomaContextInput, somaHome: string): SomaContextBundle {
  const instructions = renderInstructions(input);

  return {
    substrate: "pi-dev",
    instructions,
    files: [
      {
        path: "agent/extensions/soma.ts",
        content: renderHomeExtension(somaHome),
      },
      {
        path: "agent/soma/context.md",
        content: instructions,
      },
      {
        path: "agent/soma/profile.md",
        content: ["# Soma Profile Projection", "", renderAssistantCore(input)].join("\n"),
      },
      {
        path: "agent/soma/memory-layout.md",
        content: renderMemoryLayout(input),
      },
      {
        path: "agent/soma/pai-imports.md",
        content: renderPaiImportIndex(somaHome),
      },
      {
        path: "agent/soma/tools.md",
        content: renderToolContract(),
      },
      {
        path: "agent/soma/skills.md",
        content: renderSkills(input),
      },
      {
        path: "agent/soma/policy.md",
        content: renderPolicyProjection("pi-dev", ["soma_context extension tool reads projected context and Soma source snapshots"], [
          "Model-provider behavior",
          "Host permission prompts",
          "Verification reporting",
        ]),
      },
      {
        path: "agent/skills/soma/SKILL.md",
        content: renderHomeSkill(input, somaHome),
      },
    ],
  };
}

export const piDevAdapter: SomaAdapter = {
  name: "pi-dev",
  detect() {
    return Promise.resolve(Boolean(process.env.PI_DEV_HOME ?? process.env.PIDEV_HOME));
  },
  buildContext(input) {
    return Promise.resolve(buildPiDevContext(input));
  },
  run(task: SomaTask) {
    return Promise.resolve({
      taskId: task.id,
      substrate: "pi-dev",
      status: "failed",
      summary: "Pi.dev execution is not implemented yet; use buildContext() to generate the extension bundle.",
    });
  },
};
