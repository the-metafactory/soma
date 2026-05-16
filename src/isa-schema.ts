import type { AlgorithmEffortTier, IdealStateArtifact } from "./types";
import { TWELVE_SECTIONS, getSection, SECTION_NAME_MAP } from "./isa-accessors";

/**
 * Tier completeness gates — required ISA sections per effort tier.
 * Owned by the library (#34). The unified `IdealStateArtifact` type stays
 * section-agnostic; tier gates live here as a typed constant so schema
 * evolution doesn't ripple through CRUD operations.
 *
 * The gate set is also re-exported from `src/isa.ts` for downstream
 * consumers (#36 CLI, #38 lifecycle hooks).
 */
export const TIER_REQUIRED_SECTIONS: Record<AlgorithmEffortTier, readonly string[]> = {
  E1: [SECTION_NAME_MAP.goal, SECTION_NAME_MAP.criteria],
  E2: [
    SECTION_NAME_MAP.problem,
    SECTION_NAME_MAP.goal,
    SECTION_NAME_MAP.criteria,
    SECTION_NAME_MAP.testStrategy,
  ],
  E3: [
    SECTION_NAME_MAP.problem,
    SECTION_NAME_MAP.vision,
    SECTION_NAME_MAP.outOfScope,
    SECTION_NAME_MAP.constraints,
    SECTION_NAME_MAP.goal,
    SECTION_NAME_MAP.criteria,
    SECTION_NAME_MAP.features,
    SECTION_NAME_MAP.testStrategy,
  ],
  E4: TWELVE_SECTIONS,
  E5: TWELVE_SECTIONS,
};

export interface CompletenessGap {
  section: string;
  reason: "missing" | "empty";
}

export interface CompletenessReport {
  passed: boolean;
  tier: AlgorithmEffortTier;
  gaps: CompletenessGap[];
}

export function evaluateCompleteness(isa: IdealStateArtifact, tier: AlgorithmEffortTier): CompletenessReport {
  const required = TIER_REQUIRED_SECTIONS[tier];
  const gaps: CompletenessGap[] = [];
  for (const name of required) {
    const section = getSection(isa, name);
    if (section === null) {
      gaps.push({ section: name, reason: "missing" });
    } else if (section.content.trim().length === 0) {
      gaps.push({ section: name, reason: "empty" });
    }
  }
  return { passed: gaps.length === 0, tier, gaps };
}
