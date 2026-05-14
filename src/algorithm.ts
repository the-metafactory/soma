import type {
  AlgorithmLogEntry,
  AlgorithmBatchOperation,
  AlgorithmPhase,
  AlgorithmPlanStep,
  AlgorithmRun,
  AlgorithmRunInput,
  IdealStateCriterion,
} from "./types";
import { classifyAlgorithmPrompt } from "./algorithm-classifier";

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

  return {
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
    phase: "observe",
    isa: {
      slug: input.id ?? "algorithm-run",
      phase: "observe",
      goal: input.goal,
      criteria,
    },
    antiCriteria: (input.antiCriteria ?? []).map(criterionFromInput),
    capabilities: [],
    planSteps: [],
    decisions: [logEntry("observe", `Intent: ${input.intent}`, timestamp)],
    changelog: [],
    verification: [],
    learning: [],
  };
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

  for (const capability of capabilities) {
    assertNonEmpty(capability, "capability");
  }

  return {
    ...run,
    updatedAt: timestamp ?? new Date().toISOString(),
    capabilities: Array.from(new Set([...run.capabilities, ...capabilities])),
  };
}

export function setAlgorithmPlan(run: AlgorithmRun, planSteps: AlgorithmPlanStep[], timestamp?: string): AlgorithmRun {
  if (planSteps.length === 0) {
    throw new Error("Algorithm plan requires at least one step.");
  }

  uniqueIds(planSteps, "plan step");

  for (const step of planSteps) {
    assertNonEmpty(step.text, `plan step ${step.id} text`);

    if (step.criteriaIds.length === 0) {
      throw new Error(`Algorithm plan step ${step.id} must map to at least one criterion.`);
    }

    for (const criterionId of step.criteriaIds) {
      const exists = run.isa.criteria.some((criterion) => criterion.id === criterionId);

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
  const entry = logEntry(run.phase, text, timestamp);

  return {
    ...run,
    updatedAt: entry.timestamp,
    changelog: [...run.changelog, entry],
  };
}

export function recordAlgorithmDecision(run: AlgorithmRun, text: string, timestamp?: string): AlgorithmRun {
  const entry = logEntry(run.phase, text, timestamp);

  return {
    ...run,
    updatedAt: entry.timestamp,
    decisions: [...run.decisions, entry],
  };
}

export function recordAlgorithmLearning(run: AlgorithmRun, text: string, timestamp?: string): AlgorithmRun {
  const entry = logEntry(run.phase, text, timestamp);

  return {
    ...run,
    updatedAt: entry.timestamp,
    learning: [...run.learning, entry],
  };
}

export function verifyAlgorithmCriterion(
  run: AlgorithmRun,
  criterionId: string,
  status: "passed" | "failed" | "dropped",
  evidence: string,
  timestamp?: string,
): AlgorithmRun {
  assertNonEmpty(evidence, "verification evidence");

  const criteria = run.isa.criteria.map((criterion) => {
    if (criterion.id !== criterionId) {
      return criterion;
    }

    return {
      ...criterion,
      status,
      verification: evidence,
    };
  });

  if (!criteria.some((criterion) => criterion.id === criterionId)) {
    throw new Error(`Algorithm criterion not found: ${criterionId}`);
  }

  const entry = logEntry(run.phase, `${criterionId}: ${status}. ${evidence}`, timestamp);

  return {
    ...run,
    updatedAt: entry.timestamp,
    isa: {
      ...run.isa,
      criteria,
    },
    verification: [...run.verification, entry],
  };
}

function assertGate(run: AlgorithmRun, target: AlgorithmPhase): void {
  switch (target) {
    case "think":
      if (run.isa.criteria.length === 0) {
        throw new Error("Algorithm cannot enter THINK without criteria.");
      }
      break;
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
    case "learn":
      if (!run.isa.criteria.every((criterion) => criterion.status === "passed" || criterion.status === "dropped")) {
        throw new Error("Algorithm cannot enter LEARN until every criterion is passed or dropped.");
      }
      break;
    case "complete":
      if (run.learning.length === 0) {
        throw new Error("Algorithm cannot COMPLETE without a learning entry.");
      }
      break;
    case "observe":
      throw new Error("Algorithm cannot transition back to OBSERVE.");
  }
}

export function advanceAlgorithmRun(run: AlgorithmRun, timestamp = new Date().toISOString()): AlgorithmRun {
  const target = nextAlgorithmPhase(run.phase);

  if (!target) {
    throw new Error("Algorithm run is already complete.");
  }

  assertGate(run, target);

  return {
    ...run,
    updatedAt: timestamp,
    phase: target,
    isa: {
      ...run.isa,
      phase: target,
    },
  };
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

export function applyAlgorithmBatch(run: AlgorithmRun, operations: AlgorithmBatchOperation[]): AlgorithmRun {
  if (operations.length === 0) {
    throw new Error("Algorithm batch requires at least one operation.");
  }

  return operations.reduce((current, operation) => {
    switch (operation.kind) {
      case "decision":
        return recordAlgorithmDecision(current, operation.text);
      case "change":
        return recordAlgorithmChange(current, operation.text);
      case "learn":
        return recordAlgorithmLearning(current, operation.text);
      case "step":
        return updateAlgorithmPlanStep(current, operation.stepId, operation.status, operation.evidence);
      case "verify":
        return verifyAlgorithmCriterion(current, operation.criterionId, operation.status, operation.evidence);
      case "capability":
        return addAlgorithmCapabilities(current, [operation.capability]);
      case "advance":
        return advanceAlgorithmRun(current);
      default:
        operation satisfies never;
        return current;
    }
  }, run);
}

export function algorithmPhaseOrder(): AlgorithmPhase[] {
  return [...PHASES];
}
