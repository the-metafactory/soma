/** Structural readiness only; callers decide whether to report or refuse work. */
export function buildBriefMissing(body = ""): string[] {
  const missing: string[] = [];
  if (!/^## Deliverable[\t ]*\r?$/m.test(body)) missing.push("## Deliverable");
  if (!/^## Acceptance criteria[\t ]*\r?$/m.test(body)) missing.push("## Acceptance criteria");
  if (body.includes("[NEEDS CLARIFICATION]")) missing.push("[NEEDS CLARIFICATION]");
  return missing;
}
