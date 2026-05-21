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
  const reason = input.reason?.trim() || `Selected ${definition.name} for ${phase}.`;
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
