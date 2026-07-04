import type { InferenceBackend, InferenceLevel } from "./tools/inference/types";

export type SubstrateId = "codex" | "pi-dev" | "claude-code" | "cursor" | "grok" | "cortex" | "custom";

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

export interface Purpose {
  mission?: string;
  goals: string[];
  principles: string[];
  commitments: string[];
}

/** @deprecated Renamed to {@link Purpose} (soma#329, ADR 0001). Kept for back-compat. */
export type Telos = Purpose;

/**
 * What the verifier CLAIMS about how the evidence was obtained. A caller-asserted
 * label, NOT a machine-verified fact — Soma records the claim and gates on it, but
 * does not confirm a `probed`/`tested` label corresponds to a real probe or test
 * on any surface (CLI, VSA markdown, or library).
 * - `specified`: a design/spec claim only ("the doc says X") — weak; blocks the LEARN gate.
 * - `probed`: caller asserts behaviour was observed at runtime (curl, grep of running state).
 * - `tested`: caller asserts coverage by an automated test.
 */
export type EvidenceKind = "specified" | "probed" | "tested";

export type CriterionStatus = "open" | "passed" | "failed" | "dropped" | "deferred-probe";

/**
 * The unit of evidence-gated verification: { criterion, required evidence, typed
 * verdict, completion gate }. See CONTEXT.md and ADR 0001 — this code shape *is*
 * the extracted `checkpoint` primitive (#329).
 */
export interface Checkpoint {
  id: string;
  text: string;
  status: CriterionStatus;
  verification?: string;
  /** See {@link EvidenceKind}. Undefined on legacy/pre-feature criteria (grandfathered by the LEARN gate). */
  evidenceKind?: EvidenceKind;
}

/**
 * @deprecated soma#329: renamed to {@link Checkpoint}. Retained as a back-compat
 * alias for the PAI-era name; prefer `Checkpoint` in new code.
 */
export type IdealStateCriterion = Checkpoint;

export type AlgorithmPhase = "observe" | "think" | "plan" | "build" | "execute" | "verify" | "learn" | "complete" | "abandoned";

export type AlgorithmEffortTier = "E1" | "E2" | "E3" | "E4" | "E5";

export type AlgorithmMode = "minimal" | "native" | "algorithm";

export type AlgorithmEffortSource = "explicit" | "classifier" | "context-override" | "auto" | "fail-safe";

export type AlgorithmLoopStatus = "running" | "paused" | "blocked" | "completed";

export interface AlgorithmLoopIteration {
  iteration: number;
  timestamp: string;
  progressBefore: string;
  progressAfter: string;
  summary?: string;
}

export interface AlgorithmLoopState {
  status: AlgorithmLoopStatus;
  iterationCount: number;
  plateauCounter: number;
  iterations: AlgorithmLoopIteration[];
}

export interface AlgorithmCriteriaPartition {
  id: string;
  domain: string;
  criteria: Checkpoint[];
}

export interface IdeateParameters {
  problemConnection: number;
  selectionPressure: number;
  domainDiversity: number;
  phaseBalance: number;
  ideaVolume: number;
  mutationRate: number;
  generativeTemperature: number;
  maxCycles: number;
  contextCarryover: boolean;
  parallelAgents: number;
}

export type IdeatePresetName = "dream" | "explore" | "balanced" | "directed" | "surgical";

export interface OptimizeParameters {
  stepSize: number;
  regressionTolerance: number;
  earlyStopPatience: number;
  maxIterations: number;
}

export type OptimizePresetName = "cautious" | "standard-optimize" | "aggressive";

export type AlgorithmNotificationEvent =
  | {
      kind: "algorithm.phase.entered";
      runId: string;
      phase: AlgorithmPhase;
      timestamp: string;
    }
  | {
      kind: "algorithm.loop.state_changed";
      runId: string;
      from: AlgorithmLoopStatus;
      to: AlgorithmLoopStatus;
      iterationCount: number;
      timestamp: string;
    }
  | {
      kind: "algorithm.loop.blocked";
      runId: string;
      plateauCounter: number;
      threshold: number;
      timestamp: string;
    };

export interface AlgorithmNotificationSink {
  notify(event: AlgorithmNotificationEvent): Promise<void> | void;
}

export interface AlgorithmLoopExecutionContext {
  run: AlgorithmRun;
  iteration: number;
  partition?: AlgorithmCriteriaPartition;
}

export interface AlgorithmLoopIterationResult {
  run: AlgorithmRun;
  progressBefore: string;
  progressAfter: string;
  summary?: string;
}

export interface AlgorithmLoopExecutor {
  executeIteration(context: AlgorithmLoopExecutionContext): Promise<AlgorithmLoopIterationResult>;
}

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

export interface VsaFrontmatter extends AuthoredFrontmatter, DerivedFrontmatter {}

export interface VsaSection {
  name: string;
  content: string;
}

/**
 * Mutable working document — NOT a static artifact despite the name.
 * Accumulates Decisions, Changelog, and Verification entries over its lifetime.
 * The name is historical (predates the section-based model).
 *
 * Identity: `slug`. Source of truth when file-backed: `~/.soma/vsa/<slug>.md`.
 * In-memory ephemeral VSAs (Algorithm runs that never touch disk) leave
 * `sourcePath` undefined.
 *
 * Storage model is section-agnostic at the type level — derived accessors
 * (getGoal, getCriteria, etc.) and the SECTION_NAME_MAP are what give the
 * twelve-section schema its meaning.
 */
export interface VerificationStateArtifact {
  slug: string;
  frontmatter: VsaFrontmatter;
  sections: readonly VsaSection[];
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

/**
 * A current-state probe recorded during OBSERVE. The OBSERVE→THINK gate requires
 * at least one observation whose {@link EvidenceKind} is `probed` or `tested` —
 * a `specified` observation ("the doc says the route exists") does NOT clear the
 * floor, because the floor's whole point is confirming reality, not restating a
 * spec. Like every evidence surface, `evidenceKind` is CALLER-ASSERTED: the gate
 * forces an explicit probed/tested claim and makes a hollow observation auditable;
 * it does not verify the probe actually happened.
 */
export interface AlgorithmObservation {
  timestamp: string;
  /** The current-state assumption being checked (e.g. "route /health exists"). */
  claim: string;
  /** What the probe found (e.g. "confirmed via grep of src/server.ts:42"). */
  evidence: string;
  evidenceKind: EvidenceKind;
}

/**
 * The Soma gates a run did or did not satisfy — the generative spine of the
 * meta-reflection layer (#333): a gate recurrently unmet across runs is the
 * empirical case for a runner/prompt fix — the signal P2 / #331 proves (P2 was
 * found by a manual 188-run dig; this layer re-surfaces that signal automatically).
 * Each flag maps to a real enforced gate:
 * - `currentStateFloor`: a probed/tested observation was on record (#331).
 * - `learnGateClean`: no unresolved or hollow-`specified` criteria blocked LEARN (#330).
 * - `completeness`: every criterion reached a terminal state (passed/dropped/deferred-probe).
 *
 * Provenance of the flags: a LIVE reflection computes them from run state via
 * {@link computeGatesFired}, using the same predicates the gates enforce — a
 * point-in-time SNAPSHOT (a later mutation can move the run, so it is not a
 * standing equivalence with the gate's verdict at every later moment). An
 * IMPORTED historical record (e.g. the PAI corpus) instead carries a documented,
 * lossy best-effort mapping — caller-asserted history, not re-derived facts.
 */
export interface AlgorithmGatesFired {
  currentStateFloor: boolean;
  learnGateClean: boolean;
  completeness: boolean;
}

/**
 * A per-run meta-reflection — "how the Algorithm itself should have behaved",
 * the layer PAI captured (`reflection_q1/q2/q3` + `doctrine_fired`) and Soma
 * never ported until #333. Two halves by design, mirroring the deterministic
 * spine / model-proposed split the direction doc settled on:
 * - `gatesFired` is computed from the run (deterministic, auditable).
 * - `smarterRun` is the MODEL's proposal ("a smarter run would have…"); free
 *   text, never machine-verified. The digest counts gate-misses to RANK and
 *   buckets these q-signals to ENRICH.
 */
export interface AlgorithmMetaReflection {
  timestamp: string;
  phase: AlgorithmPhase;
  gatesFired: AlgorithmGatesFired;
  smarterRun: {
    /** q1 — an earlier step the run missed (e.g. "probe field existence before asking"). */
    missedEarlyStep?: string;
    /** q2 — verification/parallelization the run should have done (the P2 signal class). */
    missedVerifyOrParallel?: string;
    /** q3 — the highest-value move, what actually worked. */
    highestValueMove?: string;
  };
  /** Self-predicted satisfaction 0–10 (caller-asserted). */
  satisfaction?: number;
  withinBudget?: boolean;
}

export type AlgorithmProvenanceOperation =
  | "run.created"
  | "run.observed"
  | "observation.record"
  | "phase.advance"
  | "criterion.verify"
  | "capability.invoke"
  | "learning.record"
  | "reflection.record"
  | "memory.promote";

export interface AlgorithmProvenanceEntry {
  timestamp: string;
  phase: AlgorithmPhase;
  operation: AlgorithmProvenanceOperation;
  substrate: SubstrateId;
  detail?: string;
}

export type AlgorithmCapabilityKind = "skill" | "inline" | "agent" | "command" | "adapter";

export type AlgorithmCapabilityContract = "skill" | "inline" | "agent" | "command" | "adapter";

export type AlgorithmCapabilitySelectionStatus = "selected" | "invoked" | "removed" | "failed";

export interface AlgorithmCapabilityDefinition {
  name: string;
  kind: AlgorithmCapabilityKind;
  phases: AlgorithmPhase[];
  triggerSignals: string[];
  invoke: {
    contract: AlgorithmCapabilityContract;
    target: string;
  };
}

export interface SomaSkillAlgorithmCapabilityManifest {
  kind?: AlgorithmCapabilityKind;
  phases?: AlgorithmPhase[];
  triggerSignals?: string[];
}

export interface AlgorithmCapabilityInvocation {
  timestamp: string;
  substrate: SubstrateId;
  contract: AlgorithmCapabilityContract;
  target: string;
  evidence: string;
}

export interface AlgorithmCapabilitySelection {
  name: string;
  phase: AlgorithmPhase;
  reason: string;
  status: AlgorithmCapabilitySelectionStatus;
  selectedAt: string;
  invocation?: AlgorithmCapabilityInvocation;
  removalReason?: string;
  removedAt?: string;
}

export interface AlgorithmRun {
  // soma#329 slice 3: v3 stores the embedded VSA under the `vsa` key (was `isa`
  // ≤v2). The on-disk reader (loadAlgorithmRun) dual-reads both keys.
  schemaVersion: 3;
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
  vsa: VerificationStateArtifact;
  loop: AlgorithmLoopState;
  antiCriteria: Checkpoint[];
  capabilities: string[];
  capabilityDefinitions?: AlgorithmCapabilityDefinition[];
  capabilitySelections?: AlgorithmCapabilitySelection[];
  planSteps: AlgorithmPlanStep[];
  decisions: AlgorithmLogEntry[];
  /** Current-state probes recorded during OBSERVE. See {@link AlgorithmObservation}. */
  observations: AlgorithmObservation[];
  changelog: AlgorithmLogEntry[];
  verification: AlgorithmLogEntry[];
  learning: AlgorithmLogEntry[];
  /** Per-run meta-reflections ("how the Algorithm should have behaved"). See {@link AlgorithmMetaReflection}. */
  metaReflection: AlgorithmMetaReflection[];
  provenance: AlgorithmProvenanceEntry[];
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
  deferredProbeCriteria: number;
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
      kind: "observe";
      claim: string;
      evidence: string;
      evidenceKind: EvidenceKind;
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
      status: "passed" | "failed" | "dropped" | "deferred-probe";
      evidence: string;
      evidenceKind?: EvidenceKind;
    }
  | {
      kind: "capability";
      capability: string;
      phase?: AlgorithmPhase;
      reason?: string;
    }
  | {
      kind: "capability-invocation";
      capability: string;
      substrate?: SubstrateId;
      evidence: string;
    }
  | {
      kind: "capability-removal";
      capability: string;
      reason: string;
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

export interface SomaPaths {
  root(): string;
  identity(): string;
  memory(): string;
  profile(): string;
  skills(): string;
  learning(): string;
  signals(): string;
  wisdom(): string;
  relationship(): string;
  state(): string;
  work(): string;
  ratings(): string;
  opinions(): string;
  story(): string;
  events(): string;
  resolve(...segments: string[]): string;
}

export interface SomaSnapshotOptions {
  homeDir?: string;
  somaHome?: string;
  name?: string;
  trigger?: string;
}

export interface SomaSnapshotResult {
  somaHome: string;
  id: string;
  name: string;
  trigger: string;
  createdAt: string;
}

export interface SomaSnapshotListOptions {
  homeDir?: string;
  somaHome?: string;
  limit?: number;
}

export interface SomaSnapshotEntry {
  id: string;
  createdAt: string;
  name: string;
  subject: string;
}

export interface SomaSnapshotRollbackOptions {
  homeDir?: string;
  somaHome?: string;
  snapshot: string;
}

export interface SomaSnapshotRollbackResult {
  somaHome: string;
  id: string;
  name: string;
}

export interface SomaProfile {
  assistant: AssistantIdentity;
  principal: PrincipalIdentity;
  purpose: Purpose;
  memory: SomaMemoryLayout;
  skills: SomaSkill[];
}

export interface ProjectionInput {
  profile: SomaProfile;
  activeVsa?: VerificationStateArtifact;
  prompt?: string;
  /**
   * Memory subsystem M4 — the projected always-loaded memory index. A SIBLING
   * surface to `profile`, deliberately NOT under it: Memory is a peer compartment
   * to Identity/Purpose, not a sub-field of the profile. `indexContent` is the
   * verbatim rendered `memory/INDEX.md` (no wall clock — ages are baked at index
   * rebuild time, AC-4). Omitted when memory is disabled or no index exists, in
   * which case the substrate simply does not project a memory file.
   */
  memory?: { indexContent: string };
}

export interface Projection {
  substrate: SubstrateId;
  instructions: string;
  files: {
    path: string;
    content: string;
    /**
     * When true, the file is chmod'd executable (0o755) at write
     * time. Used by hook entries that the substrate execs directly
     * via shebang (soma#73 sage r2). Defaults to false; ordinary
     * markdown/config files stay 0o644.
     */
    executable?: boolean;
  }[];
}

export interface WrittenProjection {
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
  bundle: Projection;
}

export interface SomaHomeBootstrapOptions {
  homeDir?: string;
  somaHome?: string;
}

export interface SomaHomeBootstrapResult {
  somaHome: string;
  context: ProjectionInput;
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
  substrateHome: WrittenProjection;
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

/**
 * Schema for `~/.soma/memory/STATE/active.json` — canonical active-VSA
 * state file shipped by #32. Layer 3 (#34) library CRUD is the sole
 * owner of reads/writes; `bootstrapSomaHome()` only declares the schema
 * and creates the containing directory.
 *
 * - `activeSlug` — slug of the currently-active VSA, or `null` when none.
 * - `runId`      — `AlgorithmRun.id` currently operating on the active
 *                  VSA; cleared by `completeAlgorithmRun` /
 *                  `abandonAlgorithmRun` (per #41 reconciliation v3).
 * - `updatedAt`  — ISO 8601 timestamp of the last mutation.
 */
export interface SomaActiveVsaState {
  activeSlug: string | null;
  runId: string | null;
  updatedAt: string;
}

export interface SomaSkillBaseline {
  version: string;
  files: Record<string, string>;
  installedAt: string;
}

export type SomaSkillBaselines = Record<string, SomaSkillBaseline>;

export interface VsaSkillInstallOptions {
  homeDir?: string;
  somaHome?: string;
  somaRepoPath?: string;
  force?: boolean;
  /**
   * Absolute destination directory for the installed skill (#37). When
   * omitted the installer writes to `<somaHome>/skills/VSA` (preserves
   * pre-#37 behavior). When set — used by substrate adapters that want
   * to install the same versioned skill under their own root, e.g.
   * `~/.codex/skills/VSA`. The baseline + drift detection logic is
   * shared regardless of destination.
   */
  skillDestinationDir?: string;
}

export type VsaSkillInstallAction = "fresh" | "upgraded" | "unchanged" | "preserved-local-edits" | "no-source";

export interface VsaSkillInstallResult {
  somaHome: string;
  skillDir: string;
  sourceVersion: string;
  runtimeVersion: string | null;
  action: VsaSkillInstallAction;
  filesWritten: string[];
  filesPreservedUserAdditions: string[];
  upgradeMarker?: string;
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
  /**
   * #106 — opt-in flag carrying the historical name. The CLI and SDK
   * both still accept it; the canonical name is now
   * `includeUnrecognized` and the CLI surface is `--include-unrecognized`.
   * The legacy CLI flag `--include-substrate-specific` is a deprecated
   * alias for one release that emits a stderr warning. The option key
   * here keeps its old name to avoid churning every SDK consumer in
   * one go; an `includeUnrecognized` getter can be added later if a
   * second-pass rename is desired.
   */
  includeSubstrateSpecific?: boolean;
}

export interface PaiPackImportFileBase {
  target: string;
  /**
   * File classification. The router emits these tags; the importer
   * uses them to decide refusal vs. silent-skip vs. archive-only
   * routing.
   *
   *   - `portable`              — flows into a derived Soma skill.
   *   - `template`              — flows into a skill's template surface.
   *   - `source-doc`            — README/INSTALL/VERIFY etc.
   *   - `unrecognized-layout`   — file under `src/` the router didn't
   *                              recognize; refused unless
   *                              `--include-unrecognized` is set
   *                              (in which case it lands in archive).
   *                              Pre-#106 this was `substrate-specific`.
   *   - `noise`                 — editor/IDE/language infrastructure
   *                              (denylist). Silently skipped at routing
   *                              time, counted in audit, NEVER refused.
   *                              Pre-#106 these were mis-classified as
   *                              `substrate-specific` and polluted
   *                              refusal lists. (#106 AC-2)
   */
  classification: "portable" | "template" | "source-doc" | "unrecognized-layout" | "noise";
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

export interface PaiPackNormalizationAction {
  file: string;
  kind:
    | "removed-substrate-notification-hook"
    | "rewrote-claude-home-path"
    | "rewrote-pai-doc-path"
    | "rewrote-pai-template-path"
    | "rewrote-pai-algorithm-path"
    | "rewrote-pai-memory-path"
    | "rewrote-unmapped-claude-path"
    | "stripped-mandatory-runtime-block"
    | "stripped-pai-customization-block"
    | "compacted-skill-description"
    /**
     * #104 — emitted during pack file enumeration (not normalization)
     * when a symlink falls inside a well-known IDE/editor config
     * directory denylist (`.cursor/`, `.vscode/`, `.idea/`, `.fleet/`,
     * `.zed/`). The file is dropped from the import set instead of
     * aborting the pack as `refused-other`. Every other symlink still
     * refuses the pack. The audit entry surfaces in the per-pack
     * `soma-pack.json` so reviewers can see which editor-config files
     * the pack carried. `file` is the POSIX-style path relative to the
     * pack root. `detail` names the matched denylist directory segment.
     */
    | "skipped-editor-config-symlink"
    /**
     * #106 — emitted at routing time when a regular file matches the
     * noise denylist (`.gitignore`, `bun.lock`, `.vscode/`, etc.).
     * The file is dropped from the import set BEFORE refusal accounting
     * so it never pollutes a `refused-unrecognized-layout` outcome's
     * file list. Counted in the audit so reviewers can see which
     * editor/language infrastructure the pack carried. `detail` names
     * the matched denylist pattern category.
     */
    | "skipped-noise-file"
    /**
     * #109 — emitted at routing time when a file routes as
     * `unrecognized-layout` and `--include-unrecognized` is NOT set.
     * Previously these files refused the whole pack
     * (`PaiPackUnrecognizedLayoutRefusal`); now they are silently
     * dropped from the routed set so partial imports succeed (one
     * unrecognized sibling no longer poisons a pack with otherwise-
     * valid nested skills, which is the universal real-PAI-pack shape
     * — Art, Thinking, Utilities all ship unrecognized siblings). The
     * audit entry surfaces what we dropped in the per-skill
     * `soma-pack.json` so the principal can see which pack files lived
     * outside the recognized layout. With `--include-unrecognized` the
     * files land in the pack-level archive instead and no audit entry
     * is emitted (the archive listing IS the audit).
     */
    | "skipped-unrecognized-file";
  detail: string;
}

export interface PaiPackNormalizationWarning {
  file: string;
  kind:
    | "ambiguous-substrate-path"
    | "substrate-mutation-command"
    | "execution-logging-path"
    | "customization-overlay-reference"
    | "release-safety-path"
    | "unmapped-claude-home-path";
  detail: string;
}

export interface PaiPackNormalizationReport {
  mode: "deterministic";
  actions: PaiPackNormalizationAction[];
  warnings: PaiPackNormalizationWarning[];
}

export interface PaiPackManifest {
  schema: "soma.pai-pack-import.v1";
  skillName: string;
  packName: string;
  description: string;
  files: PaiPackManifestFile[];
  normalization?: PaiPackNormalizationReport;
  /**
   * #105 — when the pack archive manifest is rendered (the
   * `<somaHome>/imports/pai-packs/<pack-slug>/soma-pack-archive.json`
   * surface), every Soma skill derived from the pack is listed here in
   * sorted order. For per-skill manifests (`<somaHome>/skills/<slug>/
   * soma-pack.json`) the field is omitted. Single-skill packs still
   * emit the field on the archive manifest (one-element array) so the
   * archive shape is stable across FLAT and nested layouts.
   */
  derivedSkills?: string[];
}

export interface SomaSkillManifest {
  schema: "soma.skill.v1";
  name: string;
  description: string;
  packId?: string;
  source: { kind: "pai-pack"; packName: string };
  entrypoint: string;
  references: string[];
  workflows: string[];
  tools: string[];
  triggers: string[];
  substrates: ("claude-code" | "codex" | "pi-dev" | "cursor" | "grok" | "cortex" | "custom")[];
  algorithmCapability?: SomaSkillAlgorithmCapabilityManifest;
}

export interface PaiPackImportPlan {
  apply: boolean;
  paiPackDir: string;
  somaHome: string;
  skillName: string;
  packName: string;
  description: string;
  files: PaiPackImportFile[];
  normalization: PaiPackNormalizationReport;
}

export interface PaiPackImportResult {
  paiPackDir: string;
  somaHome: string;
  skillName: string;
  files: string[];
  normalization: PaiPackNormalizationReport;
}

/**
 * Per-pack migration outcome (#97 / #106). The bulk-pack phase of
 * `migratePai` no longer aborts on a per-pack failure — it classifies
 * each pack into one of these buckets and continues. The CLI's
 * exit-code policy is: `imported` / `refused-unrecognized-layout` /
 * `refused-reserved` / `refused-name-collision` are zero-exit
 * (policy-respected); `refused-other` forces a non-zero exit (genuine
 * error).
 *
 *   - `imported`                       — pack landed cleanly.
 *   - `refused-unrecognized-layout`    — pack contains files under
 *                                        `src/` the router didn't
 *                                        recognize and `--include-unrecognized`
 *                                        was not passed. #106 renamed
 *                                        this from `refused-substrate-specific`
 *                                        because the old name suggested
 *                                        Codex/Claude/Pi-specific intent;
 *                                        the real meaning is "layout
 *                                        the router didn't recognize".
 *   - `refused-reserved`               — pack's normalized skill name is
 *                                        in the migration reserved-name set
 *                                        (`isa`, `the-algorithm`, `knowledge`,
 *                                        `telos`) and `--overwrite-reserved`
 *                                        was not passed.
 *   - `refused-other`                  — genuine error (filesystem failure,
 *                                        malformed pack, missing required
 *                                        files, secret-file refusal, etc.).
 */
export type PaiPackOutcomeKind =
  | "imported"
  | "refused-unrecognized-layout"
  | "refused-reserved"
  /**
   * #105 — emitted when a derived skill's kebab-cased name collides
   * with an already-landed Soma skill. Two flavors:
   *
   *   1. **Within one pack** — two `src/<Name>/SKILL.md` files kebab to
   *      the same slug. The pack importer throws
   *      `PaiPackNameCollisionRefusal`; the migration orchestrator
   *      classifies it `refused-name-collision`.
   *   2. **Across packs** — Pack A landed `browser`, Pack B's nested
   *      `Browser` would also kebab to `browser`. The second pack's
   *      derived skill records `refused-name-collision` unless
   *      `--overwrite-reserved` is set.
   *
   * `outcome.skillName` is the colliding slug; `outcome.reason`
   * names which pack already owned the surface.
   */
  | "refused-name-collision"
  | "refused-other";

export interface PaiPackOutcome {
  /** Absolute path of the source pack directory. Always present. */
  paiPackDir: string;
  outcome: PaiPackOutcomeKind;
  /**
   * Pack's normalized skill name when known (always for `imported` and
   * `refused-reserved`; usually for `refused-unrecognized-layout`; may
   * be omitted for `refused-other` if metadata read itself failed).
   */
  skillName?: string;
  /**
   * Human-readable reason. For `refused-unrecognized-layout` this lists
   * the offending files; for `refused-reserved` it names the slug;
   * for `refused-other` it surfaces the underlying error message.
   * Empty/absent for `imported`.
   */
  reason?: string;
  /**
   * #106 — file counts for collapsed plan output. When the outcome is
   * `refused-unrecognized-layout`, `unrecognizedFileCount` carries the
   * exact number of files that triggered the refusal so the CLI plan
   * formatter can render `(N files — run --verbose ...)` without
   * re-parsing `reason`. For `imported` outcomes, `importedSkillCount`
   * and `importedWorkflowCount` carry the per-skill / per-workflow
   * counts used by the same formatter. All fields are optional;
   * formatters fall back to `0`.
   */
  unrecognizedFileCount?: number;
  /** #106 — files in the refused-unrecognized-layout file list, for verbose render + MIGRATION.md body. */
  unrecognizedFiles?: readonly string[];
  /** #106 — count of derived skills written by this pack (always 1 today; future-proofed for nested). */
  importedSkillCount?: number;
  /** #106 — count of workflow files written under this pack's skill(s). */
  importedWorkflowCount?: number;
}

// soma import pai-docs — see src/pai-docs-importer.ts. Imports a
// subset of a PAI release tree (DOCUMENTATION/, TEMPLATES/, ALGORITHM/)
// into ~/.soma/PAI/, with per-file SHA tracking for idempotent
// re-import.
export interface PaiDocsImportOptions {
  homeDir?: string;
  paiSourceDir?: string;
  somaHome?: string;
}

// Single source of truth for the in-scope subtree list. The runtime
// constant lives in `src/pai-docs-importer.ts`
// (`PAI_DOCS_IMPORT_SUBDIRS`); this type mirrors its members so
// adding/renaming a subtree touches one place.
export type PaiDocsImportSubdir = "DOCUMENTATION" | "TEMPLATES" | "ALGORITHM";

export interface PaiDocsImportFile {
  // Absolute path of the file on disk in the PAI source tree.
  source: string;
  // Absolute path where the file will land under ~/.soma/PAI/.
  target: string;
  // POSIX-style path relative to ~/.soma/PAI/, e.g.
  // "DOCUMENTATION/Skills/SkillSystem.md". This is the manifest key.
  relativePath: string;
  // Which in-scope subdir the file came from.
  subdir: PaiDocsImportSubdir;
  // SHA-256 of the file's bytes, hex-encoded. Optional in dry-run
  // plans so listing the file set does not require reading every
  // file's bytes. Always populated on the apply path, where the SHA
  // is needed for both the manifest and the idempotency check.
  sha256?: string;
}

export interface PaiDocsImportPlan {
  apply: boolean;
  paiSourceDir: string;
  somaHome: string;
  // PAI release version, inferred from a `VERSION` file at the source
  // root or from a `Releases/<version>/` path hint. Null when neither
  // is present — the manifest stays explicit about not guessing.
  releaseVersion: string | null;
  files: PaiDocsImportFile[];
}

export interface PaiDocsImportManifestFile {
  // POSIX-style path under ~/.soma/PAI/ — see
  // PaiDocsImportFile.relativePath.
  target: string;
  // POSIX-style path under the source dir.
  source: string;
  // SHA-256 of the source bytes at import time.
  sha256: string;
}

export interface PaiDocsImportManifest {
  schema: "soma.pai-docs-import.v1";
  paiSourceDir: string;
  releaseVersion: string | null;
  // ISO-8601 timestamp.
  importedAt: string;
  files: PaiDocsImportManifestFile[];
}

export interface PaiDocsImportResult {
  applied: true;
  paiSourceDir: string;
  somaHome: string;
  releaseVersion: string | null;
  importedAt: string;
  // How many files were actually copied this run (0 = nothing to do).
  writtenCount: number;
  // True iff writtenCount === 0 — a re-import with no source drift.
  unchanged: boolean;
  // Absolute paths of every in-scope file (the projection target).
  files: string[];
}

// soma migrate pai memory phase (#90) — translates
// <claudeHome>/PAI/MEMORY/* → <somaHome>/memory/* per DD-2's 1:1
// canonical mapping. Content-preserving; preserves mtimes; per-file
// SHA recorded in <somaHome>/imports/pai-migration/.manifest.json.
export interface PaiMemoryMigrationOptions {
  homeDir?: string;
  claudeHome?: string;
  somaHome?: string;
}

export interface PaiMemoryMigrationFile {
  // Absolute path of the file inside the PAI MEMORY tree.
  source: string;
  // Absolute path the file will land at under <somaHome>/memory/.
  target: string;
  // POSIX-style path relative to <claudeHome>/PAI/MEMORY/ — i.e.
  // "<CATEGORY>/<rest>". Manifest key.
  relativePath: string;
  // Source mtime preserved on the target file. Recorded in the
  // manifest so idempotency checks need only one stat per file.
  mtimeMs: number;
  // SHA-256 of the source bytes, hex-encoded. Always populated on the
  // apply path; optional in dry-run plans so plan-only callers do not
  // pay the read cost for every file.
  sha256?: string;
}

export interface PaiMemoryMigrationPlan {
  apply: boolean;
  claudeHome: string;
  somaHome: string;
  // Absolute path of the source directory under inspection
  // (<claudeHome>/PAI/MEMORY/). Null when the PAI install has no
  // MEMORY tree to migrate (nothing to do).
  memoryDir: string | null;
  files: PaiMemoryMigrationFile[];
}

export interface PaiMemoryMigrationResult {
  claudeHome: string;
  somaHome: string;
  memoryDir: string | null;
  importedAt: string;
  // Files actually copied this run (skipped-by-SHA files do not count).
  writtenCount: number;
  // Files inspected and confirmed already in sync (target SHA matched).
  skippedCount: number;
  unchanged: boolean;
  manifestPath: string;
  // Absolute target paths for every in-scope file (whether written or
  // skipped). Always matches `plan.files.length` on the apply path.
  files: string[];
  // Subset of `files` that were actually copied this run. Sage r2 #95
  // important: callers that want a per-run "files I touched" list
  // (e.g., the orchestrator's `filesWritten` log) must use this
  // instead of `files`, which over-reports on idempotent reruns.
  writtenTargets: string[];
}

export interface PaiMemoryMigrationManifestFile {
  // Manifest key. POSIX-style path relative to <claudeHome>/PAI/MEMORY/.
  relativePath: string;
  // POSIX-style path relative to <somaHome>/memory/ (the target home).
  target: string;
  sha256: string;
  mtimeMs: number;
}

export interface PaiMemoryMigrationManifest {
  schema: "soma.pai-memory-migration.v1";
  claudeHome: string;
  somaHome: string;
  // ISO-8601 timestamp of the last successful migration. Stable across
  // reruns when nothing changed.
  importedAt: string;
  files: PaiMemoryMigrationManifestFile[];
}

// #115 — `soma migrate claude-skills` types.
//
// Second migration path (alongside `soma migrate pai`) that imports
// directly from an installed flat `.claude/skills/` tree — one
// `<Name>/SKILL.md` per skill, no pack-level metadata, no collection
// bundles. Per-skill portability is classified heuristically (regex
// based, Phase 1) and recorded in a sibling report file. Phase 2
// (deferred) adds a `--smoke <substrate>` flag for projection verify.
// #115 Phase 2 — substrate identifier scope for the `--smoke` flag.
// `claude-code` is intentionally excluded — it's the SOURCE substrate
// for `soma migrate claude-skills`, so projecting an imported skill
// back to Claude Code would only ever round-trip; the real verify
// value is on the NON-source substrates (Codex + Pi.dev).
export type ClaudeSkillsSmokeSubstrate = "codex" | "pi-dev" | "grok";

// #115 Phase 2 — per-skill, per-substrate static-shape verification
// verdict. The verifier never EXECUTES the substrate; it only checks
// that the projection bytes survive the substrate's projection
// machinery and pass deterministic structural assertions.
export type ClaudeSkillSubstrateVerifyStatus =
  | "verified"
  | "verified-with-warnings"
  | "failed";

export interface ClaudeSkillSubstrateVerifyResult {
  substrate: ClaudeSkillsSmokeSubstrate;
  status: ClaudeSkillSubstrateVerifyStatus;
  // One-line reason — surfaced in the portability report column.
  // For `verified`: "ok" or a short positive description.
  // For `verified-with-warnings`: the warning summary (first issue).
  // For `failed`: the blocking issue summary (first issue).
  reason: string;
  // Full list of issues surfaced by the static shape checks. Empty
  // when status is `verified`. Test surface and audit trail.
  issues: ClaudeSkillSubstrateVerifyIssue[];
}

export interface ClaudeSkillSubstrateVerifyIssue {
  kind:
    | "projection-throw"
    | "missing-name"
    | "missing-description"
    | "description-mismatch"
    | "dangling-internal-ref"
    | "unresolved-tool-path"
    | "substrate-only-primitive"
    | "empty-projection"
    | "oversized-projection"
    | "frontmatter-unparseable"
    | "long-body";
  // Severity decides whether this issue is a warning or a blocker.
  // `error` → status becomes `failed`. `warning` → status becomes
  // `verified-with-warnings` (unless an `error` is also present).
  severity: "error" | "warning";
  // Human-readable line, single sentence, no trailing newline.
  message: string;
  // Optional path of the projection file that triggered the issue.
  file?: string;
}

export interface ClaudeSkillsMigrationOptions {
  // Source flat skills tree. REQUIRED. Must be a directory of
  // `<Name>/SKILL.md` direct children. Refused loud otherwise.
  from?: string;
  // Override Soma home. Defaults to `<homeDir>/.soma`.
  somaHome?: string;
  // Override `$HOME`. Used by tests; the apply path resolves
  // `somaHome` from this when not explicitly set.
  homeDir?: string;
  // When true, classifier outcomes tagged `claude-specific` are still
  // imported (with an audit warning). Default false → skipped.
  includeClaudeSpecific?: boolean;
  // #115 Phase 2 — substrate(s) to run per-skill static-shape
  // verification against after import. Ordered, de-duplicated. The
  // CLI accepts `--smoke <substrate>` repeated and `--smoke all`
  // (which the parser expands to `["codex", "pi-dev", "grok"]`). Absent /
  // empty → Phase-1 behavior (no verify, no substrate columns in
  // the report).
  smokeSubstrates?: ClaudeSkillsSmokeSubstrate[];
  // #120 — LLM agent used to compress SKILL.md frontmatter
  // descriptions that exceed the 1024-char substrate limit (codex +
  // pi-dev both cap there) or are missing entirely. Default `"none"`
  // → oversize/missing descriptions classify as `refused-description-
  // limit` and the skill is not imported. Set to `"claude" | "codex"
  // | "pi"` to dispatch the rewrite to that agent before write.
  rewriteDescriptionsAgent?: RewriteDescriptionsAgent;
  // #120 — test-only injection point for the LLM dispatcher. When
  // present, replaces the per-agent dispatcher so fixture tests can
  // exercise the rewrite path without invoking a real LLM. Absent in
  // production. The dispatcher receives a structured request and
  // returns the rewritten description text; the migrator handles SHA
  // computation, length validation, and frontmatter splicing.
  rewriteDispatchOverride?: RewriteDispatchOverride;
  // #125 — per-skill progress emitter for plan / apply phases.
  // Optional; absent → no-op emitter (library callers don't get
  // surprise stderr noise). The CLI wires a real stderr-backed
  // emitter that respects `--quiet` and TTY detection. The
  // migrator threads phase boundaries (discovery, read+classify,
  // rewrite, apply write, smoke verify) through the emitter.
  // The `quiet` flag belongs to the CLI surface (not the migrator)
  // — pass a no-op emitter to suppress progress instead.
  progressEmitter?: import("./claude-skills-progress").ProgressEmitter;
}

/**
 * #120 — LLM agent enum for `--rewrite-descriptions`. `none` is the
 * default (no rewrite; oversize/missing descriptions refuse loud).
 * Other values dispatch the rewrite to the corresponding agent:
 *   - `claude` — subscription-billed `claude` subprocess (Sonnet).
 *   - `codex`  — `codex exec` subprocess (cross-vendor GPT path).
 *   - `pi`     — Pi.dev local LLM API (refused loud if unavailable).
 *   - `auto`   — non-interactive batch approval; dispatches via the
 *                default provider (`codex`) without prompting.
 */
export type RewriteDescriptionsAgent = "claude" | "codex" | "pi" | "none" | "auto";

/**
 * #120 — status of a skill's frontmatter description relative to the
 * 1024-char substrate limit.
 *   - `ok`       — description present AND ≤ 1024 chars.
 *   - `oversize` — description present AND > 1024 chars.
 *   - `missing`  — no frontmatter OR no `description:` line.
 *
 * `length` records the original description length (0 when missing).
 * `threshold` is the hard substrate cap; carried in-band so callers
 * don't need to import a separate constant.
 */
export interface DescriptionStatus {
  kind: "ok" | "oversize" | "missing";
  length: number;
  threshold: 1024;
}

/**
 * #120 — test-only override for the LLM dispatcher. Replaces the
 * real subprocess invocation with a pure function the test can
 * inspect / control. Receives the same request shape the real
 * dispatcher would; returns the rewritten text only (SHA / length
 * validation lives in the migrator, not the dispatcher).
 */
export type RewriteDispatchOverride = (request: {
  agent: Exclude<RewriteDescriptionsAgent, "none">;
  sourceName: string;
  status: DescriptionStatus;
  originalDescription: string;
  skillMdBody: string;
  targetMaxLength: number;
}) => Promise<string>;

// Heuristic portability tag assigned to every source skill. Phase 1
// rules:
//   - `portable`        — no `~/.claude/` path refs, no hook bindings,
//                          no `/<slash-command>` refs in prose.
//   - `needs-adapt`     — has `~/.claude/...` refs that the existing
//                          `pai-pack-normalizer.ts` rewrite table can
//                          deterministically resolve.
//   - `claude-specific` — has Claude-Code-only primitives that have
//                          no portable equivalent: hook bindings
//                          (`Stop:`, `UserPromptSubmit:`,
//                          `PreToolUse:`, `PostToolUse:`,
//                          `SessionStart:`, `SubagentStop:`) OR
//                          `/<slash-command>` refs in prose.
export type ClaudeSkillPortabilityTag = "portable" | "needs-adapt" | "claude-specific";

export interface ClaudeSkillOutcome {
  // Source directory name (e.g. "Art", "ExtractWisdom").
  sourceName: string;
  // Kebab-cased target slug (e.g. "art", "extract-wisdom").
  kebabName: string;
  // Per-skill classifier verdict.
  tag: ClaudeSkillPortabilityTag;
  // Human-readable reason for the classifier verdict. One line.
  reason: string;
  // Phase 1 final disposition. `imported` = written to `<somaHome>/skills/<kebab>/`.
  // `skipped-claude-specific` = classifier verdict was `claude-specific`
  // and `includeClaudeSpecific` was false. `skipped-idempotent` =
  // source SHA matched the manifest entry on rerun.
  //
  // #118 — `refused-other` is the per-skill log-and-continue verdict
  // (mirrors `PaiPackOutcomeKind.refused-other`). Genuine errors while
  // reading a source skill (out-of-home symlink target, symlink cycle,
  // broken target, secret refusal, …) classify the surrounding skill
  // as `refused-other` and let the other skills continue. The CLI
  // turns any `refused-other` outcome into a non-zero exit ONLY in
  // apply mode (matches #112's mode-gated exit policy).
  // #120 — `refused-description-limit` is the new outcome for a
  // skill whose frontmatter description exceeds 1024 chars OR whose
  // SKILL.md has no frontmatter, AND `--rewrite-descriptions` was
  // absent or set to `none`. The skill is NOT imported; the CLI
  // footer suggests re-running with `--rewrite-descriptions auto`
  // (or claude / codex / pi) so the LLM dispatcher can compress the text.
  disposition:
    | "imported"
    | "skipped-claude-specific"
    | "skipped-idempotent"
    | "refused-other"
    | "refused-description-limit";
  // SHA-256 of the source SKILL.md bytes (hex). Stable identity for
  // idempotency checks. Populated even on classify-only / plan runs.
  sourceSha: string;
  // Absolute path of the imported skill root under
  // `<somaHome>/skills/<kebab>/`. Null when `disposition` is
  // `skipped-claude-specific`.
  target: string | null;
  // Number of file SHAs recorded under this skill's manifest entry
  // on the apply path (SKILL.md + every Workflows/Tools/References/
  // file copied or rewritten). Zero when the skill was skipped.
  fileCount: number;
  // #115 Phase 2 — per-substrate static-shape verify results. Keyed
  // by substrate id. Populated only when the migrator was invoked
  // with `--smoke <substrate>` AND the skill was actually imported
  // (skipped skills have nothing to verify). Empty/undefined when
  // no smoke run was requested — preserves Phase 1 report shape.
  substrates?: Partial<Record<ClaudeSkillsSmokeSubstrate, ClaudeSkillSubstrateVerifyResult>>;
  /**
   * #118 — per-skill audit trail. Each entry records a non-fatal event
   * the source-side walker decided to handle silently (followed
   * symlink resolutions to date). The audit feeds the portability
   * report so principals can see which symlinks were resolved without
   * grepping for them. Absent when the skill walked clean.
   *
   * Kinds:
   *   - `followed-user-owned-symlink` — a symlink whose realpath
   *     target stayed within `$HOME` was resolved + its bytes
   *     imported. `detail` carries `<rel> → <realpath>`.
   */
  audit?: ClaudeSkillAuditEntry[];
  /**
   * #118 — reason text for the `refused-other` disposition. Includes
   * the `<sourceName>/<rel>` path of the symlink (or other refusal
   * trigger) so principals can locate it without grep. Absent for
   * non-refused dispositions; the higher-level `reason` field carries
   * the classifier verdict for those.
   */
  refusalReason?: string;
  /**
   * #120 — frontmatter description status against the 1024-char
   * substrate cap. Computed unconditionally for every successfully-
   * read skill so the portability report can show the original
   * length even when no rewrite was requested. `kind: "missing"` →
   * no frontmatter OR no `description:` line in frontmatter.
   * Absent only when the skill itself was refused before the
   * description could be inspected (`refused-other`).
   */
  descriptionStatus?: DescriptionStatus;
  /**
   * #120 — when `--rewrite-descriptions <agent>` actually compressed
   * the description for this skill, this slot records the agent,
   * the resulting length, and the rewritten SHA so the portability
   * report and manifest carry the provenance trail (AC-5). Absent
   * when the skill's description was already within the cap or when
   * no rewrite was attempted.
   */
  descriptionRewrite?: ClaudeSkillDescriptionRewrite;
  /**
   * #126 — one-hop cross-skill code/documentation dependencies found
   * while scanning source payloads for `~/.claude/skills/<Other>/...`
   * references. `skill` is the kebab-cased referenced skill name;
   * `references` are the relative paths inside that referenced skill
   * (for example `Tools/ComposeAgent.ts`); `sourceFiles` are the
   * current skill files that mention the dependency.
   */
  dependencies?: ClaudeSkillDependency[];
  /**
   * #126 — referenced skills whose own migration outcome means they
   * will not be available in the projected skill tree. The dependent
   * skill still imports, but reports and CLI output surface this
   * loudly so the principal does not discover it at runtime.
   */
  dependencyMissing?: string[];
}

export interface ClaudeSkillDependency {
  skill: string;
  references: string[];
  sourceFiles: string[];
}

/**
 * #120 — provenance for a single description rewrite. Recorded on
 * both `ClaudeSkillOutcome` (for the portability report row) and
 * `ClaudeSkillsMigrationManifestEntry` (for idempotency on rerun).
 *
 * `originalDescriptionSha` is the SHA-256 of the source description
 * bytes BEFORE rewrite (empty string when status was `missing` and
 * we synthesized from body). `rewrittenDescriptionSha` is the SHA
 * of the post-rewrite text. The manifest stores both so a rerun
 * with an unchanged source description can short-circuit; a rerun
 * with a CHANGED source description re-runs the rewrite.
 */
export interface ClaudeSkillDescriptionRewrite {
  agent: Exclude<RewriteDescriptionsAgent, "none">;
  rewrittenAt: string;
  originalDescriptionSha: string;
  rewrittenDescriptionSha: string;
  originalLength: number;
  rewrittenLength: number;
}

export interface ClaudeSkillAuditEntry {
  kind: "followed-user-owned-symlink";
  /** POSIX-style path relative to the skill root that triggered the event. */
  relPath: string;
  /** Resolved realpath of the symlink target (for principal audit). */
  detail: string;
}

export interface ClaudeSkillsMigrationPlan {
  apply: boolean;
  // Absolute path of the resolved `--from <skills-dir>`.
  from: string;
  // Absolute path of the resolved Soma home.
  somaHome: string;
  // Whether the source directory passed the "flat skills tree" guard
  // (i.e. at least one `<Name>/SKILL.md` direct child). When false,
  // `outcomes` is empty and the formatter renders a hard refusal.
  isFlatSkillsTree: boolean;
  // Present only when `isFlatSkillsTree` is false: the accurate reason
  // (missing dir / empty dir / non-flat layout) so the formatter does
  // not misdiagnose a fresh, empty `~/.claude/skills/` as "not flat".
  flatTreeRefusalReason?: string;
  // One outcome per source `<Name>/SKILL.md`. Always ordered by
  // `sourceName` so the report and CLI rendering are deterministic.
  outcomes: ClaudeSkillOutcome[];
  // Mirror of `options.includeClaudeSpecific` so the formatter and
  // the manifest renderer can both reflect the same intent without
  // re-threading the option through helpers.
  includeClaudeSpecific: boolean;
  // #115 Phase 2 — substrates requested for static-shape verify.
  // Empty when `--smoke` was not passed; the report omits substrate
  // columns in that case so Phase-1 formatter output is byte-stable.
  smokeSubstrates: ClaudeSkillsSmokeSubstrate[];
  // #120 — mirror of `options.rewriteDescriptionsAgent` so the
  // formatter and report can both reflect the intent without
  // re-threading the option through helpers. `none` when the flag
  // was absent.
  rewriteDescriptionsAgent: RewriteDescriptionsAgent;
}

export interface ClaudeSkillsMigrationResult extends ClaudeSkillsMigrationPlan {
  // ISO-8601 timestamp of the last successful apply. Stable across
  // reruns when nothing changed.
  importedAt: string;
  // Absolute path of the SHA manifest file under
  // `<somaHome>/imports/claude-skills/.manifest.json`.
  manifestPath: string;
  // Absolute path of the portability report under
  // `<somaHome>/imports/claude-skills/.portability-report.md`.
  reportPath: string;
  // Skills actually written this run (`disposition: "imported"`,
  // SHA not already present in prior manifest).
  writtenCount: number;
  // Skills skipped due to SHA-match idempotency on rerun.
  skippedIdempotentCount: number;
  // Skills skipped because verdict was `claude-specific` and the
  // override flag was off.
  skippedClaudeSpecificCount: number;
  // #118 — skills that hit a genuine read failure (out-of-home symlink,
  // symlink cycle, broken target, denylisted target, etc.). Other
  // skills continue. The CLI gates exit-code on this count being > 0
  // in apply mode (mirror of #112's plan/apply split).
  refusedOtherCount: number;
  // #120 — skills refused because their frontmatter description
  // exceeded the 1024-char substrate cap (or was missing) AND no
  // `--rewrite-descriptions <agent>` was set. The CLI footer
  // suggests re-running with `--rewrite-descriptions auto`
  // (or claude / codex / pi) so the LLM dispatcher compresses the text.
  refusedDescriptionLimitCount: number;
  // #120 — skills whose description was actually rewritten via the
  // LLM dispatcher this run. Reported separately from `writtenCount`
  // so principals can see the rewrite footprint without grepping
  // the per-skill table.
  descriptionRewrittenCount: number;
  // #115 Phase 2 — per-substrate verify aggregate counts. Keyed by
  // substrate id; entries present only for substrates requested via
  // `--smoke`. Each entry counts `verified` / `verified-with-
  // warnings` / `failed` across imported skills.
  substrateVerifySummary?: Partial<Record<ClaudeSkillsSmokeSubstrate, ClaudeSkillSubstrateVerifySummary>>;
  // #125 — per-phase elapsed-time summary. Populated by the
  // migrator and rendered into the stdout summary's Timing block.
  // `phases` is ordered: discovery + read+classify, description
  // rewrites, apply write, smoke verify. Phases that didn't run
  // (e.g. `--smoke` absent) carry `unit: "(not requested)"`.
  timing?: import("./claude-skills-progress").PhaseTimings;
}

export interface ClaudeSkillSubstrateVerifySummary {
  verified: number;
  verifiedWithWarnings: number;
  failed: number;
}

export interface ClaudeSkillsMigrationManifestEntry {
  // Source directory name (`<Name>` from `<from>/<Name>/SKILL.md`).
  sourceName: string;
  // Kebab-cased target slug.
  kebabName: string;
  tag: ClaudeSkillPortabilityTag;
  // SHA-256 of the source SKILL.md bytes — the idempotency key.
  sourceSha: string;
  // Per-file SHAs of every payload file that landed under
  // `<somaHome>/skills/<kebab>/`. POSIX-style paths relative to
  // the skill root. Includes SKILL.md.
  fileShas: Record<string, string>;
  // #115 Phase 2 — last-seen per-substrate verify verdicts. Mirror
  // of `ClaudeSkillOutcome.substrates`. Idempotency contract: a
  // re-run with the same `sourceSha` AND a substrate already
  // `verified` here skips re-verification. A `failed`/`verified-
  // with-warnings` entry is re-run every invocation so a fix to the
  // adapter can flip the verdict without source churn.
  substrates?: Partial<Record<ClaudeSkillsSmokeSubstrate, ClaudeSkillSubstrateVerifyResult>>;
  // #120 — description-rewrite provenance. Present only for skills
  // whose description was actually rewritten via `--rewrite-
  // descriptions <agent>`. Idempotency: a rerun with matching
  // `originalDescriptionSha` (i.e. source description unchanged
  // since the rewrite) reuses the prior rewritten text instead of
  // calling the LLM again.
  descriptionRewrite?: ClaudeSkillDescriptionRewrite;
}

export interface ClaudeSkillsMigrationManifestOutcome {
  sourceName: string;
  kebabName: string;
  tag: ClaudeSkillPortabilityTag;
  disposition: ClaudeSkillOutcome["disposition"];
  reason: string;
  refusalReason?: string;
  remediation?: string;
  dependencyMissing?: string[];
}

export interface ClaudeSkillsMigrationManifestLastRun {
  totals: {
    imported: number;
    skippedIdempotent: number;
    skippedClaudeSpecific: number;
    refusedOther: number;
    refusedDescriptionLimit: number;
  };
  outcomes: ClaudeSkillsMigrationManifestOutcome[];
}

export interface ClaudeSkillsMigrationManifest {
  schema: "soma.claude-skills-migration.v1";
  from: string;
  somaHome: string;
  importedAt: string;
  // Whether `--include-claude-specific` was passed on the run that
  // wrote this manifest. Recorded so the next apply can detect a
  // policy change (override flipped off) and re-classify accordingly.
  includeClaudeSpecific: boolean;
  // One entry per skill that was actually imported. Skipped skills
  // (claude-specific without override) are NOT recorded — their
  // SHA isn't an idempotency anchor for anything that landed.
  // Sorted by `kebabName` for byte-stable reruns.
  skills: ClaudeSkillsMigrationManifestEntry[];
  // #175 — latest actionable skipped/refused outcomes. `skills`
  // stays the idempotency anchor for landed payloads; this ledger lets
  // `--status` report unresolved migration work without scraping the
  // Markdown portability report.
  lastRun?: ClaudeSkillsMigrationManifestLastRun;
  // #115 Phase 2 — substrate list captured at last write. Absent
  // when no `--smoke` was ever run; present so the next invocation
  // can detect a substrate-set change.
  smokeSubstrates?: ClaudeSkillsSmokeSubstrate[];
}

export type SomaInitStepId =
  | "bootstrap-soma-home"
  | "migrate-claude-skills"
  | "migrate-pai"
  | "install-codex"
  | "install-pi-dev"
  | "install-claude-code"
  | "install-cursor"
  | "install-grok";

export type SomaDoctorFindingId =
  | "starter-profile"
  | "claude-skills-not-migrated"
  | "pai-not-migrated"
  | "codex-projection-stale"
  | "claude-code-projection-stale"
  | "claude-code-projection-unmanaged-edit"
  | "claude-code-hook-missing"
  | "claude-code-settings-missing"
  | "grok-projection-stale"
  | "grok-hook-missing"
  | "grok-hook-files-incomplete"
  | "grok-hook-interpreter-missing"
  | "grok-inspect-unavailable";

export interface SomaOnboardingOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: Extract<SubstrateId, "codex" | "pi-dev" | "claude-code" | "cursor" | "grok">;
}

// Classification of a detected Claude skills source dir (sage review on
// #309): `not-importable` (non-flat layout, file-at-path) and `unreadable`
// (probe could not read the source at all) must never be conflated with
// `empty` in user-facing output.
export type ClaudeSkillsSourceStatus = "importable" | "empty" | "missing" | "not-importable" | "unreadable";

// Discriminated: `command` steps are copy-paste shell commands that map to
// a standalone CLI invocation (migrate-*, install-*); `builtin` steps are
// performed by `soma init` itself and carry a human-readable action.
export type SomaInitStep =
  | { id: SomaInitStepId; kind: "command"; command: string; description: string }
  | { id: SomaInitStepId; kind: "builtin"; action: string; description: string };

export interface SomaInitPlan {
  mode: "dry-run" | "apply";
  homeDir: string;
  somaHome: string;
  substrate: Extract<SubstrateId, "codex" | "pi-dev" | "claude-code" | "cursor" | "grok">;
  detected: {
    paiInstall: string | null;
    paiUserDir: string | null;
    claudeSkillsDir: string | null;
    // Classification of the skills source. A fresh Claude Code install
    // ships an `empty` skills dir — init must not plan a migrate step that
    // would refuse, and must not label a `not-importable` tree as empty.
    claudeSkillsStatus: ClaudeSkillsSourceStatus;
    coreUserDir: string | null;
  };
  soma: {
    exists: boolean;
    starterProfile: boolean;
    skillsPopulated: boolean;
    algorithmSkillPresent: boolean;
  };
  steps: SomaInitStep[];
}

export interface SomaInitApplyStepResult {
  id: SomaInitStepId;
  status: "applied" | "skipped";
  detail: string;
}

export interface SomaInitApplyResult {
  plan: SomaInitPlan;
  steps: SomaInitApplyStepResult[];
}

export interface SomaDoctorFinding {
  id: SomaDoctorFindingId;
  severity: "info" | "warning";
  /** Human-readable explanation of the drift; carries the narrative guidance. */
  message: string;
  /**
   * The remediation step the onboarding/doctor surfaces print verbatim.
   * Command-first: use an executable CLI command (e.g. `soma reproject grok`,
   * `soma install claude-code --apply`) wherever a single command remediates
   * the finding, so an agent or user can run it directly. Only when no single
   * command applies — e.g. `starter-profile` with no PAI source, where the
   * user must hand-author profile files — use a concise imperative
   * instruction instead. Either way the narrative explanation belongs in
   * `message`, not here. (The grok doctor's
   * `grok-inspect-unavailable` action was prose where re-running the check is
   * the right command; it now uses the command and the prose moved to
   * `message`. Documented so future findings keep the command-first
   * convention.)
   */
  action: string;
}

export interface SomaDoctorDiagnosis {
  status: "ok" | "drift";
  homeDir: string;
  somaHome: string;
  findings: SomaDoctorFinding[];
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

export interface SomaTelemetryQueryOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  kind?: string;
  limit?: number;
}

export interface SomaTelemetryQueryResult {
  somaHome: string;
  eventPath: string;
  totalEvents: number;
  skippedMalformedLines: number;
  events: SomaMemoryEvent[];
}

export interface SomaTelemetrySummaryOptions {
  homeDir?: string;
  somaHome?: string;
}

export interface SomaTelemetrySummary {
  somaHome: string;
  eventPath: string;
  totalEvents: number;
  skippedMalformedLines: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  bySubstrate: Partial<Record<SubstrateId, number>>;
  byKind: Record<string, number>;
  sessions: {
    started: number;
    ended: number;
    completedWithDuration: number;
    averageDurationMs: number | null;
    bySubstrate: Partial<Record<SubstrateId, {
      started: number;
      ended: number;
      completedWithDuration: number;
      averageDurationMs: number | null;
    }>>;
  };
  skills: {
    events: number;
    byName: Record<string, number>;
  };
  algorithm: {
    events: number;
    byPhase: Partial<Record<AlgorithmPhase, number>>;
  };
  writeback: {
    events: number;
    failures: number;
  };
}

export const SOMA_RESULT_EVENT_KINDS = [
  "result.captured",
  "learning.signal",
  "learning.pattern",
  "learning.failure",
  "wisdom.frame-update",
  "wisdom.cross-frame",
  "relationship.reflection",
  "opinion.tracked",
] as const;

export type SomaResultEventKind = (typeof SOMA_RESULT_EVENT_KINDS)[number];

export interface SomaResultMemoryEvent extends Omit<SomaMemoryEvent, "kind" | "metadata"> {
  kind: SomaResultEventKind;
  metadata: Record<string, unknown> & {
    source: string;
    promptStored: false;
    resultStored: false;
    skill?: string;
    sessionId?: string;
    resultKind?: "skill-output";
  };
}

export interface SomaResultCaptureOptions {
  homeDir?: string;
  somaHome?: string;
  substrate: SubstrateId;
  source: string;
  summary: string;
  artifactPaths?: string[];
  skill?: string;
  sessionId?: string;
  kind?: SomaResultEventKind;
}

export interface SomaResultCaptureResult {
  somaHome: string;
  event: SomaResultMemoryEvent;
}

export interface SomaResultSearchOptions {
  homeDir?: string;
  somaHome?: string;
  query: string;
  limit?: number;
}

export interface SomaResultSearchMatch {
  eventPath: string;
  line: number;
  eventId: string;
  kind: SomaResultEventKind;
  score: number;
  summary: string;
  artifactPaths: string[];
}

export interface SomaResultSearchResult {
  query: string;
  somaHome: string;
  matches: SomaResultSearchMatch[];
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

export type InboundContentDecision = "ALLOWED" | "BLOCKED" | "HUMAN_REVIEW";

export interface InboundContentFinding {
  kind: string;
  detail: string;
}

export interface InboundContentScanInput {
  content: string;
  sourcePath?: string;
  sourceUri?: string;
}

export interface InboundContentScanResult {
  decision: InboundContentDecision;
  reason: string;
  scanner: string;
  contentHash: string;
  findings: InboundContentFinding[];
}

export interface InboundContentScanner {
  id: string;
  scan(input: InboundContentScanInput): Promise<Omit<InboundContentScanResult, "scanner" | "contentHash">> | Omit<InboundContentScanResult, "scanner" | "contentHash">;
}

export interface InboundContentSecurityConfig {
  untrustedRoots: string[];
  traceRoot: string;
}

export interface InboundContentScanOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  content?: string;
  sourcePath?: string;
  sourceUri?: string;
  scanner?: InboundContentScanner;
  record?: "all" | "deny" | "none";
  timestamp?: string;
}

export interface InboundContentScanAudit {
  event?: SomaMemoryEvent;
  tracePath?: string;
}

export interface InboundContentScanOutput extends InboundContentScanResult {
  somaHome: string;
  sourcePath?: string;
  sourceUri?: string;
  audit?: InboundContentScanAudit;
}

export interface InboundContentPromotionResult {
  somaHome: string;
  sourcePath: string;
  contentRef: {
    hash: string;
    algorithm: "sha256";
  };
  scan: InboundContentScanOutput;
}

export type RuntimePolicySurface = "prompt" | "tool_call" | "permission_request" | "config_change" | "governance_event";

export type RuntimePolicyDecision = "allow" | "deny" | "ask" | "alert";

export type RuntimePolicyFindingSeverity = "low" | "medium" | "high" | "critical";

export interface RuntimePolicyFinding {
  kind: string;
  severity: RuntimePolicyFindingSeverity;
  detail: string;
  inspector: string;
  decision?: Exclude<RuntimePolicyDecision, "allow">;
}

export interface RuntimePolicyToolCall {
  toolName: string;
  input?: Record<string, unknown>;
}

export interface RuntimePolicyCommandPatternRule {
  kind: string;
  pattern: string;
  detail: string;
  decision: Exclude<RuntimePolicyDecision, "allow">;
  severity?: RuntimePolicyFindingSeverity;
}

export interface RuntimePolicyCommandInspectionConfig {
  outboundTools?: readonly string[];
  privatePathPatterns?: readonly string[];
  credentialPathPatterns?: readonly string[];
  patternRules?: readonly RuntimePolicyCommandPatternRule[];
  inlineInterpreterDecision?: Exclude<RuntimePolicyDecision, "allow">;
}

export type RuntimePolicyPermissionAction = "read" | "write" | "delete" | "execute" | "network" | "unknown";

export interface RuntimePolicyTrustedRoot {
  path: string;
  actions: readonly RuntimePolicyPermissionAction[];
  description?: string;
}

export interface RuntimePolicyApprovalCacheEntry {
  cacheKey: string;
  action: RuntimePolicyPermissionAction;
  targetPath?: string;
  expiresAt?: string;
}

export interface RuntimePolicyPermissionConfig {
  trustedRoots?: readonly RuntimePolicyTrustedRoot[];
  approvalCache?: readonly RuntimePolicyApprovalCacheEntry[];
}

export interface RuntimePolicyModelRule {
  id: string;
  description: string;
  surfaces?: readonly RuntimePolicySurface[];
  decision?: Exclude<RuntimePolicyDecision, "allow" | "deny">;
  severity?: RuntimePolicyFindingSeverity;
}

export interface RuntimePolicyModelInspectorConfig {
  enabled?: boolean;
  rules?: readonly RuntimePolicyModelRule[];
  level?: InferenceLevel;
  timeoutMs?: number;
}

export interface RuntimePolicyConfig {
  command?: RuntimePolicyCommandInspectionConfig;
  permission?: RuntimePolicyPermissionConfig;
  model?: RuntimePolicyModelInspectorConfig;
  privateRoots?: readonly string[];
}

export type RuntimePolicyConfigChangeErrorKind = "unreadable" | "malformed";

export interface RuntimePolicyConfigChangeError {
  kind: RuntimePolicyConfigChangeErrorKind;
  detail?: string;
}

export interface RuntimePolicyConfigChange {
  configSurface: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  error?: RuntimePolicyConfigChangeError;
  securityRelevantKeys?: readonly string[];
}

export interface RuntimePolicyPermissionRequest {
  requestId: string;
  action: RuntimePolicyPermissionAction;
  targetPath?: string;
  toolName?: string;
  cacheKey?: string;
  substrateSupportsAsk?: boolean;
}

export interface RuntimePolicyInspectOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  surface: RuntimePolicySurface;
  prompt?: string;
  toolCall?: RuntimePolicyToolCall;
  configChange?: RuntimePolicyConfigChange;
  permissionRequest?: RuntimePolicyPermissionRequest;
  runtimePolicy?: RuntimePolicyConfig;
  modelInspectorBackend?: InferenceBackend;
  record?: "all" | "deny" | "none";
  timestamp?: string;
}

export interface RuntimePolicyInspectAudit {
  event?: SomaMemoryEvent;
  tracePath?: string;
}

export interface RuntimePolicyInspectResult {
  somaHome: string;
  surface: RuntimePolicySurface;
  decision: RuntimePolicyDecision;
  reason: string;
  findings: RuntimePolicyFinding[];
  audit?: RuntimePolicyInspectAudit;
}

export interface SomaProtectedPath {
  path: string;
  description: string;
  guardDelete?: boolean;
  guardModify?: boolean;
  /**
   * Subpaths (relative to `path`) where `modify` is permitted even though the
   * surrounding root is otherwise modify-guarded. Has no effect on `delete`;
   * destructive operations against any descendant of `path` remain blocked.
   *
   * Used to declare known memory/VSA destinations under a private root so that
   * legitimate Soma writes (e.g. `~/.soma/vsa/*.md`, `~/.soma/memory/...`)
   * pass while overwrites of the private root itself (`~/.soma/profile/...`)
   * stay denied.
   */
  allowedSubpaths?: string[];
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
  action?: SomaPolicyAction;
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

// soma#329 slice 3: VSA writeback now emits `vsa_updated`. `isa_updated` is kept
// as a legacy member so historical events.jsonl records still typecheck on read.
export type SomaLifecycleEventName = "session_start" | "algorithm_updated" | "algorithm_observed" | "session_end" | "vsa_updated" | "isa_updated";

/**
 * Payload for `runSomaLifecycleVsaUpdated` (#38). Each entry's `text` is
 * persisted to the active VSA's matching section via the library's
 * `record*` helpers. `phase` defaults to the VSA's current phase;
 * `timestamp` defaults to the hook invocation timestamp.
 */
export interface VsaUpdatePayload {
  slug?: string;
  decisions?: { text: string; phase?: AlgorithmPhase; timestamp?: string }[];
  changelogEntries?: { text: string; phase?: AlgorithmPhase; timestamp?: string }[];
  verificationEntries?: { text: string; phase?: AlgorithmPhase; timestamp?: string }[];
}

export interface SomaLifecycleOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  sessionId?: string;
  timestamp?: string;
  /** Working directory of the substrate session (from the hook payload). */
  cwd?: string;
  /** Git branch of `cwd`, when known. Detected from `cwd` when omitted. */
  gitBranch?: string;
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
  activeVsa?: { slug: string; phase: AlgorithmPhase } | null;
  writes?: string[];
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
  project(input: ProjectionInput): Promise<Projection>;
  run(task: SomaTask): Promise<SomaRunResult>;
}

// ── Memory subsystem (Track B, M0) ──────────────────────────────────────────
// File-native memory note schema. Contract fixed in the memory-subsystem plan
// v2 §2 (do not redesign). One note = one markdown file: strict frontmatter +
// markdown body. Parser/serializer live in src/memory-note.ts and obey the
// round-trip law parse(serialize(n)) == n for any note serialize accepts whose
// body is already trimmed (serialize trims the body — the one lossy
// normalization; see serializeMemoryNote for the exact contract).
// Single source of truth for the note enums: the validator arrays in
// memory-note.ts import these, and the union types derive from them, so the
// literals live in exactly one place.
export const SOMA_MEMORY_NOTE_TYPES = ["semantic", "episodic", "procedural"] as const;
export type SomaMemoryNoteType = (typeof SOMA_MEMORY_NOTE_TYPES)[number];
// Trust tier = who vouched for a memory. "assistant" (not "agent") per
// CONTEXT.md, which reserves `agent` for substrate concepts and forbids it as a
// Soma core noun; the plan's `agent` tier is renamed here at first codification.
export const SOMA_MEMORY_TRUSTS = ["principal", "assistant", "quarantined"] as const;
export type SomaMemoryTrust = (typeof SOMA_MEMORY_TRUSTS)[number];

export interface SomaMemoryNote {
  id: string;                 // kebab slug; storage layer (M1) binds it to the filename stem
  type: SomaMemoryNoteType;
  created: string;            // YYYY-MM-DD
  last_verified: string;      // YYYY-MM-DD
  valid_until: string | null; // YYYY-MM-DD when superseded/expired, else null
  provenance: string;         // "conversation" | "consolidation" | "import" | "tool:<name>"
  trust: SomaMemoryTrust;     // who vouched: principal | assistant | quarantined.
                              // "assistant" not "agent" — CONTEXT.md reserves `agent` for substrate concepts.
  source_of_truth: string | null; // path/URL to verify against, or null
  project: string | null;     // scope key, e.g. "soma", or null
  links: string[];            // ids of related notes (may be empty)
  resurface_count: number;    // integer >= 0
  hook?: string;              // optional: recall-trigger phrase
  review?: string;            // optional: review directive
  body: string;               // markdown after the closing ---
}

// Memory subsystem M1 (write + verify). Plan v2 §M1 (do not redesign the
// governance model): trust is NOT selectable via a `--trust` flag — it is DERIVED
// from the write trigger, and elevating above `quarantined` needs a deliberate
// authority signal. Honest scope: the ENFORCED boundary is the CLI surface (no
// public self-assert path), not the SDK — an in-process caller can still set the
// `principalAuthority`/`consolidationAuthority` booleans, as soma has no
// cryptographic capability primitive (CONTEXT.md reserves bare `agent`; use
// `assistant`/substrate). THREE of
// design §7's five triggers reach the `write` path (principal-correction, import,
// consolidation); the other two — session-end and consequential-action — are
// M5's episodic `digest`/`action`, NOT `write`. M1 owns the durable, dedup-gated
// types (semantic + procedural).

/**
 * The governed write trigger (design §7). Trust is a pure function of this value
 * (see {@link SOMA_MEMORY_TRIGGER_TRUST}); there is no `--trust` flag. Only these
 * three reach the `write` path in M1:
 * - `principal-correction` — the principal said "remember"/"no, always X". The
 *   ONLY path to `principal` trust, and the documented principal-authority gate.
 * - `import` — migration / external doc. Untrusted source → `quarantined` (MINJA
 *   defense: tool/web content never lands trusted).
 * - `consolidation` — the M6 consolidator promoting/merging → `assistant`.
 * (`session-end` and `consequential-action` are the other two design-§7 triggers;
 * they belong to M5's episodic path, not `write`.)
 */
export const SOMA_MEMORY_WRITE_TRIGGERS = ["principal-correction", "import", "consolidation"] as const;
export type SomaMemoryWriteTrigger = (typeof SOMA_MEMORY_WRITE_TRIGGERS)[number];

/** Trust derived from trigger — the whole M1 governance model in one table. */
export const SOMA_MEMORY_TRIGGER_TRUST: Record<SomaMemoryWriteTrigger, SomaMemoryTrust> = {
  "principal-correction": "principal",
  import: "quarantined",
  consolidation: "assistant",
};

/** Create (dedup-gated), merge (delta-edit target), or supersede (close old + create new). */
export type SomaMemoryWriteMode = "create" | "merge" | "supersede";

/** A near-duplicate surfaced by the recall-first refusal gate (Jaccard ≥ 0.6 or exact-body hash). */
export interface SomaMemoryDuplicateCandidate {
  id: string;
  type: SomaMemoryNoteType;
  path: string;
  /** 1.0 for an exact normalized-body hash match, else the Jaccard token-set score. */
  score: number;
  exact: boolean;
}

export interface SomaMemoryWriteOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  /** Injected clock for deterministic `created`/`last_verified`. Defaults to now. */
  now?: Date;

  mode: SomaMemoryWriteMode;
  trigger: SomaMemoryWriteTrigger;
  /**
   * The deliberate-escalation gate for `principal` trust. `principal-correction`
   * mints a `principal` note only when this is set — otherwise it is REFUSED, so
   * an automated/agent invocation can never mint principal trust incidentally
   * from the trigger alone. This is a sudo-style deliberate + logged escalation,
   * NOT cryptographic principal authentication (soma has no such primitive — a
   * recorded limitation). The CLI sets it from an explicit `--principal-authority`
   * flag; it is intentionally NOT an env var (ambient authority is the footgun
   * this gate exists to close). Ignored for import/consolidation triggers.
   */
  principalAuthority?: boolean;
  /**
   * The consolidation counterpart of {@link principalAuthority}: `consolidation`
   * mints `assistant` trust, so it too requires an explicit signal. Like
   * `principalAuthority`, this is a sudo-style deliberate flag, NOT a
   * cryptographically enforced capability — at the SDK layer an in-process caller
   * (intended: the M6 consolidator) sets it, exactly as they would set
   * `principalAuthority`; soma has no capability primitive to make it
   * unforgeable. What IS enforced is the surface: it is intentionally NOT exposed
   * as a public CLI flag and `--trigger consolidation` is refused on the CLI, so
   * the public command-line cannot mint assistant trust. Ignored for
   * principal/import triggers.
   */
  consolidationAuthority?: boolean;

  /** create/supersede: the new note's id. merge: unused (target is `--merge <id>`). */
  id?: string;
  type?: SomaMemoryNoteType;
  body: string;
  project?: string | null;
  sourceOfTruth?: string | null;
  links?: string[];
  hook?: string;
  review?: string;
  /**
   * Only meaningful for `import` (`import` or `tool:<name>`); forced to
   * `conversation` for principal-correction and `consolidation` otherwise.
   */
  provenance?: string;

  /** merge: id of the note to delta-edit. supersede: id of the note to close. */
  targetId?: string;
  /** create only: bypass the recall-first refusal gate. */
  force?: boolean;
}

export interface SomaMemoryWriteResult {
  somaHome: string;
  mode: SomaMemoryWriteMode;
  path: string;
  note: SomaMemoryNote;
  /** supersede only: the id of the note that was closed (valid_until set). Undefined for create/merge. */
  supersededId?: string;
  event: SomaMemoryEvent;
}

export interface SomaMemoryVerifyOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  now?: Date;
  id: string;
  /**
   * Verifying mutates a note's decay signals (`last_verified`, `resurface_count`),
   * so verifying a non-quarantined note needs that tier's authority — otherwise a
   * tool caller could keep a trusted note artificially fresh in the index.
   * `principal` notes need this; ignored for quarantined notes.
   */
  principalAuthority?: boolean;
  /** As above, for `assistant`-trust notes. Ignored for principal/quarantined notes. */
  consolidationAuthority?: boolean;
}

export interface SomaMemoryVerifyResult {
  somaHome: string;
  path: string;
  note: SomaMemoryNote;
  event: SomaMemoryEvent;
}

// Memory subsystem M5 (episodic capture). Plan v2 §M5: session digests + a
// first-class action log, stored as `episodic` notes under
// `memory/episodic/{sessions,actions}/YYYY-MM/YYYYMMDD-<slug>.md`. Deterministic,
// no LLM. The digest write is gated to one-per-session — atomic (O_EXCL) within a
// UTC date, and a cross-date scan catches later re-digests — but it is best-effort,
// NOT an absolute guarantee: with no cross-process lock, a genuine concurrent race
// across different UTC dates can still produce two digests (reconciled by the M7
// audit). A second same-session call no-ops with an event. Action entries record plannedAction →
// approval → outcome for the consolidator (M6) to mine. Episodic notes are written
// at `assistant` trust (the assistant's own account); whether they reach the
// always-loaded INDEX is decided by M3's admission ladder, where an unresurfaced
// assistant note is not admitted until consolidation promotes it.

/** Approval state of a logged action (plannedAction → approval → outcome). */
export const SOMA_MEMORY_ACTION_APPROVALS = ["proposed", "approved", "rejected", "auto"] as const;
export type SomaMemoryActionApproval = (typeof SOMA_MEMORY_ACTION_APPROVALS)[number];

export interface SomaMemoryDigestOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  /** Injected clock for deterministic `created`/id date. Defaults to now. */
  now?: Date;
  /** The session this digest summarizes — the one-per-session gate key. */
  sessionId: string;
  /** The digest text: 8–15 non-empty lines of what happened / changed / open loops. */
  body: string;
}

export interface SomaMemoryDigestResult {
  somaHome: string;
  path: string;
  /** False when a digest already existed for the session (the write no-op'd). */
  created: boolean;
  note: SomaMemoryNote;
  event: SomaMemoryEvent;
}

export interface SomaMemoryActionOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  now?: Date;
  /** kebab slug for the action's id (`YYYYMMDD-<slug>`). */
  slug: string;
  /** The session this action belongs to (recorded in the note body for consolidation scope). */
  sessionId?: string;
  /**
   * What the assistant planned to do. Named `plannedAction` (not `intent`) because
   * CONTEXT.md reserves `intent` for the principal's checkable directional anchor
   * sourced from Purpose — a different concept from the assistant's logged action.
   */
  plannedAction: string;
  /** Approval state at record time. */
  approval: SomaMemoryActionApproval;
  /** What actually happened (may be recorded later; empty = not-yet-known). */
  outcome?: string;
}

export interface SomaMemoryActionResult {
  somaHome: string;
  path: string;
  note: SomaMemoryNote;
  event: SomaMemoryEvent;
}

// Memory subsystem M6 (deterministic consolidation). The full contract — ops,
// ordering, dry-run parity semantics, archive layout, idempotency — lives with the
// implementation in `src/memory-consolidate.ts` (single source of truth). In brief:
// a no-LLM maintenance pass; `--dry-run` reports the same file OPERATIONS the real
// run applies (operation-level parity, not a byte-level diff).
export interface SomaMemoryConsolidateOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  /** Injected clock for deterministic age math. Defaults to now. */
  now?: Date;
  /** Plan only — print the ops without touching the filesystem. */
  dryRun?: boolean;
  /**
   * Explicit override for the destructive state GC. Deleting `current-work-*.json`
   * is a destructive mutation of protected state, so per CONTEXT.md it needs a
   * deliberate flag — without this, the pass plans/deletes no state files.
   */
  gcState?: boolean;
}

/** One planned file move (episodic prune → archive), preserving relative path. */
export interface SomaMemoryArchivePlan {
  from: string;
  to: string;
  reason: string;
}

/**
 * A pair of notes with high LEXICAL similarity (Jaccard token overlap), surfaced
 * for principal review — a CANDIDATE duplicate/contradiction, not a proven semantic
 * one. `score` is the token-overlap ratio; consolidation never auto-merges.
 */
export interface SomaMemorySimilarPair {
  a: string;
  b: string;
  score: number;
}

export interface SomaMemoryConsolidateResult {
  somaHome: string;
  dryRun: boolean;
  // NOTE: on a dry-run these are the PLANNED operations (nothing was applied); on a
  // real run they are what was applied. Each field's verb is mode-neutral for that
  // reason.
  /** Aged episodic notes to move under `memory/archive/` (planned on dry-run, moved on a real run). */
  archived: SomaMemoryArchivePlan[];
  /** Monthly digest files whose archived-notes months are affected (regenerated on a real run). */
  digestsWritten: string[];
  /** Semantic notes to mark `review: stale` (planned on dry-run, marked on a real run). */
  markedStale: string[];
  /** `current-work-*.json` files older than 7d to GC — only under `--gc-state`; this pass's only deletion. */
  stateGced: string[];
  /** High-lexical-similarity note pairs listed for review (candidate duplicates/contradictions). */
  similarPairs: SomaMemorySimilarPair[];
  /**
   * Note files surfaced for the audit and NOT acted on — either an I/O/parse failure
   * (couldn't be read/parsed) OR a safety refusal (unsafe id, malformed calendar date,
   * or a mis-placed episodic note whose directory month ≠ its created month). Never
   * silently skipped; the two classes are not distinguished in this field.
   */
  unreadable: string[];
  /**
   * True iff the pass has (or, on dry-run, would have) any file mutation — i.e. any
   * of archived / markedStale / stateGced is non-empty. The single source of truth
   * for whether the INDEX is rebuilt and a `memory.consolidate` event is emitted;
   * the similar-pairs report is read-only and does NOT set this.
   */
  mutated: boolean;
  /**
   * The INDEX.md path. Always reported, but the index is REBUILT only when the pass
   * mutated something (any of archived / markedStale / stateGced non-empty) — a
   * no-op run leaves it untouched. This is the path, not proof a rebuild happened.
   */
  indexPath: string;
}

// Memory subsystem M7 (audit). Plan v2 §M7: a DETERMINISTIC health check over the
// on-disk memory tree — no LLM, no sentiment, only filesystem ground-truth probes.
// Read-only: it mutates nothing and appends no event. The CLI exits NON-ZERO when
// `healthy` is false — any health-gating probe failing: an abnormal note root
// (root-integrity), a schema-invalid note, or a stale INDEX — so it can gate CI /
// a pre-consolidation check.
export interface SomaMemoryAuditOptions {
  homeDir?: string;
  somaHome?: string;
}

/** The fixed set of audit probes (stable public names; `auditMemory` is exported). */
export type SomaMemoryAuditProbeName =
  | "root-integrity"
  | "schema"
  | "index-freshness"
  | "digest-coverage"
  | "orphaned-archive"
  | "event-ratio";

/**
 * One deterministic probe's outcome. `gatesHealth` is machine-readable: when it is
 * true, `ok: false` forces `result.healthy` false. Three probes gate:
 * `root-integrity`, `schema`, and `index-freshness`. Informational probes
 * (`digest-coverage`, `orphaned-archive`, `event-ratio`) have `gatesHealth: false`
 * and always report `ok: true`.
 */
export interface SomaMemoryAuditProbe {
  name: SomaMemoryAuditProbeName;
  ok: boolean;
  gatesHealth: boolean;
  detail: string;
}

export interface SomaMemoryAuditResult {
  somaHome: string;
  /** false ⇒ the CLI exits non-zero. Gated by: no schema-invalid notes AND a fresh INDEX. */
  healthy: boolean;
  /** Valid-note counts by type across the whole tree (durable + episodic + archive). */
  notesByType: { semantic: number; procedural: number; episodic: number };
  /** Note files that exist but fail to parse (schema-invalid) — a health failure. */
  invalidNotes: string[];
  /** INDEX freshness: stale when a durable note is newer than INDEX.md, or INDEX is absent while durable notes exist. */
  index: { path: string; stale: boolean; reason: string };
  /** Episodic coverage counts — session/action notes vs monthly digest files present. */
  digests: { sessionNotes: number; actionNotes: number; digestFiles: number };
  /** Archived episodic notes whose id is absent from their month's digest (informational drift signal). */
  orphanedArchive: string[];
  /** Event-stream vs corpus size — a coarse write-amplification signal (informational). */
  events: { lines: number; notes: number };
  /**
   * Every probe run, in report order. THREE gate `healthy` (`root-integrity`,
   * `schema`, `index-freshness`); the other three (`digest-coverage`,
   * `orphaned-archive`, `event-ratio`) are informational drift signals whose `ok` is
   * always true. Read `probe.gatesHealth` rather than hardcoding this list.
   */
  probes: SomaMemoryAuditProbe[];
}

// Memory subsystem M2 (recall). Plan v2 §M2: note-aware retrieval over the
// durable corpus (semantic + procedural) — term scoring, whole-file retrieval
// (limit 3), 1-hop link expansion, superseded-exclusion via `valid_until`, and a
// read-time verification banner whose age derives from an injected `now`. Recall
// is read-only: it appends no event and mutates nothing (verifying is a separate,
// authority-gated act). Distinct from the legacy line-grep `searchSomaMemory`,
// which walks the pre-note memory tree (WORK/KNOWLEDGE/…).
export interface SomaMemoryRecallOptions {
  homeDir?: string;
  somaHome?: string;
  query: string;
  /** Cap on primary (term-matched) notes returned; 1-hop link pulls are additional. Default 3. */
  limit?: number;
  /** Injected clock for deterministic banner ages. Defaults to now. */
  now?: Date;
}

/** One retrieved note with its verification banner (M2). */
export interface SomaMemoryRecalledNote {
  id: string;
  type: SomaMemoryNoteType;
  path: string;
  /** Distinct query terms matched in the note; 0 for a note pulled only via a 1-hop link. */
  score: number;
  /** `match` = surfaced by term score; `link` = pulled in as 1-hop context from a match. */
  via: "match" | "link";
  /** For `via: "link"`, the id of the matched note that linked here; null for matches. */
  linkedFrom: string | null;
  /** Whole days since `last_verified`, clamped at 0 for a future date (derived from injected `now`). */
  ageDays: number;
  /** True iff `trust === "quarantined"` — the note carries an untrusted-content warning. */
  quarantined: boolean;
  /** The one-line verification banner (age · trust · provenance · verify-against). */
  banner: string;
  /** Whole-file: the complete parsed note (body included). */
  note: SomaMemoryNote;
}

export interface SomaMemoryRecallResult {
  query: string;
  somaHome: string;
  /** The 3+char query terms actually scored (deduped, lowercased). */
  terms: string[];
  /** Primary matches first (score desc), then their 1-hop link pulls. */
  matches: SomaMemoryRecalledNote[];
  /** 1-hop link ids that resolved to no active note (missing or superseded) — surfaced, not hidden. */
  unresolvedLinks: string[];
  /** Corpus files that exist but could not be read/parsed — recall's blind spot, never silent. */
  unreadable: string[];
}

// Memory subsystem M3 (index renderer). The result of rebuilding the tiny,
// always-loaded INDEX (`memory/INDEX.md`, ≤200 pointer lines / ≤25KB): its path,
// rendered content, admit/render/shed/excluded counts, and the unreadable blind
// spot. Admission, scoring, and budget POLICY live with the renderer in
// `src/memory-index.ts` (the single source of truth). M4 projects the file through
// substrate adapters into each substrate's native always-loaded surface.
export interface SomaMemoryIndexResult {
  somaHome: string;
  /** On-disk path of the rendered index (`memory/INDEX.md`). */
  path: string;
  /** The rendered INDEX.md content (also what M4 projects verbatim). */
  content: string;
  /** Notes that earned admission (before the budget was applied). */
  admitted: number;
  /** Index lines actually rendered after the budget. */
  rendered: number;
  /** admitted − rendered: lines shed to stay within the line/byte budget. */
  shed: number;
  /** Notes present but NOT admitted (quarantined, superseded, or not yet earned). */
  excluded: number;
  /** Corpus files that exist but could not be read/parsed — surfaced, never silent. */
  unreadable: string[];
}
