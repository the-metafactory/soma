import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EMPTY_BEHAVIOR_POLICY,
  behaviorPolicyAdvisory,
  parseBehaviorPolicy,
} from "../src/policy/behavior-policy";

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

  expect(verification?.rules).toHaveLength(2);
  // The regression this parser exists for: `sectionBullets` would have kept only
  // "Never assert without verification. After changes, verify before claiming"
  // and silently dropped the evidence requirement.
  expect(verification?.rules[0]).toBe(
    'Never assert without verification. After changes, verify before claiming success — evidence required (tests, output, diffs). "Should work" is not done.',
  );
  expect(verification?.rules[1]).toBe("Confidence requires source.");
});

test("prose-only sections keep their rules", () => {
  const { sections } = parseBehaviorPolicy(SAMPLE);
  const permissions = sections.find((section) => section.heading === "Permission boundaries");

  expect(permissions?.rules).toHaveLength(0);
  expect(permissions?.prose).toHaveLength(1);
  expect(permissions?.prose[0]).toContain("any irreversible operation.");
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
  expect(sections[0].rules).toEqual(["Read only."]);
  expect(sections[0].prose).toEqual(["Analysis:"]);
});

test("the repo's shipped policy/behavior.md parses into rules", async () => {
  const shipped = await readFile(join(import.meta.dir, "..", "policy", "self-healing.md"), "utf8");
  // self-healing.md is the shape a behavior-style policy file takes in-repo;
  // parsing it proves the parser handles real authored markdown, not only the
  // synthetic sample above.
  const { sections } = parseBehaviorPolicy(shipped);
  expect(sections.length).toBeGreaterThan(0);
});
