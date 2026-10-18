// flows types (node #815).
import type { AlgorithmRunSummary } from "../algorithm/types";
import type { ProposalKind, SomaMemoryPromotionStore } from "../core/index";
import type { SomaFeedbackActor, SomaFeedbackClassification, SomaMemoryEvent } from "../events/index";
import type { ClaudeSkillsSourceStatus } from "../migrate/types";
import type { InstallSubstrate } from "../policy/types";
import type { SomaDoctorFinding } from "../substrates/types";
import type { AlgorithmPhase, SubstrateId } from "../core/types";

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

export interface SomaHomeBootstrapOptions {
  homeDir?: string;
  somaHome?: string;
  includeSkills?: boolean;
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

export type SomaInitStepId =
  | "bootstrap-soma-home"
  | "migrate-claude-skills"
  | "install-codex"
  | "install-pi-dev"
  | "install-claude-code"
  | "install-cursor"
  | "install-grok"
  | "install-dsh";

export type SomaOnboardingSubstrate = Exclude<InstallSubstrate, "anthropic-cowork">;

export interface SomaOnboardingOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SomaOnboardingSubstrate;
}

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