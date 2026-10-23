import { selectMarkdownSections } from "../core/index";

/** Structural readiness only; callers decide whether to report or refuse work. */
export function buildBriefMissing(body = ""): string[] {
  const missing: string[] = [];
  if (!/^## Deliverable[\t ]*\r?$/m.test(body)) missing.push("## Deliverable");
  if (!/^## Acceptance criteria[\t ]*\r?$/m.test(body)) missing.push("## Acceptance criteria");
  if (body.includes("[NEEDS CLARIFICATION]")) missing.push("[NEEDS CLARIFICATION]");
  const criteria = selectMarkdownSections(body, ["Acceptance criteria"]).sections;
  if (!criteria.some((section) => /^Live probe:[\t ]*\S/m.test(section.markdown))) missing.push("Live probe");
  return missing;
}
