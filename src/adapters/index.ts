export { projectClaudeCode, projectClaudeCodeHome, claudeCodeAdapter } from "./claude-code";
export { projectCodex, projectCodexHome, codexAdapter } from "./codex";
export {
  projectPiDev,
  projectPiDevHome,
  piDevAdapter,
  // #43 — Algorithm phase renderer extension surface.
  ALGORITHM_PHASES,
  latestAlgorithmPhaseMarker,
  parseAlgorithmPhaseMarkers,
  capabilitiesWidgetKey,
  isaCriteriaWidgetKey,
  phaseWidgetKey,
  renderPhaseOverviewLines,
  renderPhaseStatusText,
  renderPhaseWidgetLines,
  SOMA_STATUS_KEY,
  renderIsaChecklistLines,
  summarizeIsaChecklist,
  renderSomaAlgorithmExtension,
  type AlgorithmPhaseDescriptor,
  type AlgorithmPhaseKey,
  type PhaseMarker,
  type IsaChecklistCriterion,
  type IsaChecklistOptions,
  type IsaChecklistSummary,
  type RenderSomaAlgorithmExtensionOptions,
} from "./pi-dev";
