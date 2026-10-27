import { expect, test } from "bun:test";
import { classifyAlgorithmPrompt, classifyPlaybookCard, PLAYBOOK_CARD_RULES } from "../../src/algorithm/algorithm-classifier";
import routingFixtures from "../fixtures/harness-eval/playbook-routing.json";

const HINTED = new Set<string>(PLAYBOOK_CARD_RULES.map((rule) => rule.card));

test("routing fixtures get their card when it is a hinted shape, and no hint otherwise", () => {
  for (const { prompt, expectedCard } of routingFixtures) {
    expect(classifyPlaybookCard(prompt) as string | undefined, prompt).toBe(HINTED.has(expectedCard) ? expectedCard : undefined);
  }
});

test("prompt text names bug-fix before investigation, and change requests name neither", () => {
  const cases: [string, string | undefined][] = [
    ["the login page is broken since yesterday", "bug-fix"],
    ["why does the install test fail on CI?", "bug-fix"],
    ["how is the poteto-mode skill from pstack matched in soma?", "investigation"],
    ["what do you think makes most sense here?", "investigation"],
    ["should we split the adapter?", "investigation"],
    ["good, implement these things", undefined],
    ["rename the flag to --dry-run", undefined],
  ];
  for (const [prompt, card] of cases) expect(classifyPlaybookCard(prompt) as string | undefined, prompt).toBe(card);
});

test("minimal prompts and harness events carry no hint, and the mode classification is unchanged", () => {
  for (const prompt of ["ok", "thanks", "", "<task-notification><summary>build broken</summary></task-notification>"]) {
    expect(classifyPlaybookCard(prompt), prompt).toBeUndefined();
  }
  expect(classifyAlgorithmPrompt("the login page is broken")).not.toHaveProperty("card");
});
