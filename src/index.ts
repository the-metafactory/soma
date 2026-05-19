export type {
  AlgorithmEffortTier,
  AlgorithmEffortSource,
  AlgorithmBatchOperation,
  AlgorithmImportOptions,
  AlgorithmImportPlan,
  AlgorithmImportResult,
  AlgorithmLogEntry,
  AlgorithmMode,
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
  IdealStateArtifact,
  IdealStateCriterion,
  IsaUpdatePayload,
  IsaFrontmatter,
  IsaSection,
  IsaSkillInstallAction,
  IsaSkillInstallOptions,
  IsaSkillInstallResult,
  PrincipalIdentity,
  SomaActiveIsaState,
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
  SomaTask,
  SubstrateId,
  Telos,
  SomaHomeProjection,
  SomaHomeProjectionOptions,
  SomaHomeBootstrapOptions,
  SomaHomeBootstrapResult,
  SomaInstallOptions,
  SomaInstallPlan,
  SomaInstallResult,
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
  SomaProtectedPath,
  PaiImportOptions,
  PaiImportPlan,
  PaiImportResult,
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

export {
  addAlgorithmCapabilities,
  applyAlgorithmBatch,
  advanceAlgorithmRun,
  algorithmPhaseOrder,
  createAlgorithmRun,
  nextAlgorithmPhase,
  recordAlgorithmChange,
  recordAlgorithmDecision,
  recordAlgorithmLearning,
  setAlgorithmPlan,
  updateAlgorithmPlanStep,
  verifyAlgorithmCriterion,
} from "./algorithm";
export { classifyAlgorithmPrompt } from "./algorithm-classifier";
// Public ISA API — cohesive surface: semantic accessors + mutators + parse/serialize.
// Renderer details (SECTION_NAME_MAP, TWELVE_SECTIONS, renderCriteriaMarkdown,
// renderLogEntries, parseCriteriaMarkdown, progressFromCriteria,
// verifiedFromCriteria, buildIsaArtifact) stay internal — import from
// `./isa-accessors` directly if you need them from within the package.
export {
  appendCriterion,
  appendIsaChangelog,
  appendIsaDecision,
  appendIsaVerification,
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
} from "./isa-accessors";
export { parseIsa, serializeIsa } from "./isa-parse";
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
  projectClaudeCode,
  projectClaudeCodeHome,
  projectCodex,
  projectCodexHome,
  projectPiDev,
  projectPiDevHome,
  claudeCodeAdapter,
  codexAdapter,
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
  buildClaudeCodeHomeProjection,
  buildCodexHomeProjection,
  buildPiDevHomeProjection,
  installClaudeCodeHomeProjection,
  installCodexHomeProjection,
  installPiDevHomeProjection,
  resolveHomeProjectionPaths,
} from "./home-projection";
export {
  installSomaForClaudeCode,
  installSomaForCodex,
  installSomaForPiDev,
  planSomaForClaudeCodeInstall,
  planSomaForCodexInstall,
  planSomaForPiDevInstall,
  uninstallSomaForClaudeCode,
  type UninstallClaudeCodeOptions,
  type UninstallClaudeCodeResult,
} from "./install";
// Adapter active-ISA projection helpers (#37).
export {
  activeIsaProjectionPath,
  loadActiveIsaForBundle,
  renderActiveIsaFile,
  type LoadActiveIsaOptions,
} from "./adapter-active-isa";
// Public ISA-skill installer API — cohesive surface only.
// Implementation details (isaSkillRuntimeDir, isaSkillSourceDir,
// parseSkillFrontmatter, skillBaselinesPath, compareSkillVersions) stay in
// `./isa-skill-installer` and are imported directly by tests and scripts.
export { installIsaSkill } from "./isa-skill-installer";
export { importAlgorithm, planAlgorithmImport } from "./algorithm-importer";
export {
  buildSomaStartupContext,
  captureCompletedAlgorithmLearnings,
  runSomaLifecycleAlgorithmUpdated,
  runSomaLifecycleIsaUpdated,
  runSomaLifecycleSessionEnd,
  runSomaLifecycleSessionStart,
  writeAlgorithmWorkIndex,
} from "./lifecycle";
export { captureSomaFeedback, classifySomaFeedback, maybeSomaFeedbackPrompt } from "./feedback";
export { appendSomaMemoryEvent, searchSomaMemory, somaMemoryEventsPath } from "./memory";
export { promoteAlgorithmRunMemory } from "./memory-promotion";
export { captureSomaResult, isSomaResultEventKind, searchSomaResults } from "./result-capture";
export { importPaiIdentity, planPaiImport } from "./pai-importer";
export {
  importPaiPack,
  PaiPackNameCollisionRefusal,
  // #106 — `PaiPackSubstrateSpecificRefusal` is kept as a deprecated
  // alias of `PaiPackUnrecognizedLayoutRefusal` (see pai-pack-importer.ts).
  // Both names resolve to the same class.
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
export { bootstrapSomaHome, loadSomaHome } from "./soma-home";
// Algorithm ↔ ISA bridge (#39) — advisory, non-blocking.
export {
  markIsaVerifiedFromCriteria,
  recordAlgorithmIsaChange,
  recordAlgorithmIsaDecision,
  suggestIsaAtObserve,
  type AlgorithmIsaOptions,
  type HintConfig,
  type PromptShape,
  type SuggestIsaResult,
} from "./algorithm-isa-bridge";
// ISA library API (#34) — cohesive public surface only.
// Storage-layout helpers (activeStatePath, isaDir, isaPath) stay internal
// to `./isa` so on-disk layout can evolve without breaking consumers
// (Sage round-2 architecture finding). Tests + adapters that need them
// import from `./isa` directly.
export {
  checkCompleteness,
  getActiveIsa,
  listAvailableTiers,
  listIsas,
  readIsa,
  applyIsaUpdate,
  recordIsaChangelog,
  recordIsaDecision,
  recordIsaVerification,
  scaffoldIsa,
  setActiveIsa,
  writeIsa,
  type EffortTier,
  type IsaLibraryOptions,
  type IsaListEntry,
  type IsaUpdateEntry,
  type IsaUpdateSection,
  type ScaffoldIsaInput,
  type SetActiveIsaResult,
  type WriteIsaResult,
} from "./isa";
export {
  reconcileIsa,
  reconcileIsaArtifacts,
  type IsaConflictPolicy,
  type IsaReconcileConflict,
  type IsaReconcileReport,
  type IsaReconcileResult,
  type ReconcileIsaOptions,
} from "./isa-reconcile";
export { type CompletenessGap, type CompletenessReport } from "./isa-schema";

export { SOMA_VERSION } from "./version";
