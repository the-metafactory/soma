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
