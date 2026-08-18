import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_BEHAVIOR_POLICY,
  behaviorPolicyAdvisory,
  parseBehaviorPolicy,
} from "../src/policy/behavior-policy";
import type { BehaviorPolicySection } from "../src/policy/behavior-policy";

/** Entry texts of one kind, in source order. `entries` is the only stored shape. */
function textsOfKind(section: BehaviorPolicySection | undefined, kind: "rule" | "prose"): string[] {
  return (section?.entries ?? []).filter((entry) => entry.kind === kind).map((entry) => entry.text);
}

const SAMPLE = `# Behavioral Policy (advisory)

Source of truth for cross-substrate behavioral rules. Mined from PAI during
the 2026-07 migration.

## Verification

- Never assert without verification. After changes, verify before claiming
  success — evidence required (tests, output, diffs). "Should work" is not done.
- Confidence requires source.

## Permission boundaries

Ask before: deleting files or branches, deploying to production, pushing
code, modifying .env, any irreversible operation.

## Provenance

- This section is dropped as non-rule content.
`;

test("wrapped bullets fold into one rule instead of truncating at the first line", () => {
  const { sections } = parseBehaviorPolicy(SAMPLE);
  const verification = sections.find((section) => section.heading === "Verification");

  expect(textsOfKind(verification, "rule")).toHaveLength(2);
  // The regression this parser exists for: `sectionBullets` would have kept only
  // "Never assert without verification. After changes, verify before claiming"
  // and silently dropped the evidence requirement.
  expect(textsOfKind(verification, "rule")[0]).toBe(
    'Never assert without verification. After changes, verify before claiming success — evidence required (tests, output, diffs). "Should work" is not done.',
  );
  expect(textsOfKind(verification, "rule")[1]).toBe("Confidence requires source.");
});

test("prose-only sections keep their rules", () => {
  const { sections } = parseBehaviorPolicy(SAMPLE);
  const permissions = sections.find((section) => section.heading === "Permission boundaries");

  expect(textsOfKind(permissions, "rule")).toHaveLength(0);
  expect(textsOfKind(permissions, "prose")).toHaveLength(1);
  expect(textsOfKind(permissions, "prose")[0]).toContain("any irreversible operation.");
  expect(behaviorPolicyAdvisory({ sections })).toContain(
    "Permission boundaries: Ask before: deleting files or branches, deploying to production, pushing code, modifying .env, any irreversible operation.",
  );
});

test("document preamble and non-rule sections are dropped", () => {
  const { sections } = parseBehaviorPolicy(SAMPLE);

  expect(sections.map((section) => section.heading)).toEqual(["Verification", "Permission boundaries"]);
  expect(behaviorPolicyAdvisory({ sections }).join("\n")).not.toContain("dropped as non-rule content");
  expect(behaviorPolicyAdvisory({ sections }).join("\n")).not.toContain("Mined from PAI");
});

test("mixed sections project in source order, prose and bullets interleaved", () => {
  // Sage #636 r1: rendering `[...rules, ...prose]` moved a section's opening
  // paragraph to the end, silently reordering principal-authored guidance.
  const mixed = parseBehaviorPolicy(
    ["## Scope", "", "Analysis is read-only.", "", "- Only change what was requested.", "", "Ask when unsure.", ""].join("\n"),
  );

  expect(mixed.sections[0].entries.map((entry) => entry.kind)).toEqual(["prose", "rule", "prose"]);
  expect(behaviorPolicyAdvisory(mixed)).toEqual([
    "Scope: Analysis is read-only.",
    "Scope: Only change what was requested.",
    "Scope: Ask when unsure.",
  ]);
  // The convenience arrays stay filtered views of the same ordered sequence.
  expect(textsOfKind(mixed.sections[0], "rule")).toEqual(["Only change what was requested."]);
  expect(textsOfKind(mixed.sections[0], "prose")).toEqual(["Analysis is read-only.", "Ask when unsure."]);
});

test("advisory lines carry their section heading", () => {
  const lines = behaviorPolicyAdvisory(parseBehaviorPolicy(SAMPLE));

  expect(lines).toHaveLength(3);
  for (const line of lines) {
    expect(line).toMatch(/^(Verification|Permission boundaries): /);
  }
});

test("an absent or empty policy renders no advisory lines", () => {
  expect(behaviorPolicyAdvisory(undefined)).toEqual([]);
  expect(behaviorPolicyAdvisory(EMPTY_BEHAVIOR_POLICY)).toEqual([]);
  expect(parseBehaviorPolicy("")).toEqual(EMPTY_BEHAVIOR_POLICY);
  expect(parseBehaviorPolicy("# Title only\n\nSome prose.\n")).toEqual(EMPTY_BEHAVIOR_POLICY);
});

test("nested headings fold into their parent section rather than opening a sibling", () => {
  const { sections } = parseBehaviorPolicy("## Scope\n\n### Analysis\n\n- Read only.\n");

  expect(sections).toHaveLength(1);
  expect(sections[0].heading).toBe("Scope");
  expect(textsOfKind(sections[0], "rule")).toEqual(["Read only."]);
  expect(textsOfKind(sections[0], "prose")).toEqual(["Analysis:"]);
  expect(sections[0].entries.map((entry) => entry.text)).toEqual(["Analysis:", "Read only."]);
});

test("real authored markdown parses — policy/self-healing.md as the stand-in", () => {
  // The repo ships no `policy/behavior.md`: that file is principal-authored and
  // lives in the Soma home. `policy/self-healing.md` is the closest in-repo
  // sample of the same authored shape, so it stands in to prove the parser
  // handles hand-written markdown and not only the synthetic sample above.
  const shipped = readFileSync(join(import.meta.dir, "..", "policy", "self-healing.md"), "utf8");
  const { sections } = parseBehaviorPolicy(shipped);
  expect(sections.length).toBeGreaterThan(0);
});
