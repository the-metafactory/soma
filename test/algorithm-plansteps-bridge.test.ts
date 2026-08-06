import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAlgorithmBatch,
  createAlgorithmRun,
  deriveBridgedPlanStepStatus,
  markUnbridgedPlanStepsDone,
  readAlgorithmRunById,
  setAlgorithmPlan,
  syncBridgedPlanStep,
  updateAlgorithmPlanStep,
  writeAlgorithmRun,
} from "../src/index";
import type { AlgorithmRun, BridgedNodeReport } from "../src/index";
import { parseAlgorithmArgs, runAlgorithmCli } from "../src/cli/algorithm";

// docs/work-graph.md §2.7 — planSteps bridge. A bridged step's status is the
// NODE's to report; the run caches it. Every test here defends the same
// property: one work item never has two authoritative homes.

function freshRun(): AlgorithmRun {
  return setAlgorithmPlan(
    createAlgorithmRun({
      id: "bridge-run",
      timestamp: "2026-08-06T10:00:00.000Z",
      prompt: "Bridge a plan step to a work-graph node",
      intent: "Status derives from the node.",
      currentState: "planSteps own their status outright.",
      goal: "A bridged step defers to its node.",
      criteria: [{ id: "C1", text: "Direct status writes on a bridged step are refused." }],
    }),
    [
      { id: "P1", text: "Bridged work", criteriaIds: ["C1"], status: "open" },
      { id: "P2", text: "Run-owned work", criteriaIds: ["C1"], status: "open" },
    ],
    "2026-08-06T10:01:00.000Z",
  );
}

function report(overrides: Partial<BridgedNodeReport> = {}): BridgedNodeReport {
  return { ref: { id: "501" }, status: "open", ...overrides };
}

function stepOf(run: AlgorithmRun, id: string) {
  const step = run.planSteps.find((candidate) => candidate.id === id);
  if (step === undefined) throw new Error(`missing step ${id}`);
  return step;
}

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-plansteps-bridge-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

// --- the refusal -----------------------------------------------------------

test("a direct status write on a bridged step is REFUSED", () => {
  const bridged = syncBridgedPlanStep(freshRun(), "P1", report(), { bind: true }, "2026-08-06T10:02:00.000Z");

  expect(() => updateAlgorithmPlanStep(bridged, "P1", "done", "I say it is done.")).toThrow(
    /bridged to work-graph node 501/u,
  );
  // The refusal names the read path, so the caller learns the legitimate move.
  expect(() => updateAlgorithmPlanStep(bridged, "P1", "done")).toThrow(/soma graph node 501 --json/u);
  // …and nothing was written: the step still reads as the node reported it.
  expect(stepOf(bridged, "P1").status).toBe("open");
});

test("an unbridged step on the same run still takes a direct write", () => {
  let run = syncBridgedPlanStep(freshRun(), "P1", report(), { bind: true }, "2026-08-06T10:02:00.000Z");
  run = updateAlgorithmPlanStep(run, "P2", "done", "Run owns this one.", "2026-08-06T10:03:00.000Z");

  expect(stepOf(run, "P2").status).toBe("done");
  expect(stepOf(run, "P2").evidence).toBe("Run owns this one.");
  expect(stepOf(run, "P2").nodeId).toBeUndefined();
});

test("the batch `step` operation is refused on a bridged step too — one contract, not one call site", () => {
  const bridged = syncBridgedPlanStep(freshRun(), "P1", report(), { bind: true }, "2026-08-06T10:02:00.000Z");

  expect(() =>
    applyAlgorithmBatch(bridged, [{ kind: "step", stepId: "P1", status: "done", evidence: "batched" }]),
  ).toThrow(/bridged to work-graph node 501/u);
});

// --- the derivation --------------------------------------------------------

test("a closed node is the only `done`", () => {
  expect(deriveBridgedPlanStepStatus(report({ status: "closed" }))).toBe("done");
  expect(deriveBridgedPlanStepStatus(report({ status: "open" }))).toBe("open");
});

test("an open node with an open blocker derives `blocked`", () => {
  expect(
    deriveBridgedPlanStepStatus(report({ blockedBy: [{ id: "499", status: "open" }] })),
  ).toBe("blocked");
  expect(
    deriveBridgedPlanStepStatus(report({ blockedBy: [{ id: "499", status: "closed" }] })),
  ).toBe("open");
  expect(
    deriveBridgedPlanStepStatus(
      report({ blockedBy: [{ id: "499", status: "closed" }, { id: "502", status: "open" }] }),
    ),
  ).toBe("blocked");
});

test("sync records WHICH node it derived from and when — a derived status must not read like a written one", () => {
  const run = syncBridgedPlanStep(
    freshRun(),
    "P1",
    report({ status: "closed" }),
    { bind: true },
    "2026-08-06T10:02:00.000Z",
  );

  expect(stepOf(run, "P1")).toMatchObject({
    nodeId: "501",
    status: "done",
    evidence: "derived from work-graph node 501 (closed) at 2026-08-06T10:02:00.000Z",
  });
  expect(run.updatedAt).toBe("2026-08-06T10:02:00.000Z");
});

test("binding and deriving are one act — a step is never bridged while carrying its stale status", () => {
  let run = freshRun();
  run = updateAlgorithmPlanStep(run, "P1", "done", "hand-written before the bridge existed", "2026-08-06T10:02:00.000Z");
  expect(stepOf(run, "P1").status).toBe("done");

  run = syncBridgedPlanStep(run, "P1", report({ status: "open" }), { bind: true }, "2026-08-06T10:03:00.000Z");
  expect(stepOf(run, "P1").status).toBe("open");
  expect(stepOf(run, "P1").evidence).not.toContain("hand-written");
});

test("syncing a bridged step from a DIFFERENT node's report is refused", () => {
  const bridged = syncBridgedPlanStep(freshRun(), "P1", report(), { bind: true }, "2026-08-06T10:02:00.000Z");

  expect(() =>
    syncBridgedPlanStep(bridged, "P1", report({ ref: { id: "502" }, status: "closed" })),
  ).toThrow(/bridged to work-graph node 501, but the reported node is 502/u);
});

test("syncing an unbridged step is refused — there is no node to derive from", () => {
  expect(() => syncBridgedPlanStep(freshRun(), "P2", report())).toThrow(/not bridged to a work-graph node/u);
});

test("syncing an unknown step is refused", () => {
  expect(() => syncBridgedPlanStep(freshRun(), "P9", report(), { bind: true })).toThrow(
    /plan step not found: P9/u,
  );
});

// --- the other write path: the VSA sync's bulk flip ------------------------

test("the VERIFY sweep skips bridged steps rather than forging `done`", () => {
  const run = syncBridgedPlanStep(freshRun(), "P1", report({ status: "open" }), { bind: true }, "2026-08-06T10:02:00.000Z");
  const swept = markUnbridgedPlanStepsDone(run.planSteps, "synced from VSA");

  expect(swept.find((step) => step.id === "P1")).toMatchObject({
    status: "open",
    evidence: "derived from work-graph node 501 (open) at 2026-08-06T10:02:00.000Z",
  });
  expect(swept.find((step) => step.id === "P2")).toMatchObject({ status: "done", evidence: "synced from VSA" });
});

// --- the CLI surface ------------------------------------------------------

test("`step --node` bridges through the graph read path, and `--status` is then refused", async () => {
  await withTempHome(async (homeDir) => {
    await writeAlgorithmRun(freshRun(), { homeDir });

    const reads: { nodeId: string; repo?: string }[] = [];
    const deps = {
      readNode: async (nodeId: string, options: { repo?: string }) => {
        reads.push({ nodeId, repo: options.repo });
        return report({ ref: { id: nodeId }, status: "closed" as const });
      },
    };

    const bound = await runAlgorithmCli(
      parseAlgorithmArgs([
        "algorithm",
        "step",
        "--home-dir",
        homeDir,
        "--id",
        "bridge-run",
        "--step-id",
        "P1",
        "--node",
        "501",
        "--repo",
        "the-metafactory/soma",
      ]),
      deps,
    );

    expect(reads).toEqual([{ nodeId: "501", repo: "the-metafactory/soma" }]);
    // The render names the node: the status's authority is visible on sight.
    expect(bound).toContain("→ node 501");
    expect(bound).toContain("[done] P1");

    const { run: persisted } = await readAlgorithmRunById("bridge-run", { homeDir });
    expect(stepOf(persisted, "P1").nodeId).toBe("501");
    expect(stepOf(persisted, "P1").status).toBe("done");

    await expect(
      runAlgorithmCli(
        parseAlgorithmArgs([
          "algorithm",
          "step",
          "--home-dir",
          homeDir,
          "--id",
          "bridge-run",
          "--step-id",
          "P1",
          "--status",
          "open",
        ]),
        deps,
      ),
    ).rejects.toThrow(/bridged to work-graph node 501/u);
  });
});

test("`step --sync` re-derives from the step's OWN node — the node id comes off the run, not argv", async () => {
  await withTempHome(async (homeDir) => {
    const run = syncBridgedPlanStep(freshRun(), "P1", report({ status: "open" }), { bind: true }, "2026-08-06T10:02:00.000Z");
    await writeAlgorithmRun(run, { homeDir });

    const reads: string[] = [];
    const output = await runAlgorithmCli(
      parseAlgorithmArgs(["algorithm", "step", "--home-dir", homeDir, "--id", "bridge-run", "--step-id", "P1", "--sync"]),
      {
        readNode: async (nodeId: string) => {
          reads.push(nodeId);
          return report({ ref: { id: nodeId }, status: "closed" as const });
        },
      },
    );

    expect(reads).toEqual(["501"]);
    expect(output).toContain("[done] P1");
  });
});

test("`step --sync` on an unbridged step is refused before any read", async () => {
  await withTempHome(async (homeDir) => {
    await writeAlgorithmRun(freshRun(), { homeDir });

    let read = false;
    await expect(
      runAlgorithmCli(
        parseAlgorithmArgs(["algorithm", "step", "--home-dir", homeDir, "--id", "bridge-run", "--step-id", "P2", "--sync"]),
        {
          readNode: async (nodeId: string) => {
            read = true;
            return report({ ref: { id: nodeId } });
          },
        },
      ),
    ).rejects.toThrow(/not bridged to a work-graph node/u);
    expect(read).toBe(false);
  });
});

test("`--status` combined with `--node` or `--sync` is refused rather than silently preferring one", async () => {
  await withTempHome(async (homeDir) => {
    await writeAlgorithmRun(freshRun(), { homeDir });
    const deps = { readNode: async (nodeId: string) => report({ ref: { id: nodeId } }) };
    const base = ["algorithm", "step", "--home-dir", homeDir, "--id", "bridge-run", "--step-id", "P1"];

    await expect(
      runAlgorithmCli(parseAlgorithmArgs([...base, "--node", "501", "--status", "done"]), deps),
    ).rejects.toThrow(/--status cannot be combined with --node or --sync/u);

    await expect(runAlgorithmCli(parseAlgorithmArgs([...base, "--node", "501", "--sync"]), deps)).rejects.toThrow(
      /pass one of --node or --sync/u,
    );
  });
});
