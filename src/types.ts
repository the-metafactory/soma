export type SubstrateId = "codex" | "pi-dev" | "claude-code" | "cortex" | "custom";

export interface AssistantIdentity {
  name: string;
  displayName?: string;
  voiceId?: string;
  traits?: Record<string, number | string | boolean>;
}

export interface PrincipalIdentity {
  name: string;
  preferredName?: string;
  profile?: Record<string, unknown>;
}

export interface Telos {
  mission?: string;
  goals: string[];
  principles: string[];
  commitments: string[];
}

export interface IdealStateCriterion {
  id: string;
  text: string;
  status: "open" | "passed" | "failed" | "dropped";
  verification?: string;
}

export type AlgorithmPhase = "observe" | "think" | "plan" | "build" | "execute" | "verify" | "learn" | "complete" | "abandoned";

export type AlgorithmEffortTier = "E1" | "E2" | "E3" | "E4" | "E5";

export type AlgorithmMode = "minimal" | "native" | "algorithm";

export type AlgorithmEffortSource = "explicit" | "classifier" | "context-override" | "auto" | "fail-safe";

export interface AuthoredFrontmatter {
  task: string;
  effort: AlgorithmEffortTier;
  mode?: AlgorithmMode;
  iteration?: number;
  started?: string;
  algorithm_config?: Record<string, unknown>;
  custom?: Record<string, unknown>;
}

export interface DerivedFrontmatter {
  phase: AlgorithmPhase;
  progress: string;
  verified: boolean;
  updated: string;
}

export interface IsaFrontmatter extends AuthoredFrontmatter, DerivedFrontmatter {}

export interface IsaSection {
  name: string;
  content: string;
}

/**
 * Mutable working document — NOT a static artifact despite the name.
 * Accumulates Decisions, Changelog, and Verification entries over its lifetime.
 * The name is historical (predates the section-based model).
 *
 * Identity: `slug`. Source of truth when file-backed: `~/.soma/isa/<slug>.md`.
 * In-memory ephemeral ISAs (Algorithm runs that never touch disk) leave
 * `sourcePath` undefined.
 *
 * Storage model is section-agnostic at the type level — derived accessors
 * (getGoal, getCriteria, etc.) and the SECTION_NAME_MAP are what give the
 * twelve-section schema its meaning.
 */
export interface IdealStateArtifact {
  slug: string;
  frontmatter: IsaFrontmatter;
  sections: readonly IsaSection[];
  sourcePath?: string;
}

export interface AlgorithmPromptClassification {
  mode: AlgorithmMode;
  effort?: AlgorithmEffortTier;
  source: AlgorithmEffortSource;
  reason: string;
}

export interface AlgorithmPlanStep {
  id: string;
  text: string;
  criteriaIds: string[];
  status: "open" | "done" | "blocked";
  evidence?: string;
}

export interface AlgorithmLogEntry {
  timestamp: string;
  phase: AlgorithmPhase;
  text: string;
}

export interface AlgorithmRun {
  schemaVersion: 2;
  id: string;
  createdAt: string;
  updatedAt: string;
  substrate?: SubstrateId;
  prompt: string;
  intent: string;
  effort: AlgorithmEffortTier;
  effortSource: AlgorithmEffortSource;
  mode: AlgorithmMode;
  classificationReason: string;
  currentState: string;
  isa: IdealStateArtifact;
  antiCriteria: IdealStateCriterion[];
  capabilities: string[];
  planSteps: AlgorithmPlanStep[];
  decisions: AlgorithmLogEntry[];
  changelog: AlgorithmLogEntry[];
  verification: AlgorithmLogEntry[];
  learning: AlgorithmLogEntry[];
}

export interface AlgorithmRunSummary {
  id: string;
  path: string;
  updatedAt: string;
  phase: AlgorithmPhase;
  effort: AlgorithmEffortTier;
  goal: string;
  openCriteria: number;
  passedCriteria: number;
  failedCriteria: number;
  droppedCriteria: number;
  progress: string;
}

export interface AlgorithmRunInput {
  id?: string;
  timestamp?: string;
  substrate?: SubstrateId;
  prompt: string;
  intent: string;
  effort?: AlgorithmEffortTier;
  effortSource?: AlgorithmEffortSource;
  mode?: AlgorithmMode;
  classificationReason?: string;
  currentState: string;
  goal: string;
  criteria: {
    id: string;
    text: string;
    verification?: string;
  }[];
  antiCriteria?: {
    id: string;
    text: string;
    verification?: string;
  }[];
}

export type AlgorithmBatchOperation =
  | {
      kind: "decision" | "change" | "learn";
      text: string;
    }
  | {
      kind: "step";
      stepId: string;
      status: AlgorithmPlanStep["status"];
      evidence?: string;
    }
  | {
      kind: "verify";
      criterionId: string;
      status: "passed" | "failed" | "dropped";
      evidence: string;
    }
  | {
      kind: "capability";
      capability: string;
    }
  | {
      kind: "advance";
    };

export interface SomaSkill {
  name: string;
  path: string;
  description: string;
  triggers: string[];
  files?: {
    path: string;
    content: string;
  }[];
}

export interface SomaMemoryLayout {
  root: string;
  work: string;
  knowledge: string;
  learning: string;
  relationship: string;
  state: string;
}

export interface SomaProfile {
  assistant: AssistantIdentity;
  principal: PrincipalIdentity;
  telos: Telos;
  memory: SomaMemoryLayout;
  skills: SomaSkill[];
}

export interface SomaContextInput {
  profile: SomaProfile;
  activeIsa?: IdealStateArtifact;
  prompt?: string;
}

export interface SomaContextBundle {
  substrate: SubstrateId;
  instructions: string;
  files: {
    path: string;
    content: string;
  }[];
}

export interface WrittenContextBundle {
  substrate: SubstrateId;
  rootDir: string;
  files: string[];
}

export interface SomaHomeProjectionOptions {
  homeDir?: string;
  somaHome?: string;
  substrateHome?: string;
  somaRepoPath?: string;
}

export interface SomaHomeProjection {
  substrate: SubstrateId;
  somaHome: string;
  substrateHome: string;
  bundle: SomaContextBundle;
}

export interface SomaHomeBootstrapOptions {
  homeDir?: string;
  somaHome?: string;
}

export interface SomaHomeBootstrapResult {
  somaHome: string;
  context: SomaContextInput;
  files: string[];
}

export interface SomaInstallOptions {
  homeDir?: string;
  somaHome?: string;
  substrateHome?: string;
  somaRepoPath?: string;
}

export interface SomaInstallResult {
  substrate: SubstrateId;
  somaHome: SomaHomeBootstrapResult;
  substrateHome: WrittenContextBundle;
}

export interface SomaInstallPlan {
  substrate: SubstrateId;
  apply: boolean;
  somaHome: string;
  substrateHome: string;
  somaDirectories: string[];
  somaFiles: string[];
  substrateFiles: string[];
}

export interface PaiImportOptions {
  homeDir?: string;
  claudeHome?: string;
  somaHome?: string;
}

export interface PaiImportPlan {
  apply: boolean;
  claudeHome: string;
  somaHome: string;
  sourceFiles: string[];
  sourceChecks?: ImportSourceCheck[];
  targetFiles: string[];
}

export interface PaiImportResult {
  claudeHome: string;
  somaHome: string;
  files: string[];
}

export interface AlgorithmImportOptions {
  homeDir?: string;
  paiAlgorithmDir?: string;
  somaHome?: string;
}

export interface ImportSourceCheck {
  path: string;
  required: boolean;
  present: boolean;
}

export interface AlgorithmImportPlan {
  apply: boolean;
  paiAlgorithmDir: string;
  somaHome: string;
  sourceFiles: string[];
  sourceChecks?: ImportSourceCheck[];
  targetFiles: string[];
}

export interface AlgorithmImportResult {
  paiAlgorithmDir: string;
  somaHome: string;
  files: string[];
}

export interface PaiPackImportOptions {
  homeDir?: string;
  paiPackDir?: string;
  somaHome?: string;
  skillName?: string;
  overwrite?: boolean;
  includeSubstrateSpecific?: boolean;
}

export interface PaiPackImportFileBase {
  target: string;
  classification: "portable" | "template" | "source-doc" | "substrate-specific";
}

export interface PaiPackSourceImportFile extends PaiPackImportFileBase {
  origin: "source";
  source: string;
}

export interface PaiPackGeneratedImportFile extends PaiPackImportFileBase {
  origin: "generated";
  generator: "pai-pack-importer";
}

export type PaiPackImportFile = PaiPackSourceImportFile | PaiPackGeneratedImportFile;

export interface PaiPackManifestFileBase {
  target: string;
  classification: PaiPackImportFileBase["classification"];
  origin: PaiPackImportFile["origin"];
}

export interface PaiPackManifestSourceFile extends PaiPackManifestFileBase {
  origin: "source";
  source: string;
}

export interface PaiPackManifestGeneratedFile extends PaiPackManifestFileBase {
  origin: "generated";
  generator: "pai-pack-importer";
}

export type PaiPackManifestFile = PaiPackManifestSourceFile | PaiPackManifestGeneratedFile;

export interface PaiPackManifest {
  schema: "soma.pai-pack-import.v1";
  skillName: string;
  packName: string;
  description: string;
  files: PaiPackManifestFile[];
}

export interface PaiPackImportPlan {
  apply: boolean;
  paiPackDir: string;
  somaHome: string;
  skillName: string;
  packName: string;
  description: string;
  files: PaiPackImportFile[];
}

export interface PaiPackImportResult {
  paiPackDir: string;
  somaHome: string;
  skillName: string;
  files: string[];
}

export interface SomaMemoryEventInput {
  id?: string;
  timestamp?: string;
  substrate: SubstrateId;
  kind: string;
  summary: string;
  artifactPaths?: string[];
  metadata?: Record<string, unknown>;
}

export interface SomaMemoryEvent {
  id: string;
  timestamp: string;
  substrate: SubstrateId;
  kind: string;
  summary: string;
  artifactPaths?: string[];
  metadata?: Record<string, unknown>;
}

export interface SomaMemorySearchOptions {
  homeDir?: string;
  somaHome?: string;
  query: string;
  limit?: number;
}

export interface SomaMemorySearchMatch {
  path: string;
  line: number;
  score: number;
  snippet: string;
}

export interface SomaMemorySearchResult {
  query: string;
  somaHome: string;
  matches: SomaMemorySearchMatch[];
}

export type SomaMemoryPromotionStore = "learning" | "knowledge" | "relationship" | "work";

export interface SomaMemoryPromotionOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  fromRun: string;
  store: SomaMemoryPromotionStore;
  title: string;
  lesson?: string;
  appliesWhen?: string;
  timestamp?: string;
}

export interface SomaMemoryPromotionResult {
  somaHome: string;
  store: SomaMemoryPromotionStore;
  path: string;
  sourceRunPath: string;
  event: SomaMemoryEvent;
}

export type SomaFeedbackKind = "correction" | "missed-surface" | "preference" | "relationship-note" | "task-learning" | "none";

export interface SomaFeedbackClassification {
  kind: SomaFeedbackKind;
  confidence: "low" | "medium" | "high";
  reason: string;
}

export interface SomaFeedbackCaptureOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  text: string;
  source?: string;
  storeExcerpt?: boolean;
  timestamp?: string;
}

export interface SomaFeedbackCaptureResult {
  somaHome: string;
  captured: boolean;
  classification: SomaFeedbackClassification;
  event?: SomaMemoryEvent;
}

export type SomaPolicyAction = "write" | "delete" | "modify";

export type SomaPolicyDecision = "allow" | "deny";

export interface SomaProtectedPath {
  path: string;
  description: string;
  guardDelete?: boolean;
  guardModify?: boolean;
}

export interface SomaPolicyCheckOptions {
  homeDir?: string;
  somaHome?: string;
  cwd?: string;
  privateRoots?: string[];
  protectedPaths?: SomaProtectedPath[];
  substrate?: SubstrateId;
  action: SomaPolicyAction;
  destinationPath: string;
  content?: string;
  sourcePath?: string;
  record?: "all" | "deny" | "none";
  timestamp?: string;
}

export interface SomaPolicyBatchTarget {
  filePath: string;
  content?: string;
  sourcePath?: string;
}

export interface SomaPolicyBatchCheckOptions extends Pick<SomaPolicyCheckOptions, "homeDir" | "somaHome" | "cwd" | "substrate" | "action" | "record" | "timestamp" | "protectedPaths"> {
  privateRoots?: string[];
  targets: SomaPolicyBatchTarget[];
}

export type SomaPolicyFindingKind = "private-source" | "private-marker" | "protected-path";

export interface SomaPolicyFinding {
  kind: SomaPolicyFindingKind;
  detail: string;
}

export interface SomaPolicyCheckResult {
  somaHome: string;
  decision: SomaPolicyDecision;
  reason: string;
  findings: SomaPolicyFinding[];
  event?: SomaMemoryEvent;
}

export interface SomaPolicyBatchCheckResult {
  decision: SomaPolicyDecision;
  reason: string;
  results: SomaPolicyCheckResult[];
}

export type SomaLifecycleEventName = "session_start" | "algorithm_updated" | "session_end";

export interface SomaLifecycleOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  sessionId?: string;
  timestamp?: string;
}

export interface SomaStartupContext {
  somaHome: string;
  timestamp: string;
  substrate: SubstrateId;
  sessionId?: string;
  context: string;
  activeRuns: AlgorithmRunSummary[];
  recentLearnings: string[];
  relationshipNotes: string[];
}

export interface AlgorithmWorkIndex {
  updatedAt: string;
  runs: AlgorithmRunSummary[];
}

export interface SomaLifecycleResult {
  event: SomaLifecycleEventName;
  somaHome: string;
  timestamp: string;
  files: string[];
  context?: string;
}

export interface SomaTask {
  id: string;
  substrate: SubstrateId;
  prompt: string;
  cwd?: string;
}

export interface SomaRunResult {
  taskId: string;
  substrate: SubstrateId;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  artifacts?: string[];
}

export interface SomaAdapter {
  name: SubstrateId;
  detect(): Promise<boolean>;
  buildContext(input: SomaContextInput): Promise<SomaContextBundle>;
  run(task: SomaTask): Promise<SomaRunResult>;
}
