import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { syncAlgorithmRunFromVsa } from "../src/algorithm-vsa-sync";
import { readAlgorithmRunById } from "../src/algorithm-store";
import { getCriteria } from "../src/vsa-accessors";
import { getRunPhase } from "../src/algorithm-lifecycle";

async function withSomaHome<T>(fn: (somaHome: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soma-vsa-sync-"));
  const somaHome = join(dir, ".soma");
  try {
    return await fn(somaHome, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeVsaFile(dir: string, slug: string, markdown: string): Promise<string> {
  const vsaDir = join(dir, "work", slug);
  await mkdir(vsaDir, { recursive: true });
  const path = join(vsaDir, "VSA.md");
  await writeFile(path, markdown, "utf8");
  return path;
}

function vsaMarkdown(input: {
  slug: string;
  phase: string;
  progress?: string;
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
progress: ${input.progress ?? `0/${input.criteria.length}`}
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

test("creates a soma run from an VSA, keyed by slug, mapping goal + criteria", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const vsaPath = await writeVsaFile(
      dir,
      "demo-create",
      vsaMarkdown({
        slug: "demo-create",
        phase: "think",
        goal: "Ship the cross-substrate demo",
        criteria: [
          { id: "ISC-1", text: "first criterion" },
          { id: "ISC-2", text: "second criterion" },
        ],
      }),
    );

    const result = await syncAlgorithmRunFromVsa({
      vsaPath,
      substrate: "claude-code",
      somaHome,
      timestamp: "2026-06-02T10:00:00.000Z",
    });

    expect(result.created).toBe(true);
    expect(result.slug).toBe("2026-06-02-demo-create");
    expect(result.runId).toBeTruthy();
    expect(result.criteriaTotal).toBe(2);

    const { run } = await readAlgorithmRunById(result.runId!, { somaHome });
    expect(run.substrate).toBe("claude-code");
    expect(run.provenance.map((entry) => [entry.operation, entry.substrate])).toEqual([
      ["run.created", "claude-code"],
      // sync satisfies the OBSERVE current-state floor by reconstructing the probe
      // declared by the VSA's advanced phase.
      ["observation.record", "claude-code"],
      ["phase.advance", "claude-code"],
    ]);
    const criteria = getCriteria(run.vsa);
    expect(criteria.map((c) => c.id)).toEqual(["ISC-1", "ISC-2"]);
    // Advanced forward to match VSA phase `think`.
    expect(getRunPhase(run)).toBe("think");
  });
});

test("normalizes bare OBSERVE VSA slugs through dated Algorithm run ids", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const vsaPath = await writeVsaFile(
      dir,
      "switch-phish-to-learn",
      vsaMarkdown({
        slug: "switch-phish-to-learn",
        phase: "observe",
        goal: "Learn from the phishing switch",
        criteria: [{ id: "ISC-1", text: "the run id is date-prefixed" }],
      }),
    );

    const result = await syncAlgorithmRunFromVsa({
      vsaPath,
      substrate: "claude-code",
      somaHome,
      timestamp: "2026-06-02T11:30:00.000Z",
    });

    expect(result.created).toBe(true);
    expect(result.slug).toBe("2026-06-02-switch-phish-to-learn");
    expect(result.runId).toBe("2026-06-02-switch-phish-to-learn");

    const { run } = await readAlgorithmRunById(result.runId!, { somaHome });
    expect(run.id).toBe("2026-06-02-switch-phish-to-learn");
    expect(run.vsa.slug).toBe("2026-06-02-switch-phish-to-learn");

    const rewritten = await readFile(vsaPath, "utf8");
    expect(rewritten).toContain("slug: 2026-06-02-switch-phish-to-learn");
  });
});

test("resumes a normalized bare VSA when edited on a later date", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const vsaPath = await writeVsaFile(
      dir,
      "long-lived-bare",
      vsaMarkdown({
        slug: "long-lived-bare",
        phase: "observe",
        goal: "Keep one run across edits",
        criteria: [{ id: "ISC-1", text: "the run remains stable" }],
      }),
    );

    const first = await syncAlgorithmRunFromVsa({
      vsaPath,
      substrate: "claude-code",
      somaHome,
      timestamp: "2026-06-02T11:30:00.000Z",
    });
    const second = await syncAlgorithmRunFromVsa({
      vsaPath,
      substrate: "claude-code",
      somaHome,
      timestamp: "2026-06-03T11:30:00.000Z",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.runId).toBe("2026-06-02-long-lived-bare");
  });
});

test("keeps already dated OBSERVE VSA slugs stable on sync", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const vsaPath = await writeVsaFile(
      dir,
      "2026-06-02-already-dated",
      vsaMarkdown({
        slug: "2026-06-02-already-dated",
        phase: "observe",
        goal: "Do not double-prefix",
        criteria: [{ id: "ISC-1", text: "the run id is stable" }],
      }),
    );

    const result = await syncAlgorithmRunFromVsa({
      vsaPath,
      substrate: "claude-code",
      somaHome,
      timestamp: "2026-06-03T11:30:00.000Z",
    });

    expect(result.created).toBe(true);
    expect(result.runId).toBe("2026-06-02-already-dated");
  });
});

test("resumes the existing run on a second sync of the same slug (no duplicate run)", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const vsaPath = await writeVsaFile(
      dir,
      "demo-resume",
      vsaMarkdown({
        slug: "demo-resume",
        phase: "think",
        goal: "Resume goal",
        criteria: [{ id: "ISC-1", text: "c1" }],
      }),
    );

    const first = await syncAlgorithmRunFromVsa({ vsaPath, substrate: "claude-code", somaHome });
    expect(first.created).toBe(true);

    const second = await syncAlgorithmRunFromVsa({ vsaPath, substrate: "claude-code", somaHome });
    expect(second.created).toBe(false);
    expect(second.runId).toBe(first.runId);
  });
});

test("corrupt run index starts fresh and emits bounded debug output", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const vsaPath = await writeVsaFile(
      dir,
      "demo-corrupt-index",
      vsaMarkdown({
        slug: "demo-corrupt-index",
        phase: "think",
        goal: "Recover from corrupt index",
        criteria: [{ id: "ISC-1", text: "c1" }],
      }),
    );
    const stateDir = join(somaHome, "memory", "STATE");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "vsa-run-index.json"), "{not json", "utf8");

    let stderr = "";
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
    try {
      const result = await syncAlgorithmRunFromVsa({
        vsaPath,
        substrate: "claude-code",
        somaHome,
        timestamp: "2026-06-02T10:00:00.000Z",
      });
      expect(result.created).toBe(true);
      expect(result.slug).toBe("2026-06-02-demo-corrupt-index");
    } finally {
      stderrSpy.mockRestore();
    }

    expect(stderr).toContain("sync-from-isa");
    expect(stderr).toContain("ignored malformed vsa-run-index.json");
    expect(stderr.length).toBeLessThan(512);
  });
});

test("advances the run forward across the build->execute gate, recording a synthetic change", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const vsaPath = await writeVsaFile(
      dir,
      "demo-execute",
      vsaMarkdown({
        slug: "demo-execute",
        phase: "execute",
        goal: "Reach execute",
        criteria: [{ id: "ISC-1", text: "c1" }],
      }),
    );

    const result = await syncAlgorithmRunFromVsa({ vsaPath, substrate: "claude-code", somaHome });
    expect(result.phase).toBe("execute");

    const { run } = await readAlgorithmRunById(result.runId!, { somaHome });
    expect(getRunPhase(run)).toBe("execute");
    // A synthetic build change was recorded to satisfy the gate.
    expect(run.changelog.length).toBeGreaterThan(0);
  });
});

test("reconciles checked VSA criteria [x] into passed run criteria", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const vsaPath = await writeVsaFile(
      dir,
      "demo-reconcile",
      vsaMarkdown({
        slug: "demo-reconcile",
        phase: "verify",
        goal: "Reconcile criteria",
        criteria: [
          { id: "ISC-1", text: "first", done: true },
          { id: "ISC-2", text: "second", done: false },
        ],
      }),
    );

    const result = await syncAlgorithmRunFromVsa({ vsaPath, substrate: "claude-code", somaHome });
    expect(result.criteriaPassed).toBe(1);
    expect(result.criteriaTotal).toBe(2);

    const { run } = await readAlgorithmRunById(result.runId!, { somaHome });
    const criteria = getCriteria(run.vsa);
    expect(criteria.find((c) => c.id === "ISC-1")?.status).toBe("passed");
    expect(criteria.find((c) => c.id === "ISC-2")?.status).toBe("open");
  });
});

test("reconciles frontmatter progress when VSA checkboxes remain unticked", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const vsaPath = await writeVsaFile(
      dir,
      "demo-frontmatter-progress",
      vsaMarkdown({
        slug: "demo-frontmatter-progress",
        phase: "learn",
        progress: "3/3",
        goal: "Honor frontmatter completion",
        criteria: [
          { id: "ISC-1", text: "first", done: false },
          { id: "ISC-2", text: "second", done: false },
          { id: "ISC-3", text: "third", done: false },
        ],
      }),
    );

    const result = await syncAlgorithmRunFromVsa({ vsaPath, substrate: "claude-code", somaHome });
    expect(result.criteriaPassed).toBe(3);
    expect(result.criteriaTotal).toBe(3);
    // Passes fabricated from a frontmatter progress counter are specification-grade
    // only, so the LEARN integrity gate caps the run at VERIFY despite the VSA
    // frontmatter claiming `learn`. Reconciliation still marks the criteria passed.
    expect(result.phase).toBe("verify");

    const { run } = await readAlgorithmRunById(result.runId!, { somaHome });
    expect(getCriteria(run.vsa).map((c) => c.status)).toEqual(["passed", "passed", "passed"]);
    expect(getCriteria(run.vsa).every((c) => c.evidenceKind === "specified")).toBe(true);
    expect(run.verification.map((entry) => entry.text)).toContain(
      "ISC-1: passed. synced from VSA progress: Honor frontmatter completion",
    );
  });
});

test("frontmatter progress never reopens checked VSA criteria", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const vsaPath = await writeVsaFile(
      dir,
      "demo-frontmatter-lower",
      vsaMarkdown({
        slug: "demo-frontmatter-lower",
        phase: "verify",
        progress: "1/3",
        goal: "Prefer stronger checkbox signal",
        criteria: [
          { id: "ISC-1", text: "first", done: true },
          { id: "ISC-2", text: "second", done: true },
          { id: "ISC-3", text: "third", done: false },
        ],
      }),
    );

    const result = await syncAlgorithmRunFromVsa({ vsaPath, substrate: "claude-code", somaHome });
    expect(result.criteriaPassed).toBe(2);

    const { run } = await readAlgorithmRunById(result.runId!, { somaHome });
    expect(getCriteria(run.vsa).map((c) => c.status)).toEqual(["passed", "passed", "open"]);
  });
});

test("idempotent re-run with an unchanged VSA is a no-op (no extra changelog/verification)", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const vsaPath = await writeVsaFile(
      dir,
      "demo-idempotent",
      vsaMarkdown({
        slug: "demo-idempotent",
        phase: "execute",
        goal: "Idempotent goal",
        criteria: [
          { id: "ISC-1", text: "first", done: true },
          { id: "ISC-2", text: "second", done: false },
        ],
      }),
    );

    const first = await syncAlgorithmRunFromVsa({ vsaPath, substrate: "claude-code", somaHome });
    const { run: runAfterFirst } = await readAlgorithmRunById(first.runId!, { somaHome });

    const second = await syncAlgorithmRunFromVsa({ vsaPath, substrate: "claude-code", somaHome });
    expect(second.noop).toBe(true);
    const { run: runAfterSecond } = await readAlgorithmRunById(second.runId!, { somaHome });

    expect(runAfterSecond.changelog.length).toBe(runAfterFirst.changelog.length);
    expect(runAfterSecond.verification.length).toBe(runAfterFirst.verification.length);
    expect(getRunPhase(runAfterSecond)).toBe(getRunPhase(runAfterFirst));
  });
});

test("never advances the run backward when VSA phase is behind the run phase", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const vsaPath = await writeVsaFile(
      dir,
      "demo-noback",
      vsaMarkdown({
        slug: "demo-noback",
        phase: "execute",
        goal: "No backward",
        criteria: [{ id: "ISC-1", text: "c1" }],
      }),
    );
    const first = await syncAlgorithmRunFromVsa({ vsaPath, substrate: "claude-code", somaHome });
    expect(first.phase).toBe("execute");

    // Now rewrite the VSA with an earlier phase.
    await writeFile(
      vsaPath,
      vsaMarkdown({
        slug: "demo-noback",
        phase: "think",
        goal: "No backward",
        criteria: [{ id: "ISC-1", text: "c1" }],
      }),
      "utf8",
    );
    const second = await syncAlgorithmRunFromVsa({ vsaPath, substrate: "claude-code", somaHome });
    expect(second.phase).toBe("execute");
  });
});

test("malformed / non-VSA path is a no-op and never throws", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const garbage = join(dir, "not-an-isa.md");
    await writeFile(garbage, "this is not frontmatter at all\njust text\n", "utf8");

    const result = await syncAlgorithmRunFromVsa({ vsaPath: garbage, substrate: "claude-code", somaHome });
    expect(result.noop).toBe(true);
    expect(result.created).toBe(false);
  });
});

test("missing path is a no-op and never throws", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const missing = join(dir, "does-not-exist.md");
    const result = await syncAlgorithmRunFromVsa({ vsaPath: missing, substrate: "claude-code", somaHome });
    expect(result.noop).toBe(true);
    expect(result.created).toBe(false);
  });
});

test("promote-on-complete records learning and promotes when all criteria pass", async () => {
  await withSomaHome(async (somaHome, dir) => {
    const vsaPath = await writeVsaFile(
      dir,
      "demo-promote",
      vsaMarkdown({
        slug: "demo-promote",
        phase: "learn",
        goal: "Promote goal",
        criteria: [{ id: "ISC-1", text: "only", done: true }],
        decisions: ["2026-05-29 key insight worth keeping"],
      }),
    );

    const result = await syncAlgorithmRunFromVsa({
      vsaPath,
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
    const vsaPath = await writeVsaFile(
      dir,
      "demo-cli",
      vsaMarkdown({
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
      vsaPath,
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
