import type { AlgorithmEffortTier, AlgorithmMode, AlgorithmPhase, EvidenceKind } from "../core/types";

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

export interface AuthoredFrontmatter {
  task: string;
  effort: AlgorithmEffortTier;
  /** Goal ID only; private goal wording stays in soma-home (D10). */
  serves?: string;
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

export interface AlgorithmLogEntry {
  timestamp: string;
  phase: AlgorithmPhase;
  text: string;
  /** Structured verification fields; absent on older prose-only entries. */
  criterionId?: string;
  outcome?: "passed" | "failed" | "dropped" | "deferred-probe";
  /** Substrate session that asserted this verification, when available. */
  sessionId?: string;
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
