import type { AlgorithmRunSummary } from "./algorithm/types";
import type { ProposalKind } from "./core/index";
export type { AlgorithmEffortSource, AlgorithmLoopStatus, AlgorithmLoopIteration, AlgorithmLoopState, AlgorithmCriteriaPartition, IdeateParameters, IdeatePresetName, OptimizeParameters, OptimizePresetName, AlgorithmNotificationEvent, AlgorithmNotificationSink, AlgorithmLoopExecutionContext, AlgorithmLoopIterationResult, AlgorithmLoopExecutor, AlgorithmPromptClassification, AlgorithmPlanStep, AlgorithmReferenceVerdict, AlgorithmReference, AlgorithmObservation, AlgorithmGatesFired, AlgorithmMetaReflection, AlgorithmProvenanceOperation, AlgorithmProvenanceEntry, AlgorithmCapabilityKind, AlgorithmCapabilityContract, AlgorithmCapabilityInvocationContract, AlgorithmCapabilitySelectionStatus, AlgorithmCapabilityDefinition, SomaSkillAlgorithmCapabilityManifest, AlgorithmCapabilityInvocation, AlgorithmCapabilitySelection, AlgorithmRun, AlgorithmRunSummary, AlgorithmRunInput, AlgorithmBatchOperation, SomaSkillManifest } from "./algorithm/types";
export { ALGORITHM_REFERENCE_VERDICTS, ALGORITHM_CAPABILITY_KINDS } from "./algorithm/types";
import type { Purpose, ProjectionInput } from "./home/types";
/** @deprecated Import from home/types; compatibility lasts until the final seams node. */ export type { AssistantIdentity, PrincipalIdentity, Purpose, SomaMemoryLayout, SomaProfile, ProjectionInput, SomaSnapshotEntry, SomaSnapshotListOptions, SomaSnapshotOptions, SomaSnapshotResult, SomaSnapshotRollbackOptions, SomaSnapshotRollbackResult } from "./home/types";
import type { InstallSubstrate } from "./policy/types";
export type { SomaPolicyAction, SomaPolicyDecision, InboundContentDecision, InboundContentFinding, InboundContentScanInput, InboundContentScanResult, InboundContentScanner, InboundContentSecurityConfig, InboundContentScanOptions, InboundContentScanAudit, InboundContentScanOutput, InboundContentPromotionResult, RuntimePolicySurface, RuntimePolicyDecision, RuntimePolicyFindingSeverity, RuntimePolicyFinding, RuntimePolicyToolCall, RuntimePolicyCommandPatternRule, RuntimePolicyCommandInspectionConfig, RuntimePolicyPermissionAction, RuntimePolicyTrustedRoot, RuntimePolicyApprovalCacheEntry, RuntimePolicyPermissionConfig, RuntimePolicyModelRule, RuntimePolicyModelInspectorConfig, RuntimePolicyConfig, RuntimePolicyConfigChangeErrorKind, RuntimePolicyConfigChangeError, RuntimePolicyConfigChange, RuntimePolicyPermissionRequest, RuntimePolicyInspectOptions, RuntimePolicyInspectAudit, RuntimePolicyInspectResult, SomaProtectedPath, SomaPolicyCheckOptions, SomaPolicyBatchTarget, SomaPolicyBatchCheckOptions, SomaPolicyFindingKind, SomaPolicyFinding, SomaPolicyCheckResult, SomaPolicyBatchCheckResult, InstallSubstrate, PrivateRootOptions } from "./policy/types";
import type { Checkpoint } from "./vsa/types";
export type { AlgorithmLogEntry, AuthoredFrontmatter, Checkpoint, CriterionStatus, DerivedFrontmatter, SomaActiveVsaState, VerificationStateArtifact, VsaFrontmatter, VsaSection } from "./vsa/types";
export type { SomaMemoryActionApproval, SomaMemoryActionOptions, SomaMemoryActionResult, SomaMemoryArchivePlan, SomaMemoryAuditOptions, SomaMemoryAuditProbe, SomaMemoryAuditProbeName, SomaMemoryAuditResult, SomaMemoryAutoMergePlan, SomaMemoryBackfillEntry, SomaMemoryBackfillEntryStatus, SomaMemoryBackfillManifest, SomaMemoryBackfillManifestEntry, SomaMemoryBackfillOptions, SomaMemoryBackfillResult, SomaMemoryConsolidateOptions, SomaMemoryConsolidateResult, SomaMemoryDigestOptions, SomaMemoryDigestResult, SomaMemoryDuplicateCandidate, SomaMemoryIndexResult, SomaMemoryNote, SomaMemoryNoteType, SomaMemoryRecallOptions, SomaMemoryRecallResult, SomaMemoryRecalledNote, SomaMemoryResurfaceOptions, SomaMemoryResurfaceResult, SomaMemoryRetrievalQuality, SomaMemorySearchMatch, SomaMemorySearchOptions, SomaMemorySearchResult, SomaMemorySearchSourceClass, SomaMemorySimilarPair, SomaMemoryTrust, SomaMemoryVerifyOptions, SomaMemoryVerifyResult, SomaMemoryWriteMode, SomaMemoryWriteOptions, SomaMemoryWriteResult, SomaMemoryWriteTrigger, WritableNoteType } from "./memory/types";
export { SOMA_MEMORY_ACTION_APPROVALS, SOMA_MEMORY_BACKFILL_TYPE_MAP, SOMA_MEMORY_NOTE_TYPES, SOMA_MEMORY_TRIGGER_TRUST, SOMA_MEMORY_TRUSTS, SOMA_MEMORY_WRITE_TRIGGERS } from "./memory/types";
import type { SomaMemoryEvent, SomaFeedbackClassification, SomaFeedbackActor } from "./events/index";
export type { SomaMemoryEventInput, SomaMemoryEvent, SomaTelemetryQueryOptions, SomaTelemetryQueryResult, SomaTelemetrySummaryOptions, SomaTelemetrySummary, SomaFeedbackKind, SomaFeedbackClassification, SomaFeedbackActor } from "./events/index";
import type { SomaMemoryPromotionStore } from "./core/index";
export type { SomaPaths, SomaMemoryPromotionStore } from "./core/index";
export { SOMA_MEMORY_PROMOTION_STORE_DIRS, SOMA_MEMORY_PROMOTION_STORES } from "./core/index";
/** Every substrate id Soma knows. `SubstrateId` and `KNOWN_SUBSTRATES` derive from this list. */
export const SUBSTRATE_IDS = ["codex", "pi-dev", "claude-code", "cursor", "grok", "dsh", "cortex", "custom", "anthropic-cowork"] as const;
export type SubstrateId = (typeof SUBSTRATE_IDS)[number];

export type ExperimentalScaffoldSubstrate = "anthropic-cowork";
export type ProjectionSubstrate = SubstrateId | ExperimentalScaffoldSubstrate;

/**
 * The substrates with a shipped adapter. Install, reproject, `soma doctor` and
 * content-compare all cover exactly these; add a substrate here, not per command.
 */
export const SHIPPED_SUBSTRATES = ["codex", "pi-dev", "claude-code", "cursor", "grok", "dsh"] as const satisfies readonly SubstrateId[];
export type ShippedSubstrate = (typeof SHIPPED_SUBSTRATES)[number];

export const GOAL_STATUSES = ["draft", "active", "paused", "achieved", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * One goal (soma#784 D2–D8). The frontmatter fields are typed; `wording` is the
 * body's first line and `body` the whole private body (drop condition, notes).
 * Goal text stays in soma-home: only the id travels in envelopes and ledgers.
 */
export interface GoalRecord {
  /** `G<n>`, opaque and never reused. */
  id: string;
  status: GoalStatus;
  /** Mission codes (`M<n>`) this goal serves. */
  supports: string[];
  /** A reflex activation id that measures the goal. */
  sensor?: string;
  /** ISO date (`YYYY-MM-DD`) when the sweep recommends keep, revise or drop. */
  reviewBy?: string;
  /** Whole days a goal counts as pursued after its last live link (default 14). */
  pursuitWindow?: number;
  wording: string;
  body: string;
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

/**
 * @deprecated soma#329: renamed to {@link Checkpoint}. Retained as a back-compat
 * alias for the PAI-era name; prefer `Checkpoint` in new code.
 */
export type IdealStateCriterion = Checkpoint;

export const ALGORITHM_PHASES = ["observe", "think", "plan", "build", "execute", "verify", "learn", "complete", "abandoned"] as const;
export type AlgorithmPhase = (typeof ALGORITHM_PHASES)[number];

export const ALGORITHM_EFFORT_TIERS = ["E1", "E2", "E3", "E4", "E5"] as const;
export type AlgorithmEffortTier = (typeof ALGORITHM_EFFORT_TIERS)[number];

export const ALGORITHM_MODES = ["minimal", "native", "algorithm"] as const;
export type AlgorithmMode = (typeof ALGORITHM_MODES)[number];

/** Principal rejection of a delivered output; never stores assistant output content. */
export type ErrataPassedBy =
  | { kind: "algorithm-verify"; runId: string; criterionId: string }
  | { kind: "close-receipt"; repo: string; nodeId: string; receiptCommentId: string };

export interface ErrataInput {
  sessionId: string;
  rejectedTurnUuid: string;
  rejectedAt: string;
  complaintAt: string;
  complaint: string;
  artifacts: string[];
  passedBy: ErrataPassedBy | null;
}

export interface ErrataRecord extends ErrataInput {
  id: string;
  status: "active" | "dropped";
  createdAt: string;
  /** Set once a `clustered` event assigned this Errata; never changes afterwards. */
  clusterId?: string;
}

/**
 * Why a cluster's members belong together (node #851, soma#785 Q15). Deterministic
 * keys come first; a theme is judged only for `passedBy: null` with no shared artifact.
 * Theme labels are the judge's own words and never contain complaint text.
 */
export type ErrataClusterKey =
  | { kind: "check"; passedBy: ErrataPassedBy }
  | { kind: "artifact"; path: string }
  | { kind: "theme"; label: string };

/** Folded cluster: active members only; `ripe` is derived, never stored (soma#785 Q16). */
export interface ErrataCluster {
  id: string;
  key: ErrataClusterKey;
  errataIds: string[];
  status: "open" | "ripe";
  createdAt: string;
}

/** The answers a proposal can receive (soma#785 Q11, soma#903 D4). */
export type ErrataAnswerKind = "expired" | "dismissed" | "resolved";

/**
 * What the ledger records about one cluster after it was clustered. `proposed` and
 * `unroutable` are appended by triage (node #852); the answer kinds are appended by
 * the answer reader, which reads Vigil's `vigil.attention.resolved` records, and
 * triage only reads them. `ref` is the proposal ref the answer is about, so a
 * generation can be counted against the proposals that came before it.
 */
export type ErrataClusterEvent =
  | { kind: "proposed"; clusterId: string; ref: string; generation: number; landing: string; proposalKind: ProposalKind; at: string }
  | { kind: "unroutable"; clusterId: string; repo: string | null; at: string }
  | { kind: "resolved"; clusterId: string; ref: string; nodeRef?: string; at: string }
  | { kind: "dismissed"; clusterId: string; ref: string; at: string }
  | { kind: "expired"; clusterId: string; ref: string; at: string };

export type ErrataEvent =
  | { kind: "created"; record: ErrataRecord }
  | { kind: "dropped"; id: string; at: string }
  | { kind: "clustered"; id: string; clusterId: string; key: ErrataClusterKey; at: string }
  | ErrataClusterEvent;

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

export interface Projection {
  substrate: ProjectionSubstrate;
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
  substrate: ProjectionSubstrate;
  rootDir: string;
  files: string[];
}

export interface SomaHomeProjectionOptions {
  homeDir?: string;
  somaHome?: string;
  substrateHome?: string;
  somaRepoPath?: string;
  codeOnly?: boolean;
}

export interface SomaHomeProjection {
  substrate: ProjectionSubstrate;
  somaHome: string;
  substrateHome: string;
  bundle: Projection;
}

export interface SomaHomeBootstrapOptions {
  homeDir?: string;
  somaHome?: string;
  includeSkills?: boolean;
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
  /**
   * @internal Test seam (node #914): the source the runtime artifacts are
   * staged from. Omitted → `somaRepoPath`. It moves the staged runtime only;
   * bundled skills and projections still read `somaRepoPath`. Tests that do
   * not exercise the staged runtime pass a stub so each install does not
   * stage the whole soma tree.
   */
  runtimeSourceRoot?: string;
  codeOnly?: boolean;
  /**
   * Narrow the registry→loader projection to these skill names (soma#638).
   * Omitted → a `loader` substrate takes the whole curated registry. Lives on
   * the install options, not the CLI, so a programmatic install projects the
   * same skills a CLI install does.
   */
  skills?: string[];
}

/** A skill linked into a substrate's loader by install (soma#638). */
export interface InstalledSkill {
  skill: string;
  path: string;
  status: string;
}

/** A registry entry install could not project, and why (soma#638). */
export interface UninstallableSkillReport {
  dir: string;
  reason: string;
}

export interface SomaInstallResult {
  substrate: InstallSubstrate;
  /** Present when a guarded substrate was projected against the frozen runtime. */
  runtimeArtifact?: { path: string; hash: string; previous?: string };
  somaHome: SomaHomeBootstrapResult;
  substrateHome: WrittenProjection;
  /**
   * Registry skills linked into the substrate's loader, and registry entries
   * that could not be (soma#638). Empty for a `catalog` substrate, whose
   * projected catalog already advertises the registry.
   */
  projectedSkills: InstalledSkill[];
  unprojectableSkills: UninstallableSkillReport[];
}

export interface SomaInstallPlan {
  substrate: InstallSubstrate;
  apply: boolean;
  somaHome: string;
  substrateHome: string;
  somaDirectories: string[];
  somaFiles: string[];
  substrateFiles: string[];
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

export interface SkillNormalizationAction {
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
    | "stripped-pai-customization-block";
  detail: string;
}

export interface SkillNormalizationWarning {
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

/** @deprecated Renamed to {@link SkillNormalizationAction} (node #793). Kept for back-compat. */
export type PaiPackNormalizationAction = SkillNormalizationAction;

/** @deprecated Renamed to {@link SkillNormalizationWarning} (node #793). Kept for back-compat. */
export type PaiPackNormalizationWarning = SkillNormalizationWarning;

// #115 — `soma migrate claude-skills` types.
//
// Imports directly from an installed flat `.claude/skills/` tree — one
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
//                          `skill-content-normalizer.ts` rewrite table can
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
  | "install-codex"
  | "install-pi-dev"
  | "install-claude-code"
  | "install-cursor"
  | "install-grok"
  | "install-dsh";

/**
 * The substrates `soma doctor` can diagnose: the shipped substrates. Used to
 * parameterize the projection finding-id type below so only supported-substrate
 * ids are type-valid.
 */
export type SomaDoctorSubstrate = ShippedSubstrate;

/**
 * Content-compare drift findings (soma#370) are substrate-parameterized: the
 * same shapes apply uniformly whichever of the 5 doctor-supported
 * substrates produced them. Declared as a template-literal type over the
 * doctor-supported substrate union (`SomaDoctorSubstrate`) — NOT the broader
 * `SubstrateId`, which would admit `cortex-*`/`custom-*` ids the doctor can
 * never emit — rather than duplicating the suffix cross product by hand for
 * every substrate. The pre-existing substrate-specific strings this
 * generalizes (`codex-projection-stale`, `claude-code-projection-stale`,
 * `claude-code-projection-unmanaged-edit`, `grok-projection-stale`) are exact
 * members of this pattern, so no finding id string actually changes.
 *
 * `-not-diagnosable` is the honest "could not check" outcome (soma#370): Soma
 * is not installed / the Soma home is incomplete, so the source projection
 * cannot be built to compare against and NO comparison was performed. It is
 * emitted as `severity: "info"` so a legitimately-uninstalled home does not
 * hard-fail CI, but the output says "not diagnosed" rather than a bare "ok" —
 * never fail open.
 */
export type SomaDoctorProjectionFindingId =
  | `${SomaDoctorSubstrate}-projection-missing`
  | `${SomaDoctorSubstrate}-projection-stale`
  | `${SomaDoctorSubstrate}-projection-unmanaged-edit`
  | `${SomaDoctorSubstrate}-not-diagnosable`;

export type SomaDoctorFindingId =
  | "starter-profile"
  | "claude-skills-not-migrated"
  | SomaDoctorProjectionFindingId
  // soma#542: eager-loader stub integrity. Not a projection-drift id — the
  // stub's own bytes are correct; what rots is the body it points at.
  | "skill-stub-dangling"
  | "skill-stub-unreadable"
  | "claude-code-hook-missing"
  | "claude-code-settings-missing"
  | "grok-hook-missing"
  | "grok-hook-files-incomplete"
  | "grok-hook-interpreter-missing"
  | "grok-inspect-unavailable"
  | "runtime-artifact-missing"
  | "runtime-artifact-unloadable";

export type SomaOnboardingSubstrate = Exclude<InstallSubstrate, "anthropic-cowork">;

export interface SomaOnboardingOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SomaOnboardingSubstrate;
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
  substrate: SomaOnboardingSubstrate;
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
  /**
   * `error` (soma#370) is reserved for a projection file that is entirely
   * ABSENT on disk — a broken/never-installed projection, not merely an
   * out-of-date one. It is the only severity that flips `soma doctor`'s
   * process exit code to 2 (see `SomaDoctorDiagnosis.status` and the CLI
   * doctor handler); `warning` (drift/hand-edit) maps to exit 1, and no
   * findings above `info` maps to exit 0.
   */
  severity: "info" | "warning" | "error";
  /** Human-readable explanation of the drift; carries the narrative guidance. */
  message: string;
  /**
   * The remediation step the onboarding/doctor surfaces print verbatim.
   * Command-first: use an executable CLI command (e.g. `soma reproject grok`,
   * `soma install claude-code --apply`) wherever a single command remediates
   * the finding, so an agent or user can run it directly. Only when no single
   * command applies — e.g. `starter-profile`, where the
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
  /**
   * `error` (soma#370) when any finding is `severity: "error"` (a projection
   * file missing on disk); `drift` when the worst finding is a `warning`
   * (stale/hand-edited but present); `ok` when nothing above `info` was
   * found. Order matters for the CLI exit code: error dominates drift
   * dominates ok (2 / 1 / 0).
   */
  status: "ok" | "drift" | "error";
  homeDir: string;
  somaHome: string;
  findings: SomaDoctorFinding[];
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
  /**
   * The deliberate-escalation gate for the principal-trust durable note that
   * promotion mints (see docs/architecture.md Memory section). Mirrors
   * `principalAuthority` on {@link SomaMemoryWriteOptions}: a sudo-style
   * explicit, logged opt-in, NOT cryptographic principal authentication (soma
   * has no such primitive). REQUIRED — omitting it is a compile-time nudge for
   * honest callers; at runtime, promotion fails closed when it is not `true`.
   */
  principalAuthority: boolean;
}

export interface SomaMemoryPromotionResult {
  somaHome: string;
  store: SomaMemoryPromotionStore;
  path: string;
  sourceRunPath: string;
  event: SomaMemoryEvent;
  /** Path of the principal-trust durable note minted alongside the PROMOTED file. */
  notePath: string;
  /** Id of the principal-trust durable note (see {@link notePath}). */
  noteId: string;
}

export interface SomaFeedbackCaptureOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  text: string;
  source?: string;
  storeExcerpt?: boolean;
  timestamp?: string;
  /** Substrate session id; omitted from the event when absent. */
  sessionId?: string;
  /** Substrate transcript path, recorded for triage; capture never reads it. */
  transcriptPath?: string;
  /** Who authored the prompt; defaults to `interactive`. */
  actor?: SomaFeedbackActor;
}

export interface SomaFeedbackCaptureResult {
  somaHome: string;
  captured: boolean;
  classification: SomaFeedbackClassification;
  event?: SomaMemoryEvent;
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
  /** Optional adapter-provided deadline for the session work-registry writeback. */
  workRegistryLockTimeoutMs?: number;
  /**
   * On `session-end`: path to the substrate session transcript. When set (and the
   * substrate has a transcript adapter, e.g. claude-code), the handler attempts the
   * deterministic digest FALLBACK. Substrate-owned — core does not parse it.
   */
  transcriptPath?: string;
  /** Claude Code sub-agent markers from the hook payload (suppress the fallback per ADR 0014). */
  subagentId?: string;
  subagentType?: string;
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
  /** Actual scan start, independent of caller-supplied event timestamps. */
  scanStartedAt?: string;
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

/**
 * @deprecated Use {@link SomaExecutionRequest}; retained for source
 * compatibility while adapters remain projection-only.
 */
export interface SomaTask {
  id: string;
  substrate: ProjectionSubstrate;
  prompt: string;
  cwd?: string;
}

/**
 * @deprecated Use {@link SomaExecutionResult}; retained for source
 * compatibility while adapters remain projection-only.
 */
export interface SomaRunResult {
  taskId: string;
  substrate: ProjectionSubstrate;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  artifacts?: string[];
}

export interface SomaAdapter {
  name: ProjectionSubstrate;
  detect(): Promise<boolean>;
  project(input: ProjectionInput): Promise<Projection>;
}
