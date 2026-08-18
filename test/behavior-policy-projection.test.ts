import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapSomaHome,
  loadSomaHome,
  projectClaudeCode,
  projectClaudeCodeHome,
  projectCodex,
  projectCodexHome,
  projectCursor,
  projectGrok,
  projectGrokHome,
  projectPiDev,
  projectPiDevHome,
  type Projection,
  type ProjectionInput,
} from "../src/index";
import { projectAnthropicCoworkHome } from "../src/adapters/anthropic-cowork";
import { behaviorPolicyAdvisory, parseBehaviorPolicy } from "../src/policy/behavior-policy";
import { portableProjectionInput } from "./fixtures";

const BEHAVIOR_MD = `# Behavioral Policy (advisory)

## Verification

- Never assert without verification. After changes, verify before claiming
  success — evidence required.

## Permission boundaries

Ask before deleting files or branches.
`;

const POLICY = parseBehaviorPolicy(BEHAVIOR_MD);
const ADVISORY = behaviorPolicyAdvisory(POLICY);

const withBehavior: ProjectionInput = { ...portableProjectionInput, behavior: POLICY };

function policyContent(projection: Projection): string {
  return projection.files
    .filter((file) => file.path.toLowerCase().endsWith("policy.md"))
    .map((file) => file.content)
    .join("\n");
}

/** Every projection surface that renders a policy file. */
function allPolicies(input: ProjectionInput): { name: string; content: string }[] {
  return [
    { name: "claude-code (workspace)", content: policyContent(projectClaudeCode(input)) },
    { name: "claude-code (home)", content: policyContent(projectClaudeCodeHome(input)) },
    { name: "cursor", content: policyContent(projectCursor(input)) },
    { name: "anthropic-cowork", content: policyContent(projectAnthropicCoworkHome(input)) },
    { name: "pi-dev (workspace)", content: policyContent(projectPiDev(input)) },
    { name: "pi-dev (home)", content: policyContent(projectPiDevHome(input, "/tmp/soma-home")) },
    { name: "codex (workspace)", content: policyContent(projectCodex(input)) },
    { name: "codex (home)", content: policyContent(projectCodexHome(input, "/tmp/soma-home")) },
    { name: "grok (workspace)", content: policyContent(projectGrok(input)) },
    { name: "grok (home)", content: policyContent(projectGrokHome(input, "/tmp/soma-home")) },
  ];
}

test("behavioral policy projects into every substrate's policy file", () => {
  expect(ADVISORY.length).toBeGreaterThan(0);

  for (const { name, content } of allPolicies(withBehavior)) {
    expect(content, `${name} must project a policy file`).not.toBe("");
    for (const line of ADVISORY) {
      expect(content, `${name} policy is missing behavior line: ${line}`).toContain(`- ${line}`);
    }
  }
});

test("wrapped rules project whole, not truncated at the source line break", () => {
  // The failure this whole rail exists to prevent: a rule that reaches the
  // substrate missing its second half is worse than one that never projected.
  for (const { name, content } of allPolicies(withBehavior)) {
    expect(content, `${name} truncated the wrapped rule`).toContain("evidence required.");
  }
});

test("no behavior policy means no invented rules", () => {
  for (const { name, content } of allPolicies(portableProjectionInput)) {
    for (const line of ADVISORY) {
      expect(content, `${name} projected a behavior rule with no source file`).not.toContain(line);
    }
    // The substrate's own advisory lines and the shipped doctrine still project.
    expect(content, `${name} lost its baseline advisory list`).toContain("## Advisory");
  }
});

test("adapters do not restate behavior rules — the home file is the only source", () => {
  // Drift guard. sage #636 r2: editing ONE rule only proves that rule is not
  // hardcoded, while the shipped doc claims adapters never restate ANY rule. So
  // every entry is mutated and every mutation checked — an adapter holding a
  // hardcoded copy of any single rule now fails here.
  const marker = "DRIFT-SENTINEL";
  const edited = parseBehaviorPolicy(
    BEHAVIOR_MD.split("\n")
      .map((line) => (line.trim() === "" || line.startsWith("#") ? line : `${line} ${marker}`))
      .join("\n"),
  );
  const editedAdvisory = behaviorPolicyAdvisory(edited);
  const editedInput: ProjectionInput = { ...portableProjectionInput, behavior: edited };

  expect(editedAdvisory).toHaveLength(ADVISORY.length);
  expect(editedAdvisory.every((line) => line.includes(marker))).toBe(true);

  for (const { name, content } of allPolicies(editedInput)) {
    for (const original of ADVISORY) {
      expect(content, `${name} kept a hardcoded copy of: ${original}`).not.toContain(`- ${original}\n`);
    }
    for (const line of editedAdvisory) {
      expect(content, `${name} did not pick up the edited rule: ${line}`).toContain(`- ${line}`);
    }
  }
});

test("loadSomaHome reads policy/behavior.md, and tolerates its absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "soma-behavior-"));
  try {
    const somaHome = join(root, ".soma");
    await bootstrapSomaHome({ somaHome });

    // `soma init` does not create behavior.md — absence must load cleanly.
    const withoutFile = await loadSomaHome(somaHome);
    expect(withoutFile.behavior).toBeUndefined();

    await mkdir(join(somaHome, "policy"), { recursive: true });
    await writeFile(join(somaHome, "policy", "behavior.md"), BEHAVIOR_MD, "utf8");

    const loaded = await loadSomaHome(somaHome);
    expect(loaded.behavior).toBeDefined();
    expect(behaviorPolicyAdvisory(loaded.behavior)).toEqual(ADVISORY);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
