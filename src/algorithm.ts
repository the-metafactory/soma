import type {
  AlgorithmGatesFired,
  AlgorithmLogEntry,
  AlgorithmBatchOperation,
  AlgorithmMetaReflection,
  AlgorithmObservation,
  AlgorithmPhase,
  AlgorithmPlanStep,
  AlgorithmReference,
  AlgorithmReferenceVerdict,
  AlgorithmRun,
  AlgorithmRunInput,
  EvidenceKind,
  VerificationStateArtifact,
  Checkpoint,
} from "./types";
import {
  assertAlgorithmCapabilitiesSatisfied,
  recordAlgorithmCapabilityInvocation,
  removeAlgorithmCapabilitySelection,
  selectAlgorithmCapability,
} from "./algorithm-capabilities";
// The narrow report type the graph publishes for §2.7 — declared THERE, so the
// graph owns the shape it publishes and this module names a contract rather than
// a `NodeState`. Type-only: no runtime dependency on the graph from this pure module.
import type { BridgedNodeReport } from "./work-graph";
import { classifyAlgorithmPrompt } from "./algorithm-classifier";
import {
  DECISION_REFERENCE_LETTER,
  ReservedReferenceLetterError,
  isReservedReferenceLetter,
  requireReferenceCode,
} from "./communication-contract";
import { compactSmarterRun } from "./algorithm-reflection-digest";
import {
  buildVsaArtifact,
  defaultEvidenceKind,
  getCriteria,
  isClosedCriterion,
  isHollowPass,
  progressFromCriteria,
  updateCriterionWithResult,
  verificationGateViolation,
  verifiedFromCriteria,
} from "./vsa-accessors";

/**
 * The criteria that block entry to LEARN, split by reason. Single source of truth
 * for the Algorithm's LEARN-gate policy — both the assertGate guard and sync's
 * reachability check call this so the two cannot drift when a future evidence rule
 * is added. Composes the pure vsa-accessor predicates; gate policy lives here in
 * the Algorithm module, not in the structural accessor layer.
 */
export function learnGateViolations(criteria: readonly Checkpoint[]): {
  unresolved: Checkpoint[];
  hollow: Checkpoint[];
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

function criterionFromInput(input: { id: string; text: string; verification?: string }): Checkpoint {
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
    schemaVersion: 3,
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
    vsa: buildVsaArtifact({
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

  const criteria = getCriteria(run.vsa);

  for (const step of planSteps) {
    assertNonEmpty(step.text, `plan step ${step.id} text`);

    // §2.7, incoming direction: this call replaces `planSteps[]` wholesale with
    // caller-authored status, so accepting a `nodeId` here would author a bridged
    // step whose status never came from its node. Bridging goes through
    // `syncBridgedPlanStep`, where binding and deriving are one act.
    if (step.nodeId !== undefined) {
      throw new Error(
        `Algorithm plan step ${step.id} cannot be bridged to work-graph node ${step.nodeId} by setAlgorithmPlan: a bridged step's status must be derived from its node. Plan the step unbridged, then bridge it with syncBridgedPlanStep.`,
      );
    }

    // …and the outgoing direction: an unbridged step reusing a bridged step's id
    // drops the bridge in place, after which `updateAlgorithmPlanStep` accepts a
    // hand-written `done` on what a reader still believes is node-derived.
    //
    // This is a SPEED BUMP, not a seal, and the distinction is load-bearing:
    // removing the step in one call and re-adding it unbridged in the next
    // reproduces the same end state, and nothing here can see across two calls.
    // What it buys is that un-bridging cannot happen *incidentally* — a re-plan
    // that happens to omit a `nodeId` is caught, rather than quietly demoting a
    // step's authority. Deliberately unbridging still works, and the end state is
    // honest: the step no longer claims a node backs it.
    const existing = run.planSteps.find((current) => current.id === step.id);
    if (existing?.nodeId !== undefined) {
      throw new Error(
        `Algorithm plan step ${step.id} is bridged to work-graph node ${existing.nodeId}; setAlgorithmPlan cannot un-bridge it in place. A bridged step cannot be re-planned at all — omit it to remove it, then plan it afresh if you want it run-owned.`,
      );
    }

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

/**
 * Record a conversational reference point (`F1`, `O2`, `D3`) against the run.
 *
 * Three rules, each closing a way the code space could stop meaning anything:
 *  - The letter may not be `C` or `P` — those are VSA criteria and plan steps,
 *    and an overloaded letter makes "keep C1" ambiguous between a criterion and
 *    a chat finding.
 *  - A code is unique within a run. Reusing `F1` for a second finding would
 *    silently break the one property that makes the code usable: that it still
 *    points at the same thing later in the conversation.
 *  - A `D` code ALSO appends to `run.decisions`. Decisions already have a
 *    durable home; a parallel one would let `soma algorithm show` disagree with
 *    itself about what was decided.
 */
export function recordAlgorithmReference(
  run: AlgorithmRun,
  input: { code: string; text: string; label?: string },
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  assertNonEmpty(input.text, "reference text");

  const { code, letter, ordinal } = requireReferenceCode(input.code);
  if (isReservedReferenceLetter(letter)) {
    throw new ReservedReferenceLetterError(letter);
  }

  const existing = getAlgorithmReferences(run);
  if (existing.some((reference) => reference.code === code)) {
    throw new Error(`Algorithm reference ${code} already exists in run ${run.id} — codes are stable within a run.`);
  }

  const reference: AlgorithmReference = {
    code,
    letter,
    ordinal,
    ...(input.label === undefined || input.label.trim() === "" ? {} : { label: input.label.trim() }),
    text: input.text.trim(),
    createdAt: timestamp,
    phase: getRunPhase(run),
  };

  const withReference: AlgorithmRun = {
    ...run,
    updatedAt: timestamp,
    references: [...existing, reference],
  };

  return letter === DECISION_REFERENCE_LETTER
    ? recordAlgorithmDecision(withReference, `${code}: ${reference.text}`, timestamp)
    : withReference;
}

/**
 * Resolve a reference the principal addressed by code (`keep D1`,
 * `reject O2`). Re-resolving is allowed and overwrites — a decision revisited
 * later is a real event, and refusing it would push the correction back into
 * prose where nothing can read it.
 */
export function resolveAlgorithmReference(
  run: AlgorithmRun,
  input: { code: string; verdict: AlgorithmReferenceVerdict; note?: string },
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  const { code, letter } = requireReferenceCode(input.code);
  const existing = getAlgorithmReferences(run);
  const target = existing.find((reference) => reference.code === code);
  if (target === undefined) {
    throw new Error(`Algorithm reference ${code} does not exist in run ${run.id}.`);
  }

  const note = input.note?.trim();
  // `verdictNote` is dropped before the new one is applied, not merged over:
  // re-resolving `rejected -> kept` with no note must not leave the rejection's
  // rationale attached to a verdict that now says the opposite.
  const { verdictNote: _previousNote, ...withoutNote } = target;
  void _previousNote;
  const resolved: AlgorithmReference = {
    ...withoutNote,
    verdict: input.verdict,
    ...(note === undefined || note === "" ? {} : { verdictNote: note }),
    resolvedAt: timestamp,
  };

  const withResolution: AlgorithmRun = {
    ...run,
    updatedAt: timestamp,
    references: existing.map((reference) => (reference.code === code ? resolved : reference)),
  };

  // A resolved decision is itself a decision — record the verdict so the
  // decisions log carries the outcome, not only the proposal.
  return letter === DECISION_REFERENCE_LETTER
    ? recordAlgorithmDecision(
        withResolution,
        `${code} ${input.verdict}${note === undefined || note === "" ? "" : `: ${note}`}`,
        timestamp,
      )
    : withResolution;
}

/** The run's reference points, `[]` for runs written before they existed. */
export function getAlgorithmReferences(run: AlgorithmRun): AlgorithmReference[] {
  return run.references ?? [];
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
 * Compute the gate-flags for a run — the auditable spine of a meta-reflection.
 * Reuses the same predicates the live gates enforce, so it agrees with the gate's
 * verdict FOR THE RUN AS PASSED. The reflection then stores this as a snapshot at
 * reflect time; a later criterion/observation mutation can move the run, so a
 * stored snapshot is a point-in-time fact, not a standing equivalence with the
 * gate's verdict at every later moment.
 */
export function computeGatesFired(run: AlgorithmRun): AlgorithmGatesFired {
  const criteria = getCriteria(run.vsa);
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
  const smarterRun = compactSmarterRun(reflection.smarterRun);
  if (Object.keys(smarterRun).length === 0) {
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
    smarterRun,
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

/**
 * Thrown when the record-time VerificationGate refuses a hollow `passed`.
 * Typed (not a bare Error) so IO layers can observe the refusal: a gate firing
 * is the single most on-mission telemetry signal the harness produces — an
 * attempted unverified "done" — and the 2026-07-10 proxy-drift audit found it
 * was being detected and then discarded. The CLI emits a
 * `verification.gate_violation` memory event from this error's fields; the
 * core stays pure (no IO here).
 */
export class VerificationGateError extends Error {
  readonly criterionId: string;
  readonly reason: "rote_evidence" | "specification_only";
  readonly evidenceKind: Checkpoint["evidenceKind"] | undefined;

  constructor(input: {
    criterionId: string;
    reason: "rote_evidence" | "specification_only";
    message: string;
    evidenceKind: Checkpoint["evidenceKind"] | undefined;
  }) {
    super(`VerificationGate: cannot mark ${input.criterionId} passed — ${input.message}.`);
    this.name = "VerificationGateError";
    this.criterionId = input.criterionId;
    this.reason = input.reason;
    this.evidenceKind = input.evidenceKind;
  }
}

export function verifyAlgorithmCriterion(
  run: AlgorithmRun,
  criterionId: string,
  status: "passed" | "failed" | "dropped" | "deferred-probe",
  evidence: string,
  timestamp?: string,
  provenance?: Pick<AlgorithmProvenanceInput, "substrate">,
  evidenceKind?: Checkpoint["evidenceKind"],
  // VerificationGate opt-out for the RECONSTRUCTION surface. The gate fires on
  // fresh assistant/CLI assertions (default); the VSA→run sync passes false because
  // it reconstructs already-DECLARED state from existing VSA markdown (a bare
  // `[x]` legitimately carries no probe kind). Synced hollow passes remain
  // caught by the audit-time LEARN gate (layer b) — the strictness belongs on
  // the assertion surface, not on mirroring on-disk state.
  enforceGate = true,
): AlgorithmRun {
  assertNonEmpty(evidence, "verification evidence");

  // VerificationGate (layer a) — fail-fast at record time. #330's LEARN gate
  // (assertGate → learnGateViolations) already blocks a hollow pass from
  // COMPLETING; this refuses to RECORD a `passed` on spec-only/rote evidence so
  // the caller is corrected immediately, not at the finish line. Escape hatches:
  // evidenceKind "probed"/"tested", or status "deferred-probe".
  const gateViolation = enforceGate ? verificationGateViolation(status, evidence, evidenceKind) : null;
  if (gateViolation) {
    throw new VerificationGateError({
      criterionId,
      reason: gateViolation.reason,
      message: gateViolation.message,
      evidenceKind,
    });
  }

  const { isa: vsaWithSection, criteria: updatedCriteria } = updateCriterionWithResult(
    run.vsa,
    criterionId,
    status,
    evidence,
    evidenceKind,
  );
  const entry = logEntry(getRunPhase(run), `${criterionId}: ${status}. ${evidence}`, timestamp);
  const vsaWithRecompute: VerificationStateArtifact = {
    ...vsaWithSection,
    frontmatter: {
      ...vsaWithSection.frontmatter,
      progress: progressFromCriteria(updatedCriteria),
      verified: verifiedFromCriteria(updatedCriteria),
      updated: entry.timestamp,
    },
  };

  const next = {
    ...run,
    updatedAt: entry.timestamp,
    vsa: vsaWithRecompute,
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
      const criteria = getCriteria(run.vsa);
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
      const { unresolved, hollow } = learnGateViolations(getCriteria(run.vsa));
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
    vsa: {
      ...run.vsa,
      frontmatter: {
        ...run.vsa.frontmatter,
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

/**
 * Look one plan step up, or refuse. Exported so the CLI resolves a step the same
 * way the core does, rather than keeping its own copy of this lookup and message.
 */
export function requirePlanStep(run: AlgorithmRun, stepId: string): { step: AlgorithmPlanStep; index: number } {
  const index = run.planSteps.findIndex((step) => step.id === stepId);

  if (index === -1) {
    throw new Error(`Algorithm plan step not found: ${stepId}`);
  }

  return { step: run.planSteps[index], index };
}

export function updateAlgorithmPlanStep(
  run: AlgorithmRun,
  stepId: string,
  status: AlgorithmPlanStep["status"],
  evidence?: string,
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  const { step, index: stepIndex } = requirePlanStep(run, stepId);

  // §2.7: a bridged step's status lives on the node. Accepting a direct write
  // here is exactly the two-authoritative-homes failure the bridge exists to
  // prevent — and it would fail SILENTLY, since the forged status is
  // indistinguishable from a derived one once written.
  if (step.nodeId !== undefined) {
    throw new Error(
      `Algorithm plan step ${stepId} is bridged to work-graph node ${step.nodeId}: its status derives from the node, not from a direct write. ` +
        `Read the node (soma graph node ${step.nodeId} --json) and re-derive via syncBridgedPlanStep.`,
    );
  }

  const planSteps = run.planSteps.map((current, index) =>
    index === stepIndex
      ? {
          ...current,
          status,
          evidence,
        }
      : current,
  );

  return {
    ...run,
    updatedAt: timestamp,
    planSteps,
  };
}

/**
 * Sweep every *unbridged* open step to `done` — the whole-run flush the VSA sync
 * performs when a VSA is already past VERIFY.
 *
 * Bridged steps are skipped, not refused. This is a whole-run map with no single
 * step to refuse for, and the status it writes comes from the VSA's phase alone,
 * so applying it to a bridged step would forge a derived status — the exact
 * write {@link updateAlgorithmPlanStep} refuses one step at a time. The visible
 * cost is the honest one: an open bridged step leaves the run short of the
 * VERIFY gate until its node closes.
 */
export function markUnbridgedPlanStepsDone(
  planSteps: readonly AlgorithmPlanStep[],
  evidence: string,
): AlgorithmPlanStep[] {
  return planSteps.map((step) =>
    step.status === "open" && step.nodeId === undefined
      ? { ...step, status: "done" as const, evidence: step.evidence ?? evidence }
      : step,
  );
}

export type { BridgedNodeReport };

/**
 * Map a node's reported state onto a plan-step status. `closed` is the only
 * `done`; an open node with an open blocker is `blocked`, which is what makes
 * the run's checklist show graph topology rather than restate it.
 */
export function deriveBridgedPlanStepStatus(report: BridgedNodeReport): AlgorithmPlanStep["status"] {
  if (report.status === "closed") return "done";
  return report.blockedBy.some((blocker) => blocker.status === "open") ? "blocked" : "open";
}

/**
 * Re-derive a bridged step's status from its node — the ONLY write path for a
 * bridged step's status (§2.7). Also the path that first binds a step to a node:
 * pass `bind` to attach `nodeId`, so a step can never be bridged and left
 * carrying its stale hand-written status.
 *
 * Refuses when the report describes a different node than the step is bridged
 * to: syncing step A from node B's state would write a status with no relation
 * to the step's authoritative home, which is the same defect as a direct write
 * wearing a derivation's clothes. `bind` does NOT license that — re-homing an
 * already-bridged step is refused too, or the mismatch check would be unreachable
 * from the one caller that always sets `bind`, and a typo'd node id would move a
 * step silently.
 */
export function syncBridgedPlanStep(
  run: AlgorithmRun,
  stepId: string,
  report: BridgedNodeReport,
  options: { bind?: boolean } = {},
  timestamp = new Date().toISOString(),
): AlgorithmRun {
  const { step, index: stepIndex } = requirePlanStep(run, stepId);

  if (options.bind === true && step.nodeId !== undefined && step.nodeId !== report.ref.id) {
    throw new Error(
      `Algorithm plan step ${stepId} is already bridged to work-graph node ${step.nodeId}; refusing to re-home it to ${report.ref.id}. Re-plan the step to move it.`,
    );
  }

  const nodeId = options.bind === true ? report.ref.id : step.nodeId;

  if (nodeId === undefined) {
    throw new Error(
      `Algorithm plan step ${stepId} is not bridged to a work-graph node. Bind it to one first, or set its status directly with updateAlgorithmPlanStep.`,
    );
  }

  if (nodeId !== report.ref.id) {
    throw new Error(
      `Algorithm plan step ${stepId} is bridged to work-graph node ${nodeId}, but the reported node is ${report.ref.id}.`,
    );
  }

  const status = deriveBridgedPlanStepStatus(report);
  const planSteps = run.planSteps.map((current, index) =>
    index === stepIndex
      ? {
          ...current,
          nodeId,
          status,
          // Derived, never caller-asserted — the pointer names the authority and
          // the moment, so a reader can tell a fresh derivation from a stale one.
          evidence: `derived from work-graph node ${nodeId} (${report.status}) at ${timestamp}`,
        }
      : current,
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
      case "ref":
        return recordAlgorithmReference(current, { code: operation.code, label: operation.label, text: operation.text }, timestamp);
      case "resolve":
        return resolveAlgorithmReference(current, { code: operation.code, verdict: operation.verdict, note: operation.note }, timestamp);
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
