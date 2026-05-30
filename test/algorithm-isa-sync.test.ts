import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { syncAlgorithmRunFromIsa } from "../src/algorithm-isa-sync";
import { readAlgorithmRunById } from "../src/algorithm-store";
import { getCriteria } from "../src/isa-accessors";
import { getRunPhase } from "../src/algorithm-lifecycle";

async function withSomaHome<T>(fn: (somaHome: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soma-isa-sync-"));
  const somaHome = join(dir, ".soma");
  try {
    return await fn(somaHome, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeIsaFile(dir: string, slug: string, markdown: string): Promise<string> {
  const isaDir = join(dir, "work", slug);
  await mkdir(isaDir, { recursive: true });
  const path = join(isaDir, "ISA.md");
  await writeFile(path, markdown, "utf8");
  return path;
}

function isaMarkdown(input: {
  slug: string;
  phase: string;
  effort?: string;
  goal: string;
  criteria: { id: string; text: string; done?: boolean }[];
  decisions?: string[];
}): string {
  const criteriaLines = input.criteria
    .map((c) => `- [${c.done ? "x" : " "}] ${c.id}: ${c.text}`)
    .join("\n");
  const decisions = input.decisions ?? [];
  const decisionBlock =
    decisions.length > 0 ? `\n\n## Decisions\n\n${decisions.map((d) => `- ${d}`).join("\n")}` : "";
  return `---
task: ${input.goal}
slug: ${input.slug}
effort: ${input.effort ?? "E2"}
phase: ${input.phase}
progress: 0/${input.criteria.length}
mode: ALGORITHM
started: 2026-05-29
updated: 2026-05-29
---

## Goal

${input.goal}

## Criteria

${criteriaLines}${decisionBlock}
`;
}

test("creates a soma run from an ISA, keyed by slug, mapping goal + criteria", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const isaPath = await writeIsaFile(
      dir,
      "demo-create",
      isaMarkdown({
        slug: "demo-create",
        phase: "think",
        goal: "Ship the cross-substrate demo",
        criteria: [
          { id: "ISC-1", text: "first criterion" },
          { id: "ISC-2", text: "second criterion" },
        ],
      }),
    );

    const result = await syncAlgorithmRunFromIsa({ isaPath, substrate: "claude-code", somaHome });

    expect(result.created).toBe(true);
    expect(result.slug).toBe("demo-create");
    expect(result.runId).toBeTruthy();
    expect(result.criteriaTotal).toBe(2);

    const { run } = await readAlgorithmRunById(result.runId!, { somaHome });
    expect(run.substrate).toBe("claude-code");
    const criteria = getCriteria(run.isa);
    expect(criteria.map((c) => c.id)).toEqual(["ISC-1", "ISC-2"]);
    // Advanced forward to match ISA phase `think`.
    expect(getRunPhase(run)).toBe("think");
  });
});

test("resumes the existing run on a second sync of the same slug (no duplicate run)", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const isaPath = await writeIsaFile(
      dir,
      "demo-resume",
      isaMarkdown({
        slug: "demo-resume",
        phase: "think",
        goal: "Resume goal",
        criteria: [{ id: "ISC-1", text: "c1" }],
      }),
    );

    const first = await syncAlgorithmRunFromIsa({ isaPath, substrate: "claude-code", somaHome });
    expect(first.created).toBe(true);

    const second = await syncAlgorithmRunFromIsa({ isaPath, substrate: "claude-code", somaHome });
    expect(second.created).toBe(false);
    expect(second.runId).toBe(first.runId);
  });
});

test("advances the run forward across the build->execute gate, recording a synthetic change", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const isaPath = await writeIsaFile(
      dir,
      "demo-execute",
      isaMarkdown({
        slug: "demo-execute",
        phase: "execute",
        goal: "Reach execute",
        criteria: [{ id: "ISC-1", text: "c1" }],
      }),
    );

    const result = await syncAlgorithmRunFromIsa({ isaPath, substrate: "claude-code", somaHome });
    expect(result.phase).toBe("execute");

    const { run } = await readAlgorithmRunById(result.runId!, { somaHome });
    expect(getRunPhase(run)).toBe("execute");
    // A synthetic build change was recorded to satisfy the gate.
    expect(run.changelog.length).toBeGreaterThan(0);
  });
});

test("reconciles checked ISA criteria [x] into passed run criteria", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const isaPath = await writeIsaFile(
      dir,
      "demo-reconcile",
      isaMarkdown({
        slug: "demo-reconcile",
        phase: "verify",
        goal: "Reconcile criteria",
        criteria: [
          { id: "ISC-1", text: "first", done: true },
          { id: "ISC-2", text: "second", done: false },
        ],
      }),
    );

    const result = await syncAlgorithmRunFromIsa({ isaPath, substrate: "claude-code", somaHome });
    expect(result.criteriaPassed).toBe(1);
    expect(result.criteriaTotal).toBe(2);

    const { run } = await readAlgorithmRunById(result.runId!, { somaHome });
    const criteria = getCriteria(run.isa);
    expect(criteria.find((c) => c.id === "ISC-1")?.status).toBe("passed");
    expect(criteria.find((c) => c.id === "ISC-2")?.status).toBe("open");
  });
});

test("idempotent re-run with an unchanged ISA is a no-op (no extra changelog/verification)", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const isaPath = await writeIsaFile(
      dir,
      "demo-idempotent",
      isaMarkdown({
        slug: "demo-idempotent",
        phase: "execute",
        goal: "Idempotent goal",
        criteria: [
          { id: "ISC-1", text: "first", done: true },
          { id: "ISC-2", text: "second", done: false },
        ],
      }),
    );

    const first = await syncAlgorithmRunFromIsa({ isaPath, substrate: "claude-code", somaHome });
    const { run: runAfterFirst } = await readAlgorithmRunById(first.runId!, { somaHome });

    const second = await syncAlgorithmRunFromIsa({ isaPath, substrate: "claude-code", somaHome });
    expect(second.noop).toBe(true);
    const { run: runAfterSecond } = await readAlgorithmRunById(second.runId!, { somaHome });

    expect(runAfterSecond.changelog.length).toBe(runAfterFirst.changelog.length);
    expect(runAfterSecond.verification.length).toBe(runAfterFirst.verification.length);
    expect(getRunPhase(runAfterSecond)).toBe(getRunPhase(runAfterFirst));
  });
});

test("never advances the run backward when ISA phase is behind the run phase", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const isaPath = await writeIsaFile(
      dir,
      "demo-noback",
      isaMarkdown({
        slug: "demo-noback",
        phase: "execute",
        goal: "No backward",
        criteria: [{ id: "ISC-1", text: "c1" }],
      }),
    );
    const first = await syncAlgorithmRunFromIsa({ isaPath, substrate: "claude-code", somaHome });
    expect(first.phase).toBe("execute");

    // Now rewrite the ISA with an earlier phase.
    await writeFile(
      isaPath,
      isaMarkdown({
        slug: "demo-noback",
        phase: "think",
        goal: "No backward",
        criteria: [{ id: "ISC-1", text: "c1" }],
      }),
      "utf8",
    );
    const second = await syncAlgorithmRunFromIsa({ isaPath, substrate: "claude-code", somaHome });
    expect(second.phase).toBe("execute");
  });
});

test("malformed / non-ISA path is a no-op and never throws", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const garbage = join(dir, "not-an-isa.md");
    await writeFile(garbage, "this is not frontmatter at all\njust text\n", "utf8");

    const result = await syncAlgorithmRunFromIsa({ isaPath: garbage, substrate: "claude-code", somaHome });
    expect(result.noop).toBe(true);
    expect(result.created).toBe(false);
  });
});

test("missing path is a no-op and never throws", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const missing = join(dir, "does-not-exist.md");
    const result = await syncAlgorithmRunFromIsa({ isaPath: missing, substrate: "claude-code", somaHome });
    expect(result.noop).toBe(true);
    expect(result.created).toBe(false);
  });
});

test("promote-on-complete records learning and promotes when all criteria pass", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const isaPath = await writeIsaFile(
      dir,
      "demo-promote",
      isaMarkdown({
        slug: "demo-promote",
        phase: "learn",
        goal: "Promote goal",
        criteria: [{ id: "ISC-1", text: "only", done: true }],
        decisions: ["2026-05-29 key insight worth keeping"],
      }),
    );

    const result = await syncAlgorithmRunFromIsa({
      isaPath,
      substrate: "claude-code",
      somaHome,
      promoteOnComplete: true,
    });

    expect(result.phase).toBe("learn");
    expect(result.promoted).toBe(true);
    expect(result.promotionPath).toBeTruthy();

    const { run } = await readAlgorithmRunById(result.runId!, { somaHome });
    expect(run.learning.length).toBeGreaterThan(0);

    const promoted = await readFile(result.promotionPath!, "utf8");
    expect(promoted).toContain("Promote goal");
  });
});

test("CLI: soma algorithm sync-from-isa wires through and reports a summary", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const { runSomaCli } = await import("../src/cli");
    const isaPath = await writeIsaFile(
      dir,
      "demo-cli",
      isaMarkdown({
        slug: "demo-cli",
        phase: "think",
        goal: "CLI goal",
        criteria: [{ id: "ISC-1", text: "c1" }],
      }),
    );
    const text = await runSomaCli([
      "algorithm",
      "sync-from-isa",
      "--isa",
      isaPath,
      "--substrate",
      "claude-code",
      "--soma-home",
      somaHome,
    ]);
    expect(text).toContain("demo-cli");
    expect(text).toContain("phase: think");
    expect(text).toContain("created");
  });
});
