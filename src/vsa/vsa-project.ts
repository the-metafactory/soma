import { readFile } from "node:fs/promises";
import { ALGORITHM_EFFORT_TIERS } from "../core/types";
import { getSection, SECTION_NAME_MAP } from "./vsa-accessors";
import { parseVsa } from "./vsa-parse";
import { evaluateCompleteness, type CompletenessReport } from "./vsa-schema";
import type { VerificationStateArtifact } from "./types";

export const VISION_LEVELS = [1, 2, 3] as const;
export type VisionLevel = (typeof VISION_LEVELS)[number];

const LEVEL_LINE = /^[ \t]*(?:[-*][ \t]+|#{3,4}[ \t]+)?(?:\*\*)?Level[ \t]+([1-3])\b/gm;

/** The Vision levels a `## Vision` body states, each as a line opening with `Level N`. */
export function visionLevels(content: string): Set<VisionLevel> {
  const found = new Set<VisionLevel>();
  for (const match of content.matchAll(LEVEL_LINE)) found.add(Number(match[1]) as VisionLevel);
  return found;
}

/**
 * A product's root `VSA.md` needs at least E3 structure and a Vision that
 * states Level 1 (life outcome), Level 2 (system behavior) and Level 3
 * (mechanism), whatever its own effort tier says.
 */
export function evaluateProjectCompleteness(isa: VerificationStateArtifact): CompletenessReport {
  const own = isa.frontmatter.effort;
  const tier = ALGORITHM_EFFORT_TIERS.indexOf(own) >= ALGORITHM_EFFORT_TIERS.indexOf("E3") ? own : "E3";
  const report = evaluateCompleteness(isa, tier);
  const vision = getSection(isa, SECTION_NAME_MAP.vision);
  if (vision !== null && vision.content.trim().length > 0) {
    const present = visionLevels(vision.content);
    for (const level of VISION_LEVELS) {
      if (!present.has(level)) report.gaps.push({ section: `${SECTION_NAME_MAP.vision} Level ${level}`, reason: "missing" });
    }
  }
  return { ...report, passed: report.gaps.length === 0 };
}

/** Checks a product's root `VSA.md` by path, under the rules of `evaluateProjectCompleteness`. */
export async function checkProjectVsa(path: string): Promise<CompletenessReport> {
  const markdown = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
  return evaluateProjectCompleteness(parseVsa(markdown, path));
}
