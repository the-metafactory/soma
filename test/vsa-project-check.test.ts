import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runVsaCli } from "../src/cli/vsa";

const E3_REST = [
  "## Problem\n\nNodes ship without intent.\n",
  "## Out of Scope\n\n- A rewrite.\n",
  "## Constraints\n\n- Bun.\n",
  "## Goal\n\nEvery claim cites a criterion.\n",
  "## Checkpoints\n\n- [ ] ISC-1: Ranger refuses a node that cites no ISC.\n",
  "## Test Strategy\n\n| ISC | Probe |\n| --- | --- |\n| ISC-1 | claim a node without an ISC |\n",
  "## Features\n\n| Feature | ISCs |\n| --- | --- |\n| claim gate | ISC-1 |\n",
];

function projectVsa(vision: string, effort = "E2"): string {
  const [problem, ...rest] = E3_REST;
  return [`---\ntask: ranger\neffort: ${effort}\nphase: observe\n---\n`, problem, `## Vision\n\n${vision}\n`, ...rest].join("\n");
}

const THREE_LEVELS = [
  "- **Level 1 — Life outcome.** Goals advance on their own.",
  "- **Level 2 — System behavior.** Agents work only on failing criteria.",
  "- **Level 3 — Mechanism.** The claim gate refuses nodes without an ISC.",
].join("\n");

async function inRepo(vsa: string, scenario: (repo: string) => Promise<void>) {
  const repo = await mkdtemp(join(tmpdir(), "soma-project-vsa-"));
  try {
    await writeFile(join(repo, "VSA.md"), vsa);
    await scenario(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

test("a product VSA with E3 sections and all three Vision levels passes, given the repo directory", async () => {
  await inRepo(projectVsa(THREE_LEVELS), async (repo) => {
    const run = await runVsaCli(["check", "--project", repo]);
    expect(run.exitCode).toBe(0);
    expect(run.text).toContain("passed project completeness check at E3");
  });
});

test("a product VSA whose Vision lacks a level fails and names the missing level", async () => {
  const withoutMechanism = THREE_LEVELS.split("\n").slice(0, 2).join("\n");
  await inRepo(projectVsa(withoutMechanism), async (repo) => {
    const run = await runVsaCli(["check", "--project", join(repo, "VSA.md")]);
    expect(run.exitCode).toBe(1);
    expect(run.text).toContain("Vision Level 3: missing");
    expect(run.text).not.toContain("Level 1: missing");
  });
});

test("a one-paragraph Vision fails with all three levels named", async () => {
  await inRepo(projectVsa("Ranger becomes the place where intent turns into merged work."), async (repo) => {
    const run = await runVsaCli(["check", "--project", repo]);
    expect(run.exitCode).toBe(1);
    for (const level of [1, 2, 3]) expect(run.text).toContain(`Vision Level ${level}: missing`);
  });
});

test("a product VSA is held to E3 sections even when its own tier is lower", async () => {
  const noFeatures = projectVsa(THREE_LEVELS).replace(/## Features[\s\S]*$/, "");
  await inRepo(noFeatures, async (repo) => {
    const run = await runVsaCli(["check", "--project", repo]);
    expect(run.exitCode).toBe(1);
    expect(run.text).toContain("at E3");
    expect(run.text).toContain("Features: missing");
  });
});

test("Vision levels written as subheadings count too", async () => {
  const headed = "### Level 1 — Life outcome\n\nA.\n\n### Level 2 — System behavior\n\nB.\n\n### Level 3 — Mechanism\n\nC.";
  await inRepo(projectVsa(headed), async (repo) => {
    const run = await runVsaCli(["check", "--project", repo]);
    expect(run.exitCode).toBe(0);
  });
});

test("a repo without VSA.md is reported as not found", async () => {
  const repo = await mkdtemp(join(tmpdir(), "soma-project-vsa-"));
  try {
    const run = await runVsaCli(["check", "--project", repo]);
    expect(run.exitCode).toBe(1);
    expect(run.text).toContain("VSA not found");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
