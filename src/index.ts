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
  IsaFrontmatter,
  IsaSection,
  PrincipalIdentity,
  SomaAdapter,
  SomaContextBundle,
  SomaContextInput,
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
  WrittenContextBundle,
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
  buildClaudeCodeContext,
  buildCodexContext,
  buildCodexHomeContext,
  buildPiDevContext,
  claudeCodeAdapter,
  codexAdapter,
  piDevAdapter,
} from "./adapters";
export { writeContextBundle } from "./context-bundle";
export {
  buildCodexHomeProjection,
  buildPiDevHomeProjection,
  installCodexHomeProjection,
  installPiDevHomeProjection,
  resolveHomeProjectionPaths,
} from "./home-projection";
export { installSomaForCodex, installSomaForPiDev, planSomaForCodexInstall, planSomaForPiDevInstall } from "./install";
export { importAlgorithm, planAlgorithmImport } from "./algorithm-importer";
export {
  buildSomaStartupContext,
  captureCompletedAlgorithmLearnings,
  runSomaLifecycleAlgorithmUpdated,
  runSomaLifecycleSessionEnd,
  runSomaLifecycleSessionStart,
  writeAlgorithmWorkIndex,
} from "./lifecycle";
export { captureSomaFeedback, classifySomaFeedback, maybeSomaFeedbackPrompt } from "./feedback";
export { appendSomaMemoryEvent, searchSomaMemory, somaMemoryEventsPath } from "./memory";
export { promoteAlgorithmRunMemory } from "./memory-promotion";
export { importPaiIdentity, planPaiImport } from "./pai-importer";
export { importPaiPack, planPaiPackImport } from "./pai-pack-importer";
export { checkSomaPolicy, checkSomaPolicyBatch } from "./policy-audit";
export { evaluateSomaPolicy } from "./policy";
export { bootstrapSomaHome, loadSomaHome } from "./soma-home";

export const SOMA_VERSION = "0.1.3";
