import type { SomaDoctorFinding, SkillNormalizationAction, SkillNormalizationWarning } from "./substrates/types";
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
import type { AlgorithmRunSummary } from "./algorithm/types";
import type { ProposalKind } from "./core/index";
export type { AlgorithmEffortSource, AlgorithmLoopStatus, AlgorithmLoopIteration, AlgorithmLoopState, AlgorithmCriteriaPartition, IdeateParameters, IdeatePresetName, OptimizeParameters, OptimizePresetName, AlgorithmNotificationEvent, AlgorithmNotificationSink, AlgorithmLoopExecutionContext, AlgorithmLoopIterationResult, AlgorithmLoopExecutor, AlgorithmPromptClassification, AlgorithmPlanStep, AlgorithmReferenceVerdict, AlgorithmReference, AlgorithmObservation, AlgorithmGatesFired, AlgorithmMetaReflection, AlgorithmProvenanceOperation, AlgorithmProvenanceEntry, AlgorithmCapabilityKind, AlgorithmCapabilityContract, AlgorithmCapabilityInvocationContract, AlgorithmCapabilitySelectionStatus, AlgorithmCapabilityDefinition, SomaSkillAlgorithmCapabilityManifest, AlgorithmCapabilityInvocation, AlgorithmCapabilitySelection, AlgorithmRun, AlgorithmRunSummary, AlgorithmRunInput, AlgorithmBatchOperation, SomaSkillManifest } from "./algorithm/types";
export { ALGORITHM_REFERENCE_VERDICTS, ALGORITHM_CAPABILITY_KINDS } from "./algorithm/types";
import type { Purpose } from "./home/types";
/** @deprecated Import from home/types; compatibility lasts until the final seams node. */ export type { AssistantIdentity, PrincipalIdentity, Purpose, SomaMemoryLayout, SomaProfile, ProjectionInput, SomaSnapshotEntry, SomaSnapshotListOptions, SomaSnapshotOptions, SomaSnapshotResult, SomaSnapshotRollbackOptions, SomaSnapshotRollbackResult } from "./home/types";
import type { InstallSubstrate } from "./policy/types";
import type { ClaudeSkillsSourceStatus } from "./migrate/types";
/** @deprecated Import from migrate/types; compatibility lasts until the final seams node. */ export type { ClaudeSkillsSmokeSubstrate, ClaudeSkillSubstrateVerifyStatus, ClaudeSkillSubstrateVerifyResult, ClaudeSkillSubstrateVerifyIssue, ClaudeSkillsMigrationOptions, RewriteDescriptionsAgent, DescriptionStatus, RewriteDispatchOverride, ClaudeSkillPortabilityTag, ClaudeSkillOutcome, ClaudeSkillDependency, ClaudeSkillDescriptionRewrite, ClaudeSkillAuditEntry, ClaudeSkillsMigrationPlan, ClaudeSkillsMigrationResult, ClaudeSkillSubstrateVerifySummary, ClaudeSkillsMigrationManifestEntry, ClaudeSkillsMigrationManifestOutcome, ClaudeSkillsMigrationManifestLastRun, ClaudeSkillsMigrationManifest, ClaudeSkillsSourceStatus } from "./migrate/types";
export type { SomaPolicyAction, SomaPolicyDecision, InboundContentDecision, InboundContentFinding, InboundContentScanInput, InboundContentScanResult, InboundContentScanner, InboundContentSecurityConfig, InboundContentScanOptions, InboundContentScanAudit, InboundContentScanOutput, InboundContentPromotionResult, RuntimePolicySurface, RuntimePolicyDecision, RuntimePolicyFindingSeverity, RuntimePolicyFinding, RuntimePolicyToolCall, RuntimePolicyCommandPatternRule, RuntimePolicyCommandInspectionConfig, RuntimePolicyPermissionAction, RuntimePolicyTrustedRoot, RuntimePolicyApprovalCacheEntry, RuntimePolicyPermissionConfig, RuntimePolicyModelRule, RuntimePolicyModelInspectorConfig, RuntimePolicyConfig, RuntimePolicyConfigChangeErrorKind, RuntimePolicyConfigChangeError, RuntimePolicyConfigChange, RuntimePolicyPermissionRequest, RuntimePolicyInspectOptions, RuntimePolicyInspectAudit, RuntimePolicyInspectResult, SomaProtectedPath, SomaPolicyCheckOptions, SomaPolicyBatchTarget, SomaPolicyBatchCheckOptions, SomaPolicyFindingKind, SomaPolicyFinding, SomaPolicyCheckResult, SomaPolicyBatchCheckResult, InstallSubstrate, PrivateRootOptions } from "./policy/types";
import type { Checkpoint } from "./vsa/types";
export type { AlgorithmLogEntry, AuthoredFrontmatter, Checkpoint, CriterionStatus, DerivedFrontmatter, SomaActiveVsaState, VerificationStateArtifact, VsaFrontmatter, VsaSection } from "./vsa/types";
export type { SomaMemoryActionApproval, SomaMemoryActionOptions, SomaMemoryActionResult, SomaMemoryArchivePlan, SomaMemoryAuditOptions, SomaMemoryAuditProbe, SomaMemoryAuditProbeName, SomaMemoryAuditResult, SomaMemoryAutoMergePlan, SomaMemoryBackfillEntry, SomaMemoryBackfillEntryStatus, SomaMemoryBackfillManifest, SomaMemoryBackfillManifestEntry, SomaMemoryBackfillOptions, SomaMemoryBackfillResult, SomaMemoryConsolidateOptions, SomaMemoryConsolidateResult, SomaMemoryDigestOptions, SomaMemoryDigestResult, SomaMemoryDuplicateCandidate, SomaMemoryIndexResult, SomaMemoryNote, SomaMemoryNoteType, SomaMemoryRecallOptions, SomaMemoryRecallResult, SomaMemoryRecalledNote, SomaMemoryResurfaceOptions, SomaMemoryResurfaceResult, SomaMemoryRetrievalQuality, SomaMemorySearchMatch, SomaMemorySearchOptions, SomaMemorySearchResult, SomaMemorySearchSourceClass, SomaMemorySimilarPair, SomaMemoryTrust, SomaMemoryVerifyOptions, SomaMemoryVerifyResult, SomaMemoryWriteMode, SomaMemoryWriteOptions, SomaMemoryWriteResult, SomaMemoryWriteTrigger, WritableNoteType } from "./memory/types";
export { SOMA_MEMORY_ACTION_APPROVALS, SOMA_MEMORY_BACKFILL_TYPE_MAP, SOMA_MEMORY_NOTE_TYPES, SOMA_MEMORY_TRIGGER_TRUST, SOMA_MEMORY_TRUSTS, SOMA_MEMORY_WRITE_TRIGGERS } from "./memory/types";
import type { SomaMemoryEvent, SomaFeedbackClassification, SomaFeedbackActor } from "./events/index";
export type { SomaMemoryEventInput, SomaMemoryEvent, SomaTelemetryQueryOptions, SomaTelemetryQueryResult, SomaTelemetrySummaryOptions, SomaTelemetrySummary, SomaFeedbackKind, SomaFeedbackClassification, SomaFeedbackActor } from "./events/index";
import type { SomaMemoryPromotionStore } from "./core/index";
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

/** The answers a proposal can receive (soma#785 Q11, soma#903 D4). */
export type ErrataAnswerKind = "expired" | "dismissed" | "resolved";

/**
 * What the ledger records about one cluster after it was clustered. `proposed` and
 * `unroutable` are appended by triage (node #852); the answer kinds are appended by
 * the answer reader, which reads Vigil's `vigil.attention.resolved` records, and
 * triage only reads them. `ref` is the proposal ref the answer is about, so a
 * generation can be counted against the proposals that came before it.
 */
export type ErrataClusterEvent =
  | { kind: "proposed"; clusterId: string; ref: string; generation: number; landing: string; proposalKind: ProposalKind; at: string }
  | { kind: "unroutable"; clusterId: string; repo: string | null; at: string }
  | { kind: "resolved"; clusterId: string; ref: string; nodeRef?: string; at: string }
  | { kind: "dismissed"; clusterId: string; ref: string; at: string }
  | { kind: "expired"; clusterId: string; ref: string; at: string };

export type ErrataEvent =
  | { kind: "created"; record: ErrataRecord }
  | { kind: "dropped"; id: string; at: string }
  | { kind: "clustered"; id: string; clusterId: string; key: ErrataClusterKey; at: string }
  | ErrataClusterEvent;

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

export interface SomaHomeBootstrapOptions {
  homeDir?: string;
  somaHome?: string;
  includeSkills?: boolean;
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

/** @deprecated Renamed to {@link SkillNormalizationAction} (node #793). Kept for back-compat. */
export type PaiPackNormalizationAction = SkillNormalizationAction;

/** @deprecated Renamed to {@link SkillNormalizationWarning} (node #793). Kept for back-compat. */
export type PaiPackNormalizationWarning = SkillNormalizationWarning;

export type SomaInitStepId =
  | "bootstrap-soma-home"
  | "migrate-claude-skills"
  | "install-codex"
  | "install-pi-dev"
  | "install-claude-code"
  | "install-cursor"
  | "install-grok"
  | "install-dsh";

export type SomaOnboardingSubstrate = Exclude<InstallSubstrate, "anthropic-cowork">;

export interface SomaOnboardingOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SomaOnboardingSubstrate;
}

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
