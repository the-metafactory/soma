import { expect, test } from "bun:test";
import {
  projectClaudeCode,
  projectClaudeCodeHome,
  projectCodex,
  projectCursor,
  projectGrok,
  projectPiDev,
  projectPiDevHome,
  type Projection,
} from "../src/index";
import { projectAnthropicCoworkHome } from "../src/adapters/anthropic-cowork";
import {
  SELF_HEALING_DOCTRINE_ADVISORY,
  SELF_HEALING_DOCTRINE_TITLE,
  SELF_HEALING_ROUTES,
  renderSelfHealingRoute,
} from "../src/policy/self-healing-doctrine";
import { portableProjectionInput } from "./fixtures";

/**
 * Concatenated content of every projected policy file (`.../policy.md`, and the
 * uppercase `POLICY.md` the claude-code home projection emits) in a projection.
 */
function policyContent(projection: Projection): string {
  return projection.files
    .filter((file) => file.path.toLowerCase().endsWith("policy.md"))
    .map((file) => file.content)
    .join("\n");
}

/**
 * Every substrate whose `renderPolicyProjection` call site was wired to the
 * SelfHealing doctrine (soma#459). Each entry projects at least one policy file.
 */
const SUBSTRATE_POLICIES: readonly { name: string; content: string }[] = [
  { name: "claude-code (workspace)", content: policyContent(projectClaudeCode(portableProjectionInput)) },
  { name: "claude-code (home)", content: policyContent(projectClaudeCodeHome(portableProjectionInput)) },
  { name: "cursor", content: policyContent(projectCursor(portableProjectionInput)) },
  { name: "anthropic-cowork", content: policyContent(projectAnthropicCoworkHome(portableProjectionInput)) },
  { name: "pi-dev (workspace)", content: policyContent(projectPiDev(portableProjectionInput)) },
  { name: "pi-dev (home)", content: policyContent(projectPiDevHome(portableProjectionInput, "/tmp/soma-home")) },
  { name: "codex", content: policyContent(projectCodex(portableProjectionInput)) },
  { name: "grok", content: policyContent(projectGrok(portableProjectionInput)) },
];

test("SelfHealing doctrine projects into every wired substrate's policy", () => {
  for (const { name, content } of SUBSTRATE_POLICIES) {
    expect(content, `${name} must project a policy file`).not.toBe("");
    // (a) The doctrine appears in the projected policy output.
    for (const line of SELF_HEALING_DOCTRINE_ADVISORY) {
      expect(content, `${name} policy is missing doctrine line: ${line}`).toContain(line);
    }
  }
});

test("SelfHealing doctrine originates from the single source module (drift guard)", () => {
  // (b) Drift guard: each routing line is rendered from SELF_HEALING_ROUTES via
  // renderSelfHealingRoute, and that exact rendered text must appear in every
  // substrate's projection — so a change to the module, or an adapter that
  // altered the rendered text, fails here. (This enforces no-drift; a verbatim
  // copy of the identical bytes would still pass — the module stays the source.)
  for (const route of SELF_HEALING_ROUTES) {
    const line = renderSelfHealingRoute(route);
    for (const { name, content } of SUBSTRATE_POLICIES) {
      expect(content, `${name} routing line drifted from the module: ${line}`).toContain(line);
    }
  }

  // The whole doctrine block appears byte-identical in every substrate's
  // projection — so a per-adapter edit to the block's text (drift) fails.
  const block = SELF_HEALING_DOCTRINE_ADVISORY.map((line) => `- ${line}`).join("\n");
  for (const { name, content } of SUBSTRATE_POLICIES) {
    expect(content, `${name} does not contain the single-source doctrine block`).toContain(block);
  }
});

test("SelfHealing doctrine is advice-to-route, not authority-to-apply", () => {
  // The deliberate divergence from LifeOS auto-apply (soma#429/#375): the
  // doctrine steers routing; existing --principal-authority governance gates the
  // write. Lock that guardrail text into the projection.
  const governanceLine = SELF_HEALING_DOCTRINE_ADVISORY.find((line) =>
    line.includes("--principal-authority"),
  );
  expect(governanceLine, "doctrine must carry the principal-authority guardrail").toBeDefined();
  expect(governanceLine).toContain("not authority to apply");

  expect(SELF_HEALING_DOCTRINE_TITLE).toContain("soma#459");
  for (const { name, content } of SUBSTRATE_POLICIES) {
    expect(content, `${name} must carry the governance guardrail`).toContain(governanceLine ?? "");
  }
});
