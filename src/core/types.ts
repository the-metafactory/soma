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
