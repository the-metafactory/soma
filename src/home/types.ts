import type { GoalRecord, SomaSkill, VerificationStateArtifact } from "../types";
import type { BehaviorPolicy } from "../policy/types";
import type { CommunicationContract } from "./communication-contract";

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
  /** The durable missions (M0–Mn). Loaded from `## Missions`, or `## Goals` in an older home (soma#784 D9). */
  missions: string[];
  /** Typed goal records from `profile/goals/G<n>.md`, in id order, every status (soma#784 D2, D9). */
  goals: GoalRecord[];
  principles: string[];
  commitments: string[];
}

export interface SomaMemoryLayout {
  root: string;
  work: string;
  knowledge: string;
  learning: string;
  relationship: string;
  state: string;
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
  /**
   * `profile/communication.md` — how the assistant talks — carried verbatim.
   * Nothing is parsed out of it; the file's own text is the whole payload. Under
   * `profile` (not a sibling like `memory`/`behavior`) because the Identity
   * compartment explicitly owns "voice, personality" (CONTEXT.md
   * "compartment"), and voice is what this is. Conduct rules are the Policy
   * compartment and live in `ProjectionInput.behavior` instead.
   *
   * Omitted when the home has no `profile/communication.md` — an older home
   * predating the starter template, or one where the principal deleted it. The
   * substrate then simply projects no contract.
   */
  communication?: CommunicationContract;
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
  /**
   * Names (skill dir basenames) of the repo-bundled skills — every `src/skills/*`
   * dir (the-algorithm, Memory, and VSA) — that the install copied into the Soma
   * home. When present, the generic portable-skill loop projects ONLY these as
   * invocable dirs (VSA is in the list but still excluded by `projectableSkills`'
   * dedicated VSA guard — it has its own managed installer); principal-authored
   * and registry skills present in `~/.soma/skills` reach a
   * substrate through `soma install --skills` symlinks instead, not the
   * always-on loop. Absent for direct projection callers (kept permissive:
   * legacy all-except-VSA behavior) — install is the sole scope authority.
   */
  bundledSkillNames?: readonly string[];
  /**
   * Parsed `~/.soma/policy/behavior.md` — the principal's cross-substrate
   * behavioral rules. A SIBLING of `profile`, not a field under it: behavior is
   * the Policy compartment, `profile` is Identity, and the two are peers (same
   * reasoning as `memory` above). Adapters merge
   * `behaviorPolicyAdvisory(input.behavior)` into their
   * `renderPolicyProjection` advisory list. Omitted when the home has no
   * `policy/behavior.md`, in which case the projection simply carries no
   * principal behavioral rules — never a default set, because inventing rules
   * the principal did not write is worse than projecting none.
   */
  behavior?: BehaviorPolicy;
}
