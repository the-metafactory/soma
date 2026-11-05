import { expect, test } from "bun:test";
import { classifyErrataWithClaude } from "../../src/flows/errata-classifier";

const live = process.env.SOMA_TEST_CLAUDE_LIVE === "1" ? test : test.skip;

live("installed Claude classifies public synthetic feedback with the isolated Errata adapter", async () => {
  const verdict = await classifyErrataWithClaude("The delivered answer said two plus two is five. Please correct the arithmetic.");
  expect(verdict.verdict).toBe("promote");
  expect(verdict.reason.length).toBeGreaterThan(0);
  expect(verdict.backendVersion).toContain("Claude Code");
}, 90_000);
