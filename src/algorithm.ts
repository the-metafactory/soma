import type {
  AlgorithmGatesFired,
  AlgorithmLogEntry,
  AlgorithmBatchOperation,
  AlgorithmMetaReflection,
  AlgorithmObservation,
  AlgorithmPhase,
  AlgorithmPlanStep,
  AlgorithmRun,
  AlgorithmRunInput,
  EvidenceKind,
  IdealStateArtifact,
  IdealStateCriterion,
} from "./types";
import {
  assertAlgorithmCapabilitiesSatisfied,
  recordAlgorithmCapabilityInvocation,
  removeAlgorithmCapabilitySelection,
  selectAlgorithmCapability,
} from "./algorithm-capabilities";
import { classifyAlgorithmPrompt } from "./algorithm-classifier";
import {
  buildIsaArtifact,
  defaultEvidenceKind,
  getCriteria,
  isClosedCriterion,
  isHollowPass,
  progressFromCriteria,
  updateCriterionWithResult,
  verifiedFromCriteria,
} from "./isa-accessors";

/**
 * The criteria that block entry to LEARN, split by reason. Single source of truth
 * for the Algorithm's LEARN-gate policy — both the assertGate guard and sync's
 * reachability check call this so the two cannot drift when a future evidence rule
 * is added. Composes the pure isa-accessor predicates; gate policy lives here in
 * the Algorithm module, not in the structural accessor layer.
 */
export function learnGateViolations(criteria: readonly IdealStateCriterion[]): {
  unresolved: IdealStateCriterion[];
  hollow: IdealStateCriterion[];
} {
  return {
    unresolved: criteria.filter((criterion) => !isClosedCriterion(criterion)),
    hollow: criteria.filter(isHollowPass),
  };
}

/**
 * The OBSERVE→THINK floor: a current-state probe is an observation the caller
 * asserts was obtained by `probed` or `tested` evidence — not `specified`. A
 * `specified` observation only restates a spec, so it never clears the floor.
 * Single source of truth for the OBSERVE gate; both the assertGate guard and
 * sync's prepareAndAdvance consult it so the two cannot drift.
 */
export function hasCurrentStateProbe(observations: readonly AlgorithmObservation[]): boolean {
  return observations.some((observation) => observation.evidenceKind === "probed" || observation.evidenceKind === "tested");
}
import { getRunPhase } from "./algorithm-lifecycle";
import { DEFAULT_ALGORITHM_LOOP_STATE } from "./algorithm-execution-modes";
import { appendAlgorithmProvenance } from "./algorithm-provenance";
import type { AlgorithmProvenanceInput } from "./algorithm-provenance";

const PHASES: AlgorithmPhase[] = ["observe", "think", "plan", "build", "execute", "verify", "learn", "complete"];

function createRunId(timestamp: string): string {
  const date = timestamp.slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().slice(0, 8);

  return `${date}_alg_${suffix}`;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Algorithm ${field} must not be empty.`);
  }
}

function uniqueIds(criteria: { id: string }[], field: string): void {
  const ids = new Set<string>();

  for (const criterion of criteria) {
    assertNonEmpty(criterion.id, `${field} id`);

    if (ids.has(criterion.id)) {
      throw new Error(`Algorithm ${field} id is duplicated: ${criterion.id}`);
    }

    ids.add(criterion.id);
  }
}

function criterionFromInput(input: { id: string; text: string; verification?: string }): IdealStateCriterion {
  assertNonEmpty(input.text, `criterion ${input.id} text`);

  return {
    id: input.id,
    text: input.text,
    status: "open",
    verification: input.verification,
  };
}

function logEntry(phase: AlgorithmPhase, text: string, timestamp = new Date().toISOString()): AlgorithmLogEntry {
  assertNonEmpty(text, "log entry");

  return {
    timestamp,
    phase,
    text,
  };
}

export function createAlgorithmRun(input: AlgorithmRunInput): AlgorithmRun {
  assertNonEmpty(input.prompt, "prompt");
  assertNonEmpty(input.intent, "intent");
  assertNonEmpty(input.currentState, "current state");
  assertNonEmpty(input.goal, "goal");

  if (input.criteria.length === 0) {
    throw new Error("Algorithm run requires at least one criterion.");
  }

  uniqueIds(input.criteria, "criterion");
  uniqueIds(input.antiCriteria ?? [], "anti-criterion");

  const timestamp = input.timestamp ?? new Date().toISOString();
  const criteria = input.criteria.map(criterionFromInput);
  const classification = classifyAlgorithmPrompt(input.prompt);
  const effort = input.effort ?? classification.effort ?? "E1";
  const effortSource = input.effortSource ?? (input.effort ? "explicit" : classification.source);
  const mode = input.mode ?? "algorithm";
  const classificationReason = input.classificationReason ?? classification.reason;
  const slug = input.id ?? "algorithm-run";

  const run: AlgorithmRun = {
    schemaVersion: 2,
    id: input.id ?? createRunId(timestamp),
    createdAt: timestamp,
    updatedAt: timestamp,
    substrate: input.substrate,
    prompt: input.prompt,
    intent: input.intent,
    effort,
    effortSource,
    mode,
    classificationReason,
    currentState: input.currentState,
    loop: { ...DEFAULT_ALGORITHM_LOOP_STATE, iterations: [] },
    isa: buildIsaArtifact({
      slug,
      task: input.intent,
      goal: input.goal,
      criteria,
      effort,
      mode,
      timestamp,
    }),
    antiCriteria: (input.antiCriteria ?? []).map(criterionFromInput),
    capabilities: [],
    capabilityDefinitions: [],
    capabilitySelections: [],
    planSteps: [],
    decisions: [logEntry("observe", `Intent: ${input.intent}`, timestamp)],
    observations: [],
    changelog: [],
    verification: [],
    learning: [],
    metaReflection: [],
    provenance: [],
  };
  return input.substrate
    ? appendAlgorithmProvenance(run, {
        timestamp,
        operation: "run.created",
        substrate: input.substrate,
        phase: "observe",
      })
    : run;
}

export function nextAlgorithmPhase(phase: AlgorithmPhase): AlgorithmPhase | undefined {
  const index = PHASES.indexOf(phase);

  if (index === -1 || index === PHASES.length - 1) {
    return undefined;
  }

  return PHASES[index + 1];
}

export function addAlgorithmCapabilities(run: AlgorithmRun, capabilities: string[], timestamp?: string): AlgorithmRun {
  if (capabilities.length === 0) {
    throw new Error("Algorithm capabilities update requires at least one capability.");
  }

  return capabilities.reduce(
    (current, capability) => selectAlgorithmCapability(current, { name: capability }, timestamp),
    run,
  );
}

export function setAlgorithmPlan(run: AlgorithmRun, planSteps: AlgorithmPlanStep[], timestamp?: string): AlgorithmRun {
  if (planSteps.length === 0) {
    throw new Error("Algorithm plan requires at least one step.");
  }

  uniqueIds(planSteps, "plan step");

  const criteria = getCriteria(run.isa);

  for (const step of planSteps) {
    assertNonEmpty(step.text, `plan step ${step.id} text`);

    if (step.criteriaIds.length === 0) {
      throw new Error(`Algorithm plan step ${step.id} must map to at least one criterion.`);
    }

    for (const criterionId of step.criteriaIds) {
      const exists = criteria.some((criterion) => criterion.id === criterionId);

      if (!exists) {
        throw new Error(`Algorithm plan step ${step.id} references unknown criterion: ${criterionId}`);
      }
    }
  }

  return {
    ...run,
    updatedAt: timestamp ?? new Date().toISOString(),
    planSteps,
  };
}

export function recordAlgorithmChange(run: AlgorithmRun, text: string, timestamp?: string): AlgorithmRun {
  const entry = logEntry(getRunPhase(run), text, timestamp);

  return {
    ...run,
    updatedAt: entry.timestamp,
    changelog: [...run.changelog, entry],
  };
}

export function recordAlgorithmDecision(run: AlgorithmRun, text: string, timestamp?: string): AlgorithmRun {
  const entry = logEntry(getRunPhase(run), text, timestamp);

  return {
    ...run,
    updatedAt: entry.timestamp,
    decisions: [...run.decisions, entry],
  };
}

export function recordAlgorithmObservation(
  run: AlgorithmRun,
  observation: { claim: string; evidence: string; evidenceKind: EvidenceKind },
  timestamp?: string,
  provenance?: Pick<AlgorithmProvenanceInput, "substrate">,
): AlgorithmRun {
  assertNonEmpty(observation.claim, "observation claim");
  assertNonEmpty(observation.evidence, "observation evidence");

  const stamp = timestamp ?? new Date().toISOString();
  const entry: AlgorithmObservation = {
    timestamp: stamp,
    claim: observation.claim,
    evidence: observation.evidence,
    evidenceKind: observation.evidenceKind,
  };

  const next = {
    ...run,
    updatedAt: stamp,
    observations: [...run.observations, entry],
  };
  return appendAlgorithmProvenance(next, {
    timestamp: stamp,
    phase: getRunPhase(run),
    operation: "observation.record",
    substrate: provenance?.substrate,
    detail: observation.claim,
  });
}

/**
 * Compute the deterministic gate-flags for a run — the auditable spine of a
 * meta-reflection. Reuses the same predicates the live gates enforce so the
 * reflection can never disagree with what the gates would say.
 */
export function computeGatesFired(run: AlgorithmRun): AlgorithmGatesFired {
  const criteria = getCriteria(run.isa);
  const { unresolved, hollow } = learnGateViolations(criteria);
  return {
    currentStateFloor: hasCurrentStateProbe(run.observations),
    learnGateClean: criteria.length > 0 && unresolved.length === 0 && hollow.length === 0,
    completeness: criteria.length > 0 && criteria.every(isClosedCriterion),
  };
}

/**
 * Record a per-run meta-reflection (#333). `gatesFired` is computed from the run
 * (deterministic); `smarterRun`/`satisfaction`/`withinBudget` are the caller's
 * (model's) proposal. At least one `smarterRun` signal must be present — an empty
 * reflection carries no improvement signal.
 */
export function recordAlgorithmMetaReflection(
  run: AlgorithmRun,
  reflection: {
    smarterRun: AlgorithmMetaReflection["smarterRun"];
    satisfaction?: number;
    withinBudget?: boolean;
  },
  timestamp?: string,
  provenance?: Pick<AlgorithmProvenanceInput, "substrate">,
): AlgorithmRun {
  const { missedEarlyStep, missedVerifyOrParallel, highestValueMove } = reflection.smarterRun;
  if (![missedEarlyStep, missedVerifyOrParallel, highestValueMove].some((s) => s !== undefined && s.trim().length > 0)) {
    throw new Error("Algorithm meta-reflection requires at least one smarterRun signal (missedEarlyStep, missedVerifyOrParallel, or highestValueMove).");
  }
  if (reflection.satisfaction !== undefined && (reflection.satisfaction < 0 || reflection.satisfaction > 10)) {
    throw new Error("Algorithm meta-reflection satisfaction must be between 0 and 10.");
  }

  const stamp = timestamp ?? new Date().toISOString();
  const phase = getRunPhase(run);
  const entry: AlgorithmMetaReflection = {
    timestamp: stamp,
    phase,
    gatesFired: computeGatesFired(run),
    smarterRun: {
      ...(missedEarlyStep?.trim() ? { missedEarlyStep: missedEarlyStep.trim() } : {}),
      ...(missedVerifyOrParallel?.trim() ? { missedVerifyOrParallel: missedVerifyOrParallel.trim() } : {}),
      ...(highestValueMove?.trim() ? { highestValueMove: highestValueMove.trim() } : {}),
    },
    ...(reflection.satisfaction !== undefined ? { satisfaction: reflection.satisfaction } : {}),
    ...(reflection.withinBudget !== undefined ? { withinBudget: reflection.withinBudget } : {}),
  };

  const next = {
    ...run,
    updatedAt: stamp,
    metaReflection: [...run.metaReflection, entry],
  };
  return appendAlgorithmProvenance(next, {
    timestamp: stamp,
    phase,
    operation: "reflection.record",
    substrate: provenance?.substrate,
  });
}

export function recordAlgorithmLearning(
  run: AlgorithmRun,
  text: string,
  timestamp?: string,
  provenance?: Pick<AlgorithmProvenanceInput, "substrate">,
): AlgorithmRun {
  const entry = logEntry(getRunPhase(run), text, timestamp);

  const next = {
    ...run,
    updatedAt: entry.timestamp,
    learning: [...run.learning, entry],
  };
  return appendAlgorithmProvenance(next, {
    timestamp: entry.timestamp,
    phase: entry.phase,
    operation: "learning.record",
    substrate: provenance?.substrate,
  });
}

export function verifyAlgorithmCriterion(
  run: AlgorithmRun,
  criterionId: string,
  status: "passed" | "failed" | "dropped" | "deferred-probe",
  evidence: string,
  timestamp?: string,
  provenance?: Pick<AlgorithmProvenanceInput, "substrate">,
  evidenceKind?: IdealStateCriterion["evidenceKind"],
): AlgorithmRun {
  assertNonEmpty(evidence, "verification evidence");

  const { isa: isaWithSection, criteria: updatedCriteria } = updateCriterionWithResult(
    run.isa,
    criterionId,
    status,
    evidence,
    evidenceKind,
  );
  const entry = logEntry(getRunPhase(run), `${criterionId}: ${status}. ${evidence}`, timestamp);
  const isaWithRecompute: IdealStateArtifact = {
    ...isaWithSection,
    frontmatter: {
      ...isaWithSection.frontmatter,
      progress: progressFromCriteria(updatedCriteria),
      verified: verifiedFromCriteria(updatedCriteria),
      updated: entry.timestamp,
    },
  };

  const next = {
    ...run,
    updatedAt: entry.timestamp,
    isa: isaWithRecompute,
    verification: [...run.verification, entry],
  };
  return appendAlgorithmProvenance(next, {
    timestamp: entry.timestamp,
    phase: entry.phase,
    operation: "criterion.verify",
    substrate: provenance?.substrate,
    detail: criterionId,
  });
}

function assertGate(run: AlgorithmRun, target: AlgorithmPhase): void {
  switch (target) {
    case "think": {
      const criteria = getCriteria(run.isa);
      if (criteria.length === 0) {
        throw new Error("Algorithm cannot enter THINK without criteria.");
      }
      // OBSERVE current-state floor: 63% of real runs stalled at OBSERVE or
      // advanced on unverified assumptions. Require ≥1 current-state probe
      // (probed/tested), not a 'specified' spec-restatement. Caller-asserted —
      // necessary, not sufficient: it makes skipping the floor explicit, it does
      // not confirm the probe happened.
      if (!hasCurrentStateProbe(run.observations)) {
        throw new Error(
          "Algorithm cannot enter THINK without a current-state probe. Record an observation with probed/tested evidence (soma algorithm observe).",
        );
      }
      break;
    }
    case "plan":
      if (run.capabilities.length === 0) {
        throw new Error("Algorithm cannot enter PLAN without selected capabilities.");
      }
      break;
    case "build":
      if (run.planSteps.length === 0) {
        throw new Error("Algorithm cannot enter BUILD without a criterion-mapped plan.");
      }
      break;
    case "execute":
      if (run.changelog.length === 0) {
        throw new Error("Algorithm cannot enter EXECUTE without recorded build changes.");
      }
      break;
    case "verify":
      if (!run.planSteps.every((step) => step.status === "done" || step.status === "blocked")) {
        throw new Error("Algorithm cannot enter VERIFY until every plan step is done or blocked.");
      }
      break;
    case "learn": {
      const { unresolved, hollow } = learnGateViolations(getCriteria(run.isa));
      if (unresolved.length > 0) {
        throw new Error(
          `Algorithm cannot enter LEARN until every criterion is passed, dropped, or deferred-probe. Unresolved: ${unresolved.map((c) => c.id).join(", ")}.`,
        );
      }
      // Integrity gate: a 'passed' criterion verified by specification only is a
      // self-attested claim, not a real probe. Probe it (probed/tested) or mark it
      // deferred-probe.
      if (hollow.length > 0) {
        throw new Error(
          `Algorithm cannot enter LEARN: criteria verified by specification only — probe them (probed/tested) or mark deferred-probe: ${hollow.map((c) => c.id).join(", ")}.`,
        );
      }
      break;
    }
    case "complete":
      assertAlgorithmCapabilitiesSatisfied(run);
      if (run.learning.length === 0) {
        throw new Error("Algorithm cannot COMPLETE without a learning entry.");
      }
      break;
    case "observe":
      throw new Error("Algorithm cannot transition back to OBSERVE.");
    case "abandoned":
      // abandoned is terminal — only reachable through abandonAlgorithmRun, never via advanceAlgorithmRun.
      throw new Error("Algorithm cannot advance to ABANDONED; use abandonAlgorithmRun.");
  }
}

export function advanceAlgorithmRun(
  run: AlgorithmRun,
  timestamp = new Date().toISOString(),
  provenance?: Pick<AlgorithmProvenanceInput, "substrate">,
): AlgorithmRun {
  const current = getRunPhase(run);
  if (current === "abandoned") {
    throw new Error("Algorithm run was abandoned and cannot advance.");
  }

  const target = nextAlgorithmPhase(current);

  if (!target) {
    throw new Error("Algorithm run is already complete.");
  }

  assertGate(run, target);

  const next = {
    ...run,
    updatedAt: timestamp,
    isa: {
      ...run.isa,
      frontmatter: {
        ...run.isa.frontmatter,
        phase: target,
        updated: timestamp,
      },
    },
  };
  return appendAlgorithmProvenance(next, {
    timestamp,
    phase: target,
    operation: "phase.advance",
    substrate: provenance?.substrate,
  });
}

export function advanceAlgorithmRunUntil(
  run: AlgorithmRun,
  untilPhase: AlgorithmPhase,
  timestamp = new Date().toISOString(),
  provenance?: Pick<AlgorithmProvenanceInput, "substrate">,
): AlgorithmRun {
  const targetIndex = PHASES.indexOf(untilPhase);
  if (targetIndex === -1 || untilPhase === "abandoned") {
    throw new Error(`Algorithm handoff boundary must be one of ${PHASES.join(", ")}.`);
  }

  const currentIndex = PHASES.indexOf(getRunPhase(run));
  if (currentIndex === -1) {
    throw new Error("Algorithm run was abandoned and cannot advance.");
  }
  if (currentIndex > targetIndex) {
    throw new Error(`Algorithm run is already past handoff boundary ${untilPhase}.`);
  }

  let next = run;
  while (PHASES.indexOf(getRunPhase(next)) < targetIndex) {
    next = advanceAlgorithmRun(next, timestamp, provenance);
  }

  return next;
}

export function updateAlgorithmPlanStep(
  run: AlgorithmRun,
  stepId: string,
  status: AlgorithmPlanStep["status"],
  evidence?: string,
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  const stepIndex = run.planSteps.findIndex((step) => step.id === stepId);

  if (stepIndex === -1) {
    throw new Error(`Algorithm plan step not found: ${stepId}`);
  }

  const planSteps = run.planSteps.map((step, index) =>
    index === stepIndex
      ? {
          ...step,
          status,
          evidence,
        }
      : step,
  );

  return {
    ...run,
    updatedAt: timestamp,
    planSteps,
  };
}

export function applyAlgorithmBatch(
  run: AlgorithmRun,
  operations: AlgorithmBatchOperation[],
  timestamp = new Date().toISOString(),
  provenance?: Pick<AlgorithmProvenanceInput, "substrate">,
): AlgorithmRun {
  if (operations.length === 0) {
    throw new Error("Algorithm batch requires at least one operation.");
  }

  return operations.reduce((current, operation) => {
    switch (operation.kind) {
      case "decision":
        return recordAlgorithmDecision(current, operation.text, timestamp);
      case "observe":
        return recordAlgorithmObservation(
          current,
          { claim: operation.claim, evidence: operation.evidence, evidenceKind: operation.evidenceKind },
          timestamp,
          provenance,
        );
      case "change":
        return recordAlgorithmChange(current, operation.text, timestamp);
      case "learn":
        return recordAlgorithmLearning(current, operation.text, timestamp, provenance);
      case "step":
        return updateAlgorithmPlanStep(current, operation.stepId, operation.status, operation.evidence, timestamp);
      case "verify":
        return verifyAlgorithmCriterion(
          current,
          operation.criterionId,
          operation.status,
          operation.evidence,
          timestamp,
          provenance,
          defaultEvidenceKind(operation.evidenceKind, operation.status),
        );
      case "capability":
        return selectAlgorithmCapability(current, {
          name: operation.capability,
          phase: operation.phase,
          reason: operation.reason,
        }, timestamp);
      case "capability-invocation":
        return recordAlgorithmCapabilityInvocation(current, {
          name: operation.capability,
          substrate: operation.substrate ?? provenance?.substrate,
          evidence: operation.evidence,
        }, timestamp);
      case "capability-removal":
        return removeAlgorithmCapabilitySelection(current, {
          name: operation.capability,
          reason: operation.reason,
        }, timestamp);
      case "advance":
        return advanceAlgorithmRun(current, timestamp, provenance);
      default:
        operation satisfies never;
        return current;
    }
  }, run);
}

export function algorithmPhaseOrder(): AlgorithmPhase[] {
  return [...PHASES];
}
