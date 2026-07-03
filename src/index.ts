export type {
  AlgorithmEffortTier,
  AlgorithmEffortSource,
  AlgorithmBatchOperation,
  AlgorithmCapabilityContract,
  AlgorithmCapabilityDefinition,
  AlgorithmCapabilityInvocation,
  AlgorithmCapabilityKind,
  AlgorithmCapabilitySelection,
  AlgorithmCapabilitySelectionStatus,
  AlgorithmImportOptions,
  AlgorithmImportPlan,
  AlgorithmImportResult,
  AlgorithmCriteriaPartition,
  AlgorithmGatesFired,
  AlgorithmLogEntry,
  AlgorithmMetaReflection,
  AlgorithmObservation,
  AlgorithmLoopExecutionContext,
  AlgorithmLoopExecutor,
  AlgorithmLoopIteration,
  AlgorithmLoopIterationResult,
  AlgorithmLoopState,
  AlgorithmLoopStatus,
  AlgorithmMode,
  AlgorithmNotificationEvent,
  AlgorithmNotificationSink,
  AlgorithmPhase,
  AlgorithmPlanStep,
  AlgorithmPromptClassification,
  AlgorithmRun,
  AlgorithmRunInput,
  AlgorithmRunSummary,
  AlgorithmWorkIndex,
  AssistantIdentity,
  AuthoredFrontmatter,
  DerivedFrontmatter,
  VerificationStateArtifact,
  Checkpoint,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional back-compat re-export of the deprecated alias (soma#329)
  IdealStateCriterion,
  IdeateParameters,
  IdeatePresetName,
  VsaUpdatePayload,
  VsaFrontmatter,
  VsaSection,
  VsaSkillInstallAction,
  VsaSkillInstallOptions,
  VsaSkillInstallResult,
  PrincipalIdentity,
  SomaActiveVsaState,
  SomaSkillBaseline,
  SomaSkillBaselines,
  SomaAdapter,
  Projection,
  ProjectionInput,
  SomaMemoryLayout,
  SomaPaths,
  SomaProfile,
  SomaRunResult,
  SomaSkill,
  SomaSnapshotEntry,
  SomaSnapshotListOptions,
  SomaSnapshotOptions,
  SomaSnapshotResult,
  SomaSnapshotRollbackOptions,
  SomaSnapshotRollbackResult,
  SomaTask,
  SubstrateId,
  Purpose,
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
  SomaMemoryPromotionStore,
  SomaMemoryRecallOptions,
  SomaMemoryRecallResult,
  SomaMemoryRecalledNote,
  SomaMemoryIndexResult,
  SomaMemorySearchMatch,
  SomaMemorySearchOptions,
  SomaMemorySearchResult,
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
  PaiImportOptions,
  PaiImportPlan,
  PaiImportResult,
  OptimizeParameters,
  OptimizePresetName,
  PaiPackImportFile,
  PaiPackImportOptions,
  PaiPackImportPlan,
  PaiPackImportResult,
  PaiPackOutcome,
  PaiPackOutcomeKind,
  PaiPackManifest,
  PaiPackManifestFile,
  PaiPackNormalizationAction,
  PaiPackNormalizationReport,
  PaiPackNormalizationWarning,
  SomaSkillManifest,
  WrittenProjection,
} from "./types";
export { SOMA_RESULT_EVENT_KINDS } from "./types";
export { SOMA_MEMORY_NOTE_TYPES, SOMA_MEMORY_TRUSTS } from "./types";
export { SOMA_MEMORY_WRITE_TRIGGERS, SOMA_MEMORY_TRIGGER_TRUST } from "./types";
export type { SomaMemoryNote, SomaMemoryNoteType, SomaMemoryTrust } from "./types";
export type {
  SomaMemoryWriteTrigger,
  SomaMemoryWriteMode,
  SomaMemoryWriteOptions,
  SomaMemoryWriteResult,
  SomaMemoryVerifyOptions,
  SomaMemoryVerifyResult,
  SomaMemoryDuplicateCandidate,
} from "./types";

export {
  addAlgorithmCapabilities,
  applyAlgorithmBatch,
  advanceAlgorithmRun,
  advanceAlgorithmRunUntil,
  algorithmPhaseOrder,
  computeGatesFired,
  createAlgorithmRun,
  hasCurrentStateProbe,
  learnGateViolations,
  nextAlgorithmPhase,
  recordAlgorithmChange,
  recordAlgorithmDecision,
  recordAlgorithmLearning,
  recordAlgorithmMetaReflection,
  recordAlgorithmObservation,
  setAlgorithmPlan,
  updateAlgorithmPlanStep,
  verifyAlgorithmCriterion,
} from "./algorithm";
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
} from "./algorithm-capabilities";
export { classifyAlgorithmPrompt } from "./algorithm-classifier";
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
} from "./algorithm-execution-modes";
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
  recomputeProgress,
  recomputeVerified,
  setSection,
  updateCriterion,
} from "./vsa-accessors";
export { parseVsa, serializeVsa } from "./vsa-parse";
export {
  abandonAlgorithmRun,
  completeAlgorithmRun,
  getRunPhase,
} from "./algorithm-lifecycle";
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
} from "./algorithm-store";
export {
  buildReflectionDigest,
  renderReflectionDigest,
  type ReflectionDigestEntry,
  type ReflectionForDigest,
  type ReflectionCategoryKey,
} from "./algorithm-reflection-digest";
export { parsePaiReflections } from "./algorithm-reflection-import";
export {
  projectClaudeCode,
  projectClaudeCodeHome,
  projectCodex,
  projectCodexHome,
  projectCursor,
  projectCursorHome,
  projectGrok,
  projectGrokHome,
  projectPiDev,
  projectPiDevHome,
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  grokAdapter,
  piDevAdapter,
} from "./adapters";
// NOTE: #43 Algorithm renderer pure-logic helpers (phase parser,
// widget helpers, extension-source renderer) are intentionally NOT
// re-exported at the package root. They are scoped to the pi-dev
// substrate barrel (./adapters/pi-dev) until AC-7..AC-12 settle the
// runtime shape in the follow-up PR. Tests can import the helpers
// directly from the substrate path.
export { writeProjection } from "./projection";
export { createPaths, type SomaPathsOptions } from "./paths";
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
} from "./tools/inference";
export {
  applySomaInit,
  diagnoseSomaDoctor,
  planSomaInit,
} from "./onboarding";
export {
  addOpinion,
  addOpinionEvidence,
  captureFailure,
  completeSessionProgress,
  createSessionProgress,
  formatCountsShell,
  getSomaCounts,
  harvestSessions,
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
} from "./tools/learning";
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
} from "./tools/relationship";
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
} from "./tools/wisdom";
export {
  buildClaudeCodeHomeProjection,
  buildCodexHomeProjection,
  buildCursorHomeProjection,
  buildGrokHomeProjection,
  buildPiDevHomeProjection,
  installClaudeCodeHomeProjection,
  installCodexHomeProjection,
  installCursorHomeProjection,
  installGrokHomeProjection,
  installPiDevHomeProjection,
  resolveHomeProjectionPaths,
} from "./home-projection";
export {
  installSomaForClaudeCode,
  installSomaForCodex,
  installSomaForCursor,
  installSomaForGrok,
  installSomaForPiDev,
  planSomaForClaudeCodeInstall,
  planSomaForCodexInstall,
  planSomaForCursorInstall,
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
} from "./install";
export type { ClaudeCodeInstallOptions } from "./adapters/claude-code/install-options";
// Adapter active-VSA projection helpers (#37).
export {
  activeVsaProjectionPath,
  loadActiveVsaForBundle,
  renderActiveVsaFile,
  type LoadActiveVsaOptions,
} from "./adapter-active-vsa";
// Public VSA-skill installer API — cohesive surface only.
// Implementation details (vsaSkillRuntimeDir, vsaSkillSourceDir,
// parseSkillFrontmatter, skillBaselinesPath, compareSkillVersions) stay in
// `./vsa-skill-installer` and are imported directly by tests and scripts.
export { installVsaSkill } from "./vsa-skill-installer";
export { importAlgorithm, planAlgorithmImport } from "./algorithm-importer";
export {
  buildSomaStartupContext,
  captureCompletedAlgorithmLearnings,
  runSomaLifecycleAlgorithmObserved,
  runSomaLifecycleAlgorithmUpdated,
  runSomaLifecycleVsaUpdated,
  runSomaLifecycleSessionEnd,
  runSomaLifecycleSessionStart,
  writeAlgorithmWorkIndex,
} from "./lifecycle";
export { captureSomaFeedback, classifySomaFeedback, maybeSomaFeedbackPrompt } from "./feedback";
export { appendSomaMemoryEvent, searchSomaMemory, somaMemoryEventsPath } from "./memory";
export { MemoryNoteError, parseMemoryNote, serializeMemoryNote } from "./memory-note";
// Public write surface only. Path/dedup helpers (memoryNotePath,
// findDuplicateCandidates, MEMORY_DEDUP_JACCARD_THRESHOLD) stay module-private so
// the storage layout and dedup threshold are not frozen as stable API — internal
// soma modules (M2/M3/M6) and tests import them from "./memory-write" directly.
export { writeMemoryNote, verifyMemoryNote } from "./memory-write";
export { recallMemory } from "./memory-recall";
export { rebuildMemoryIndex, renderMemoryIndex, retentionScore, collectAllNotes, memoryIndexPath } from "./memory-index";
export { createSomaSnapshot, listSomaSnapshots, rollbackSomaSnapshot } from "./snapshots";
export { querySomaTelemetryEvents, summarizeSomaTelemetry } from "./observability";
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
} from "./work-registry";
export { applySomaWriteback, type SomaWritebackOptions, type SomaWritebackResult } from "./writeback";
export { promoteAlgorithmRunMemory } from "./memory-promotion";
export {
  syncAlgorithmRunFromVsa,
  formatSyncResult,
  type SyncAlgorithmRunFromVsaOptions,
  type SyncAlgorithmRunFromVsaResult,
} from "./algorithm-vsa-sync";
export { captureSomaResult, isSomaResultEventKind, searchSomaResults } from "./result-capture";
export { importPaiIdentity, planPaiImport } from "./pai-importer";
export {
  importPaiPack,
  PaiPackNameCollisionRefusal,
  // #106 — `PaiPackSubstrateSpecificRefusal` is kept as a deprecated
  // alias of `PaiPackUnrecognizedLayoutRefusal` (see pai-pack-importer.ts).
  // Both names resolve to the same class.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  PaiPackSubstrateSpecificRefusal,
  PaiPackUnrecognizedLayoutRefusal,
  planPaiPackImport,
} from "./pai-pack-importer";
// Sage r3 #108 Security (blocker) + Architecture (important):
// `planPaiPackImportHandle`, `importPaiPackFromPlan`, and
// `PaiPackImportPlanHandle` are migration-orchestrator plumbing and
// MUST NOT appear on the public package barrel. Exposing them turns
// an internal plan cache into irreversible SDK surface AND opens a
// trust-boundary bypass — a JS caller could forge a handle whose
// `routedFiles` escape `somaHome` and the cached plan would write
// them without re-validating. The migration orchestrator imports the
// trio directly from `./pai-pack-importer`; that module's
// `castHandle` is unforgeable from outside the module file.
// Sage r3 #103 Architecture: `PaiPackReservedNameRefusal` is an
// internal migration-classification detail. The migration orchestrator
// imports it directly from `./pai-pack-importer`; no demonstrated
// external consumer needs to catch it. Keeping it off the barrel
// avoids an irreversible public-API expansion. If a downstream caller
// ever needs structural classification it can be promoted here in a
// dedicated change with documented contract.
export { importPaiDocs, planPaiDocsImport } from "./pai-docs-importer";
// PAI MEMORY → Soma memory translator (#90) is intentionally NOT
// re-exported from the package root — it is an internal phase of
// `migratePai` and its public boundary is not yet stable (Sage r2
// #95 Architecture finding). Tests that need direct access import
// from `./pai-memory-migrator` explicitly.
// PAI → Soma migration orchestrator (#28 minimal scope, extended
// for full migrate in #90).
// Sage r2 #99 Architecture: `formatPackOutcomeLines` is a presentation
// helper for the CLI summary and `MIGRATION.md` body. Keeping it out
// of the package's public API leaves us free to revise the text shape
// without an SDK breakage. Internal callers in `src/cli.ts` import it
// directly from `./pai-migration`.
export {
  migratePai,
  planPaiMigration,
  type PaiMigrationOptions,
  type PaiMigrationPlan,
  type PaiMigrationResult,
} from "./pai-migration";
export { checkSomaPolicy, checkSomaPolicyBatch } from "./policy-audit";
export { evaluateSomaPolicy } from "./policy";
export {
  createDeterministicInboundContentScanner,
  defaultInboundContentSecurityConfig,
  inboundContentHash,
  isInboundUntrustedPath,
  promoteInboundContent,
  scanInboundContent,
} from "./inbound-security";
export {
  inspectRuntimePolicy,
  runtimePolicyTraceRoot,
  RUNTIME_POLICY_SURFACES,
} from "./runtime-policy";
export {
  evaluateToolCallPolicyGuard,
  type ToolCallPolicyGuardOptions,
  type ToolCallPolicyGuardResult,
  type ToolCallPolicyGuardDecision,
} from "./tool-policy-guard";
export { bootstrapSomaHome, loadSomaHome, loadSomaProfile } from "./soma-home";
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
} from "./algorithm-vsa-bridge";
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
} from "./vsa";
export {
  reconcileVsa,
  reconcileVsaArtifacts,
  type VsaConflictPolicy,
  type VsaReconcileConflict,
  type VsaReconcileReport,
  type VsaReconcileResult,
  type ReconcileVsaOptions,
} from "./vsa-reconcile";
export { type CompletenessGap, type CompletenessReport } from "./vsa-schema";

export { SOMA_VERSION } from "./version";
