import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AlgorithmImportOptions, AlgorithmImportPlan, AlgorithmImportResult } from "./types";

const SOURCE_FILES = [
  { path: "v6.3.0.md", target: "references/algorithm-v6.3.0.md", required: true },
  { path: "capabilities.md", target: "references/capabilities.md", required: false },
  { path: "mode-detection.md", target: "references/mode-detection.md", required: false },
  { path: "parameter-schema.md", target: "references/parameter-schema.md", required: false },
  { path: "ideate-loop.md", target: "references/ideate-loop.md", required: false },
  { path: "optimize-loop.md", target: "references/optimize-loop.md", required: false },
] as const;

const TARGET_FILES = [
  "skills/the-algorithm/SKILL.md",
  "skills/the-algorithm/Workflows/RunAlgorithm.md",
  ...SOURCE_FILES.map((source) => `skills/the-algorithm/${source.target}`),
] as const;

function resolveHomes(options: AlgorithmImportOptions = {}): { paiAlgorithmDir: string; somaHome: string } {
  const home = resolve(options.homeDir ?? homedir());

  return {
    paiAlgorithmDir: resolve(options.paiAlgorithmDir ?? join(home, ".claude/PAI/Algorithm")),
    somaHome: resolve(options.somaHome ?? join(home, ".soma")),
  };
}

function renderSkill(): string {
  return [
    "---",
    "name: the-algorithm",
    'description: "Use when work should run through the PAI Algorithm: current-state to ideal-state, ISA/ISC creation or refinement, effort tiers, seven-phase execution, verification-first planning, euphoric-surprise goals, substantial build/design/refactor/migration work, or explicit Algorithm requests."',
    "metadata:",
    "  short-description: PAI Algorithm execution doctrine",
    "---",
    "",
    "# The Algorithm",
    "",
    "The Algorithm is Soma's portable version of PAI's core execution doctrine. It turns work into a transition from current state to ideal state, captured as an ISA whose criteria are granular, binary, and verifiable.",
    "",
    "Prefer the Soma Algorithm harness over freeform execution when it is available. The harness is the deterministic layer; these files are the doctrine and substrate-facing instructions.",
    "",
    "## Use",
    "",
    "- Start with `Workflows/RunAlgorithm.md`.",
    "- Read `references/algorithm-v6.3.0.md` when doctrine detail matters.",
    "- Read `references/capabilities.md` before selecting thinking or delegation capabilities.",
    "- Read `references/mode-detection.md` when effort tier, fast-path, ideate, optimize, or research mode is ambiguous.",
    "- Read `references/parameter-schema.md` for ideate and optimize parameter handling.",
    "- Treat Claude-specific hooks, voice curls, and agents as source history, not portable requirements.",
    "",
    "## Triggers",
    "",
    "- algorithm",
    "- ideal state",
    "- ISA",
    "- ISC",
    "- verification criteria",
    "- current state to ideal state",
    "- euphoric surprise",
    "- substantial build/design/refactor/migration work",
  ].join("\n");
}

function renderRunWorkflow(): string {
  return [
    "# Run The Algorithm",
    "",
    "Use this workflow to execute the portable PAI Algorithm inside any substrate.",
    "",
    "## Portable Contract",
    "",
    "1. Restate the user's intent in one sentence before planning.",
    "2. Create a harness run with the installed Soma lifecycle tool or repo CLI. For Codex use `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma algorithm new ...`; for Pi.dev use `cd $(cat ~/.pi/agent/soma/soma-repo.txt) && bun run soma algorithm new ...`. Do not assume a global `soma` binary exists.",
    "3. Choose the smallest sufficient effort tier: E1, E2, E3, E4, or E5.",
    "4. Treat the work as a transition from current state to ideal state.",
    "5. Create or update the ISA that belongs to the thing being articulated.",
    "6. Write criteria as atomic yes/no claims with nameable probes.",
    "7. Preserve anti-criteria with `Anti:` criteria when something must not happen.",
    "8. Execute through the seven phases unless an E1 fast path clearly applies.",
    "9. Verify every criterion with evidence before declaring completion.",
    "10. Record decisions, changelog, and verification in the ISA rather than parallel artifacts.",
    "",
    "## Seven Phases",
    "",
    "1. OBSERVE: restate intent, identify current state, choose ISA home, draft problem/goal/criteria.",
    "2. THINK: refine assumptions, split vague criteria, select thinking capabilities from the closed list.",
    "3. PLAN: map criteria to implementation steps, capabilities, dependencies, and verification probes.",
    "4. BUILD: create or modify artifacts while updating criteria when reality sharpens the ideal state.",
    "5. EXECUTE: run the concrete steps and keep criteria state current.",
    "6. VERIFY: prove each criterion and anti-criterion with evidence.",
    "7. LEARN: capture decisions, refutations, lessons, and next iteration.",
    "",
    "## Harness CLI",
    "",
    "The harness is mutable run state, not just a document. Use the repo-local CLI for the active substrate:",
    "",
    "- Codex prefix: `cd $(cat ~/.codex/memories/soma/soma-repo.txt) && bun run soma`",
    "- Pi.dev prefix: `cd $(cat ~/.pi/agent/soma/soma-repo.txt) && bun run soma`",
    "",
    "Common commands:",
    "",
    "- `algorithm new --id <run-id> --prompt \"...\" --intent \"...\" --current-state \"...\" --goal \"...\" --criterion \"C1:...\" --effort E2`",
    "- `algorithm list`",
    "- `algorithm show --id <run-id>`",
    "- `algorithm capabilities --id <run-id> --capability <CapabilityName>`",
    "- `algorithm plan --id <run-id> --step \"P1:C1[,C2]:Do the concrete work.\"`",
    "- `algorithm decision --id <run-id> --text \"Decision made and why.\"`",
    "- `algorithm change --id <run-id> --text \"Artifact changed.\"`",
    "- `algorithm step --id <run-id> --step-id P1 --status done --evidence \"Probe output or file path.\"`",
    "- `algorithm verify --id <run-id> --criterion-id C1 --status passed --evidence \"Verification evidence.\"`",
    "- `algorithm learn --id <run-id> --text \"Reusable lesson.\"`",
    "- `algorithm advance --id <run-id>`",
    "",
    "`algorithm advance` is the deterministic gate. If required capabilities, plan steps, build changes, verification, or learning are missing, Soma rejects the transition and the substrate must fill the missing state before trying again.",
    "",
    "## Effort Tiers",
    "",
    "- E1 Standard: quick work; minimal ISA with Goal and Criteria is enough.",
    "- E2 Extended: structured work; include Problem, Goal, Criteria, Test Strategy.",
    "- E3 Advanced: substantial multi-file or multi-step work; include project-grade sections.",
    "- E4 Deep: architecture/doctrine/cross-cutting work; all twelve ISA sections.",
    "- E5 Comprehensive: long-running comprehensive work; all twelve sections plus interview/refinement before build.",
    "",
    "## Closed Thinking Capability Names",
    "",
    "When naming thinking capabilities, use names verbatim from `references/capabilities.md`. Do not invent synonyms.",
    "",
    "## Substrate Adaptation",
    "",
    "- Codex: use repository edits, tests, and final verification reports as the execution surface.",
    "- Pi.dev: use the Soma system-prompt context and `soma_context` tool for identity/PAI detail; use Pi tools for work.",
    "- Claude Code: defer live home integration until no active agents depend on `~/.claude`.",
    "- Cortex/Myelin: later, the ISA becomes bus-visible work state.",
    "",
    "## Completion Gate",
    "",
    "Before final response, re-read the user's latest request and check every explicit ask against shipped artifacts. Do not claim done if any explicit ask is missing.",
  ].join("\n");
}

export function planAlgorithmImport(options: AlgorithmImportOptions = {}): AlgorithmImportPlan {
  const homes = resolveHomes(options);

  return {
    apply: false,
    paiAlgorithmDir: homes.paiAlgorithmDir,
    somaHome: homes.somaHome,
    sourceFiles: SOURCE_FILES.map((source) => join(homes.paiAlgorithmDir, source.path)),
    targetFiles: TARGET_FILES.map((path) => join(homes.somaHome, path)),
  };
}

export async function importAlgorithm(options: AlgorithmImportOptions = {}): Promise<AlgorithmImportResult> {
  const homes = resolveHomes(options);
  const sources = new Map<string, string>();

  for (const source of SOURCE_FILES) {
    const path = join(homes.paiAlgorithmDir, source.path);
    const content = await readFile(path, "utf8").catch((error: unknown) => {
      if (!source.required) {
        return undefined;
      }

      throw error;
    });

    if (content !== undefined) {
      sources.set(source.target, content);
    }
  }
  const files = new Map<string, string>();

  files.set("skills/the-algorithm/SKILL.md", renderSkill());
  files.set("skills/the-algorithm/Workflows/RunAlgorithm.md", renderRunWorkflow());

  for (const [path, content] of sources) {
    files.set(`skills/the-algorithm/${path}`, content);
  }

  const written: string[] = [];

  for (const [relativePath, content] of files) {
    const target = join(homes.somaHome, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${content.trimEnd()}\n`, "utf8");
    written.push(target);
  }

  return {
    paiAlgorithmDir: homes.paiAlgorithmDir,
    somaHome: homes.somaHome,
    files: written,
  };
}
