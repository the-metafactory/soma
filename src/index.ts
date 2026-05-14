export type {
  AlgorithmEffortTier,
  AlgorithmImportOptions,
  AlgorithmImportPlan,
  AlgorithmImportResult,
  AlgorithmLogEntry,
  AlgorithmPhase,
  AlgorithmPlanStep,
  AlgorithmRun,
  AlgorithmRunInput,
  AlgorithmRunSummary,
  AlgorithmWorkIndex,
  AssistantIdentity,
  IdealStateArtifact,
  IdealStateCriterion,
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
  SomaMemoryEvent,
  SomaMemoryEventInput,
  PaiImportOptions,
  PaiImportPlan,
  PaiImportResult,
  WrittenContextBundle,
} from "./types";

export {
  addAlgorithmCapabilities,
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
export { appendSomaMemoryEvent, somaMemoryEventsPath } from "./memory";
export { importPaiIdentity, planPaiImport } from "./pai-importer";
export { bootstrapSomaHome, loadSomaHome } from "./soma-home";

export const SOMA_VERSION = "0.1.0";
