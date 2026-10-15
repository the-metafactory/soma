import type { SomaMemoryEvent, SomaFeedbackClassification, SomaFeedbackActor } from "./events/index";
export type { SomaMemoryEventInput, SomaMemoryEvent, SomaTelemetryQueryOptions, SomaTelemetryQueryResult, SomaTelemetrySummaryOptions, SomaTelemetrySummary, SomaFeedbackKind, SomaFeedbackClassification, SomaFeedbackActor } from "./events/index";
import type { SomaMemoryPromotionStore } from "./core/index";
export type { SomaPaths, SomaMemoryPromotionStore } from "./core/index";
export { SOMA_MEMORY_PROMOTION_STORE_DIRS, SOMA_MEMORY_PROMOTION_STORES } from "./core/index";

import type { InferenceBackend, InferenceLevel } from "./tools/inference/types";
import type { BehaviorPolicy } from "./policy/behavior-policy";
import type { CommunicationContract } from "./communication-contract";

export type SubstrateId =
  | "codex"
  | "pi-dev"
  | "claude-code"
  | "cursor"
  | "grok"
  | "dsh"
  | "cortex"
  | "custom"
  | "anthropic-cowork";

export type ExperimentalScaffoldSubstrate = "anthropic-cowork";
export type ProjectionSubstrate = SubstrateId | ExperimentalScaffoldSubstrate;
export type InstallSubstrate = Extract<SubstrateId, "codex" | "pi-dev" | "claude-code" | "cursor" | "grok" | "dsh"> | ExperimentalScaffoldSubstrate;

export interface AssistantIdentity {
  name: string;
  displayName?: string;
  voiceId?: string;
  traits?: Record<string, number | string | boolean>;
}

export interface PrincipalIdentity {
  name: string;
  preferredName?: string;
  profile?: Record<string, unknown>;
}

export interface Purpose {
  mission?: string;
  /** The durable missions (M0–Mn). Loaded from `## Missions`, or `## Goals` in an older home (soma#784 D9). */
  missions: string[];
  /** Typed goal records from `profile/goals/G<n>.md`, in id order, every status (soma#784 D2, D9). */
  goals: GoalRecord[];
  principles: string[];
  commitments: string[];
}

export type GoalStatus = "draft" | "active" | "paused" | "achieved" | "dropped";

/**
 * One goal (soma#784 D2–D8). The frontmatter fields are typed; `wording` is the
 * body's first line and `body` the whole private body (drop condition, notes).
 * Goal text stays in soma-home: only the id travels in envelopes and ledgers.
 */
export interface GoalRecord {
  /** `G<n>`, opaque and never reused. */
  id: string;
  status: GoalStatus;
  /** Mission codes (`M<n>`) this goal serves. */
  supports: string[];
  /** A reflex activation id that measures the goal. */
  sensor?: string;
  /** ISO date (`YYYY-MM-DD`) when the sweep recommends keep, revise or drop. */
  reviewBy?: string;
  /** Whole days a goal counts as pursued after its last live link (default 14). */
  pursuitWindow?: number;
  wording: string;
  body: string;
}

/** @deprecated Renamed to {@link Purpose} (soma#329, ADR 0001). Kept for back-compat. */
export type Telos = Purpose;

/**
 * What the verifier CLAIMS about how the evidence was obtained. A caller-asserted
 * label, NOT a machine-verified fact — Soma records the claim and gates on it, but
 * does not confirm a `probed`/`tested` label corresponds to a real probe or test
 * on any surface (CLI, VSA markdown, or library).
 * - `specified`: a design/spec claim only ("the doc says X") — weak; blocks the LEARN gate.
 * - `probed`: caller asserts behaviour was observed at runtime (curl, grep of running state).
 * - `tested`: caller asserts coverage by an automated test.
 */
export type EvidenceKind = "specified" | "probed" | "tested";

export type CriterionStatus = "open" | "passed" | "failed" | "dropped" | "deferred-probe";

/**
 * The unit of evidence-gated verification: { criterion, required evidence, typed
 * verdict, completion gate }. See CONTEXT.md and ADR 0001 — this code shape *is*
 * the extracted `checkpoint` primitive (#329).
 */
export interface Checkpoint {
  id: string;
  text: string;
  status: CriterionStatus;
  verification?: string;
  /** See {@link EvidenceKind}. Undefined on legacy/pre-feature criteria (grandfathered by the LEARN gate). */
  evidenceKind?: EvidenceKind;
}

/**
 * @deprecated soma#329: renamed to {@link Checkpoint}. Retained as a back-compat
 * alias for the PAI-era name; prefer `Checkpoint` in new code.
 */
export type IdealStateCriterion = Checkpoint;

export type AlgorithmPhase = "observe" | "think" | "plan" | "build" | "execute" | "verify" | "learn" | "complete" | "abandoned";

export type AlgorithmEffortTier = "E1" | "E2" | "E3" | "E4" | "E5";

export type AlgorithmMode = "minimal" | "native" | "algorithm";

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

export interface AuthoredFrontmatter {
  task: string;
  effort: AlgorithmEffortTier;
  /** Goal ID only; private goal wording stays in soma-home (D10). */
  serves?: string;
  mode?: AlgorithmMode;
  iteration?: number;
  started?: string;
  algorithm_config?: Record<string, unknown>;
  custom?: Record<string, unknown>;
}

export interface DerivedFrontmatter {
  phase: AlgorithmPhase;
  progress: string;
  verified: boolean;
  updated: string;
}

export interface VsaFrontmatter extends AuthoredFrontmatter, DerivedFrontmatter {}

export interface VsaSection {
  name: string;
  content: string;
}

/**
 * Mutable working document — NOT a static artifact despite the name.
 * Accumulates Decisions, Changelog, and Verification entries over its lifetime.
 * The name is historical (predates the section-based model).
 *
 * Identity: `slug`. Source of truth when file-backed: `~/.soma/vsa/<slug>.md`.
 * In-memory ephemeral VSAs (Algorithm runs that never touch disk) leave
 * `sourcePath` undefined.
 *
 * Storage model is section-agnostic at the type level — derived accessors
 * (getGoal, getCriteria, etc.) and the SECTION_NAME_MAP are what give the
 * twelve-section schema its meaning.
 */
export interface VerificationStateArtifact {
  slug: string;
  frontmatter: VsaFrontmatter;
  sections: readonly VsaSection[];
  sourcePath?: string;
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

/** Principal rejection of a delivered output; never stores assistant output content. */
export type ErrataPassedBy =
  | { kind: "algorithm-verify"; runId: string; criterionId: string }
  | { kind: "close-receipt"; repo: string; nodeId: string; receiptCommentId: string };

export interface ErrataInput {
  sessionId: string;
  rejectedTurnUuid: string;
  rejectedAt: string;
  complaintAt: string;
  complaint: string;
  artifacts: string[];
  passedBy: ErrataPassedBy | null;
}

export interface ErrataRecord extends ErrataInput {
  id: string;
  status: "active" | "dropped";
  createdAt: string;
  /** Set once a `clustered` event assigned this Errata; never changes afterwards. */
  clusterId?: string;
}

/**
 * Why a cluster's members belong together (node #851, soma#785 Q15). Deterministic
 * keys come first; a theme is judged only for `passedBy: null` with no shared artifact.
 * Theme labels are the judge's own words and never contain complaint text.
 */
export type ErrataClusterKey =
  | { kind: "check"; passedBy: ErrataPassedBy }
  | { kind: "artifact"; path: string }
  | { kind: "theme"; label: string };

/** Folded cluster: active members only; `ripe` is derived, never stored (soma#785 Q16). */
export interface ErrataCluster {
  id: string;
  key: ErrataClusterKey;
  errataIds: string[];
  status: "open" | "ripe";
  createdAt: string;
}

export type ErrataEvent =
  | { kind: "created"; record: ErrataRecord }
  | { kind: "dropped"; id: string; at: string }
  | { kind: "clustered"; id: string; clusterId: string; key: ErrataClusterKey; at: string };

export interface AlgorithmLogEntry {
  timestamp: string;
  phase: AlgorithmPhase;
  text: string;
  /** Structured verification fields; absent on older prose-only entries. */
  criterionId?: string;
  outcome?: "passed" | "failed" | "dropped" | "deferred-probe";
  /** Substrate session that asserted this verification, when available. */
  sessionId?: string;
}

/** What happened to a reference the principal addressed by code. */
export type AlgorithmReferenceVerdict = "kept" | "rejected" | "answered" | "done" | "dropped";

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
     * The model role an `Agent(…, model="…")` row names (soma#921, O6). The
     * registry carries it so a second opinion or cross-family audit can say
     * which family answers; the substrate decides what to do with the slug.
     * Absent on every other kind.
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
  /** Copied from the definition at invocation time so the run records which model role answered. */
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

export interface SomaSkill {
  name: string;
  path: string;
  description: string;
  triggers: string[];
  files?: {
    path: string;
    content: string;
  }[];
}

export interface SomaMemoryLayout {
  root: string;
  work: string;
  knowledge: string;
  learning: string;
  relationship: string;
  state: string;
}

export interface SomaSnapshotOptions {
  homeDir?: string;
  somaHome?: string;
  name?: string;
  trigger?: string;
}

export interface SomaSnapshotResult {
  somaHome: string;
  id: string;
  name: string;
  trigger: string;
  createdAt: string;
}

export interface SomaSnapshotListOptions {
  homeDir?: string;
  somaHome?: string;
  limit?: number;
}

export interface SomaSnapshotEntry {
  id: string;
  createdAt: string;
  name: string;
  subject: string;
}

export interface SomaSnapshotRollbackOptions {
  homeDir?: string;
  somaHome?: string;
  snapshot: string;
}

export interface SomaSnapshotRollbackResult {
  somaHome: string;
  id: string;
  name: string;
}

export interface SomaProfile {
  assistant: AssistantIdentity;
  principal: PrincipalIdentity;
  purpose: Purpose;
  memory: SomaMemoryLayout;
  skills: SomaSkill[];
  /**
   * `profile/communication.md` — how the assistant talks — carried verbatim.
   * Nothing is parsed out of it; the file's own text is the whole payload. Under
   * `profile` (not a sibling like `memory`/`behavior`) because the Identity
   * compartment explicitly owns "voice, personality" (CONTEXT.md
   * "compartment"), and voice is what this is. Conduct rules are the Policy
   * compartment and live in `ProjectionInput.behavior` instead.
   *
   * Omitted when the home has no `profile/communication.md` — an older home
   * predating the starter template, or one where the principal deleted it. The
   * substrate then simply projects no contract.
   */
  communication?: CommunicationContract;
}

export interface ProjectionInput {
  profile: SomaProfile;
  activeVsa?: VerificationStateArtifact;
  prompt?: string;
  /**
   * Memory subsystem M4 — the projected always-loaded memory index. A SIBLING
   * surface to `profile`, deliberately NOT under it: Memory is a peer compartment
   * to Identity/Purpose, not a sub-field of the profile. `indexContent` is the
   * verbatim rendered `memory/INDEX.md` (no wall clock — ages are baked at index
   * rebuild time, AC-4). Omitted when memory is disabled or no index exists, in
   * which case the substrate simply does not project a memory file.
   */
  memory?: { indexContent: string };
  /**
   * Names (skill dir basenames) of the repo-bundled skills — every `src/skills/*`
   * dir (the-algorithm, Memory, and VSA) — that the install copied into the Soma
   * home. When present, the generic portable-skill loop projects ONLY these as
   * invocable dirs (VSA is in the list but still excluded by `projectableSkills`'
   * dedicated VSA guard — it has its own managed installer); principal-authored
   * and registry skills present in `~/.soma/skills` reach a
   * substrate through `soma install --skills` symlinks instead, not the
   * always-on loop. Absent for direct projection callers (kept permissive:
   * legacy all-except-VSA behavior) — install is the sole scope authority.
   */
  bundledSkillNames?: readonly string[];
  /**
   * Parsed `~/.soma/policy/behavior.md` — the principal's cross-substrate
   * behavioral rules. A SIBLING of `profile`, not a field under it: behavior is
   * the Policy compartment, `profile` is Identity, and the two are peers (same
   * reasoning as `memory` above). Adapters merge
   * `behaviorPolicyAdvisory(input.behavior)` into their
   * `renderPolicyProjection` advisory list. Omitted when the home has no
   * `policy/behavior.md`, in which case the projection simply carries no
   * principal behavioral rules — never a default set, because inventing rules
   * the principal did not write is worse than projecting none.
   */
  behavior?: BehaviorPolicy;
}

export interface Projection {
  substrate: ProjectionSubstrate;
  instructions: string;
  files: {
    path: string;
    content: string;
    /**
     * When true, the file is chmod'd executable (0o755) at write
     * time. Used by hook entries that the substrate execs directly
     * via shebang (soma#73 sage r2). Defaults to false; ordinary
     * markdown/config files stay 0o644.
     */
    executable?: boolean;
  }[];
}

export interface WrittenProjection {
  substrate: ProjectionSubstrate;
  rootDir: string;
  files: string[];
}

export interface SomaHomeProjectionOptions {
  homeDir?: string;
  somaHome?: string;
  substrateHome?: string;
  somaRepoPath?: string;
  codeOnly?: boolean;
}

export interface SomaHomeProjection {
  substrate: ProjectionSubstrate;
  somaHome: string;
  substrateHome: string;
  bundle: Projection;
}

export interface SomaHomeBootstrapOptions {
  homeDir?: string;
  somaHome?: string;
  includeSkills?: boolean;
}

export interface SomaHomeBootstrapResult {
  somaHome: string;
  context: ProjectionInput;
  files: string[];
}

export interface SomaInstallOptions {
  homeDir?: string;
  somaHome?: string;
  substrateHome?: string;
  somaRepoPath?: string;
  /**
   * @internal Test seam (node #914): the source the runtime artifacts are
   * staged from. Omitted → `somaRepoPath`. It moves the staged runtime only;
   * bundled skills and projections still read `somaRepoPath`. Tests that do
   * not exercise the staged runtime pass a stub so each install does not
   * stage the whole soma tree.
   */
  runtimeSourceRoot?: string;
  codeOnly?: boolean;
  /**
   * Narrow the registry→loader projection to these skill names (soma#638).
   * Omitted → a `loader` substrate takes the whole curated registry. Lives on
   * the install options, not the CLI, so a programmatic install projects the
   * same skills a CLI install does.
   */
  skills?: string[];
}

/** A skill linked into a substrate's loader by install (soma#638). */
export interface InstalledSkill {
  skill: string;
  path: string;
  status: string;
}

/** A registry entry install could not project, and why (soma#638). */
export interface UninstallableSkillReport {
  dir: string;
  reason: string;
}

export interface SomaInstallResult {
  substrate: InstallSubstrate;
  /** Present when a guarded substrate was projected against the frozen runtime. */
  runtimeArtifact?: { path: string; hash: string; previous?: string };
  somaHome: SomaHomeBootstrapResult;
  substrateHome: WrittenProjection;
  /**
   * Registry skills linked into the substrate's loader, and registry entries
   * that could not be (soma#638). Empty for a `catalog` substrate, whose
   * projected catalog already advertises the registry.
   */
  projectedSkills: InstalledSkill[];
  unprojectableSkills: UninstallableSkillReport[];
}

export interface SomaInstallPlan {
  substrate: InstallSubstrate;
  apply: boolean;
  somaHome: string;
  substrateHome: string;
  somaDirectories: string[];
  somaFiles: string[];
  substrateFiles: string[];
}

/**
 * Schema for `~/.soma/memory/STATE/active.json` — canonical active-VSA
 * state file shipped by #32. Layer 3 (#34) library CRUD is the sole
 * owner of reads/writes; `bootstrapSomaHome()` only declares the schema
 * and creates the containing directory.
 *
 * - `activeSlug` — slug of the currently-active VSA, or `null` when none.
 * - `runId`      — `AlgorithmRun.id` currently operating on the active
 *                  VSA; cleared by `completeAlgorithmRun` /
 *                  `abandonAlgorithmRun` (per #41 reconciliation v3).
 * - `updatedAt`  — ISO 8601 timestamp of the last mutation.
 */
export interface SomaActiveVsaState {
  activeSlug: string | null;
  runId: string | null;
  updatedAt: string;
}

export interface SomaSkillBaseline {
  version: string;
  files: Record<string, string>;
  installedAt: string;
}

export type SomaSkillBaselines = Record<string, SomaSkillBaseline>;

export interface VsaSkillInstallOptions {
  homeDir?: string;
  somaHome?: string;
  somaRepoPath?: string;
  force?: boolean;
  /**
   * Absolute destination directory for the installed skill (#37). When
   * omitted the installer writes to `<somaHome>/skills/VSA` (preserves
   * pre-#37 behavior). When set — used by substrate adapters that want
   * to install the same versioned skill under their own root, e.g.
   * `~/.codex/skills/VSA`. The baseline + drift detection logic is
   * shared regardless of destination.
   */
  skillDestinationDir?: string;
}

export type VsaSkillInstallAction = "fresh" | "upgraded" | "unchanged" | "preserved-local-edits" | "no-source";

export interface VsaSkillInstallResult {
  somaHome: string;
  skillDir: string;
  sourceVersion: string;
  runtimeVersion: string | null;
  action: VsaSkillInstallAction;
  filesWritten: string[];
  filesPreservedUserAdditions: string[];
  upgradeMarker?: string;
}

export interface SkillNormalizationAction {
  file: string;
  kind:
    | "removed-substrate-notification-hook"
    | "rewrote-claude-home-path"
    | "rewrote-pai-doc-path"
    | "rewrote-pai-template-path"
    | "rewrote-pai-algorithm-path"
    | "rewrote-pai-memory-path"
    | "rewrote-unmapped-claude-path"
    | "stripped-mandatory-runtime-block"
    | "stripped-pai-customization-block";
  detail: string;
}

export interface SkillNormalizationWarning {
  file: string;
  kind:
    | "ambiguous-substrate-path"
    | "substrate-mutation-command"
    | "execution-logging-path"
    | "customization-overlay-reference"
    | "release-safety-path"
    | "unmapped-claude-home-path";
  detail: string;
}

/** @deprecated Renamed to {@link SkillNormalizationAction} (node #793). Kept for back-compat. */
export type PaiPackNormalizationAction = SkillNormalizationAction;

/** @deprecated Renamed to {@link SkillNormalizationWarning} (node #793). Kept for back-compat. */
export type PaiPackNormalizationWarning = SkillNormalizationWarning;

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

// #115 — `soma migrate claude-skills` types.
//
// Imports directly from an installed flat `.claude/skills/` tree — one
// `<Name>/SKILL.md` per skill, no pack-level metadata, no collection
// bundles. Per-skill portability is classified heuristically (regex
// based, Phase 1) and recorded in a sibling report file. Phase 2
// (deferred) adds a `--smoke <substrate>` flag for projection verify.
// #115 Phase 2 — substrate identifier scope for the `--smoke` flag.
// `claude-code` is intentionally excluded — it's the SOURCE substrate
// for `soma migrate claude-skills`, so projecting an imported skill
// back to Claude Code would only ever round-trip; the real verify
// value is on the NON-source substrates (Codex + Pi.dev).
export type ClaudeSkillsSmokeSubstrate = "codex" | "pi-dev" | "grok";

// #115 Phase 2 — per-skill, per-substrate static-shape verification
// verdict. The verifier never EXECUTES the substrate; it only checks
// that the projection bytes survive the substrate's projection
// machinery and pass deterministic structural assertions.
export type ClaudeSkillSubstrateVerifyStatus =
  | "verified"
  | "verified-with-warnings"
  | "failed";

export interface ClaudeSkillSubstrateVerifyResult {
  substrate: ClaudeSkillsSmokeSubstrate;
  status: ClaudeSkillSubstrateVerifyStatus;
  // One-line reason — surfaced in the portability report column.
  // For `verified`: "ok" or a short positive description.
  // For `verified-with-warnings`: the warning summary (first issue).
  // For `failed`: the blocking issue summary (first issue).
  reason: string;
  // Full list of issues surfaced by the static shape checks. Empty
  // when status is `verified`. Test surface and audit trail.
  issues: ClaudeSkillSubstrateVerifyIssue[];
}

export interface ClaudeSkillSubstrateVerifyIssue {
  kind:
    | "projection-throw"
    | "missing-name"
    | "missing-description"
    | "description-mismatch"
    | "dangling-internal-ref"
    | "unresolved-tool-path"
    | "substrate-only-primitive"
    | "empty-projection"
    | "oversized-projection"
    | "frontmatter-unparseable"
    | "long-body";
  // Severity decides whether this issue is a warning or a blocker.
  // `error` → status becomes `failed`. `warning` → status becomes
  // `verified-with-warnings` (unless an `error` is also present).
  severity: "error" | "warning";
  // Human-readable line, single sentence, no trailing newline.
  message: string;
  // Optional path of the projection file that triggered the issue.
  file?: string;
}

export interface ClaudeSkillsMigrationOptions {
  // Source flat skills tree. REQUIRED. Must be a directory of
  // `<Name>/SKILL.md` direct children. Refused loud otherwise.
  from?: string;
  // Override Soma home. Defaults to `<homeDir>/.soma`.
  somaHome?: string;
  // Override `$HOME`. Used by tests; the apply path resolves
  // `somaHome` from this when not explicitly set.
  homeDir?: string;
  // When true, classifier outcomes tagged `claude-specific` are still
  // imported (with an audit warning). Default false → skipped.
  includeClaudeSpecific?: boolean;
  // #115 Phase 2 — substrate(s) to run per-skill static-shape
  // verification against after import. Ordered, de-duplicated. The
  // CLI accepts `--smoke <substrate>` repeated and `--smoke all`
  // (which the parser expands to `["codex", "pi-dev", "grok"]`). Absent /
  // empty → Phase-1 behavior (no verify, no substrate columns in
  // the report).
  smokeSubstrates?: ClaudeSkillsSmokeSubstrate[];
  // #120 — LLM agent used to compress SKILL.md frontmatter
  // descriptions that exceed the 1024-char substrate limit (codex +
  // pi-dev both cap there) or are missing entirely. Default `"none"`
  // → oversize/missing descriptions classify as `refused-description-
  // limit` and the skill is not imported. Set to `"claude" | "codex"
  // | "pi"` to dispatch the rewrite to that agent before write.
  rewriteDescriptionsAgent?: RewriteDescriptionsAgent;
  // #120 — test-only injection point for the LLM dispatcher. When
  // present, replaces the per-agent dispatcher so fixture tests can
  // exercise the rewrite path without invoking a real LLM. Absent in
  // production. The dispatcher receives a structured request and
  // returns the rewritten description text; the migrator handles SHA
  // computation, length validation, and frontmatter splicing.
  rewriteDispatchOverride?: RewriteDispatchOverride;
  // #125 — per-skill progress emitter for plan / apply phases.
  // Optional; absent → no-op emitter (library callers don't get
  // surprise stderr noise). The CLI wires a real stderr-backed
  // emitter that respects `--quiet` and TTY detection. The
  // migrator threads phase boundaries (discovery, read+classify,
  // rewrite, apply write, smoke verify) through the emitter.
  // The `quiet` flag belongs to the CLI surface (not the migrator)
  // — pass a no-op emitter to suppress progress instead.
  progressEmitter?: import("./claude-skills-progress").ProgressEmitter;
}

/**
 * #120 — LLM agent enum for `--rewrite-descriptions`. `none` is the
 * default (no rewrite; oversize/missing descriptions refuse loud).
 * Other values dispatch the rewrite to the corresponding agent:
 *   - `claude` — subscription-billed `claude` subprocess (Sonnet).
 *   - `codex`  — `codex exec` subprocess (cross-vendor GPT path).
 *   - `pi`     — Pi.dev local LLM API (refused loud if unavailable).
 *   - `auto`   — non-interactive batch approval; dispatches via the
 *                default provider (`codex`) without prompting.
 */
export type RewriteDescriptionsAgent = "claude" | "codex" | "pi" | "none" | "auto";

/**
 * #120 — status of a skill's frontmatter description relative to the
 * 1024-char substrate limit.
 *   - `ok`       — description present AND ≤ 1024 chars.
 *   - `oversize` — description present AND > 1024 chars.
 *   - `missing`  — no frontmatter OR no `description:` line.
 *
 * `length` records the original description length (0 when missing).
 * `threshold` is the hard substrate cap; carried in-band so callers
 * don't need to import a separate constant.
 */
export interface DescriptionStatus {
  kind: "ok" | "oversize" | "missing";
  length: number;
  threshold: 1024;
}

/**
 * #120 — test-only override for the LLM dispatcher. Replaces the
 * real subprocess invocation with a pure function the test can
 * inspect / control. Receives the same request shape the real
 * dispatcher would; returns the rewritten text only (SHA / length
 * validation lives in the migrator, not the dispatcher).
 */
export type RewriteDispatchOverride = (request: {
  agent: Exclude<RewriteDescriptionsAgent, "none">;
  sourceName: string;
  status: DescriptionStatus;
  originalDescription: string;
  skillMdBody: string;
  targetMaxLength: number;
}) => Promise<string>;

// Heuristic portability tag assigned to every source skill. Phase 1
// rules:
//   - `portable`        — no `~/.claude/` path refs, no hook bindings,
//                          no `/<slash-command>` refs in prose.
//   - `needs-adapt`     — has `~/.claude/...` refs that the existing
//                          `skill-content-normalizer.ts` rewrite table can
//                          deterministically resolve.
//   - `claude-specific` — has Claude-Code-only primitives that have
//                          no portable equivalent: hook bindings
//                          (`Stop:`, `UserPromptSubmit:`,
//                          `PreToolUse:`, `PostToolUse:`,
//                          `SessionStart:`, `SubagentStop:`) OR
//                          `/<slash-command>` refs in prose.
export type ClaudeSkillPortabilityTag = "portable" | "needs-adapt" | "claude-specific";

export interface ClaudeSkillOutcome {
  // Source directory name (e.g. "Art", "ExtractWisdom").
  sourceName: string;
  // Kebab-cased target slug (e.g. "art", "extract-wisdom").
  kebabName: string;
  // Per-skill classifier verdict.
  tag: ClaudeSkillPortabilityTag;
  // Human-readable reason for the classifier verdict. One line.
  reason: string;
  // Phase 1 final disposition. `imported` = written to `<somaHome>/skills/<kebab>/`.
  // `skipped-claude-specific` = classifier verdict was `claude-specific`
  // and `includeClaudeSpecific` was false. `skipped-idempotent` =
  // source SHA matched the manifest entry on rerun.
  //
  // #118 — `refused-other` is the per-skill log-and-continue verdict
  // (mirrors `PaiPackOutcomeKind.refused-other`). Genuine errors while
  // reading a source skill (out-of-home symlink target, symlink cycle,
  // broken target, secret refusal, …) classify the surrounding skill
  // as `refused-other` and let the other skills continue. The CLI
  // turns any `refused-other` outcome into a non-zero exit ONLY in
  // apply mode (matches #112's mode-gated exit policy).
  // #120 — `refused-description-limit` is the new outcome for a
  // skill whose frontmatter description exceeds 1024 chars OR whose
  // SKILL.md has no frontmatter, AND `--rewrite-descriptions` was
  // absent or set to `none`. The skill is NOT imported; the CLI
  // footer suggests re-running with `--rewrite-descriptions auto`
  // (or claude / codex / pi) so the LLM dispatcher can compress the text.
  disposition:
    | "imported"
    | "skipped-claude-specific"
    | "skipped-idempotent"
    | "refused-other"
    | "refused-description-limit";
  // SHA-256 of the source SKILL.md bytes (hex). Stable identity for
  // idempotency checks. Populated even on classify-only / plan runs.
  sourceSha: string;
  // Absolute path of the imported skill root under
  // `<somaHome>/skills/<kebab>/`. Null when `disposition` is
  // `skipped-claude-specific`.
  target: string | null;
  // Number of file SHAs recorded under this skill's manifest entry
  // on the apply path (SKILL.md + every Workflows/Tools/References/
  // file copied or rewritten). Zero when the skill was skipped.
  fileCount: number;
  // #115 Phase 2 — per-substrate static-shape verify results. Keyed
  // by substrate id. Populated only when the migrator was invoked
  // with `--smoke <substrate>` AND the skill was actually imported
  // (skipped skills have nothing to verify). Empty/undefined when
  // no smoke run was requested — preserves Phase 1 report shape.
  substrates?: Partial<Record<ClaudeSkillsSmokeSubstrate, ClaudeSkillSubstrateVerifyResult>>;
  /**
   * #118 — per-skill audit trail. Each entry records a non-fatal event
   * the source-side walker decided to handle silently (followed
   * symlink resolutions to date). The audit feeds the portability
   * report so principals can see which symlinks were resolved without
   * grepping for them. Absent when the skill walked clean.
   *
   * Kinds:
   *   - `followed-user-owned-symlink` — a symlink whose realpath
   *     target stayed within `$HOME` was resolved + its bytes
   *     imported. `detail` carries `<rel> → <realpath>`.
   */
  audit?: ClaudeSkillAuditEntry[];
  /**
   * #118 — reason text for the `refused-other` disposition. Includes
   * the `<sourceName>/<rel>` path of the symlink (or other refusal
   * trigger) so principals can locate it without grep. Absent for
   * non-refused dispositions; the higher-level `reason` field carries
   * the classifier verdict for those.
   */
  refusalReason?: string;
  /**
   * #120 — frontmatter description status against the 1024-char
   * substrate cap. Computed unconditionally for every successfully-
   * read skill so the portability report can show the original
   * length even when no rewrite was requested. `kind: "missing"` →
   * no frontmatter OR no `description:` line in frontmatter.
   * Absent only when the skill itself was refused before the
   * description could be inspected (`refused-other`).
   */
  descriptionStatus?: DescriptionStatus;
  /**
   * #120 — when `--rewrite-descriptions <agent>` actually compressed
   * the description for this skill, this slot records the agent,
   * the resulting length, and the rewritten SHA so the portability
   * report and manifest carry the provenance trail (AC-5). Absent
   * when the skill's description was already within the cap or when
   * no rewrite was attempted.
   */
  descriptionRewrite?: ClaudeSkillDescriptionRewrite;
  /**
   * #126 — one-hop cross-skill code/documentation dependencies found
   * while scanning source payloads for `~/.claude/skills/<Other>/...`
   * references. `skill` is the kebab-cased referenced skill name;
   * `references` are the relative paths inside that referenced skill
   * (for example `Tools/ComposeAgent.ts`); `sourceFiles` are the
   * current skill files that mention the dependency.
   */
  dependencies?: ClaudeSkillDependency[];
  /**
   * #126 — referenced skills whose own migration outcome means they
   * will not be available in the projected skill tree. The dependent
   * skill still imports, but reports and CLI output surface this
   * loudly so the principal does not discover it at runtime.
   */
  dependencyMissing?: string[];
}

export interface ClaudeSkillDependency {
  skill: string;
  references: string[];
  sourceFiles: string[];
}

/**
 * #120 — provenance for a single description rewrite. Recorded on
 * both `ClaudeSkillOutcome` (for the portability report row) and
 * `ClaudeSkillsMigrationManifestEntry` (for idempotency on rerun).
 *
 * `originalDescriptionSha` is the SHA-256 of the source description
 * bytes BEFORE rewrite (empty string when status was `missing` and
 * we synthesized from body). `rewrittenDescriptionSha` is the SHA
 * of the post-rewrite text. The manifest stores both so a rerun
 * with an unchanged source description can short-circuit; a rerun
 * with a CHANGED source description re-runs the rewrite.
 */
export interface ClaudeSkillDescriptionRewrite {
  agent: Exclude<RewriteDescriptionsAgent, "none">;
  rewrittenAt: string;
  originalDescriptionSha: string;
  rewrittenDescriptionSha: string;
  originalLength: number;
  rewrittenLength: number;
}

export interface ClaudeSkillAuditEntry {
  kind: "followed-user-owned-symlink";
  /** POSIX-style path relative to the skill root that triggered the event. */
  relPath: string;
  /** Resolved realpath of the symlink target (for principal audit). */
  detail: string;
}

export interface ClaudeSkillsMigrationPlan {
  apply: boolean;
  // Absolute path of the resolved `--from <skills-dir>`.
  from: string;
  // Absolute path of the resolved Soma home.
  somaHome: string;
  // Whether the source directory passed the "flat skills tree" guard
  // (i.e. at least one `<Name>/SKILL.md` direct child). When false,
  // `outcomes` is empty and the formatter renders a hard refusal.
  isFlatSkillsTree: boolean;
  // Present only when `isFlatSkillsTree` is false: the accurate reason
  // (missing dir / empty dir / non-flat layout) so the formatter does
  // not misdiagnose a fresh, empty `~/.claude/skills/` as "not flat".
  flatTreeRefusalReason?: string;
  // One outcome per source `<Name>/SKILL.md`. Always ordered by
  // `sourceName` so the report and CLI rendering are deterministic.
  outcomes: ClaudeSkillOutcome[];
  // Mirror of `options.includeClaudeSpecific` so the formatter and
  // the manifest renderer can both reflect the same intent without
  // re-threading the option through helpers.
  includeClaudeSpecific: boolean;
  // #115 Phase 2 — substrates requested for static-shape verify.
  // Empty when `--smoke` was not passed; the report omits substrate
  // columns in that case so Phase-1 formatter output is byte-stable.
  smokeSubstrates: ClaudeSkillsSmokeSubstrate[];
  // #120 — mirror of `options.rewriteDescriptionsAgent` so the
  // formatter and report can both reflect the intent without
  // re-threading the option through helpers. `none` when the flag
  // was absent.
  rewriteDescriptionsAgent: RewriteDescriptionsAgent;
}

export interface ClaudeSkillsMigrationResult extends ClaudeSkillsMigrationPlan {
  // ISO-8601 timestamp of the last successful apply. Stable across
  // reruns when nothing changed.
  importedAt: string;
  // Absolute path of the SHA manifest file under
  // `<somaHome>/imports/claude-skills/.manifest.json`.
  manifestPath: string;
  // Absolute path of the portability report under
  // `<somaHome>/imports/claude-skills/.portability-report.md`.
  reportPath: string;
  // Skills actually written this run (`disposition: "imported"`,
  // SHA not already present in prior manifest).
  writtenCount: number;
  // Skills skipped due to SHA-match idempotency on rerun.
  skippedIdempotentCount: number;
  // Skills skipped because verdict was `claude-specific` and the
  // override flag was off.
  skippedClaudeSpecificCount: number;
  // #118 — skills that hit a genuine read failure (out-of-home symlink,
  // symlink cycle, broken target, denylisted target, etc.). Other
  // skills continue. The CLI gates exit-code on this count being > 0
  // in apply mode (mirror of #112's plan/apply split).
  refusedOtherCount: number;
  // #120 — skills refused because their frontmatter description
  // exceeded the 1024-char substrate cap (or was missing) AND no
  // `--rewrite-descriptions <agent>` was set. The CLI footer
  // suggests re-running with `--rewrite-descriptions auto`
  // (or claude / codex / pi) so the LLM dispatcher compresses the text.
  refusedDescriptionLimitCount: number;
  // #120 — skills whose description was actually rewritten via the
  // LLM dispatcher this run. Reported separately from `writtenCount`
  // so principals can see the rewrite footprint without grepping
  // the per-skill table.
  descriptionRewrittenCount: number;
  // #115 Phase 2 — per-substrate verify aggregate counts. Keyed by
  // substrate id; entries present only for substrates requested via
  // `--smoke`. Each entry counts `verified` / `verified-with-
  // warnings` / `failed` across imported skills.
  substrateVerifySummary?: Partial<Record<ClaudeSkillsSmokeSubstrate, ClaudeSkillSubstrateVerifySummary>>;
  // #125 — per-phase elapsed-time summary. Populated by the
  // migrator and rendered into the stdout summary's Timing block.
  // `phases` is ordered: discovery + read+classify, description
  // rewrites, apply write, smoke verify. Phases that didn't run
  // (e.g. `--smoke` absent) carry `unit: "(not requested)"`.
  timing?: import("./claude-skills-progress").PhaseTimings;
}

export interface ClaudeSkillSubstrateVerifySummary {
  verified: number;
  verifiedWithWarnings: number;
  failed: number;
}

export interface ClaudeSkillsMigrationManifestEntry {
  // Source directory name (`<Name>` from `<from>/<Name>/SKILL.md`).
  sourceName: string;
  // Kebab-cased target slug.
  kebabName: string;
  tag: ClaudeSkillPortabilityTag;
  // SHA-256 of the source SKILL.md bytes — the idempotency key.
  sourceSha: string;
  // Per-file SHAs of every payload file that landed under
  // `<somaHome>/skills/<kebab>/`. POSIX-style paths relative to
  // the skill root. Includes SKILL.md.
  fileShas: Record<string, string>;
  // #115 Phase 2 — last-seen per-substrate verify verdicts. Mirror
  // of `ClaudeSkillOutcome.substrates`. Idempotency contract: a
  // re-run with the same `sourceSha` AND a substrate already
  // `verified` here skips re-verification. A `failed`/`verified-
  // with-warnings` entry is re-run every invocation so a fix to the
  // adapter can flip the verdict without source churn.
  substrates?: Partial<Record<ClaudeSkillsSmokeSubstrate, ClaudeSkillSubstrateVerifyResult>>;
  // #120 — description-rewrite provenance. Present only for skills
  // whose description was actually rewritten via `--rewrite-
  // descriptions <agent>`. Idempotency: a rerun with matching
  // `originalDescriptionSha` (i.e. source description unchanged
  // since the rewrite) reuses the prior rewritten text instead of
  // calling the LLM again.
  descriptionRewrite?: ClaudeSkillDescriptionRewrite;
}

export interface ClaudeSkillsMigrationManifestOutcome {
  sourceName: string;
  kebabName: string;
  tag: ClaudeSkillPortabilityTag;
  disposition: ClaudeSkillOutcome["disposition"];
  reason: string;
  refusalReason?: string;
  remediation?: string;
  dependencyMissing?: string[];
}

export interface ClaudeSkillsMigrationManifestLastRun {
  totals: {
    imported: number;
    skippedIdempotent: number;
    skippedClaudeSpecific: number;
    refusedOther: number;
    refusedDescriptionLimit: number;
  };
  outcomes: ClaudeSkillsMigrationManifestOutcome[];
}

export interface ClaudeSkillsMigrationManifest {
  schema: "soma.claude-skills-migration.v1";
  from: string;
  somaHome: string;
  importedAt: string;
  // Whether `--include-claude-specific` was passed on the run that
  // wrote this manifest. Recorded so the next apply can detect a
  // policy change (override flipped off) and re-classify accordingly.
  includeClaudeSpecific: boolean;
  // One entry per skill that was actually imported. Skipped skills
  // (claude-specific without override) are NOT recorded — their
  // SHA isn't an idempotency anchor for anything that landed.
  // Sorted by `kebabName` for byte-stable reruns.
  skills: ClaudeSkillsMigrationManifestEntry[];
  // #175 — latest actionable skipped/refused outcomes. `skills`
  // stays the idempotency anchor for landed payloads; this ledger lets
  // `--status` report unresolved migration work without scraping the
  // Markdown portability report.
  lastRun?: ClaudeSkillsMigrationManifestLastRun;
  // #115 Phase 2 — substrate list captured at last write. Absent
  // when no `--smoke` was ever run; present so the next invocation
  // can detect a substrate-set change.
  smokeSubstrates?: ClaudeSkillsSmokeSubstrate[];
}

export type SomaInitStepId =
  | "bootstrap-soma-home"
  | "migrate-claude-skills"
  | "install-codex"
  | "install-pi-dev"
  | "install-claude-code"
  | "install-cursor"
  | "install-grok"
  | "install-dsh";

/**
 * The substrates `soma doctor` can diagnose — every `InstallSubstrate` except
 * the experimental `anthropic-cowork` scaffold. Kept in lockstep with the
 * runtime `DOCTOR_SUPPORTED_SUBSTRATES` list in `src/adapters/doctor.ts`
 * (codex, claude-code, cursor, grok, pi-dev); the two must agree. Used to
 * parameterize the projection finding-id type below so only supported-substrate
 * ids are type-valid.
 */
export type SomaDoctorSubstrate = Exclude<InstallSubstrate, "anthropic-cowork">;

/**
 * Content-compare drift findings (soma#370) are substrate-parameterized: the
 * same shapes apply uniformly whichever of the 5 doctor-supported
 * substrates produced them. Declared as a template-literal type over the
 * doctor-supported substrate union (`SomaDoctorSubstrate`) — NOT the broader
 * `SubstrateId`, which would admit `cortex-*`/`custom-*` ids the doctor can
 * never emit — rather than duplicating the suffix cross product by hand for
 * every substrate. The pre-existing substrate-specific strings this
 * generalizes (`codex-projection-stale`, `claude-code-projection-stale`,
 * `claude-code-projection-unmanaged-edit`, `grok-projection-stale`) are exact
 * members of this pattern, so no finding id string actually changes.
 *
 * `-not-diagnosable` is the honest "could not check" outcome (soma#370): Soma
 * is not installed / the Soma home is incomplete, so the source projection
 * cannot be built to compare against and NO comparison was performed. It is
 * emitted as `severity: "info"` so a legitimately-uninstalled home does not
 * hard-fail CI, but the output says "not diagnosed" rather than a bare "ok" —
 * never fail open.
 */
export type SomaDoctorProjectionFindingId =
  | `${SomaDoctorSubstrate}-projection-missing`
  | `${SomaDoctorSubstrate}-projection-stale`
  | `${SomaDoctorSubstrate}-projection-unmanaged-edit`
  | `${SomaDoctorSubstrate}-not-diagnosable`;

export type SomaDoctorFindingId =
  | "starter-profile"
  | "claude-skills-not-migrated"
  | SomaDoctorProjectionFindingId
  // soma#542: eager-loader stub integrity. Not a projection-drift id — the
  // stub's own bytes are correct; what rots is the body it points at.
  | "skill-stub-dangling"
  | "skill-stub-unreadable"
  | "claude-code-hook-missing"
  | "claude-code-settings-missing"
  | "grok-hook-missing"
  | "grok-hook-files-incomplete"
  | "grok-hook-interpreter-missing"
  | "grok-inspect-unavailable"
  | "runtime-artifact-missing"
  | "runtime-artifact-unloadable";

export type SomaOnboardingSubstrate = Exclude<InstallSubstrate, "anthropic-cowork">;

export interface SomaOnboardingOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SomaOnboardingSubstrate;
}

// Classification of a detected Claude skills source dir (sage review on
// #309): `not-importable` (non-flat layout, file-at-path) and `unreadable`
// (probe could not read the source at all) must never be conflated with
// `empty` in user-facing output.
export type ClaudeSkillsSourceStatus = "importable" | "empty" | "missing" | "not-importable" | "unreadable";

// Discriminated: `command` steps are copy-paste shell commands that map to
// a standalone CLI invocation (migrate-*, install-*); `builtin` steps are
// performed by `soma init` itself and carry a human-readable action.
export type SomaInitStep =
  | { id: SomaInitStepId; kind: "command"; command: string; description: string }
  | { id: SomaInitStepId; kind: "builtin"; action: string; description: string };

export interface SomaInitPlan {
  mode: "dry-run" | "apply";
  homeDir: string;
  somaHome: string;
  substrate: SomaOnboardingSubstrate;
  detected: {
    paiInstall: string | null;
    paiUserDir: string | null;
    claudeSkillsDir: string | null;
    // Classification of the skills source. A fresh Claude Code install
    // ships an `empty` skills dir — init must not plan a migrate step that
    // would refuse, and must not label a `not-importable` tree as empty.
    claudeSkillsStatus: ClaudeSkillsSourceStatus;
    coreUserDir: string | null;
  };
  soma: {
    exists: boolean;
    starterProfile: boolean;
    skillsPopulated: boolean;
    algorithmSkillPresent: boolean;
  };
  steps: SomaInitStep[];
}

export interface SomaInitApplyStepResult {
  id: SomaInitStepId;
  status: "applied" | "skipped";
  detail: string;
}

export interface SomaInitApplyResult {
  plan: SomaInitPlan;
  steps: SomaInitApplyStepResult[];
}

export interface SomaDoctorFinding {
  id: SomaDoctorFindingId;
  /**
   * `error` (soma#370) is reserved for a projection file that is entirely
   * ABSENT on disk — a broken/never-installed projection, not merely an
   * out-of-date one. It is the only severity that flips `soma doctor`'s
   * process exit code to 2 (see `SomaDoctorDiagnosis.status` and the CLI
   * doctor handler); `warning` (drift/hand-edit) maps to exit 1, and no
   * findings above `info` maps to exit 0.
   */
  severity: "info" | "warning" | "error";
  /** Human-readable explanation of the drift; carries the narrative guidance. */
  message: string;
  /**
   * The remediation step the onboarding/doctor surfaces print verbatim.
   * Command-first: use an executable CLI command (e.g. `soma reproject grok`,
   * `soma install claude-code --apply`) wherever a single command remediates
   * the finding, so an agent or user can run it directly. Only when no single
   * command applies — e.g. `starter-profile`, where the
   * user must hand-author profile files — use a concise imperative
   * instruction instead. Either way the narrative explanation belongs in
   * `message`, not here. (The grok doctor's
   * `grok-inspect-unavailable` action was prose where re-running the check is
   * the right command; it now uses the command and the prose moved to
   * `message`. Documented so future findings keep the command-first
   * convention.)
   */
  action: string;
}

export interface SomaDoctorDiagnosis {
  /**
   * `error` (soma#370) when any finding is `severity: "error"` (a projection
   * file missing on disk); `drift` when the worst finding is a `warning`
   * (stale/hand-edited but present); `ok` when nothing above `info` was
   * found. Order matters for the CLI exit code: error dominates drift
   * dominates ok (2 / 1 / 0).
   */
  status: "ok" | "drift" | "error";
  homeDir: string;
  somaHome: string;
  findings: SomaDoctorFinding[];
}

export interface SomaMemorySearchOptions {
  homeDir?: string;
  somaHome?: string;
  query: string;
  limit?: number;
  /**
   * Include `memory/STATE` — the event log, work indices and import manifests.
   * Off by default: that tree is operational bookkeeping, not memory content,
   * and it is large enough to exhaust any limit on a common term. Search also
   * appends its own `memory.recall` event there, so including it lets a search
   * match the record of previous searches.
   */
  includeState?: boolean;
  /** Injected clock for the `memory.recall` event's timestamp. Defaults to now. */
  now?: Date;
  /** Substrate tag for the `memory.recall` event this call appends. Defaults to `"custom"`. */
  substrate?: SubstrateId;
}

/**
 * What kind of file a match came from. Ranking is by class first and term score
 * second, so a curated note always outranks the raw archive it was distilled
 * from — the archive shares its vocabulary and vastly outnumbers it.
 */
export type SomaMemorySearchSourceClass = "note" | "archive" | "state";

export interface SomaMemorySearchMatch {
  path: string;
  line: number;
  score: number;
  snippet: string;
  /** Which corpus this line came from. Drives ranking; see the type. */
  sourceClass: SomaMemorySearchSourceClass;
}

export interface SomaMemorySearchResult {
  query: string;
  somaHome: string;
  matches: SomaMemorySearchMatch[];
}

export const SOMA_RESULT_EVENT_KINDS = [
  "result.captured",
  "learning.signal",
  "learning.pattern",
  "learning.failure",
  "wisdom.frame-update",
  "wisdom.cross-frame",
  "relationship.reflection",
  "opinion.tracked",
] as const;

export type SomaResultEventKind = (typeof SOMA_RESULT_EVENT_KINDS)[number];

export interface SomaResultMemoryEvent extends Omit<SomaMemoryEvent, "kind" | "metadata"> {
  kind: SomaResultEventKind;
  metadata: Record<string, unknown> & {
    source: string;
    promptStored: false;
    resultStored: false;
    skill?: string;
    sessionId?: string;
    resultKind?: "skill-output";
  };
}

export interface SomaResultCaptureOptions {
  homeDir?: string;
  somaHome?: string;
  substrate: SubstrateId;
  source: string;
  summary: string;
  artifactPaths?: string[];
  skill?: string;
  sessionId?: string;
  kind?: SomaResultEventKind;
}

export interface SomaResultCaptureResult {
  somaHome: string;
  event: SomaResultMemoryEvent;
}

export interface SomaResultSearchOptions {
  homeDir?: string;
  somaHome?: string;
  query: string;
  limit?: number;
}

export interface SomaResultSearchMatch {
  eventPath: string;
  line: number;
  eventId: string;
  kind: SomaResultEventKind;
  score: number;
  summary: string;
  artifactPaths: string[];
}

export interface SomaResultSearchResult {
  query: string;
  somaHome: string;
  matches: SomaResultSearchMatch[];
}

export interface SomaMemoryPromotionOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  fromRun: string;
  store: SomaMemoryPromotionStore;
  title: string;
  lesson?: string;
  appliesWhen?: string;
  timestamp?: string;
  /**
   * The deliberate-escalation gate for the principal-trust durable note that
   * promotion mints (see docs/architecture.md Memory section). Mirrors
   * `principalAuthority` on {@link SomaMemoryWriteOptions}: a sudo-style
   * explicit, logged opt-in, NOT cryptographic principal authentication (soma
   * has no such primitive). REQUIRED — omitting it is a compile-time nudge for
   * honest callers; at runtime, promotion fails closed when it is not `true`.
   */
  principalAuthority: boolean;
}

export interface SomaMemoryPromotionResult {
  somaHome: string;
  store: SomaMemoryPromotionStore;
  path: string;
  sourceRunPath: string;
  event: SomaMemoryEvent;
  /** Path of the principal-trust durable note minted alongside the PROMOTED file. */
  notePath: string;
  /** Id of the principal-trust durable note (see {@link notePath}). */
  noteId: string;
}

export interface SomaFeedbackCaptureOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  text: string;
  source?: string;
  storeExcerpt?: boolean;
  timestamp?: string;
  /** Substrate session id; omitted from the event when absent. */
  sessionId?: string;
  /** Substrate transcript path, recorded for triage; capture never reads it. */
  transcriptPath?: string;
  /** Who authored the prompt; defaults to `interactive`. */
  actor?: SomaFeedbackActor;
}

export interface SomaFeedbackCaptureResult {
  somaHome: string;
  captured: boolean;
  classification: SomaFeedbackClassification;
  event?: SomaMemoryEvent;
}

export type SomaPolicyAction = "write" | "delete" | "modify";

export type SomaPolicyDecision = "allow" | "deny";

export type InboundContentDecision = "ALLOWED" | "BLOCKED" | "HUMAN_REVIEW";

export interface InboundContentFinding {
  kind: string;
  detail: string;
}

export interface InboundContentScanInput {
  content: string;
  sourcePath?: string;
  sourceUri?: string;
}

export interface InboundContentScanResult {
  decision: InboundContentDecision;
  reason: string;
  scanner: string;
  contentHash: string;
  findings: InboundContentFinding[];
}

export interface InboundContentScanner {
  id: string;
  scan(input: InboundContentScanInput): Promise<Omit<InboundContentScanResult, "scanner" | "contentHash">> | Omit<InboundContentScanResult, "scanner" | "contentHash">;
}

export interface InboundContentSecurityConfig {
  untrustedRoots: string[];
  traceRoot: string;
}

export interface InboundContentScanOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  content?: string;
  sourcePath?: string;
  sourceUri?: string;
  scanner?: InboundContentScanner;
  record?: "all" | "deny" | "none";
  timestamp?: string;
}

export interface InboundContentScanAudit {
  event?: SomaMemoryEvent;
  tracePath?: string;
}

export interface InboundContentScanOutput extends InboundContentScanResult {
  somaHome: string;
  sourcePath?: string;
  sourceUri?: string;
  audit?: InboundContentScanAudit;
}

export interface InboundContentPromotionResult {
  somaHome: string;
  sourcePath: string;
  contentRef: {
    hash: string;
    algorithm: "sha256";
  };
  scan: InboundContentScanOutput;
}

export type RuntimePolicySurface = "prompt" | "tool_call" | "permission_request" | "config_change" | "governance_event";

export type RuntimePolicyDecision = "allow" | "deny" | "ask" | "alert";

export type RuntimePolicyFindingSeverity = "low" | "medium" | "high" | "critical";

export interface RuntimePolicyFinding {
  kind: string;
  severity: RuntimePolicyFindingSeverity;
  detail: string;
  inspector: string;
  decision?: Exclude<RuntimePolicyDecision, "allow">;
  /** How to do the same thing safely; appended to the decision reason the model sees. */
  hint?: string;
}

export interface RuntimePolicyToolCall {
  toolName: string;
  input?: Record<string, unknown>;
}

export interface RuntimePolicyCommandPatternRule {
  kind: string;
  pattern: string;
  detail: string;
  decision: Exclude<RuntimePolicyDecision, "allow">;
  severity?: RuntimePolicyFindingSeverity;
}

export interface RuntimePolicyCommandInspectionConfig {
  outboundTools?: readonly string[];
  privatePathPatterns?: readonly string[];
  credentialPathPatterns?: readonly string[];
  /** Extra path regexes for `secret-read`, on top of the defaults (soma#716). */
  secretReadPathPatterns?: readonly string[];
  patternRules?: readonly RuntimePolicyCommandPatternRule[];
  inlineInterpreterDecision?: Exclude<RuntimePolicyDecision, "allow">;
}

export type RuntimePolicyPermissionAction = "read" | "write" | "delete" | "execute" | "network" | "unknown";

export interface RuntimePolicyTrustedRoot {
  path: string;
  actions: readonly RuntimePolicyPermissionAction[];
  description?: string;
}

export interface RuntimePolicyApprovalCacheEntry {
  cacheKey: string;
  action: RuntimePolicyPermissionAction;
  targetPath?: string;
  expiresAt?: string;
}

export interface RuntimePolicyPermissionConfig {
  trustedRoots?: readonly RuntimePolicyTrustedRoot[];
  approvalCache?: readonly RuntimePolicyApprovalCacheEntry[];
}

export interface RuntimePolicyModelRule {
  id: string;
  description: string;
  surfaces?: readonly RuntimePolicySurface[];
  decision?: Exclude<RuntimePolicyDecision, "allow" | "deny">;
  severity?: RuntimePolicyFindingSeverity;
}

export interface RuntimePolicyModelInspectorConfig {
  enabled?: boolean;
  rules?: readonly RuntimePolicyModelRule[];
  level?: InferenceLevel;
  timeoutMs?: number;
}

export interface RuntimePolicyConfig {
  command?: RuntimePolicyCommandInspectionConfig;
  permission?: RuntimePolicyPermissionConfig;
  model?: RuntimePolicyModelInspectorConfig;
  privateRoots?: readonly string[];
}

export type RuntimePolicyConfigChangeErrorKind = "unreadable" | "malformed";

export interface RuntimePolicyConfigChangeError {
  kind: RuntimePolicyConfigChangeErrorKind;
  detail?: string;
}

export interface RuntimePolicyConfigChange {
  configSurface: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  error?: RuntimePolicyConfigChangeError;
  securityRelevantKeys?: readonly string[];
}

export interface RuntimePolicyPermissionRequest {
  requestId: string;
  action: RuntimePolicyPermissionAction;
  targetPath?: string;
  toolName?: string;
  cacheKey?: string;
  substrateSupportsAsk?: boolean;
}

export interface RuntimePolicyInspectOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  surface: RuntimePolicySurface;
  prompt?: string;
  toolCall?: RuntimePolicyToolCall;
  configChange?: RuntimePolicyConfigChange;
  permissionRequest?: RuntimePolicyPermissionRequest;
  runtimePolicy?: RuntimePolicyConfig;
  modelInspectorBackend?: InferenceBackend;
  record?: "all" | "deny" | "none";
  timestamp?: string;
}

export interface RuntimePolicyInspectAudit {
  event?: SomaMemoryEvent;
  tracePath?: string;
}

export interface RuntimePolicyInspectResult {
  somaHome: string;
  surface: RuntimePolicySurface;
  decision: RuntimePolicyDecision;
  /**
   * What the substrate relays to the model and the principal. A prompt denial
   * quotes the input span that tripped it, so this may contain raw input:
   * relay it, never persist it. Traces and events store a span-free reason.
   */
  reason: string;
  findings: RuntimePolicyFinding[];
  audit?: RuntimePolicyInspectAudit;
}

export interface SomaProtectedPath {
  path: string;
  description: string;
  guardDelete?: boolean;
  guardModify?: boolean;
  /**
   * Subpaths (relative to `path`) where `modify` is permitted even though the
   * surrounding root is otherwise modify-guarded. Has no effect on `delete`;
   * destructive operations against any descendant of `path` remain blocked.
   *
   * Used to declare known memory/VSA destinations under a private root so that
   * legitimate Soma writes (e.g. `~/.soma/vsa/*.md`, `~/.soma/memory/...`)
   * pass while overwrites of the private root itself (`~/.soma/profile/...`)
   * stay denied.
   */
  allowedSubpaths?: string[];
}

export interface SomaPolicyCheckOptions {
  homeDir?: string;
  somaHome?: string;
  cwd?: string;
  privateRoots?: string[];
  protectedPaths?: SomaProtectedPath[];
  substrate?: SubstrateId;
  action: SomaPolicyAction;
  destinationPath: string;
  content?: string;
  sourcePath?: string;
  record?: "all" | "deny" | "none";
  timestamp?: string;
}

export interface SomaPolicyBatchTarget {
  filePath: string;
  action?: SomaPolicyAction;
  content?: string;
  sourcePath?: string;
}

export interface SomaPolicyBatchCheckOptions extends Pick<SomaPolicyCheckOptions, "homeDir" | "somaHome" | "cwd" | "substrate" | "action" | "record" | "timestamp" | "protectedPaths"> {
  privateRoots?: string[];
  targets: SomaPolicyBatchTarget[];
}

export type SomaPolicyFindingKind = "private-source" | "private-marker" | "protected-path";

export interface SomaPolicyFinding {
  kind: SomaPolicyFindingKind;
  detail: string;
}

export interface SomaPolicyCheckResult {
  somaHome: string;
  decision: SomaPolicyDecision;
  reason: string;
  findings: SomaPolicyFinding[];
  event?: SomaMemoryEvent;
}

export interface SomaPolicyBatchCheckResult {
  decision: SomaPolicyDecision;
  reason: string;
  results: SomaPolicyCheckResult[];
}

// soma#329 slice 3: VSA writeback now emits `vsa_updated`. `isa_updated` is kept
// as a legacy member so historical events.jsonl records still typecheck on read.
export type SomaLifecycleEventName = "session_start" | "algorithm_updated" | "algorithm_observed" | "session_end" | "vsa_updated" | "isa_updated";

/**
 * Payload for `runSomaLifecycleVsaUpdated` (#38). Each entry's `text` is
 * persisted to the active VSA's matching section via the library's
 * `record*` helpers. `phase` defaults to the VSA's current phase;
 * `timestamp` defaults to the hook invocation timestamp.
 */
export interface VsaUpdatePayload {
  slug?: string;
  decisions?: { text: string; phase?: AlgorithmPhase; timestamp?: string }[];
  changelogEntries?: { text: string; phase?: AlgorithmPhase; timestamp?: string }[];
  verificationEntries?: { text: string; phase?: AlgorithmPhase; timestamp?: string }[];
}

export interface SomaLifecycleOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  sessionId?: string;
  timestamp?: string;
  /** Working directory of the substrate session (from the hook payload). */
  cwd?: string;
  /** Git branch of `cwd`, when known. Detected from `cwd` when omitted. */
  gitBranch?: string;
  /** Optional adapter-provided deadline for the session work-registry writeback. */
  workRegistryLockTimeoutMs?: number;
  /**
   * On `session-end`: path to the substrate session transcript. When set (and the
   * substrate has a transcript adapter, e.g. claude-code), the handler attempts the
   * deterministic digest FALLBACK. Substrate-owned — core does not parse it.
   */
  transcriptPath?: string;
  /** Claude Code sub-agent markers from the hook payload (suppress the fallback per ADR 0014). */
  subagentId?: string;
  subagentType?: string;
}

export interface SomaStartupContext {
  somaHome: string;
  timestamp: string;
  substrate: SubstrateId;
  sessionId?: string;
  context: string;
  activeRuns: AlgorithmRunSummary[];
  recentLearnings: string[];
  relationshipNotes: string[];
}

export interface AlgorithmWorkIndex {
  updatedAt: string;
  /** Actual scan start, independent of caller-supplied event timestamps. */
  scanStartedAt?: string;
  runs: AlgorithmRunSummary[];
}

export interface SomaLifecycleResult {
  event: SomaLifecycleEventName;
  somaHome: string;
  timestamp: string;
  files: string[];
  context?: string;
  activeVsa?: { slug: string; phase: AlgorithmPhase } | null;
  writes?: string[];
}

/**
 * @deprecated Use {@link SomaExecutionRequest}; retained for source
 * compatibility while adapters remain projection-only.
 */
export interface SomaTask {
  id: string;
  substrate: ProjectionSubstrate;
  prompt: string;
  cwd?: string;
}

/**
 * @deprecated Use {@link SomaExecutionResult}; retained for source
 * compatibility while adapters remain projection-only.
 */
export interface SomaRunResult {
  taskId: string;
  substrate: ProjectionSubstrate;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  artifacts?: string[];
}

export interface SomaAdapter {
  name: ProjectionSubstrate;
  detect(): Promise<boolean>;
  project(input: ProjectionInput): Promise<Projection>;
}

// ── Memory subsystem (Track B, M0) ──────────────────────────────────────────
// File-native memory note schema. Contract fixed in the memory-subsystem plan
// v2 §2 (do not redesign). One note = one markdown file: strict frontmatter +
// markdown body. Parser/serializer live in src/memory-note.ts and obey the
// round-trip law parse(serialize(n)) == n for any note serialize accepts whose
// body is already trimmed (serialize trims the body — the one lossy
// normalization; see serializeMemoryNote for the exact contract).
// Single source of truth for the note enums: the validator arrays in
// memory-note.ts import these, and the union types derive from them, so the
// literals live in exactly one place.
export const SOMA_MEMORY_NOTE_TYPES = ["semantic", "episodic", "procedural"] as const;
export type SomaMemoryNoteType = (typeof SOMA_MEMORY_NOTE_TYPES)[number];
// Trust tier = who vouched for a memory. "assistant" (not "agent") per
// CONTEXT.md, which reserves `agent` for substrate concepts and forbids it as a
// Soma core noun; the plan's `agent` tier is renamed here at first codification.
export const SOMA_MEMORY_TRUSTS = ["principal", "assistant", "quarantined"] as const;
export type SomaMemoryTrust = (typeof SOMA_MEMORY_TRUSTS)[number];

export interface SomaMemoryNote {
  id: string;                 // kebab slug; storage layer (M1) binds it to the filename stem
  type: SomaMemoryNoteType;
  created: string;            // YYYY-MM-DD
  last_verified: string;      // YYYY-MM-DD
  valid_until: string | null; // YYYY-MM-DD when superseded/expired, else null
  provenance: string;         // "conversation" | "consolidation" | "import" | "tool:<name>"
  trust: SomaMemoryTrust;     // who vouched: principal | assistant | quarantined.
                              // "assistant" not "agent" — CONTEXT.md reserves `agent` for substrate concepts.
  source_of_truth: string | null; // path/URL to verify against, or null
  project: string | null;     // scope key, e.g. "soma", or null
  links: string[];            // ids of related notes (may be empty)
  resurface_count: number;    // integer >= 0
  hook?: string;              // optional: recall-trigger phrase
  review?: string;            // optional: review directive
  body: string;               // markdown after the closing ---
}

// Memory subsystem M1 (write + verify). Plan v2 §M1 (do not redesign the
// governance model): trust is NOT selectable via a `--trust` flag — it is DERIVED
// from the write trigger, and elevating above `quarantined` needs a deliberate
// authority signal. Honest scope: the ENFORCED boundary is the CLI surface (no
// public self-assert path), not the SDK — an in-process caller can still set the
// `principalAuthority`/`consolidationAuthority` booleans, as soma has no
// cryptographic capability primitive (CONTEXT.md reserves bare `agent`; use
// `assistant`/substrate). THREE of
// design §7's five triggers reach the `write` path (principal-correction, import,
// consolidation); the other two — session-end and consequential-action — are
// M5's episodic `digest`/`action`, NOT `write`. M1 owns the durable, dedup-gated
// types (semantic + procedural).

/**
 * The governed write trigger (design §7). Trust is a pure function of this value
 * (see {@link SOMA_MEMORY_TRIGGER_TRUST}); there is no `--trust` flag. Only these
 * three reach the `write` path in M1:
 * - `principal-correction` — the principal said "remember"/"no, always X". The
 *   ONLY path to `principal` trust, and the documented principal-authority gate.
 * - `import` — migration / external doc. Untrusted source → `quarantined` (MINJA
 *   defense: tool/web content never lands trusted).
 * - `consolidation` — the M6 consolidator promoting/merging → `assistant`.
 * (`session-end` and `consequential-action` are the other two design-§7 triggers;
 * they belong to M5's episodic path, not `write`.)
 */
export const SOMA_MEMORY_WRITE_TRIGGERS = ["principal-correction", "import", "consolidation"] as const;
export type SomaMemoryWriteTrigger = (typeof SOMA_MEMORY_WRITE_TRIGGERS)[number];

/** Trust derived from trigger — the whole M1 governance model in one table. */
export const SOMA_MEMORY_TRIGGER_TRUST: Record<SomaMemoryWriteTrigger, SomaMemoryTrust> = {
  "principal-correction": "principal",
  import: "quarantined",
  consolidation: "assistant",
};

/** Create (dedup-gated), merge (delta-edit target), or supersede (close old + create new). */
export type SomaMemoryWriteMode = "create" | "merge" | "supersede";

/** A near-duplicate surfaced by the recall-first refusal gate (Jaccard ≥ 0.6 or exact-body hash). */
export interface SomaMemoryDuplicateCandidate {
  id: string;
  type: SomaMemoryNoteType;
  path: string;
  /** 1.0 for an exact normalized-body hash match, else the Jaccard token-set score. */
  score: number;
  exact: boolean;
}

export interface SomaMemoryWriteOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  /** Injected clock for deterministic `created`/`last_verified`. Defaults to now. */
  now?: Date;

  mode: SomaMemoryWriteMode;
  trigger: SomaMemoryWriteTrigger;
  /**
   * The deliberate-escalation gate for `principal` trust. `principal-correction`
   * mints a `principal` note only when this is set — otherwise it is REFUSED, so
   * an automated/agent invocation can never mint principal trust incidentally
   * from the trigger alone. This is a sudo-style deliberate + logged escalation,
   * NOT cryptographic principal authentication (soma has no such primitive — a
   * recorded limitation). The CLI sets it from an explicit `--principal-authority`
   * flag; it is intentionally NOT an env var (ambient authority is the footgun
   * this gate exists to close). Ignored for import/consolidation triggers.
   */
  principalAuthority?: boolean;
  /**
   * The consolidation counterpart of {@link principalAuthority}: `consolidation`
   * mints `assistant` trust, so it too requires an explicit signal. Like
   * `principalAuthority`, this is a sudo-style deliberate flag, NOT a
   * cryptographically enforced capability — at the SDK layer an in-process caller
   * (intended: the M6 consolidator) sets it, exactly as they would set
   * `principalAuthority`; soma has no capability primitive to make it
   * unforgeable. What IS enforced is the surface: it is intentionally NOT exposed
   * as a public CLI flag and `--trigger consolidation` is refused on the CLI, so
   * the public command-line cannot mint assistant trust. Ignored for
   * principal/import triggers.
   */
  consolidationAuthority?: boolean;

  /** create/supersede: the new note's id. merge: unused (target is `--merge <id>`). */
  id?: string;
  type?: SomaMemoryNoteType;
  body: string;
  project?: string | null;
  sourceOfTruth?: string | null;
  links?: string[];
  hook?: string;
  review?: string;
  /**
   * Only meaningful for `import` (`import` or `tool:<name>`); forced to
   * `conversation` for principal-correction and `consolidation` otherwise.
   */
  provenance?: string;

  /** merge: id of the note to delta-edit. supersede: id of the note to close. */
  targetId?: string;
  /** create only: bypass the recall-first refusal gate. */
  force?: boolean;
  /**
   * #428 — create only: when the recall-first refusal gate finds a near-dup
   * (exact-hash or Jaccard ≥ 0.6), delta-merge this write's body into the
   * BEST-scoring candidate (the existing `merge` mode) instead of refusing —
   * an opt-in resolution, not a silent auto-merge. Governance is UNCHANGED: the
   * redirect only picks the target automatically, `mergeNote`'s own
   * trust-rank + tier-authority checks still apply exactly as for an explicit
   * `--merge <id>`. Mutually exclusive with `force` (which skips the scan
   * entirely, so there is nothing for `upsert` to react to). Ignored when no
   * candidate is found — the write proceeds as a normal create.
   */
  upsert?: boolean;
}

export interface SomaMemoryWriteResult {
  somaHome: string;
  mode: SomaMemoryWriteMode;
  path: string;
  note: SomaMemoryNote;
  /** supersede only: the id of the note that was closed (valid_until set). Undefined for create/merge. */
  supersededId?: string;
  event: SomaMemoryEvent;
}

export interface SomaMemoryVerifyOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  now?: Date;
  id: string;
  /**
   * Verifying mutates a note's decay signals (`last_verified`, `resurface_count`),
   * so verifying a non-quarantined note needs that tier's authority — otherwise a
   * tool caller could keep a trusted note artificially fresh in the index.
   * `principal` notes need this; ignored for quarantined notes.
   */
  principalAuthority?: boolean;
  /** As above, for `assistant`-trust notes. Ignored for principal/quarantined notes. */
  consolidationAuthority?: boolean;
}

export interface SomaMemoryVerifyResult {
  somaHome: string;
  path: string;
  note: SomaMemoryNote;
  event: SomaMemoryEvent;
}

/**
 * #427 — the low-friction "this recalled note helped" signal. Distinct from
 * `verify`: `verify` is the caller ASSERTING a fact still holds (authority-gated,
 * requires `--principal-authority`/`consolidationAuthority` per tier); `resurface`
 * is the caller observing that a recall was USEFUL, which is a weaker, cheaper
 * claim — so it needs no per-call authority flag at all. It performs the identical
 * frontmatter bump (`last_verified` = today, `resurface_count += 1`) through the
 * same governance + atomicity path, but with its OWN trust-scoping instead of
 * verify's: `assistant` notes are bumped freely (the resurface act IS the
 * authority — the whole point is a path reachable from the public CLI, unlike
 * `consolidationAuthority`), `principal` notes are a no-op (already
 * unconditionally admitted, see `memory-index.ts`'s `isAdmitted`), and
 * `quarantined` notes are refused outright (never admitted; resurfacing one would
 * only mislead the retention score). This DOES introduce a narrow new governed
 * authority — the resurface act self-authorizes an assistant-tier `resurface_count`
 * bump that is reachable from the public CLI (justified above: it moves only a
 * decay signal, never body content or trust tier, so "the `used` call fired" is
 * sufficient authority for it). It adds no new note-CONTENT authority, and no
 * change to the admission threshold or retention formula.
 */
export interface SomaMemoryResurfaceOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  now?: Date;
  id: string;
}

export interface SomaMemoryResurfaceResult {
  somaHome: string;
  path: string;
  note: SomaMemoryNote;
  /**
   * `false` for the principal-trust no-op (already admitted — nothing written,
   * `event` is `undefined`). `true` for the assistant-trust bump (`event` is set).
   * Quarantined never reaches a result — `resurfaceMemoryNote` throws instead.
   */
  mutated: boolean;
  event?: SomaMemoryEvent;
}

// Memory subsystem M8 (backfill). Bulk-import a principal's existing free-form
// markdown memory into schema-valid, governed notes through the M1 write path.
// Deterministic, no LLM: bodies are imported verbatim (no wrapper/preamble),
// `created` comes from the source mtime, and every note lands at `quarantined` trust via the `import`
// trigger (MINJA defense — bulk-imported content is never trusted incidentally;
// the principal re-authors it later at higher trust via principal-correction/
// supersede — verify alone does not elevate a quarantined note). The top-level
// category dir is mapped to a note type by {@link SOMA_MEMORY_BACKFILL_TYPE_MAP}; `--type`
// forces a single type for all files. Idempotent via a SHA manifest at
// `memory/STATE/imports/backfill/.manifest.json`.

/** The durable, backfillable note types (episodic is written via digest/action, not backfill). */
export type WritableNoteType = Exclude<SomaMemoryNoteType, "episodic">;

/**
 * Top-level source category dir → note type. Categories not listed here fall
 * back to `semantic`. The map affects TYPE only — trust is always `quarantined`
 * (derived from the `import` trigger), never selectable here.
 */
export const SOMA_MEMORY_BACKFILL_TYPE_MAP: Record<string, WritableNoteType> = {
  LEARNING: "procedural",
  KNOWLEDGE: "semantic",
};

export interface SomaMemoryBackfillOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  /** Injected clock for deterministic manifest `importedAt`. Defaults to now. */
  now?: Date;
  /** Source root walked recursively. Defaults to `<somaHome>/memory`. */
  from?: string;
  /** Force ALL notes to this type, overriding the category map. */
  type?: WritableNoteType;
  /** Sets each note's `project` field. Defaults to null. */
  project?: string | null;
  /** Plan only — print the intended imports and touch nothing (no manifest write). */
  dryRun?: boolean;
}

export type SomaMemoryBackfillEntryStatus =
  | "written"
  | "skipped-manifest"
  | "skipped-duplicate"
  | "error";

/** One planned/attempted source-file → note import. */
export interface SomaMemoryBackfillEntry {
  /** POSIX relative path under the source root. */
  relativePath: string;
  /** Absolute source path (also recorded as the note's `source_of_truth`). */
  source: string;
  noteId: string;
  type: WritableNoteType;
  /** `created`/`last_verified` date derived from the source mtime (YYYY-MM-DD, UTC). */
  created: string;
  /** Target note path (written, or would-be for a dry-run). */
  target: string;
  /** Populated after a real run; absent for a dry-run plan entry. */
  status?: SomaMemoryBackfillEntryStatus;
  /** Present for `skipped-duplicate` / `error`: the reason. */
  detail?: string;
}

export interface SomaMemoryBackfillResult {
  somaHome: string;
  from: string;
  dryRun: boolean;
  writtenCount: number;
  skippedManifestCount: number;
  skippedDuplicateCount: number;
  errorCount: number;
  manifestPath: string;
  entries: SomaMemoryBackfillEntry[];
}

export interface SomaMemoryBackfillManifestEntry {
  relativePath: string;
  noteId: string;
  type: WritableNoteType;
  sha256: string;
  mtimeMs: number;
}

export interface SomaMemoryBackfillManifest {
  schema: "soma.memory-backfill.v1";
  somaHome: string;
  from: string;
  importedAt: string;
  files: SomaMemoryBackfillManifestEntry[];
}

// Memory subsystem M5 (episodic capture). Plan v2 §M5: session digests + a
// first-class action log, stored as `episodic` notes under
// `memory/episodic/{sessions,actions}/YYYY-MM/YYYYMMDD-<slug>.md`. Deterministic,
// no LLM. The digest write is gated to one-per-session — atomic (O_EXCL) within a
// UTC date, and a cross-date scan catches later re-digests — but it is best-effort,
// NOT an absolute guarantee: with no cross-process lock, a genuine concurrent race
// across different UTC dates can still produce two digests (reconciled by the M7
// audit). A second same-session call no-ops with an event. Action entries record plannedAction →
// approval → outcome for the consolidator (M6) to mine. Episodic notes are written
// at `assistant` trust (the assistant's own account); whether they reach the
// always-loaded INDEX is decided by M3's admission ladder, where an unresurfaced
// assistant note is not admitted until consolidation promotes it.

/** Approval state of a logged action (plannedAction → approval → outcome). */
export const SOMA_MEMORY_ACTION_APPROVALS = ["proposed", "approved", "rejected", "auto"] as const;
export type SomaMemoryActionApproval = (typeof SOMA_MEMORY_ACTION_APPROVALS)[number];

export interface SomaMemoryDigestOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  /** Injected clock for deterministic `created`/id date. Defaults to now. */
  now?: Date;
  /** The session this digest summarizes — the one-per-session gate key. */
  sessionId: string;
  /** The digest text: 8–15 non-empty lines of what happened / changed / open loops. */
  body: string;
  /**
   * Optional lifecycle-event label (e.g. `session-end`) recorded into the note's M0
   * `hook:` frontmatter field, marking the digest as lifecycle-triggered. Its ABSENCE
   * means only "not lifecycle-triggered" — it does NOT by itself prove assistant
   * authorship; `provenance` is the independent source signal (e.g. a `tool:<name>`
   * digest is machine-authored with no lifecycleEvent). Read both. The VALUE is an
   * opaque adapter-supplied string carrying lifecycle-event (not substrate-hook)
   * semantics, so core stays substrate-neutral without being semantics-free.
   */
  lifecycleEvent?: string;
  /**
   * Optional provenance override (`conversation` | `consolidation` | `import` |
   * `tool:<name>`). Defaults to `conversation`. A machine-extracted fallback passes a
   * `tool:<name>` value so recall surfaces that the body was not assistant-authored.
   * Rejected if outside this grammar.
   */
  provenance?: string;
}

// The Claude Code SessionEnd transcript-fallback types (ClaudeSessionDigestOptions/
// Result) are adapter-owned — see src/adapters/claude-code/session-digest.ts. Core
// stays substrate-neutral: it exposes only `writeSessionDigest` (ready body + hook
// marker) and `hasSessionDigest`; the Claude JSONL format never enters core.

export interface SomaMemoryDigestResult {
  somaHome: string;
  path: string;
  /** False when a digest already existed for the session (the write no-op'd). */
  created: boolean;
  note: SomaMemoryNote;
  event: SomaMemoryEvent;
}

export interface SomaMemoryActionOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  now?: Date;
  /** kebab slug for the action's id (`YYYYMMDD-<slug>`). */
  slug: string;
  /** The session this action belongs to (recorded in the note body for consolidation scope). */
  sessionId?: string;
  /**
   * What the assistant planned to do. Named `plannedAction` (not `intent`) because
   * CONTEXT.md reserves `intent` for the principal's checkable directional anchor
   * sourced from Purpose — a different concept from the assistant's logged action.
   */
  plannedAction: string;
  /** Approval state at record time. */
  approval: SomaMemoryActionApproval;
  /** What actually happened (may be recorded later; empty = not-yet-known). */
  outcome?: string;
}

export interface SomaMemoryActionResult {
  somaHome: string;
  path: string;
  note: SomaMemoryNote;
  event: SomaMemoryEvent;
}

// Memory subsystem M6 (deterministic consolidation). The full contract — ops,
// ordering, dry-run parity semantics, archive layout, idempotency — lives with the
// implementation in `src/memory-consolidate.ts` (single source of truth). In brief:
// a no-LLM maintenance pass; `--dry-run` reports the same file OPERATIONS the real
// run applies (operation-level parity, not a byte-level diff).
export interface SomaMemoryConsolidateOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  /** Injected clock for deterministic age math. Defaults to now. */
  now?: Date;
  /** Plan only — print the ops without touching the filesystem. */
  dryRun?: boolean;
  /**
   * Explicit override for the destructive state GC. Deleting `current-work-*.json`
   * is a destructive mutation of protected state, so per CONTEXT.md it needs a
   * deliberate flag — without this, the pass plans/deletes no state files.
   */
  gcState?: boolean;
}

/** One planned file move (episodic prune → archive), preserving relative path. */
export interface SomaMemoryArchivePlan {
  from: string;
  to: string;
  reason: string;
}

/**
 * A pair of notes with high LEXICAL similarity (Jaccard token overlap), surfaced
 * for principal review — a CANDIDATE duplicate/contradiction, not a proven semantic
 * one. `score` is the token-overlap ratio. This report itself is always read-only
 * (unchanged by #428); the ELIGIBLE-for-auto-merge subset of it is a separate field,
 * {@link SomaMemoryAutoMergePlan}.
 */
export interface SomaMemorySimilarPair {
  a: string;
  b: string;
  score: number;
}

/**
 * #428 — a near-dup pair from {@link SomaMemorySimilarPair} that M6 consolidation
 * is eligible to auto-merge: BOTH notes are `assistant` trust (never `principal` —
 * those stay a read-only `similarPairs` entry only; never `quarantined` — unvetted
 * content is never auto-consolidated either). `keepId` absorbs `dropId`'s body via
 * the SAME delta-append shape the M1 `merge` mode uses; `dropId` is then CLOSED
 * (`valid_until` set, cross-linked) — invalidated, never deleted, and never
 * re-minted under a new id (this is NOT `supersede`). `score` is the pair's
 * Jaccard score at plan time.
 */
export interface SomaMemoryAutoMergePlan {
  keepId: string;
  dropId: string;
  score: number;
}

export interface SomaMemoryConsolidateResult {
  somaHome: string;
  dryRun: boolean;
  // NOTE: on a dry-run these are the PLANNED operations (nothing was applied); on a
  // real run they are what was applied. Each field's verb is mode-neutral for that
  // reason.
  /** Aged episodic notes to move under `memory/archive/` (planned on dry-run, moved on a real run). */
  archived: SomaMemoryArchivePlan[];
  /** Monthly digest files whose archived-notes months are affected (regenerated on a real run). */
  digestsWritten: string[];
  /** Semantic notes to mark `review: stale` (planned on dry-run, marked on a real run). */
  markedStale: string[];
  /** `current-work-*.json` files older than 7d to GC — only under `--gc-state`; this pass's only deletion. */
  stateGced: string[];
  /** High-lexical-similarity note pairs listed for review (candidate duplicates/contradictions). Read-only; never mutates anything itself. */
  similarPairs: SomaMemorySimilarPair[];
  /**
   * #428 — assistant-trust near-dup pairs auto-merged (planned on dry-run, applied
   * on a real run): `keepId` absorbed `dropId`'s body and `dropId` was closed.
   * Principal-trust pairs NEVER appear here — see {@link SomaMemoryAutoMergePlan}.
   */
  autoMerged: SomaMemoryAutoMergePlan[];
  /**
   * Note files surfaced for the audit and NOT acted on — either an I/O/parse failure
   * (couldn't be read/parsed) OR a safety refusal (unsafe id, malformed calendar date,
   * or a mis-placed episodic note whose directory month ≠ its created month). Never
   * silently skipped; the two classes are not distinguished in this field.
   */
  unreadable: string[];
  /**
   * True iff the pass has (or, on dry-run, would have) any file mutation — i.e. any
   * of archived / markedStale / stateGced / autoMerged is non-empty. The single
   * source of truth for whether the INDEX is rebuilt and a `memory.consolidate`
   * event is emitted; the similar-pairs report is read-only and does NOT set this.
   */
  mutated: boolean;
  /**
   * The INDEX.md path. Always reported, but the index is REBUILT only when the pass
   * mutated something (any of archived / markedStale / stateGced non-empty) — a
   * no-op run leaves it untouched. This is the path, not proof a rebuild happened.
   */
  indexPath: string;
}

// Memory subsystem M7 (audit). Plan v2 §M7: a DETERMINISTIC health check over the
// on-disk memory tree — no LLM, no sentiment, only filesystem ground-truth probes.
// Read-only: it mutates nothing and appends no event. The CLI exits NON-ZERO when
// `healthy` is false — any health-gating probe failing: an abnormal note root
// (root-integrity), a schema-invalid note, or a stale INDEX — so it can gate CI /
// a pre-consolidation check.
export interface SomaMemoryAuditOptions {
  homeDir?: string;
  somaHome?: string;
}

/** The fixed set of audit probes (stable public names; `auditMemory` is exported). */
export type SomaMemoryAuditProbeName =
  | "root-integrity"
  | "schema"
  | "index-freshness"
  | "digest-coverage"
  | "orphaned-archive"
  | "event-ratio"
  | "retrieval-quality";

/**
 * One deterministic probe's outcome. `gatesHealth` is machine-readable: when it is
 * true, `ok: false` forces `result.healthy` false. Three probes gate:
 * `root-integrity`, `schema`, and `index-freshness`. Informational probes
 * (`digest-coverage`, `orphaned-archive`, `event-ratio`, `retrieval-quality`) have
 * `gatesHealth: false` and always report `ok: true`.
 */
export interface SomaMemoryAuditProbe {
  name: SomaMemoryAuditProbeName;
  ok: boolean;
  gatesHealth: boolean;
  detail: string;
}

/**
 * #425 — the first retrieval-quality signal, computed PURELY from the journal
 * (no new state files, no gating): the AUTOMEM-inspired "does recall actually
 * help" proxy. Every rate here is over PARSEABLE journal events — a malformed
 * JSONL line is skipped and counted in `skippedEventLines`, so a reader can see
 * the metric is not necessarily over the complete journal. `verifyFollowsRecallRate`'s
 * denominator is recalls WITH results (`recallsWithResults`), not every recall —
 * an empty recall structurally can never be followed by a verify of a returned
 * note, so folding it into this rate would just re-encode `emptyRecallRate` a
 * second time. `verifyWindowEvents` is the number of SUBSEQUENT parseable journal
 * events (any kind) searched, chronologically after a recall, for a
 * `memory.verify` OR (#427) `memory.resurface` of one of its returned ids — a
 * fixed default (see `memory-audit.ts`), not yet configurable; a future slice
 * may gate on this metric, this one only measures it.
 */
export interface SomaMemoryRetrievalQuality {
  /** Total `memory.recall` events in the journal. */
  recallVolume: number;
  /** Fraction of recalls returning 0 note ids (AUTOMEM's "empty-search rate"). 0 when recallVolume is 0. */
  emptyRecallRate: number;
  /** Fraction of non-empty recalls followed by a `memory.verify` OR (#427) `memory.resurface` of a returned id within the window. 0 when recallsWithResults is 0. */
  verifyFollowsRecallRate: number;
  /** Denominator for verifyFollowsRecallRate: recalls that returned ≥1 note id. */
  recallsWithResults: number;
  /** The subsequent-event window used to correlate a recall with a later verify. */
  verifyWindowEvents: number;
  /** Non-empty journal lines that failed to parse (skipped, not counted in any rate) — surfaces that the metric is over PARSEABLE events, not the whole journal. */
  skippedEventLines: number;
}

export interface SomaMemoryAuditResult {
  somaHome: string;
  /** false ⇒ the CLI exits non-zero. Gated by ALL three: real note roots (root-integrity),
   *  no schema-invalid notes, AND a fresh INDEX. */
  healthy: boolean;
  /** Valid-note counts by type across the whole tree (durable + episodic + archive). */
  notesByType: { semantic: number; procedural: number; episodic: number };
  /** Note files that exist but fail to parse (schema-invalid) — a health failure. */
  invalidNotes: string[];
  /** INDEX freshness: stale when a durable note is newer than INDEX.md, or INDEX is absent while durable notes exist. */
  index: { path: string; stale: boolean; reason: string };
  /** Episodic coverage counts — session/action notes vs monthly digest files present. */
  digests: { sessionNotes: number; actionNotes: number; digestFiles: number };
  /** Archived episodic notes whose id is absent from their month's digest (informational drift signal). */
  orphanedArchive: string[];
  /** Event-stream vs corpus size — a coarse write-amplification signal (informational). */
  events: { lines: number; notes: number };
  /** #425 retrieval-quality signal computed from the journal (informational, never gates `healthy`). */
  retrieval: SomaMemoryRetrievalQuality;
  /**
   * Every probe run, in report order. THREE gate `healthy` (`root-integrity`,
   * `schema`, `index-freshness`); the other four (`digest-coverage`,
   * `orphaned-archive`, `event-ratio`, `retrieval-quality`) are informational drift
   * signals whose `ok` is always true. Read `probe.gatesHealth` rather than
   * hardcoding this list.
   */
  probes: SomaMemoryAuditProbe[];
}

// Memory subsystem M2 (recall). Plan v2 §M2: note-aware retrieval over the
// durable corpus (semantic + procedural) — term scoring, whole-file retrieval
// (limit 3), 1-hop link expansion, superseded-exclusion via `valid_until`, and a
// read-time verification banner whose age derives from an injected `now`. Recall
// mutates NO note (verifying is a separate, authority-gated act) — that purity
// invariant is unchanged. #425 adds exactly one observability side effect: every
// call appends a `memory.recall` journal event (query terms, returned note ids,
// result count, unresolved-link count) so retrieval can finally be measured; see
// `memory-recall.ts`'s module docstring for the full contract. The legacy
// line-grep `searchSomaMemory` (which walks the pre-note memory tree
// WORK/KNOWLEDGE/…) also appends a `memory.recall` event now, tagged
// `via: "search"` — but only when the query has searchable terms.
export interface SomaMemoryRecallOptions {
  homeDir?: string;
  somaHome?: string;
  query: string;
  /** Cap on primary (term-matched) notes returned; 1-hop link pulls are additional. Default 3. */
  limit?: number;
  /** Injected clock for deterministic banner ages AND the recall event's timestamp. Defaults to now. */
  now?: Date;
  /** Substrate tag for the `memory.recall` event this call appends. Defaults to `"custom"`. */
  substrate?: SubstrateId;
}

/** One retrieved note with its verification banner (M2). */
export interface SomaMemoryRecalledNote {
  id: string;
  type: SomaMemoryNoteType;
  path: string;
  /** Distinct query terms matched in the note; 0 for a note pulled only via a 1-hop link. */
  score: number;
  /** `match` = surfaced by term score; `link` = pulled in as 1-hop context from a match. */
  via: "match" | "link";
  /** For `via: "link"`, the id of the matched note that linked here; null for matches. */
  linkedFrom: string | null;
  /** Whole days since `last_verified`, clamped at 0 for a future date (derived from injected `now`). */
  ageDays: number;
  /** True iff `trust === "quarantined"` — the note carries an untrusted-content warning. */
  quarantined: boolean;
  /** The one-line verification banner (age · trust · provenance · verify-against). */
  banner: string;
  /** Whole-file: the complete parsed note (body included). */
  note: SomaMemoryNote;
}

export interface SomaMemoryRecallResult {
  query: string;
  somaHome: string;
  /** The 3+char query terms actually scored (deduped, lowercased). */
  terms: string[];
  /** Primary matches first (score desc), then their 1-hop link pulls. */
  matches: SomaMemoryRecalledNote[];
  /** 1-hop link ids that resolved to no active note (missing or superseded) — surfaced, not hidden. */
  unresolvedLinks: string[];
  /** Corpus files that exist but could not be read/parsed — recall's blind spot, never silent. */
  unreadable: string[];
}

// Memory subsystem M3 (index renderer). The result of rebuilding the tiny,
// always-loaded INDEX (`memory/INDEX.md`, ≤200 pointer lines / ≤25KB): its path,
// rendered content, admit/render/shed/excluded counts, and the unreadable blind
// spot. Admission, scoring, and budget POLICY live with the renderer in
// `src/memory-index.ts` (the single source of truth). M4 projects the file through
// substrate adapters into each substrate's native always-loaded surface.
export interface SomaMemoryIndexResult {
  somaHome: string;
  /** On-disk path of the rendered index (`memory/INDEX.md`). */
  path: string;
  /** The rendered INDEX.md content (also what M4 projects verbatim). */
  content: string;
  /** Notes that earned admission (before the budget was applied). */
  admitted: number;
  /** Index lines actually rendered after the budget. */
  rendered: number;
  /** admitted − rendered: lines shed to stay within the line/byte budget. */
  shed: number;
  /** Notes present but NOT admitted (quarantined, superseded, or not yet earned). */
  excluded: number;
  /** Corpus files that exist but could not be read/parsed — surfaced, never silent. */
  unreadable: string[];
}
