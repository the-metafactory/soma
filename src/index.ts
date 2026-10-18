export type { SomaPaths, SomaMemoryPromotionStore } from "./core/index";
export type { AlgorithmEffortSource, AlgorithmBatchOperation, AlgorithmCapabilityContract, AlgorithmCapabilityDefinition, AlgorithmCapabilityInvocation, AlgorithmCapabilityKind, AlgorithmCapabilitySelection, AlgorithmCapabilitySelectionStatus, AlgorithmCriteriaPartition, AlgorithmGatesFired, AlgorithmMetaReflection, AlgorithmObservation, AlgorithmReference, AlgorithmReferenceVerdict, AlgorithmLoopExecutionContext, AlgorithmLoopExecutor, AlgorithmLoopIteration, AlgorithmLoopIterationResult, AlgorithmLoopState, AlgorithmLoopStatus, AlgorithmNotificationEvent, AlgorithmNotificationSink, AlgorithmPlanStep, AlgorithmPromptClassification, AlgorithmRun, AlgorithmRunInput, AlgorithmRunSummary, IdeateParameters, IdeatePresetName, OptimizeParameters, OptimizePresetName, SomaSkillManifest } from "./algorithm/types";
export type {
  AlgorithmEffortTier,
  AlgorithmMode,
  AlgorithmPhase,
  AlgorithmWorkIndex,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional back-compat re-export of the deprecated alias (soma#329)
  IdealStateCriterion,
  VsaUpdatePayload,
  VsaSkillInstallAction,
  VsaSkillInstallOptions,
  VsaSkillInstallResult,
  SomaSkillBaseline,
  SomaSkillBaselines,
  SomaAdapter,
  Projection,
  SomaSkill,
  SubstrateId,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- re-exported for back-compat (soma#329)
  Telos,
  SomaHomeProjection,
  SomaHomeProjectionOptions,
  SomaHomeBootstrapOptions,
  SomaHomeBootstrapResult,
  SomaInstallOptions,
  SomaInstallPlan,
  SomaInstallResult,
  SomaDoctorDiagnosis,
  SomaDoctorFinding,
  SomaDoctorFindingId,
  SomaInitPlan,
  SomaInitApplyResult,
  SomaInitApplyStepResult,
  SomaInitStep,
  SomaInitStepId,
  SomaOnboardingOptions,
  SomaLifecycleEventName,
  SomaLifecycleOptions,
  SomaLifecycleResult,
  SomaFeedbackCaptureOptions,
  SomaFeedbackCaptureResult,
  SomaFeedbackClassification,
  SomaFeedbackKind,
  SomaMemoryEvent,
  SomaMemoryEventInput,
  SomaMemoryPromotionOptions,
  SomaMemoryPromotionResult,
  SomaResultCaptureOptions,
  SomaResultCaptureResult,
  SomaResultEventKind,
  SomaResultSearchMatch,
  SomaResultSearchOptions,
  SomaResultSearchResult,
  SomaPolicyAction,
  SomaPolicyCheckOptions,
  SomaPolicyCheckResult,
  SomaPolicyBatchCheckOptions,
  SomaPolicyBatchCheckResult,
  SomaPolicyBatchTarget,
  SomaPolicyDecision,
  SomaPolicyFinding,
  SomaPolicyFindingKind,
  InboundContentDecision,
  InboundContentFinding,
  InboundContentScanInput,
  InboundContentScanOptions,
  InboundContentScanOutput,
  InboundContentScanner,
  InboundContentSecurityConfig,
  InboundContentPromotionResult,
  RuntimePolicyDecision,
  RuntimePolicyCommandInspectionConfig,
  RuntimePolicyCommandPatternRule,
  RuntimePolicyApprovalCacheEntry,
  RuntimePolicyConfigChange,
  RuntimePolicyConfigChangeError,
  RuntimePolicyConfigChangeErrorKind,
  RuntimePolicyConfig,
  RuntimePolicyFinding,
  RuntimePolicyFindingSeverity,
  RuntimePolicyInspectAudit,
  RuntimePolicyInspectOptions,
  RuntimePolicyInspectResult,
  RuntimePolicyModelInspectorConfig,
  RuntimePolicyModelRule,
  RuntimePolicyPermissionAction,
  RuntimePolicyPermissionConfig,
  RuntimePolicyPermissionRequest,
  RuntimePolicySurface,
  RuntimePolicyToolCall,
  RuntimePolicyTrustedRoot,
  SomaProtectedPath,
  SkillNormalizationAction,
  SkillNormalizationWarning,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional migration alias re-export (node #793)
  PaiPackNormalizationAction,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional migration alias re-export (node #793)
  PaiPackNormalizationWarning,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional migration alias re-export (DD-15)
  SomaRunResult,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional migration alias re-export (DD-15)
  SomaTask,
  WrittenProjection,
} from "./types";
export type {
  AssistantIdentity,
  PrincipalIdentity,
  ProjectionInput,
  SomaMemoryLayout,
  SomaProfile,
  SomaSnapshotEntry,
  SomaSnapshotListOptions,
  SomaSnapshotOptions,
  SomaSnapshotResult,
  SomaSnapshotRollbackOptions,
  SomaSnapshotRollbackResult,
  Purpose,
} from "./home/index";
export type { AlgorithmLogEntry, AuthoredFrontmatter, DerivedFrontmatter, VerificationStateArtifact, Checkpoint, VsaFrontmatter, VsaSection, SomaActiveVsaState } from "./vsa/index";
export type {
  SomaMemoryRecallOptions,
  SomaMemoryRecallResult,
  SomaMemoryRecalledNote,
  SomaMemoryIndexResult,
  SomaMemoryDigestOptions,
  SomaMemoryDigestResult,
  SomaMemoryActionOptions,
  SomaMemoryActionResult,
  SomaMemoryActionApproval,
  SomaMemoryConsolidateOptions,
  SomaMemoryConsolidateResult,
  SomaMemorySimilarPair,
  SomaMemoryAutoMergePlan,
  SomaMemoryArchivePlan,
  SomaMemorySearchMatch,
  SomaMemorySearchOptions,
  SomaMemorySearchResult,
} from "./memory/index";

export type {
  ExecuteOptions,
  CancelOptions,
  PrepareOptions,
  ExecutionCapabilities,
  ExecutionProbeOptions,
  PreparedExecution,
  SomaExecutionEvent,
  SomaExecutionFailureCode,
  SomaExecutionRequest,
  SomaExecutionResult,
  SubstrateExecutor,
} from "./execution/index";
export { runSubstrateExecution } from "./execution/index";
export { outputFromText } from "./execution/index";
export type { CommandOutput } from "./execution/index";
export type { ExecutionKernelOptions, SubstrateExecutionRun } from "./execution/index";
export { SubstrateExecutionAlgorithmLoopExecutor } from "./flows/index";
export type { SubstrateExecutionAlgorithmLoopExecutorOptions } from "./flows/index";
export { MockSubstrateExecutor } from "./execution/index";
export type { MockExecutionScript } from "./execution/index";
export { REQUIRED_EXECUTION_CONFORMANCE_SCENARIOS, runExecutionConformance } from "./execution/index";
export type { ExecutionConformanceReport, ExecutionConformanceResult, ExecutionConformanceScenario, ExecutionConformanceScenarioId } from "./execution/index";
export { ExecutorRegistry, isKnownExecutionSubstrate, isKnownSubstrate, KNOWN_EXECUTION_SUBSTRATES, KNOWN_SUBSTRATES } from "./execution/index";
export type { ExecutorRegistryResolution, RegisteredSubstrateExecutor } from "./execution/index";
export { diagnoseExecutionReadiness } from "./substrates/index";
export type { ExecutionReadiness } from "./substrates/index";
export { CodexExecutor, registerCodexExecutor } from "./execution/index";
export type { CodexCommandResult, CodexCommandRunner, CodexExecutorOptions } from "./execution/index";
export { ClaudeCodeExecutor, registerClaudeCodeExecutor } from "./execution/index";
export type { ClaudeCodeCommandResult, ClaudeCodeCommandRunner, ClaudeCodeExecutorOptions } from "./execution/index";
export { SOMA_RESULT_EVENT_KINDS } from "./types";
export { SOMA_MEMORY_NOTE_TYPES, SOMA_MEMORY_TRUSTS } from "./memory/index";
export { SOMA_MEMORY_WRITE_TRIGGERS, SOMA_MEMORY_TRIGGER_TRUST } from "./memory/index";
export type { SomaMemoryNote, SomaMemoryNoteType, SomaMemoryTrust } from "./memory/index";
export type {
  SomaMemoryWriteTrigger,
  SomaMemoryWriteMode,
  SomaMemoryWriteOptions,
  SomaMemoryWriteResult,
  SomaMemoryVerifyOptions,
  SomaMemoryVerifyResult,
  SomaMemoryResurfaceOptions,
  SomaMemoryResurfaceResult,
  SomaMemoryDuplicateCandidate,
} from "./memory/index";

export {
  addAlgorithmCapabilities,
  applyAlgorithmBatch,
  advanceAlgorithmRun,
  advanceAlgorithmRunUntil,
  algorithmPhaseOrder,
  computeGatesFired,
  createAlgorithmRun,
  getAlgorithmReferences,
  hasCurrentStateProbe,
  learnGateViolations,
  nextAlgorithmPhase,
  recordAlgorithmChange,
  recordAlgorithmDecision,
  recordAlgorithmLearning,
  recordAlgorithmMetaReflection,
  recordAlgorithmObservation,
  recordAlgorithmReference,
  resolveAlgorithmReference,
  deriveBridgedPlanStepStatus,
  requirePlanStep,
  setAlgorithmPlan,
  syncBridgedPlanStep,
  updateAlgorithmPlanStep,
  VerificationGateError,
  verifyAlgorithmCriterion,
} from "./algorithm/algorithm";
export type { BridgedNodeReport } from "./algorithm/algorithm";
// The two principal-authored compartment surfaces reach the barrel as TYPES
// ONLY, because `ProjectionInput`/`SomaProfile` name them and a caller building
// a projection input needs to spell them. Their parsers and helpers stay module-
// local: every real consumer (six adapters, `soma-home.ts`, the tests) imports
// from `./policy/behavior-policy` or `./home/communication-contract` directly, and
// `BehaviorPolicyEntry` changed shape three times while this branch was in
// review. This is the same call `src/policy/self-healing-doctrine.ts` already
// makes — it exports nothing here — and the one this file makes for
// `VerificationGateError`: off the barrel, free to change.
export type { CommunicationContract } from "./home/index";
export type { BehaviorPolicy } from "./policy/index";
export {
  assertAlgorithmCapabilitiesSatisfied,
  getAlgorithmCapabilityDefinition,
  listAlgorithmCapabilityDefinitions,
  recordAlgorithmCapabilityInvocation,
  registerAlgorithmCapabilityDefinition,
  registerAlgorithmCapabilityDefinitions,
  removeAlgorithmCapabilitySelection,
  selectAlgorithmCapability,
  unresolvedAlgorithmCapabilitySelections,
} from "./algorithm/algorithm-capabilities";
export { classifyAlgorithmPrompt } from "./algorithm/algorithm-classifier";
export {
  DEFAULT_ALGORITHM_LOOP_ITERATION_HISTORY_LIMIT,
  DEFAULT_ALGORITHM_LOOP_STATE,
  IDEATE_PRESETS,
  OPTIMIZE_PRESETS,
  algorithmLoopBlockedEvent,
  algorithmLoopStateChangedEvent,
  algorithmPhaseEnteredEvent,
  detectPlateau,
  partitionCriteriaByDomain,
  partitionRunCriteriaByDomain,
  recordAlgorithmLoopIterationResult,
  validateIdeateParameters,
  validateOptimizeParameters,
} from "./algorithm/index";
// Public VSA API — cohesive surface: semantic accessors + mutators + parse/serialize.
// Renderer details (SECTION_NAME_MAP, TWELVE_SECTIONS, renderCriteriaMarkdown,
// renderLogEntries, parseCriteriaMarkdown, progressFromCriteria,
// verifiedFromCriteria, buildVsaArtifact) stay internal — import from
// `./vsa-accessors` directly if you need them from within the package.
export {
  appendCriterion,
  appendVsaChangelog,
  appendVsaDecision,
  appendVsaVerification,
  getChangelog,
  getCriteria,
  getDecisions,
  getGoal,
  getSection,
  getVerification,
  parseVsa,
  recomputeProgress,
  recomputeVerified,
  setSection,
  serializeVsa,
  updateCriterion,
} from "./vsa/index";
export {
  abandonAlgorithmRun,
  completeAlgorithmRun,
  getRunPhase,
} from "./algorithm/algorithm-lifecycle";
export {
  algorithmRunPath,
  algorithmRunPathById,
  listAlgorithmRunSummaries,
  listAlgorithmRuns,
  readAlgorithmRunById,
  readAlgorithmRun,
  resolveAlgorithmRunsDir,
  summarizeAlgorithmRun,
  updateAlgorithmRunById,
  writeAlgorithmRun,
  type AlgorithmStoreOptions,
  type WrittenAlgorithmRun,
} from "./algorithm/algorithm-store";
export {
  buildReflectionDigest,
  renderReflectionDigest,
  type ReflectionDigestEntry,
  type ReflectionForDigest,
  type ReflectionCategoryKey,
} from "./algorithm/algorithm-reflection-digest";
export { parsePaiReflections } from "./algorithm/algorithm-reflection-import";
export {
  projectClaudeCode,
  projectClaudeCodeHome,
  projectCodex,
  projectCodexHome,
  projectCursor,
  projectCursorHome,
  projectDsh,
  projectDshHome,
  projectGrok,
  projectGrokHome,
  projectPiDev,
  projectPiDevHome,
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  dshAdapter,
  grokAdapter,
  piDevAdapter,
} from "./substrates/index";
// NOTE: #43 Algorithm renderer pure-logic helpers (phase parser,
// widget helpers, extension-source renderer) are intentionally NOT
// re-exported at the package root. They are scoped to the pi-dev
// substrate barrel (./adapters/pi-dev) until AC-7..AC-12 settle the
// runtime shape in the follow-up PR. Tests can import the helpers
// directly from the substrate path.
export { harvestSessions } from "./flows/index";
export { writeProjection } from "./substrates/index";
export { SomaInstallError } from "./substrates/index";
export type {
  SomaHomeInstallReceipt,
  SomaInstallStage,
  SomaPartialInstallResult,
  SomaRuntimeArtifactReceipt,
  SomaSubstrateInstallReceipt,
} from "./substrates/index";
export { createPaths, type SomaPathsOptions } from "./core/index";
export {
  advisor,
  inference,
  parseInferenceJson,
  synthesizeAdvisorState,
  type AdvisorStateOptions,
  type InferenceBackend,
  type InferenceBackendKind,
  type InferenceLevel,
  type InferenceMode,
  type InferenceOptions,
  type InferenceRequest,
  type InferenceResult,
} from "./tools/index";
export {
  applySomaInit,
  diagnoseSomaDoctor,
  planSomaInit,
} from "./flows/index";
export {
  addOpinion,
  addOpinionEvidence,
  captureFailure,
  completeSessionProgress,
  createSessionProgress,
  formatCountsShell,
  getSomaCounts,
  listOpinions,
  listSessionProgress,
  recordSessionBlocker,
  recordSessionDecision,
  recordSessionHandoff,
  recordSessionNextStep,
  recordSessionWork,
  resumeSessionProgress,
  showOpinion,
  synthesizeLearningPatterns,
  type EvidenceType,
  type FailureCaptureInput,
  type FailureCaptureResult,
  type HarvestOptions,
  type HarvestedLearning,
  type LearningToolOptions,
  type Opinion,
  type OpinionCategory,
  type OpinionEvidence,
  type OpinionEvidenceResult,
  type PatternGroup,
  type Rating,
  type SessionProgressRecord,
  type SomaCounts,
  type SynthesisResult,
  type ToolCall,
} from "./tools/index";
export {
  parseRelationshipNotes,
  reflectRelationship,
  type RelationshipMilestone,
  type RelationshipNote,
  type RelationshipNoteKind,
  type RelationshipNotification,
  type RelationshipNotifier,
  type RelationshipReflectOptions,
  type RelationshipReflectResult,
} from "./tools/index";
export {
  classifyDomains,
  listFrames,
  synthesizeWisdom,
  updateFrame,
  type CrossFramePrinciple,
  type DomainClassification,
  type FrameHealth,
  type FrameHealthStatus,
  type FrameUpdateInput,
  type FrameUpdateResult,
  type WisdomFrame,
  type WisdomFrameSummary,
  type WisdomObservationType,
  type WisdomSynthesisResult,
  type WisdomToolOptions,
} from "./tools/index";
export {
  buildClaudeCodeHomeProjection,
  buildCodexHomeProjection,
  buildCursorHomeProjection,
  buildDshHomeProjection,
  buildGrokHomeProjection,
  buildPiDevHomeProjection,
  installClaudeCodeHomeProjection,
  installCodexHomeProjection,
  installCursorHomeProjection,
  installDshHomeProjection,
  installGrokHomeProjection,
  installPiDevHomeProjection,
  resolveHomeProjectionPaths,
} from "./substrates/index";
export {
  installSomaForClaudeCode,
  installSomaForCodex,
  installSomaForCursor,
  installSomaForDsh,
  installSomaForGrok,
  installSomaForPiDev,
  planSomaForClaudeCodeInstall,
  planSomaForCodexInstall,
  planSomaForCursorInstall,
  planSomaForDshInstall,
  planSomaForGrokInstall,
  planSomaForPiDevInstall,
  uninstallSomaForClaudeCode,
  uninstallSomaForCursor,
  uninstallSomaForGrok,
  type UninstallClaudeCodeOptions,
  type UninstallClaudeCodeResult,
  type UninstallCursorOptions,
  type UninstallCursorResult,
  type UninstallGrokOptions,
  type UninstallGrokResult,
} from "./flows/index";
export { inspectRuntimeArtifact, rollbackRuntimeArtifact } from "./substrates/index";
export { experimentalAnthropicCowork } from "./substrates/index";
export type { ClaudeCodeInstallOptions } from "./substrates/index";
// Adapter active-VSA projection helpers (#37).
export {
  activeVsaProjectionPath,
  loadActiveVsaForBundle,
  renderActiveVsaFile,
  type LoadActiveVsaOptions,
} from "./vsa/index";
// Public VSA-skill installer API — cohesive surface only.
// Implementation details (vsaSkillRuntimeDir, vsaSkillSourceDir,
// parseSkillFrontmatter, skillBaselinesPath, compareSkillVersions) stay in
// `./substrates/vsa-skill-installer` and are imported directly by tests and scripts.
export { installVsaSkill } from "./substrates/index";
export {
  buildSomaStartupContext,
  captureCompletedAlgorithmLearnings,
  runSomaLifecycleAlgorithmObserved,
  runSomaLifecycleAlgorithmUpdated,
  runSomaLifecycleVsaUpdated,
  runSomaLifecycleSessionEnd,
  runSomaLifecycleSessionStart,
  writeAlgorithmWorkIndex,
} from "./flows/index";
export { registerSessionEndTranscriptHandler, registerProjectionRepairProvider } from "./home/index";
export type { SessionEndTranscriptHandler, ProjectionRepairProvider } from "./home/index";
export { buildLearningReadback } from "./flows/index";
export type { LearningReadbackOptions } from "./flows/index";
export { repairProjectedArtifacts } from "./substrates/index";
export type { ProjectedArtifact, ProjectionRepairFinding, ProjectionRepairFindingKind, ProjectionRepairResult } from "./substrates/index";
export { captureSomaFeedback, classifySomaFeedback, maybeSomaFeedbackPrompt } from "./flows/index";
export { appendSomaMemoryEvent, somaMemoryEventsPath } from "./events/index";
export { searchSomaMemory } from "./memory/index";
export { streamEventLines, streamEventRecords } from "./events/index";
export { MemoryNoteError, parseMemoryNote, serializeMemoryNote } from "./memory/index";
// Preserve the root write surface; path/dedup helpers are exposed by memory/index.
export { writeMemoryNote, verifyMemoryNote, resurfaceMemoryNote } from "./memory/index";
export { recallMemory } from "./memory/index";
// Preserve the root rebuild surface; scoring/path helpers are exposed by memory/index.
export { rebuildMemoryIndex } from "./memory/index";
// SessionStart's smart reindex + single-file substrate projection (M8). The
// CLI-facing entry point; lifecycle and tests use memory/index for smart reindexing.
export {
  reprojectSubstrateMemoryProjection,
  type ReprojectSubstrateMemoryProjectionOptions,
  type ReprojectSubstrateMemoryProjectionResult,
} from "./flows/index";
export { writeSessionDigest, writeMemoryAction, hasSessionDigest } from "./memory/index";
// The Claude Code SessionEnd transcript fallback (extractDigestBodyFromTranscript /
// writeSessionDigestFromTranscript / ClaudeSessionDigest*) is adapter-specific and is
// NOT re-exported from the package root — the CLI and tests import it directly from
// `./adapters/claude-code/session-digest`, keeping the root substrate-neutral
// (docs/architecture.md#Core; sage m5b r2).
export { consolidateMemory } from "./memory/index";
export { auditMemory } from "./memory/index";
export { createSomaSnapshot, listSomaSnapshots, rollbackSomaSnapshot } from "./home/index";
export { querySomaTelemetryEvents, summarizeSomaTelemetry } from "./events/index";
export {
  listSomaWorkRegistryEntries,
  readSomaWorkRegistry,
  somaWorkRegistryPaths,
  upsertSomaCurrentWorkPointer,
  upsertSomaWorkRegistryEntry,
  type SomaCurrentWorkPointer,
  type SomaCurrentWorkPointerLearningSources,
  type SomaCurrentWorkPointerSignals,
  type SomaCurrentWorkPointerStatus,
  type SomaWorkRegistry,
  type SomaWorkRegistryEntry,
  type UpsertSomaCurrentWorkPointerOptions,
  type UpsertSomaWorkRegistryEntryOptions,
  type UpsertSomaWorkRegistryEntryResult,
} from "./home/index";
export { applySomaWriteback, type SomaWritebackOptions, type SomaWritebackResult } from "./flows/index";
export { promoteAlgorithmRunMemory } from "./flows/index";
export { planMemoryBackfill, runMemoryBackfill } from "./memory/index";
export {
  syncAlgorithmRunFromVsa,
  formatSyncResult,
  type SyncAlgorithmRunFromVsaOptions,
  type SyncAlgorithmRunFromVsaResult,
} from "./flows/index";
export { captureSomaResult, isSomaResultEventKind, searchSomaResults } from "./flows/index";
export { checkSomaPolicy, checkSomaPolicyBatch } from "./policy/policy-audit";
export { evaluateSomaPolicy } from "./policy/index";
export {
  createDeterministicInboundContentScanner,
  defaultInboundContentSecurityConfig,
  inboundContentHash,
  isInboundUntrustedPath,
  promoteInboundContent,
  scanInboundContent,
} from "./policy/inbound-security";
export {
  inspectRuntimePolicy,
  runtimePolicyTraceRoot,
  RUNTIME_POLICY_SURFACES,
} from "./policy/runtime-policy";
export {
  evaluateToolCallPolicyGuard,
  type ToolCallPolicyGuardOptions,
  type ToolCallPolicyGuardResult,
  type ToolCallPolicyGuardDecision,
} from "./policy/tool-policy-guard";
export { bootstrapSomaHome } from "./flows/index";
export { loadSomaHome, loadSomaProfile } from "./home/index";
// Algorithm ↔ VSA bridge (#39) — advisory, non-blocking.
export {
  markVsaVerifiedFromCriteria,
  recordAlgorithmVsaChange,
  recordAlgorithmVsaDecision,
  suggestVsaAtObserve,
  type AlgorithmVsaOptions,
  type HintConfig,
  type PromptShape,
  type SuggestVsaResult,
} from "./flows/index";
// VSA library API (#34) — cohesive public surface only.
// Storage-layout helpers (activeStatePath, vsaDir, vsaPath) stay internal
// to `./isa` so on-disk layout can evolve without breaking consumers
// (Sage round-2 architecture finding). Tests + adapters that need them
// import from `./isa` directly.
export {
  checkCompleteness,
  getActiveVsa,
  listAvailableTiers,
  listVsas,
  readVsa,
  applyVsaUpdate,
  recordVsaChangelog,
  recordVsaDecision,
  recordVsaVerification,
  scaffoldVsa,
  setActiveVsa,
  writeVsa,
  type EffortTier,
  type VsaLibraryOptions,
  type VsaListEntry,
  type VsaUpdateEntry,
  type VsaUpdateSection,
  type ScaffoldVsaInput,
  type SetActiveVsaResult,
  type WriteVsaResult,
  reconcileVsa,
  reconcileVsaArtifacts,
  type VsaConflictPolicy,
  type VsaReconcileConflict,
  type VsaReconcileReport,
  type VsaReconcileResult,
  type ReconcileVsaOptions,
  type CompletenessGap,
  type CompletenessReport,
} from "./vsa/index";

// Work graph (#497, DD-16): preserve the root compatibility surface until the
// final seams node. Graph owns its contract, bridge reader, refs and backends.
export {
  readNodeForBridge,
  type ReadNodeForBridgeOptions,
  FORGES,
  formatQualifiedNodeRef,
  formatRepoRef,
  parseQualifiedNodeRef,
  parseRepoRef,
  type Forge,
  type QualifiedNodeRef,
  type RepoRef,
  WorkGraph,
  WorkGraphError,
  UnreadableBlockersError,
  agentExternalEvidenceKinds,
  assertClosable,
  hashGatedNodeFields,
  normalizeKind,
  parseNodeSpec,
  parseProbe,
  estimateReceiptChars,
  renderCloseReceipt,
  scanCommentsForReceipt,
  spliceSection,
  CLOSE_RECEIPT_MARKER,
  DECISIONS_BEGIN,
  DECISIONS_END,
  RECEIPT_COMMENT_BUDGET,
  RECEIPT_COMMENT_LIMIT,
  resolveClaimRace,
  toNode,
  type AttestationCapability,
  type AttestationFacts,
  type AttestationState,
  type BlockingRef,
  type ConfinementProbeRecord,
  type ConfinementResult,
  type ClaimResult,
  type ReleaseResult,
  type CloseEvidence,
  type CloseReceipt,
  type CommentRef,
  type CreateNodeOptions,
  type CreateNodeSpec,
  type CreatedNode,
  type EdgeWrites,
  type FrontierReport,
  type GraphStore,
  type GraphReadOptions,
  type NodeBudget,
  type NodeComment,
  type NodeRef,
  type NodeState,
  type NodeStatus,
  type Probe,
  type ProbeResult,
  type ProbeTree,
  type ProbeType,
  type Ratification,
  type Reaction,
  type RehomeSelection,
  type ReceiptScan,
  type WorkGraphAutonomy,
  type WorkGraphErrorCode,
  type WorkGraphEvidenceKind,
  type WorkGraphNode,
  type WorkGraphNodeBase,
  checkGitHubConfinement,
  createGhCliTransport,
  createGitHubGraphStore,
  parseAuthStatusLogins,
  decodeNodeBlock,
  encodeNodeBlock,
  estimateSubtreeQueryPrimaryRatePoints,
  ghApiArgs,
  parseGhApiOutput,
  SUBTREE_QUERY_PRIMARY_RATE_POINTS,
  type DecodedBody,
  type GhCliTransportOptions,
  type GitHubApiRequest,
  type GitHubApiTransport,
  type GitHubGraphStoreOptions,
  checkGitLabConfinement,
  createGlabCliTransport,
  createGitLabGraphStore,
  type GitLabApiRequest,
  type GitLabApiTransport,
  type GitLabGraphStoreOptions,
  type GlabCliTransportOptions,
  allProbesPassed,
  authorizeProbeTree,
  boundObserved,
  isProbeEscape,
  probeDirectory,
  CLOSE_DEADLINE_SEC,
  resolvedProbePaths,
  runCommand,
  runProbe,
  runProbes,
  PROBE_ESCAPED_PREFIX,
  type CommandOutcome,
  type CommandRequest,
  type ProbeRunnerDeps,
  type ProbeRunnerOptions,
  type ResolvedProbePath,
  authorizeProbe,
  isProbeRefusal,
  loadProbeRegistry,
  parseProbeRegistry,
  probeRegistryPath,
  PROBE_REFUSED_PREFIX,
  PROBE_REGISTRY_RELATIVE_PATH,
  PROBE_REGISTRY_VERSION,
  type DeclaredCommand,
  type LoadProbeRegistryOptions,
  type ParseProbeRegistryInput,
  type ProbeAuthorization,
  type ProbeRegistry,
  type ProbeRegistryHomeOptions,
  deriveAttestation,
  findGraphRoot,
  type AttestationInputs,
  type AttestationOutcome,
  type ConfinementDeps,
} from "./graph/index";

export { SOMA_VERSION } from "./core/index";
