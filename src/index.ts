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
  WrittenContextBundle,
} from "./types";

export { buildClaudeCodeContext, buildCodexContext, buildPiDevContext, claudeCodeAdapter, codexAdapter, piDevAdapter } from "./adapters";
export { writeContextBundle } from "./context-bundle";

export const SOMA_VERSION = "0.1.0";
