export interface SomaPaths {
  root(): string;
  identity(): string;
  memory(): string;
  profile(): string;
  skills(): string;
  learning(): string;
  knowledge(): string;
  signals(): string;
  wisdom(): string;
  relationship(): string;
  state(...segments: string[]): string;
  work(): string;
  semantic(): string;
  procedural(): string;
  episodic(kind: "sessions" | "actions" | "digests", ...segments: string[]): string;
  promoted(store: SomaMemoryPromotionStore): string;
  archive(...segments: string[]): string;
  ratings(): string;
  opinions(): string;
  story(): string;
  events(): string;
  resolve(...segments: string[]): string;
}

// Single source of truth for the promotion-store enumeration AND its on-disk
// dir mapping: `promoted()` (src/core/paths.ts) keys this map, and the CLI's
// `--store` validator (src/cli/memory.ts) checks against the derived array —
// neither re-lists the literals independently (soma#419 review: the dir map
// used to be re-declared in paths.ts, a second source list).
export const SOMA_MEMORY_PROMOTION_STORE_DIRS = {
  learning: "LEARNING",
  knowledge: "KNOWLEDGE",
  relationship: "RELATIONSHIP",
  work: "WORK",
} as const;
export type SomaMemoryPromotionStore = keyof typeof SOMA_MEMORY_PROMOTION_STORE_DIRS;
export const SOMA_MEMORY_PROMOTION_STORES = Object.keys(
  SOMA_MEMORY_PROMOTION_STORE_DIRS,
) as SomaMemoryPromotionStore[];

/** Shared by proposal producers and the graph file-proposal schema. */
export const PROPOSAL_KINDS = [
  "deterministic-check",
  "reviewer-standard",
  "navigation-pointer",
  "information-access",
  "rule-memory",
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** Every substrate id Soma knows. `SubstrateId` and `KNOWN_SUBSTRATES` derive from this list. */
export const SUBSTRATE_IDS = ["codex", "pi-dev", "claude-code", "cursor", "grok", "dsh", "cortex", "custom", "anthropic-cowork"] as const;
export type SubstrateId = (typeof SUBSTRATE_IDS)[number];

export type ExperimentalScaffoldSubstrate = "anthropic-cowork";
export type ProjectionSubstrate = SubstrateId | ExperimentalScaffoldSubstrate;

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

export const ALGORITHM_PHASES = ["observe", "think", "plan", "build", "execute", "verify", "learn", "complete", "abandoned"] as const;
export type AlgorithmPhase = (typeof ALGORITHM_PHASES)[number];

export const ALGORITHM_EFFORT_TIERS = ["E1", "E2", "E3", "E4", "E5"] as const;
export type AlgorithmEffortTier = (typeof ALGORITHM_EFFORT_TIERS)[number];

export const ALGORITHM_MODES = ["minimal", "native", "algorithm"] as const;
export type AlgorithmMode = (typeof ALGORITHM_MODES)[number];
