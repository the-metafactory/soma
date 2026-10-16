import type { AlgorithmEffortTier, AlgorithmPhase, AlgorithmMode, EvidenceKind, SubstrateId } from "../types";
import type { AlgorithmLogEntry, Checkpoint, VerificationStateArtifact } from "../vsa/types";

export type AlgorithmEffortSource = "explicit" | "classifier" | "context-override" | "auto" | "fail-safe";

export type AlgorithmLoopStatus = "running" | "paused" | "blocked" | "completed";

export interface AlgorithmLoopIteration {
  iteration: number;
  timestamp: string;
  progressBefore: string;
  progressAfter: string;
  summary?: string;
}

export interface AlgorithmLoopState {
  status: AlgorithmLoopStatus;
  iterationCount: number;
  plateauCounter: number;
  iterations: AlgorithmLoopIteration[];
}

export interface AlgorithmCriteriaPartition {
  id: string;
  domain: string;
  criteria: Checkpoint[];
}

export interface IdeateParameters {
  problemConnection: number;
  selectionPressure: number;
  domainDiversity: number;
  phaseBalance: number;
  ideaVolume: number;
  mutationRate: number;
  generativeTemperature: number;
  maxCycles: number;
  contextCarryover: boolean;
  parallelAgents: number;
}

export type IdeatePresetName = "dream" | "explore" | "balanced" | "directed" | "surgical";

export interface OptimizeParameters {
  stepSize: number;
  regressionTolerance: number;
  earlyStopPatience: number;
  maxIterations: number;
}

export type OptimizePresetName = "cautious" | "standard-optimize" | "aggressive";

export type AlgorithmNotificationEvent =
  | {
      kind: "algorithm.phase.entered";
      runId: string;
      phase: AlgorithmPhase;
      timestamp: string;
    }
  | {
      kind: "algorithm.loop.state_changed";
      runId: string;
      from: AlgorithmLoopStatus;
      to: AlgorithmLoopStatus;
      iterationCount: number;
      timestamp: string;
    }
  | {
      kind: "algorithm.loop.blocked";
      runId: string;
      plateauCounter: number;
      threshold: number;
      timestamp: string;
    };

export interface AlgorithmNotificationSink {
  notify(event: AlgorithmNotificationEvent): Promise<void> | void;
}

export interface AlgorithmLoopExecutionContext {
  run: AlgorithmRun;
  iteration: number;
  partition?: AlgorithmCriteriaPartition;
}

export interface AlgorithmLoopIterationResult {
  run: AlgorithmRun;
  progressBefore: string;
  progressAfter: string;
  summary?: string;
}

export interface AlgorithmLoopExecutor {
  executeIteration(context: AlgorithmLoopExecutionContext): Promise<AlgorithmLoopIterationResult>;
}

export interface AlgorithmPromptClassification {
  mode: AlgorithmMode;
  effort?: AlgorithmEffortTier;
  source: AlgorithmEffortSource;
  reason: string;
}

/**
 * A within-run execution checklist item. `planSteps[]` stays the run's own
 * checklist; a step may additionally be **bridged** to a work-graph node via
 * {@link AlgorithmPlanStep.nodeId}, and a bridged step's `status` stops being
 * caller-authored (`docs/work-graph.md` §2.7).
 */
export interface AlgorithmPlanStep {
  id: string;
  text: string;
  criteriaIds: string[];
  /**
   * Caller-authored on an unbridged step. On a bridged step it is a **cache of
   * the node's reported state**: `syncBridgedPlanStep` is the intended writer,
   * and `updateAlgorithmPlanStep` / `setAlgorithmPlan` refuse a direct write,
   * because one work item never has two authoritative homes (§2.7).
   *
   * Read that as a speed bump, not a seal. The refusals live in the mutation
   * helpers, not in this type — a caller who builds an `AlgorithmRun` literal and
   * calls `writeAlgorithmRun`, or who removes and re-adds a step across two
   * `setAlgorithmPlan` calls, can still persist a hand-written status on a step
   * that was bridged. What the helpers guarantee is that it cannot happen
   * *incidentally*. See `docs/work-graph.md` §2.7 for the full boundary.
   */
  status: "open" | "done" | "blocked";
  evidence?: string;
  /**
   * Work-graph node this step defers to. Present ⇒ the node is the single
   * authoritative home for the step's status, and `status`/`evidence` here are
   * re-derived from `GraphStore.readNode` (surfaced to CLI callers as
   * `soma graph node <id> --json`). Absent ⇒ the run owns the status outright.
   */
  nodeId?: string;
}

/** What happened to a reference the principal addressed by code. */
export const ALGORITHM_REFERENCE_VERDICTS = ["kept", "rejected", "answered", "done", "dropped"] as const;

export type AlgorithmReferenceVerdict = (typeof ALGORITHM_REFERENCE_VERDICTS)[number];

/**
 * A conversational reference point (`F1`, `O2`, `D3`) recorded against a run.
 *
 * The point of storing these is that `keep D1` becomes a WRITE rather than an
 * acknowledgement: the code the assistant printed in chat and the code the
 * principal types back both resolve to the same durable row. Without that, a
 * reference code is only display formatting.
 *
 * The letter space is shared with the Algorithm's own: `C` (VSA criteria) and
 * `P` (plan steps) are reserved and rejected at write time, because `keep C1`
 * must never be ambiguous between a criterion and a chat finding. `D`
 * references additionally mirror into `AlgorithmRun.decisions` — decisions are
 * the one family the Algorithm already has a durable home for, so a `D` code
 * is a handle on that record, not a parallel one.
 */
export interface AlgorithmReference {
  /** Normalized code, uppercase letter + ordinal, e.g. `F1`. Unique per run. */
  code: string;
  /** The code's letter, uppercase. */
  letter: string;
  /** The code's ordinal. */
  ordinal: number;
  /** What the code labels, from the communication contract (e.g. `findings`). */
  label?: string;
  /** The reference's content as presented. */
  text: string;
  createdAt: string;
  phase: AlgorithmPhase;
  verdict?: AlgorithmReferenceVerdict;
  verdictNote?: string;
  resolvedAt?: string;
}

/**
 * A current-state probe recorded during OBSERVE. The OBSERVE→THINK gate requires
 * at least one observation whose {@link EvidenceKind} is `probed` or `tested` —
 * a `specified` observation ("the doc says the route exists") does NOT clear the
 * floor, because the floor's whole point is confirming reality, not restating a
 * spec. Like every evidence surface, `evidenceKind` is CALLER-ASSERTED: the gate
 * forces an explicit probed/tested claim and makes a hollow observation auditable;
 * it does not verify the probe actually happened.
 */
export interface AlgorithmObservation {
  timestamp: string;
  /** The current-state assumption being checked (e.g. "route /health exists"). */
  claim: string;
  /** What the probe found (e.g. "confirmed via grep of src/server.ts:42"). */
  evidence: string;
  evidenceKind: EvidenceKind;
}

/**
 * The Soma gates a run did or did not satisfy — the generative spine of the
 * meta-reflection layer (#333): a gate recurrently unmet across runs is the
 * empirical case for a runner/prompt fix — the signal P2 / #331 proves (P2 was
 * found by a manual 188-run dig; this layer re-surfaces that signal automatically).
 * Each flag maps to a real enforced gate:
 * - `currentStateFloor`: a probed/tested observation was on record (#331).
 * - `learnGateClean`: no unresolved or hollow-`specified` criteria blocked LEARN (#330).
 * - `completeness`: every criterion reached a terminal state (passed/dropped/deferred-probe).
 *
 * Provenance of the flags: a LIVE reflection computes them from run state via
 * {@link computeGatesFired}, using the same predicates the gates enforce — a
 * point-in-time SNAPSHOT (a later mutation can move the run, so it is not a
 * standing equivalence with the gate's verdict at every later moment). An
 * IMPORTED historical record (e.g. the PAI corpus) instead carries a documented,
 * lossy best-effort mapping — caller-asserted history, not re-derived facts.
 */
export interface AlgorithmGatesFired {
  currentStateFloor: boolean;
  learnGateClean: boolean;
  completeness: boolean;
}

/**
 * A per-run meta-reflection — "how the Algorithm itself should have behaved",
 * the layer PAI captured (`reflection_q1/q2/q3` + `doctrine_fired`) and Soma
 * never ported until #333. Two halves by design, mirroring the deterministic
 * spine / model-proposed split the direction doc settled on:
 * - `gatesFired` is computed from the run (deterministic, auditable).
 * - `smarterRun` is the MODEL's proposal ("a smarter run would have…"); free
 *   text, never machine-verified. The digest counts gate-misses to RANK and
 *   buckets these q-signals to ENRICH.
 */
export interface AlgorithmMetaReflection {
  timestamp: string;
  phase: AlgorithmPhase;
  gatesFired: AlgorithmGatesFired;
  smarterRun: {
    /** q1 — an earlier step the run missed (e.g. "probe field existence before asking"). */
    missedEarlyStep?: string;
    /** q2 — verification/parallelization the run should have done (the P2 signal class). */
    missedVerifyOrParallel?: string;
    /** q3 — the highest-value move, what actually worked. */
    highestValueMove?: string;
  };
  /** Self-predicted satisfaction 0–10 (caller-asserted). */
  satisfaction?: number;
  withinBudget?: boolean;
}

export type AlgorithmProvenanceOperation =
  | "run.created"
  | "run.observed"
  | "observation.record"
  | "phase.advance"
  | "criterion.verify"
  | "capability.invoke"
  | "learning.record"
  | "reflection.record"
  | "memory.promote";

export interface AlgorithmProvenanceEntry {
  timestamp: string;
  phase: AlgorithmPhase;
  operation: AlgorithmProvenanceOperation;
  substrate: SubstrateId;
  detail?: string;
}

/**
 * The one capability-kind vocabulary. `AlgorithmCapabilityKind`,
 * `AlgorithmCapabilityContract` and the runtime membership check are all derived
 * from this tuple, so a new kind is added in exactly one place (Sage review).
 */
export const ALGORITHM_CAPABILITY_KINDS = ["skill", "inline", "agent", "command", "adapter", "contract"] as const;

export type AlgorithmCapabilityKind = (typeof ALGORITHM_CAPABILITY_KINDS)[number];

export type AlgorithmCapabilityContract = AlgorithmCapabilityKind;

/**
 * The kinds an ACTUALLY RECORDED invocation can carry — every kind except
 * `contract` (Sage review). `contract` is a declaration-only state: it means a
 * capability was declared by its contract and never bound, and
 * `recordAlgorithmCapabilityInvocation` refuses it, so no invocation record can
 * ever hold it. Narrowing here states that in the type instead of leaving every
 * consumer to handle a case the code cannot produce.
 *
 * The DEFINITION's `invoke.contract` keeps the wide union: a contract-kind
 * definition legitimately reports `contract` there, and forcing it to name an
 * invocation kind it does not have would be a lie in the other direction.
 */
export type AlgorithmCapabilityInvocationContract = Exclude<AlgorithmCapabilityKind, "contract">;

export type AlgorithmCapabilitySelectionStatus = "selected" | "invoked" | "removed" | "failed";

export interface AlgorithmCapabilityDefinition {
  name: string;
  kind: AlgorithmCapabilityKind;
  phases: AlgorithmPhase[];
  triggerSignals: string[];
  invoke: {
    contract: AlgorithmCapabilityContract;
    target: string;
    /**
     * The model slug an `Agent(…, model="…")` row asks for (soma#921, O6).
     * The registry carries it so a second-opinion or cross-family-audit
     * binding can name the family it wants; Soma never validates the slug and
     * the substrate decides whether it can route to it. Absent on every other
     * kind.
     */
    model?: string;
  };
  /**
   * Who put this definition on the run (soma#574). A home refresh REPLACES the
   * set it owns — a row retargeted at something missing, or deleted outright,
   * must stop being selectable — so the replace needs to know what is its to
   * drop.
   *
   * - `soma-home`  — resolved from the soma home; replaced on every refresh.
   * - `caller`     — registered directly through
   *                  `registerAlgorithmCapabilityDefinition(s)`; a refresh
   *                  leaves it alone.
   * - absent       — persisted before this field existed, so the producer is
   *                  genuinely unknown. PRESERVED. Absence is not a deletion
   *                  signal: reading it as foreign makes a legacy home row
   *                  undeletable, reading it as home destroys a caller's
   *                  registration, and only the second is unrecoverable. A
   *                  stale legacy row is replaced the moment a same-named row
   *                  resolves again; until then it lingers, which is the
   *                  cheaper of the two mistakes.
   */
  origin?: "soma-home" | "caller";
}

export interface SomaSkillAlgorithmCapabilityManifest {
  kind?: AlgorithmCapabilityKind;
  phases?: AlgorithmPhase[];
  triggerSignals?: string[];
}

export interface AlgorithmCapabilityInvocation {
  timestamp: string;
  substrate: SubstrateId;
  contract: AlgorithmCapabilityInvocationContract;
  target: string;
  /**
   * Copied from the definition at invocation time: the slug the binding asked
   * for, not evidence of which model answered. `algorithm invoke` does not run
   * the target, so what actually ran belongs in `evidence`.
   */
  model?: string;
  evidence: string;
}

export interface AlgorithmCapabilitySelection {
  name: string;
  phase: AlgorithmPhase;
  reason: string;
  status: AlgorithmCapabilitySelectionStatus;
  selectedAt: string;
  invocation?: AlgorithmCapabilityInvocation;
  removalReason?: string;
  removedAt?: string;
}

export interface AlgorithmRun {
  // soma#329 slice 3: v3 stores the embedded VSA under the `vsa` key (was `isa`
  // ≤v2). The on-disk reader (loadAlgorithmRun) dual-reads both keys.
  schemaVersion: 3;
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Substrate sessions that mutated this run, unique in first-seen order. Optional on older runs. */
  sessionIds?: string[];
  substrate?: SubstrateId;
  prompt: string;
  intent: string;
  effort: AlgorithmEffortTier;
  effortSource: AlgorithmEffortSource;
  mode: AlgorithmMode;
  classificationReason: string;
  currentState: string;
  vsa: VerificationStateArtifact;
  loop: AlgorithmLoopState;
  antiCriteria: Checkpoint[];
  capabilities: string[];
  capabilityDefinitions?: AlgorithmCapabilityDefinition[];
  capabilitySelections?: AlgorithmCapabilitySelection[];
  planSteps: AlgorithmPlanStep[];
  decisions: AlgorithmLogEntry[];
  /**
   * Conversational reference points addressable by code. Optional on disk:
   * every run written before this shipped has none, and the store defaults it
   * to `[]` rather than bumping the schema version. See {@link AlgorithmReference}.
   */
  references?: AlgorithmReference[];
  /** Current-state probes recorded during OBSERVE. See {@link AlgorithmObservation}. */
  observations: AlgorithmObservation[];
  changelog: AlgorithmLogEntry[];
  verification: AlgorithmLogEntry[];
  learning: AlgorithmLogEntry[];
  /** Per-run meta-reflections ("how the Algorithm should have behaved"). See {@link AlgorithmMetaReflection}. */
  metaReflection: AlgorithmMetaReflection[];
  provenance: AlgorithmProvenanceEntry[];
}

export interface AlgorithmRunSummary {
  id: string;
  path: string;
  updatedAt: string;
  phase: AlgorithmPhase;
  effort: AlgorithmEffortTier;
  goal: string;
  openCriteria: number;
  passedCriteria: number;
  failedCriteria: number;
  droppedCriteria: number;
  deferredProbeCriteria: number;
  progress: string;
}

export interface AlgorithmRunInput {
  id?: string;
  timestamp?: string;
  substrate?: SubstrateId;
  prompt: string;
  intent: string;
  effort?: AlgorithmEffortTier;
  effortSource?: AlgorithmEffortSource;
  mode?: AlgorithmMode;
  classificationReason?: string;
  currentState: string;
  goal: string;
  criteria: {
    id: string;
    text: string;
    verification?: string;
  }[];
  antiCriteria?: {
    id: string;
    text: string;
    verification?: string;
  }[];
}

export type AlgorithmBatchOperation =
  | {
      kind: "decision" | "change" | "learn";
      text: string;
    }
  | {
      kind: "ref";
      code: string;
      label?: string;
      text: string;
    }
  | {
      kind: "resolve";
      code: string;
      verdict: AlgorithmReferenceVerdict;
      note?: string;
    }
  | {
      kind: "observe";
      claim: string;
      evidence: string;
      evidenceKind: EvidenceKind;
    }
  | {
      kind: "step";
      stepId: string;
      status: AlgorithmPlanStep["status"];
      evidence?: string;
    }
  | {
      kind: "verify";
      criterionId: string;
      status: "passed" | "failed" | "dropped" | "deferred-probe";
      evidence: string;
      evidenceKind?: EvidenceKind;
    }
  | {
      kind: "capability";
      capability: string;
      phase?: AlgorithmPhase;
      reason?: string;
    }
  | {
      kind: "capability-invocation";
      capability: string;
      substrate?: SubstrateId;
      evidence: string;
    }
  | {
      kind: "capability-removal";
      capability: string;
      reason: string;
    }
  | {
      kind: "advance";
    };

export interface SomaSkillManifest {
  schema: "soma.skill.v1";
  name: string;
  description: string;
  packId?: string;
  source: { kind: "pai-pack"; packName: string };
  entrypoint: string;
  references: string[];
  workflows: string[];
  tools: string[];
  triggers: string[];
  substrates: SubstrateId[];
  algorithmCapability?: SomaSkillAlgorithmCapabilityManifest;
}
