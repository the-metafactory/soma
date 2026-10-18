import type { SkillNormalizationAction, SkillNormalizationWarning } from "./substrates/types";
export type {
  InstalledSkill,
  Projection,
  SkillNormalizationAction,
  SkillNormalizationWarning,
  SomaAdapter,
  SomaDoctorFinding,
  SomaDoctorFindingId,
  SomaDoctorProjectionFindingId,
  SomaDoctorSubstrate,
  SomaHomeBootstrapResult,
  SomaHomeProjection,
  SomaHomeProjectionOptions,
  SomaInstallOptions,
  SomaInstallResult,
  SomaLifecycleOptions,
  SomaSkillBaseline,
  SomaSkillBaselines,
  UninstallableSkillReport,
  VsaSkillInstallAction,
  VsaSkillInstallOptions,
  VsaSkillInstallResult,
  WrittenProjection,
} from "./substrates/types";
export type { AlgorithmEffortSource, AlgorithmLoopStatus, AlgorithmLoopIteration, AlgorithmLoopState, AlgorithmCriteriaPartition, IdeateParameters, IdeatePresetName, OptimizeParameters, OptimizePresetName, AlgorithmNotificationEvent, AlgorithmNotificationSink, AlgorithmLoopExecutionContext, AlgorithmLoopIterationResult, AlgorithmLoopExecutor, AlgorithmPromptClassification, AlgorithmPlanStep, AlgorithmReferenceVerdict, AlgorithmReference, AlgorithmObservation, AlgorithmGatesFired, AlgorithmMetaReflection, AlgorithmProvenanceOperation, AlgorithmProvenanceEntry, AlgorithmCapabilityKind, AlgorithmCapabilityContract, AlgorithmCapabilityInvocationContract, AlgorithmCapabilitySelectionStatus, AlgorithmCapabilityDefinition, SomaSkillAlgorithmCapabilityManifest, AlgorithmCapabilityInvocation, AlgorithmCapabilitySelection, AlgorithmRun, AlgorithmRunSummary, AlgorithmRunInput, AlgorithmBatchOperation, SomaSkillManifest } from "./algorithm/types";
export { ALGORITHM_REFERENCE_VERDICTS, ALGORITHM_CAPABILITY_KINDS } from "./algorithm/types";
import type { Purpose } from "./home/types";
/** @deprecated Import from home/types; compatibility lasts until the final seams node. */ export type { AssistantIdentity, PrincipalIdentity, Purpose, SomaMemoryLayout, SomaProfile, ProjectionInput, SomaSnapshotEntry, SomaSnapshotListOptions, SomaSnapshotOptions, SomaSnapshotResult, SomaSnapshotRollbackOptions, SomaSnapshotRollbackResult } from "./home/types";
/** @deprecated Import from flows/types; compatibility lasts until the final seams node. */ export type { ErrataPassedBy, ErrataInput, ErrataRecord, ErrataClusterKey, ErrataCluster, ErrataAnswerKind, ErrataClusterEvent, ErrataEvent, SomaHomeBootstrapOptions, SomaInstallPlan, SomaInitStepId, SomaOnboardingSubstrate, SomaOnboardingOptions, SomaInitStep, SomaInitPlan, SomaInitApplyStepResult, SomaInitApplyResult, SomaDoctorDiagnosis, SomaResultEventKind, SomaResultMemoryEvent, SomaResultCaptureOptions, SomaResultCaptureResult, SomaResultSearchOptions, SomaResultSearchMatch, SomaResultSearchResult, SomaMemoryPromotionOptions, SomaMemoryPromotionResult, SomaFeedbackCaptureOptions, SomaFeedbackCaptureResult, SomaLifecycleEventName, VsaUpdatePayload, SomaStartupContext, AlgorithmWorkIndex, SomaLifecycleResult } from "./flows/types";
export { SOMA_RESULT_EVENT_KINDS } from "./flows/types";
/** @deprecated Import from migrate/types; compatibility lasts until the final seams node. */ export type { ClaudeSkillsSmokeSubstrate, ClaudeSkillSubstrateVerifyStatus, ClaudeSkillSubstrateVerifyResult, ClaudeSkillSubstrateVerifyIssue, ClaudeSkillsMigrationOptions, RewriteDescriptionsAgent, DescriptionStatus, RewriteDispatchOverride, ClaudeSkillPortabilityTag, ClaudeSkillOutcome, ClaudeSkillDependency, ClaudeSkillDescriptionRewrite, ClaudeSkillAuditEntry, ClaudeSkillsMigrationPlan, ClaudeSkillsMigrationResult, ClaudeSkillSubstrateVerifySummary, ClaudeSkillsMigrationManifestEntry, ClaudeSkillsMigrationManifestOutcome, ClaudeSkillsMigrationManifestLastRun, ClaudeSkillsMigrationManifest, ClaudeSkillsSourceStatus } from "./migrate/types";
export type { SomaPolicyAction, SomaPolicyDecision, InboundContentDecision, InboundContentFinding, InboundContentScanInput, InboundContentScanResult, InboundContentScanner, InboundContentSecurityConfig, InboundContentScanOptions, InboundContentScanAudit, InboundContentScanOutput, InboundContentPromotionResult, RuntimePolicySurface, RuntimePolicyDecision, RuntimePolicyFindingSeverity, RuntimePolicyFinding, RuntimePolicyToolCall, RuntimePolicyCommandPatternRule, RuntimePolicyCommandInspectionConfig, RuntimePolicyPermissionAction, RuntimePolicyTrustedRoot, RuntimePolicyApprovalCacheEntry, RuntimePolicyPermissionConfig, RuntimePolicyModelRule, RuntimePolicyModelInspectorConfig, RuntimePolicyConfig, RuntimePolicyConfigChangeErrorKind, RuntimePolicyConfigChangeError, RuntimePolicyConfigChange, RuntimePolicyPermissionRequest, RuntimePolicyInspectOptions, RuntimePolicyInspectAudit, RuntimePolicyInspectResult, SomaProtectedPath, SomaPolicyCheckOptions, SomaPolicyBatchTarget, SomaPolicyBatchCheckOptions, SomaPolicyFindingKind, SomaPolicyFinding, SomaPolicyCheckResult, SomaPolicyBatchCheckResult, InstallSubstrate, PrivateRootOptions } from "./policy/types";
import type { Checkpoint } from "./vsa/types";
export type { AlgorithmLogEntry, AuthoredFrontmatter, Checkpoint, CriterionStatus, DerivedFrontmatter, SomaActiveVsaState, VerificationStateArtifact, VsaFrontmatter, VsaSection } from "./vsa/types";
export type { SomaMemoryActionApproval, SomaMemoryActionOptions, SomaMemoryActionResult, SomaMemoryArchivePlan, SomaMemoryAuditOptions, SomaMemoryAuditProbe, SomaMemoryAuditProbeName, SomaMemoryAuditResult, SomaMemoryAutoMergePlan, SomaMemoryBackfillEntry, SomaMemoryBackfillEntryStatus, SomaMemoryBackfillManifest, SomaMemoryBackfillManifestEntry, SomaMemoryBackfillOptions, SomaMemoryBackfillResult, SomaMemoryConsolidateOptions, SomaMemoryConsolidateResult, SomaMemoryDigestOptions, SomaMemoryDigestResult, SomaMemoryDuplicateCandidate, SomaMemoryIndexResult, SomaMemoryNote, SomaMemoryNoteType, SomaMemoryRecallOptions, SomaMemoryRecallResult, SomaMemoryRecalledNote, SomaMemoryResurfaceOptions, SomaMemoryResurfaceResult, SomaMemoryRetrievalQuality, SomaMemorySearchMatch, SomaMemorySearchOptions, SomaMemorySearchResult, SomaMemorySearchSourceClass, SomaMemorySimilarPair, SomaMemoryTrust, SomaMemoryVerifyOptions, SomaMemoryVerifyResult, SomaMemoryWriteMode, SomaMemoryWriteOptions, SomaMemoryWriteResult, SomaMemoryWriteTrigger, WritableNoteType } from "./memory/types";
export { SOMA_MEMORY_ACTION_APPROVALS, SOMA_MEMORY_BACKFILL_TYPE_MAP, SOMA_MEMORY_NOTE_TYPES, SOMA_MEMORY_TRIGGER_TRUST, SOMA_MEMORY_TRUSTS, SOMA_MEMORY_WRITE_TRIGGERS } from "./memory/types";
export type { SomaMemoryEventInput, SomaMemoryEvent, SomaTelemetryQueryOptions, SomaTelemetryQueryResult, SomaTelemetrySummaryOptions, SomaTelemetrySummary, SomaFeedbackKind, SomaFeedbackClassification, SomaFeedbackActor } from "./events/index";
export type { SomaPaths, SomaMemoryPromotionStore } from "./core/index";
export { SOMA_MEMORY_PROMOTION_STORE_DIRS, SOMA_MEMORY_PROMOTION_STORES } from "./core/index";
/** Every substrate id Soma knows. `SubstrateId` and `KNOWN_SUBSTRATES` derive from this list. */
export const SUBSTRATE_IDS = ["codex", "pi-dev", "claude-code", "cursor", "grok", "dsh", "cortex", "custom", "anthropic-cowork"] as const;
export type SubstrateId = (typeof SUBSTRATE_IDS)[number];

export type ExperimentalScaffoldSubstrate = "anthropic-cowork";
export type ProjectionSubstrate = SubstrateId | ExperimentalScaffoldSubstrate;

/**
 * The substrates with a shipped adapter. Install, reproject, `soma doctor` and
 * content-compare all cover exactly these; add a substrate here, not per command.
 */
export const SHIPPED_SUBSTRATES = ["codex", "pi-dev", "claude-code", "cursor", "grok", "dsh"] as const satisfies readonly SubstrateId[];
export type ShippedSubstrate = (typeof SHIPPED_SUBSTRATES)[number];

export const GOAL_STATUSES = ["draft", "active", "paused", "achieved", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

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

/**
 * @deprecated soma#329: renamed to {@link Checkpoint}. Retained as a back-compat
 * alias for the PAI-era name; prefer `Checkpoint` in new code.
 */
export type IdealStateCriterion = Checkpoint;

export const ALGORITHM_PHASES = ["observe", "think", "plan", "build", "execute", "verify", "learn", "complete", "abandoned"] as const;
export type AlgorithmPhase = (typeof ALGORITHM_PHASES)[number];

export const ALGORITHM_EFFORT_TIERS = ["E1", "E2", "E3", "E4", "E5"] as const;
export type AlgorithmEffortTier = (typeof ALGORITHM_EFFORT_TIERS)[number];

export const ALGORITHM_MODES = ["minimal", "native", "algorithm"] as const;
export type AlgorithmMode = (typeof ALGORITHM_MODES)[number];

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

/** @deprecated Renamed to {@link SkillNormalizationAction} (node #793). Kept for back-compat. */
export type PaiPackNormalizationAction = SkillNormalizationAction;

/** @deprecated Renamed to {@link SkillNormalizationWarning} (node #793). Kept for back-compat. */
export type PaiPackNormalizationWarning = SkillNormalizationWarning;

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