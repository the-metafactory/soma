/**
 * Internal memory-layout constants shared across the memory subsystem
 * (promotion, backfill). NOT part of the public Soma API surface — on-disk
 * store names are an implementation detail; only `SomaMemoryPromotionStore`
 * (the type) is public. Keeping these in an internal module avoids painting
 * future layout changes into a compatibility corner.
 */
import type { SomaMemoryPromotionStore } from "./types";

/** Promotion store -> on-disk memory directory. */
export const SOMA_PROMOTION_STORE_DIRS: Record<SomaMemoryPromotionStore, string> = {
  learning: "LEARNING",
  knowledge: "KNOWLEDGE",
  relationship: "RELATIONSHIP",
  work: "WORK",
};

/** Set of promotion store directory names (for membership checks). */
export const SOMA_PROMOTION_STORE_DIR_NAMES: ReadonlySet<string> = new Set(Object.values(SOMA_PROMOTION_STORE_DIRS));
