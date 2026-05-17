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
  PaiPackManifest,
  PaiPackManifestFile,
  PaiPackNormalizationAction,
  PaiPackNormalizationReport,
  PaiPackNormalizationWarning,
  SomaSkillManifest,
  WrittenProjection,
} from "./types";

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
export { importPaiIdentity, planPaiImport } from "./pai-importer";
export { importPaiPack, planPaiPackImport } from "./pai-pack-importer";
// PAI → Soma migration orchestrator (#28 minimal scope).
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
