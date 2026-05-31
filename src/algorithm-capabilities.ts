import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
  AlgorithmCapabilityContract,
  AlgorithmCapabilityDefinition,
  AlgorithmCapabilitySelection,
  AlgorithmCapabilitySelectionStatus,
  AlgorithmCapabilityInvocation,
  AlgorithmCapabilityKind,
  AlgorithmPhase,
  AlgorithmRun,
  SomaSkillManifest,
  SubstrateId,
} from "./types";
import { getRunPhase } from "./algorithm-lifecycle";
import { appendAlgorithmProvenance } from "./algorithm-provenance";

const CORE_PHASES: AlgorithmPhase[] = ["observe", "think", "plan", "build", "execute", "verify", "learn"];
const CAPABILITY_INVOKE_KINDS = ["skill", "inline", "agent", "command", "adapter"] as const;

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
  substrate?: SubstrateId;
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

function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function hasOwnField(value: unknown, field: string): boolean {
  return typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function frontmatterValue(content: string, key: string, fallback: string): string {
  const pattern = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = content.match(pattern);
  if (!match) return fallback;
  const value = match[1].trim().replace(/^["']|["']$/g, "");
  return value.length > 0 ? value : fallback;
}

function sectionBullets(content: string, heading: string): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return [];

  const bullets: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const match = /^\s*[-*]\s+(.+)$/.exec(line);
    if (match) bullets.push(stripMarkdownEmphasis(match[1]));
  }

  return bullets;
}

interface AvailableSkill {
  dirName: string;
  name: string;
  description: string;
  triggers: string[];
  manifest?: SomaSkillManifest;
}

async function readSomaSkillManifest(skillRoot: string): Promise<SomaSkillManifest | undefined> {
  const raw = await readFile(join(skillRoot, "soma-skill.json"), "utf8").catch(() => undefined);
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as Partial<SomaSkillManifest>;
    if (
      parsed.schema !== "soma.skill.v1"
      || typeof parsed.name !== "string"
    ) {
      return undefined;
    }

    return parsed as SomaSkillManifest;
  } catch {
    return undefined;
  }
}

async function loadAvailableSkills(somaHome: string): Promise<{ skills: AvailableSkill[]; byKey: Map<string, AvailableSkill> }> {
  const skillsRoot = join(somaHome, "skills");
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const byKey = new Map<string, AvailableSkill>();

  const skillCandidates: (AvailableSkill | undefined)[] = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<AvailableSkill | undefined> => {
        const skillRoot = join(skillsRoot, entry.name);
        const skillMd = await readFile(join(skillRoot, "SKILL.md"), "utf8").catch(() => undefined);
        if (!skillMd) return undefined;

        const manifest = await readSomaSkillManifest(skillRoot);
        const manifestName = typeof manifest?.name === "string" && manifest.name.trim().length > 0
          ? manifest.name
          : undefined;
        const name = manifestName ?? frontmatterValue(skillMd, "name", entry.name);
        const description = typeof manifest?.description === "string"
          ? manifest.description
          : frontmatterValue(skillMd, "description", "");
        const manifestTriggers = nonEmptyStrings(manifest?.triggers);
        const triggers = manifestTriggers.length > 0 ? manifestTriggers : sectionBullets(skillMd, "Triggers");

        return { dirName: entry.name, name, description, triggers, manifest };
      }),
  );
  const skills = skillCandidates.filter((skill): skill is AvailableSkill => skill !== undefined);

  for (const skill of skills) {
    byKey.set(normalizeCapabilityKey(skill.name), skill);
    byKey.set(normalizeCapabilityKey(skill.dirName), skill);
    byKey.set(normalizeCapabilityKey(basename(skill.dirName)), skill);
  }

  return { skills, byKey };
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
  contract: AlgorithmCapabilityContract = kind,
): AlgorithmCapabilityDefinition {
  return {
    name,
    kind,
    phases,
    triggerSignals,
    invoke: { contract, target },
  };
}

function isSubstrateSupported(manifest: SomaSkillManifest | undefined, substrate: SubstrateId | undefined): boolean {
  if (!manifest || !substrate) return true;
  if (!Array.isArray(manifest.substrates)) return false;
  return manifest.substrates.includes(substrate);
}

function isCapabilityInvokeKind(value: unknown): value is AlgorithmCapabilityContract & AlgorithmCapabilityKind {
  return typeof value === "string" && CAPABILITY_INVOKE_KINDS.includes(value as (typeof CAPABILITY_INVOKE_KINDS)[number]);
}

function isCapabilityKind(value: unknown): value is AlgorithmCapabilityKind {
  return isCapabilityInvokeKind(value);
}

function isAlgorithmPhase(value: unknown): value is AlgorithmPhase {
  return value === "observe" || value === "think" || value === "plan" || value === "build" || value === "execute" || value === "verify" || value === "learn" || value === "complete";
}

function fallbackTriggerSignals(skill: AvailableSkill): string[] {
  const triggers = skill.triggers.map((trigger) => trigger.trim()).filter((trigger) => trigger.length > 0);
  if (triggers.length > 0) return triggers;

  const description = skill.description.trim();
  return description.length > 0 ? [description] : [skill.name];
}

function skillManifestCapabilityDefinition(skill: AvailableSkill): AlgorithmCapabilityDefinition | undefined {
  const metadata = isRecord(skill.manifest?.algorithmCapability)
    ? skill.manifest.algorithmCapability
    : undefined;
  const kind = isCapabilityKind(metadata?.kind) ? metadata.kind : "skill";
  const phases = Array.isArray(metadata?.phases)
    ? metadata.phases.filter(isAlgorithmPhase)
    : [];
  if (hasOwnField(metadata, "phases") && phases.length === 0) {
    return undefined;
  }
  const triggerSignals = nonEmptyStrings(metadata?.triggerSignals);

  return buildCapabilityDefinition(
    skill.name,
    kind,
    phases.length > 0 ? phases : [...CORE_PHASES],
    triggerSignals.length > 0 ? triggerSignals : fallbackTriggerSignals(skill),
    skill.name,
    kind,
  );
}

function maybeRegisterSkillCapability(
  definitions: Map<string, AlgorithmCapabilityDefinition>,
  unsupported: Set<string>,
  skill: AvailableSkill,
  substrate: SubstrateId | undefined,
  options: { requireManifestCapability: boolean },
): void {
  if (definitions.has(skill.name) || unsupported.has(skill.name)) {
    return;
  }
  if (!isSubstrateSupported(skill.manifest, substrate)) {
    unsupported.add(skill.name);
    return;
  }
  if (options.requireManifestCapability && !isRecord(skill.manifest?.algorithmCapability)) {
    return;
  }

  const definition = skillManifestCapabilityDefinition(skill);
  if (!definition) {
    unsupported.add(skill.name);
    return;
  }
  definitions.set(definition.name, definition);
}

export async function loadSomaHomeAlgorithmCapabilityRegistry(
  options: SomaHomeAlgorithmCapabilityOptions = {},
): Promise<SomaHomeAlgorithmCapabilityRegistry> {
  const somaHome = resolveSomaHome(options);
  const referencePath = join(somaHome, "skills", "the-algorithm", "references", "capabilities.md");
  const markdown = await readFile(referencePath, "utf8").catch(() => "");
  const availableSkills = await loadAvailableSkills(somaHome);
  const definitions = new Map<string, AlgorithmCapabilityDefinition>();
  const unsupported = new Set<string>();

  for (const skill of availableSkills.skills) {
    maybeRegisterSkillCapability(definitions, unsupported, skill, options.substrate, { requireManifestCapability: true });
  }

  for (const row of markdown ? parseMarkdownTableRows(markdown) : []) {
    const name = stripCapabilityLabel(row[0] ?? "");
    const phaseCell = row[1] ?? "";
    const triggerCell = row.length >= 5 ? row[2] ?? "" : row[1] ?? "";
    const invokeCell = row.length >= 5 ? row[3] ?? "" : row[2] ?? "";

    if (!name) continue;
    if (definitions.has(name) || unsupported.has(name)) continue;

    const phases = parsePhaseCell(phaseCell, row.length >= 5 ? ["think"] : ["plan"]);
    const triggerSignals = [stripMarkdownEmphasis(triggerCell)].filter((signal) => signal.length > 0);
    const skillTarget = skillInvocationTarget(invokeCell);
    const agentTarget = agentInvocationTarget(invokeCell, name);
    const commandTarget = commandInvocationTarget(invokeCell);
    const inlineTarget = inlineInvocationTarget(invokeCell);

    if (skillTarget) {
      const targetSkill = availableSkills.byKey.get(normalizeCapabilityKey(skillTarget));
      if (!targetSkill) {
        unsupported.add(name);
        continue;
      }
      if (!isSubstrateSupported(targetSkill.manifest, options.substrate)) {
        unsupported.add(name);
        continue;
      }

      definitions.set(name, buildCapabilityDefinition(name, "skill", phases, triggerSignals, targetSkill.name));
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

  for (const skill of availableSkills.skills) {
    maybeRegisterSkillCapability(definitions, unsupported, skill, options.substrate, { requireManifestCapability: false });
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

  const next = {
    ...run,
    updatedAt: timestamp,
    capabilities: dedupeCapabilities(run.capabilities, name),
    capabilitySelections: selections.map((selection, index) =>
      index === selectionIndex
        ? {
            ...selection,
            status: "invoked" as const,
            invocation,
          }
        : selection,
    ),
  };
  return appendAlgorithmProvenance(next, {
    timestamp,
    phase: getRunPhase(run),
    operation: "capability.invoke",
    substrate: invocation.substrate,
    detail: name,
  });
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
