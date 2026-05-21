import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
  AlgorithmCapabilityDefinition,
  AlgorithmCapabilitySelection,
  AlgorithmCapabilitySelectionStatus,
  AlgorithmCapabilityInvocation,
  AlgorithmPhase,
  AlgorithmRun,
  SubstrateId,
} from "./types";
import { getRunPhase } from "./algorithm-lifecycle";

const CORE_PHASES: AlgorithmPhase[] = ["observe", "think", "plan", "build", "execute", "verify", "learn"];

const DEFAULT_CAPABILITY_REGISTRY: AlgorithmCapabilityDefinition[] = [
  {
    name: "ReReadCheck",
    kind: "inline",
    phases: ["verify", "learn"],
    triggerSignals: ["review", "regression", "instruction drift", "before final"],
    invoke: { contract: "inline", target: "Re-read task, issue, diff, tests, and final answer for drift." },
  },
  {
    name: "sequential-analysis",
    kind: "inline",
    phases: ["think", "plan"],
    triggerSignals: ["sequence", "phase gates", "ordered work"],
    invoke: { contract: "inline", target: "Analyze the work as an ordered sequence before planning." },
  },
];

export interface SomaHomeAlgorithmCapabilityOptions {
  homeDir?: string;
  somaHome?: string;
}

export interface SomaHomeAlgorithmCapabilityRegistry {
  definitions: AlgorithmCapabilityDefinition[];
  unsupported: string[];
}

export interface SelectAlgorithmCapabilityInput {
  name: string;
  phase?: AlgorithmPhase;
  reason?: string;
}

export interface RecordAlgorithmCapabilityInvocationInput {
  name: string;
  substrate?: SubstrateId;
  evidence: string;
}

export interface RemoveAlgorithmCapabilityInput {
  name: string;
  reason: string;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Algorithm ${field} must not be empty.`);
  }
}

function dedupeCapabilities(capabilities: string[], name: string): string[] {
  return Array.from(new Set([...capabilities, name]));
}

function findSelectionIndex(selections: AlgorithmCapabilitySelection[], name: string): number {
  const unresolvedIndex = selections.findIndex(
    (selection) => selection.name === name && (selection.status === "selected" || selection.status === "failed"),
  );

  if (unresolvedIndex !== -1) {
    return unresolvedIndex;
  }

  return selections.findIndex((selection) => selection.name === name && selection.status === "invoked");
}

function capabilityStatusText(status: AlgorithmCapabilitySelectionStatus): string {
  return status === "selected" ? "selected but not invoked" : status;
}

function cloneCapabilityDefinition(definition: AlgorithmCapabilityDefinition): AlgorithmCapabilityDefinition {
  return {
    ...definition,
    phases: [...definition.phases],
    triggerSignals: [...definition.triggerSignals],
    invoke: { ...definition.invoke },
  };
}

function resolveSomaHome(options: SomaHomeAlgorithmCapabilityOptions = {}): string {
  const home = resolve(options.homeDir ?? homedir());
  return options.somaHome ? resolve(home, options.somaHome) : join(home, ".soma");
}

function normalizeCapabilityKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripMarkdownEmphasis(value: string): string {
  return value
    .replaceAll("**", "")
    .replaceAll("*", "")
    .replaceAll("`", "")
    .trim();
}

function stripCapabilityLabel(value: string): string {
  const label = stripMarkdownEmphasis(value).replace(/\s*\([^)]*\)\s*$/, "").trim();
  return label === "ISA Skill" ? "ISA" : label;
}

function frontmatterValue(content: string, key: string, fallback: string): string {
  const pattern = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = content.match(pattern);
  if (!match) return fallback;
  const value = match[1].trim().replace(/^["']|["']$/g, "");
  return value.length > 0 ? value : fallback;
}

async function loadAvailableSkillNames(somaHome: string): Promise<Map<string, string>> {
  const skillsRoot = join(somaHome, "skills");
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const names = new Map<string, string>();

  const skillMetadata = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const skillRoot = join(skillsRoot, entry.name);
        const skillMd = await readFile(join(skillRoot, "SKILL.md"), "utf8").catch(() => undefined);
        return skillMd ? { dirName: entry.name, name: frontmatterValue(skillMd, "name", entry.name) } : undefined;
      }),
  );

  for (const metadata of skillMetadata) {
    if (!metadata) continue;

    names.set(normalizeCapabilityKey(metadata.name), metadata.name);
    names.set(normalizeCapabilityKey(metadata.dirName), metadata.name);
    names.set(normalizeCapabilityKey(basename(metadata.dirName)), metadata.name);
  }

  return names;
}

function parsePhaseCell(value: string, fallback: AlgorithmPhase[] = ["think"]): AlgorithmPhase[] {
  const normalized = stripMarkdownEmphasis(value).toLowerCase();
  if (normalized === "any") {
    return [...CORE_PHASES];
  }

  const phases = new Set<AlgorithmPhase>();
  const phaseNames: AlgorithmPhase[] = [...CORE_PHASES, "complete"];
  for (const phase of phaseNames) {
    if (normalized.includes(phase)) {
      phases.add(phase);
    }
  }

  return phases.size > 0 ? Array.from(phases) : [...fallback];
}

function parseMarkdownTableRows(markdown: string): string[][] {
  const rows: string[][] = [];
  let inCapabilityTable = false;

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("|") || !line.endsWith("|")) {
      inCapabilityTable = false;
      continue;
    }

    const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
    const first = cells[0]?.toLowerCase() ?? "";
    if (first === "capability") {
      inCapabilityTable = true;
      continue;
    }

    if (!inCapabilityTable) {
      continue;
    }

    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) {
      continue;
    }

    if (cells.length >= 3) {
      rows.push(cells);
    }
  }

  return rows;
}

function skillInvocationTarget(value: string): string | undefined {
  return /Skill\("([^"]+)"/.exec(value)?.[1];
}

function agentInvocationTarget(value: string, capabilityName: string): string | undefined {
  const subtype = /subagent_type\s*=\s*"([^"]+)"/.exec(value)?.[1];
  return subtype ?? (value.includes("Agent(") ? capabilityName : undefined);
}

function commandInvocationTarget(value: string): string | undefined {
  const stripped = stripMarkdownEmphasis(value);
  if (stripped.includes("Bash(")) return stripped;
  if (stripped.startsWith("bun ")) return stripped;
  return undefined;
}

function inlineInvocationTarget(value: string): string | undefined {
  const stripped = stripMarkdownEmphasis(value);
  if (stripped.includes("inline doctrine") || stripped.includes("no external tool")) {
    return stripped;
  }
  return undefined;
}

function buildCapabilityDefinition(
  name: string,
  kind: AlgorithmCapabilityDefinition["kind"],
  phases: AlgorithmPhase[],
  triggerSignals: string[],
  target: string,
): AlgorithmCapabilityDefinition {
  return {
    name,
    kind,
    phases,
    triggerSignals,
    invoke: { contract: kind, target },
  };
}

export async function loadSomaHomeAlgorithmCapabilityRegistry(
  options: SomaHomeAlgorithmCapabilityOptions = {},
): Promise<SomaHomeAlgorithmCapabilityRegistry> {
  const somaHome = resolveSomaHome(options);
  const referencePath = join(somaHome, "skills", "the-algorithm", "references", "capabilities.md");
  const markdown = await readFile(referencePath, "utf8").catch(() => "");
  if (!markdown) {
    return { definitions: [], unsupported: [] };
  }

  const availableSkills = await loadAvailableSkillNames(somaHome);
  const definitions = new Map<string, AlgorithmCapabilityDefinition>();
  const unsupported = new Set<string>();

  for (const row of parseMarkdownTableRows(markdown)) {
    const name = stripCapabilityLabel(row[0] ?? "");
    const phaseCell = row[1] ?? "";
    const triggerCell = row.length >= 5 ? row[2] ?? "" : row[1] ?? "";
    const invokeCell = row.length >= 5 ? row[3] ?? "" : row[2] ?? "";

    if (!name) continue;

    const phases = parsePhaseCell(phaseCell, row.length >= 5 ? ["think"] : ["plan"]);
    const triggerSignals = [stripMarkdownEmphasis(triggerCell)].filter((signal) => signal.length > 0);
    const skillTarget = skillInvocationTarget(invokeCell);
    const agentTarget = agentInvocationTarget(invokeCell, name);
    const commandTarget = commandInvocationTarget(invokeCell);
    const inlineTarget = inlineInvocationTarget(invokeCell);

    if (skillTarget) {
      const availableTarget = availableSkills.get(normalizeCapabilityKey(skillTarget));
      if (!availableTarget) {
        unsupported.add(name);
        continue;
      }

      definitions.set(name, buildCapabilityDefinition(name, "skill", phases, triggerSignals, availableTarget));
      continue;
    }

    if (agentTarget) {
      definitions.set(name, buildCapabilityDefinition(name, "agent", phases, triggerSignals, agentTarget));
      continue;
    }

    if (inlineTarget) {
      definitions.set(name, buildCapabilityDefinition(name, "inline", phases, triggerSignals, inlineTarget));
      continue;
    }

    if (commandTarget) {
      definitions.set(name, buildCapabilityDefinition(name, "command", phases, triggerSignals, commandTarget));
      continue;
    }

    unsupported.add(name);
  }

  return {
    definitions: Array.from(definitions.values()).map(cloneCapabilityDefinition),
    unsupported: Array.from(unsupported).sort(),
  };
}

export async function registerSomaHomeAlgorithmCapabilities(
  run: AlgorithmRun,
  options: SomaHomeAlgorithmCapabilityOptions = {},
  timestamp = run.updatedAt,
): Promise<AlgorithmRun> {
  const { definitions } = await loadSomaHomeAlgorithmCapabilityRegistry(options);
  if (definitions.length === 0) {
    return run;
  }

  return registerAlgorithmCapabilityDefinitions(run, definitions, timestamp);
}

export function listAlgorithmCapabilityDefinitions(): AlgorithmCapabilityDefinition[] {
  return DEFAULT_CAPABILITY_REGISTRY.map(cloneCapabilityDefinition);
}

function definitionsForRun(run: Pick<AlgorithmRun, "capabilityDefinitions">): AlgorithmCapabilityDefinition[] {
  const byName = new Map<string, AlgorithmCapabilityDefinition>();
  for (const definition of DEFAULT_CAPABILITY_REGISTRY) {
    byName.set(definition.name, definition);
  }
  for (const definition of run.capabilityDefinitions ?? []) {
    byName.set(definition.name, definition);
  }

  return Array.from(byName.values()).map(cloneCapabilityDefinition);
}

function validateCapabilityDefinition(definition: AlgorithmCapabilityDefinition): void {
  assertNonEmpty(definition.name, "capability name");
  assertNonEmpty(definition.invoke.target, "capability invocation target");

  if (definition.phases.length === 0) {
    throw new Error(`Algorithm capability must declare at least one phase: ${definition.name}`);
  }

  if (!Array.isArray(definition.triggerSignals)) {
    throw new Error(`Algorithm capability must declare triggerSignals: ${definition.name}`);
  }
}

export function registerAlgorithmCapabilityDefinition(
  run: AlgorithmRun,
  definition: AlgorithmCapabilityDefinition,
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  return registerAlgorithmCapabilityDefinitions(run, [definition], timestamp);
}

export function registerAlgorithmCapabilityDefinitions(
  run: AlgorithmRun,
  definitions: AlgorithmCapabilityDefinition[],
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  if (definitions.length === 0) {
    throw new Error("Algorithm capability registration requires at least one definition.");
  }

  const nextDefinitions = new Map((run.capabilityDefinitions ?? []).map((existing) => [existing.name, existing]));
  for (const definition of definitions) {
    validateCapabilityDefinition(definition);
    nextDefinitions.set(definition.name, cloneCapabilityDefinition(definition));
  }

  return {
    ...run,
    updatedAt: timestamp,
    capabilityDefinitions: Array.from(nextDefinitions.values()).map(cloneCapabilityDefinition),
  };
}

export function getAlgorithmCapabilityDefinition(
  name: string,
  run?: Pick<AlgorithmRun, "capabilityDefinitions">,
): AlgorithmCapabilityDefinition {
  assertNonEmpty(name, "capability");
  const definition = (run ? definitionsForRun(run) : listAlgorithmCapabilityDefinitions()).find((capability) => capability.name === name);

  if (!definition) {
    throw new Error(`Algorithm capability is not registered: ${name}`);
  }

  return cloneCapabilityDefinition(definition);
}

export function selectAlgorithmCapability(
  run: AlgorithmRun,
  input: SelectAlgorithmCapabilityInput,
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  const name = input.name.trim();
  const definition = getAlgorithmCapabilityDefinition(name, run);
  const phase = input.phase ?? getRunPhase(run);
  const trimmedReason = input.reason?.trim();
  const reason = trimmedReason && trimmedReason.length > 0 ? trimmedReason : `Selected ${definition.name} for ${phase}.`;
  const selections = run.capabilitySelections ?? [];
  const existingIndex = findSelectionIndex(selections, name);

  assertNonEmpty(reason, "capability selection reason");

  if (!definition.phases.includes(phase)) {
    throw new Error(`Algorithm capability ${name} cannot be selected for ${phase}; allowed phases: ${definition.phases.join(", ")}.`);
  }

  if (existingIndex !== -1) {
    const existing = selections[existingIndex];
    const changedSelection = existing.phase !== phase || existing.reason !== reason;

    if (existing.status === "invoked" && !changedSelection) {
      return {
        ...run,
        updatedAt: timestamp,
        capabilities: dedupeCapabilities(run.capabilities, name),
        capabilitySelections: selections,
      };
    }

    if ((existing.status === "invoked" || existing.status === "failed") && changedSelection) {
      return appendCapabilitySelection(run, selections, { name, phase, reason, timestamp });
    }

    const nextSelections = selections.map((selection, index) =>
      index === existingIndex
        ? {
            ...selection,
            phase,
            reason,
            status: "selected" as const,
            invocation: undefined,
            selectedAt: selection.selectedAt,
          }
        : selection,
    );

    return {
      ...run,
      updatedAt: timestamp,
      capabilities: dedupeCapabilities(run.capabilities, name),
      capabilitySelections: nextSelections,
    };
  }

  return appendCapabilitySelection(run, selections, { name, phase, reason, timestamp });
}

function appendCapabilitySelection(
  run: AlgorithmRun,
  selections: AlgorithmCapabilitySelection[],
  input: { name: string; phase: AlgorithmPhase; reason: string; timestamp: string },
): AlgorithmRun {
  return {
    ...run,
    updatedAt: input.timestamp,
    capabilities: dedupeCapabilities(run.capabilities, input.name),
    capabilitySelections: [
      ...selections,
      {
        name: input.name,
        phase: input.phase,
        reason: input.reason,
        status: "selected",
        selectedAt: input.timestamp,
      },
    ],
  };
}

export function recordAlgorithmCapabilityInvocation(
  run: AlgorithmRun,
  input: RecordAlgorithmCapabilityInvocationInput,
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  const name = input.name.trim();
  const evidence = input.evidence.trim();
  const definition = getAlgorithmCapabilityDefinition(name, run);
  const selections = run.capabilitySelections ?? [];
  const selectionIndex = findSelectionIndex(selections, name);

  assertNonEmpty(evidence, "capability invocation evidence");

  if (selectionIndex === -1) {
    throw new Error(`Algorithm capability must be selected before invocation: ${name}`);
  }

  const invocation: AlgorithmCapabilityInvocation = {
    timestamp,
    substrate: input.substrate ?? run.substrate ?? "custom",
    contract: definition.invoke.contract,
    target: definition.invoke.target,
    evidence,
  };

  return {
    ...run,
    updatedAt: timestamp,
    capabilities: dedupeCapabilities(run.capabilities, name),
    capabilitySelections: selections.map((selection, index) =>
      index === selectionIndex
        ? {
            ...selection,
            status: "invoked",
            invocation,
          }
        : selection,
    ),
  };
}

export function removeAlgorithmCapabilitySelection(
  run: AlgorithmRun,
  input: RemoveAlgorithmCapabilityInput,
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  const name = input.name.trim();
  const reason = input.reason.trim();
  assertNonEmpty(reason, "capability removal reason");

  const selections = run.capabilitySelections ?? [];
  const selectionIndex = findSelectionIndex(selections, name);

  if (selectionIndex === -1) {
    throw new Error(`Algorithm capability selection not found: ${name}`);
  }

  return {
    ...run,
    updatedAt: timestamp,
    capabilitySelections: selections.map((selection, index) =>
      index === selectionIndex
        ? {
            ...selection,
            status: "removed",
            removalReason: reason,
            removedAt: timestamp,
          }
        : selection,
    ),
  };
}

export function unresolvedAlgorithmCapabilitySelections(run: AlgorithmRun): AlgorithmCapabilitySelection[] {
  return (run.capabilitySelections ?? []).filter(
    (selection) => selection.status === "selected" || selection.status === "failed",
  );
}

export function assertAlgorithmCapabilitiesSatisfied(run: AlgorithmRun): void {
  const unresolved = unresolvedAlgorithmCapabilitySelections(run);

  if (unresolved.length > 0) {
    const summary = unresolved.map((selection) => `${selection.name} (${capabilityStatusText(selection.status)})`).join(", ");
    throw new Error(`Algorithm cannot COMPLETE with selected capabilities that were not invoked or removed: ${summary}`);
  }
}
