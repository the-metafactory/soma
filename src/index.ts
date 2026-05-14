export type {
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
  SomaInstallResult,
  SomaMemoryEvent,
  SomaMemoryEventInput,
  WrittenContextBundle,
} from "./types";

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
export { buildCodexHomeProjection, installCodexHomeProjection, resolveHomeProjectionPaths } from "./home-projection";
export { installSomaForCodex } from "./install";
export { appendSomaMemoryEvent, somaMemoryEventsPath } from "./memory";
export { bootstrapSomaHome, loadSomaHome } from "./soma-home";

export const SOMA_VERSION = "0.1.0";
