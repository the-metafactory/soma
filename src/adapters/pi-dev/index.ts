export { projectPiDev, projectPiDevHome, piDevAdapter } from "./adapter";
// Pi.dev Algorithm renderer extension (#43 minimal slice). Surfaced
// through this substrate barrel so consumers reach the parser + widget
// helpers + extension-source renderer without deep-importing into the
// per-substrate dir (substrate-adapter boundary rule in eslint.config).
export {
  ALGORITHM_PHASES,
  parseAlgorithmPhaseMarkers,
  type AlgorithmPhaseDescriptor,
  type AlgorithmPhaseKey,
  type PhaseMarker,
} from "./extensions/phase-parser";
export {
  isaCriteriaWidgetKey,
  phaseWidgetKey,
  renderPhaseOverviewLines,
  renderPhaseStatusText,
  renderPhaseWidgetLines,
  SOMA_STATUS_KEY,
} from "./extensions/widget-renderers";
export {
  renderIsaChecklistLines,
  type IsaChecklistCriterion,
  type IsaChecklistOptions,
} from "./extensions/isa-checklist";
export {
  renderSomaAlgorithmExtension,
  type RenderSomaAlgorithmExtensionOptions,
} from "./extensions/soma-algorithm";
export { buildPiDevPortableSkillFiles } from "./skill-projection";
