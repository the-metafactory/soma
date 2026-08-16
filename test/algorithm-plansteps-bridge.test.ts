import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceAlgorithmRun,
  applyAlgorithmBatch,
  createAlgorithmRun,
  deriveBridgedPlanStepStatus,
  getRunPhase,
  readAlgorithmRunById,
  setAlgorithmPlan,
  syncBridgedPlanStep,
  updateAlgorithmPlanStep,
  writeAlgorithmRun,
} from "../src/index";
import type { AlgorithmRun, BridgedNodeReport } from "../src/index";
// Not on the public barrel — its one production consumer imports it here too.
import { markUnbridgedPlanStepsDone } from "../src/algorithm";
import type { GraphStore, NodeRef, NodeState } from "../src/work-graph";
import { readNodeForBridge } from "../src/work-graph-bridge";
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
  return { ref: { id: "501" }, status: "open", blockedBy: [], ...overrides };
}

/**
 * A FULL `NodeState` — every field a real `readNode` returns, not the three the
 * derivation happens to touch. `BridgedNodeReport` is `Pick`ed from `NodeState`,
 * and this is what proves the two still line up: if the graph adds a required
 * field to the picked set, or the report's shape drifts, this stops compiling.
 * The hand-built `report()` fixtures cannot catch that (Sage, PR #555).
 */
function realNodeState(overrides: Partial<NodeState> = {}): NodeState {
  return {
    ref: { id: "501" },
    node: {
      id: "501",
      title: "planSteps nodeId bridge (spec §2.7)",
      autonomy: "auto",
      kind: "task",
      checkpointId: "cp-501",
      probes: [{ type: "git-ref-exists", ref: "main" }],
    },
    status: "open",
    assignees: ["jcfischer"],
    blockedBy: [],
    author: "jcfischer",
    parent: { id: "495" },
    typed: true,
    ...overrides,
  };
}

/**
 * A `GraphStore` whose only real method is `readNode` — injected at the STORE
 * seam so `WorkGraph.readNode` (the contract layer) actually runs, which is what
 * the CLI tests' reader injection skips past.
 */
function stubStore(readNode: (ref: NodeRef) => NodeState): GraphStore {
  return {
    attestation: "unverified",
    createNode: async () => ({ id: "unused" }),
    addBlockingEdge: async () => {},
    readNode: async (ref) => readNode(ref),
    readSubtree: async () => [],
    claim: async () => ({ held: true, identity: "jcfischer", holder: null, assignees: [] }),
    release: async () => ({ released: true, identity: "jcfischer", assignees: [] }),
    postComment: async () => ({ id: "c1", nodeId: "501" }),
    readComment: async () => ({ id: "c1", nodeId: "501" }),
    readCommentReactions: async () => [],
    listComments: async () => [],
    readRawBody: async () => "",
    writeRawBody: async () => {},
    close: async () => {},
  };
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

test("`bind` does not license re-homing an already-bridged step", () => {
  const bridged = syncBridgedPlanStep(freshRun(), "P1", report(), { bind: true }, "2026-08-06T10:02:00.000Z");

  // Without this, `bind: true` made the mismatch refusal unreachable from the one
  // caller that always sets it — a typo'd `--node` moved the step silently.
  expect(() =>
    syncBridgedPlanStep(bridged, "P1", report({ ref: { id: "502" }, status: "closed" }), { bind: true }),
  ).toThrow(/already bridged to work-graph node 501; refusing to re-home it to 502/u);
  expect(stepOf(bridged, "P1").nodeId).toBe("501");
  expect(stepOf(bridged, "P1").status).toBe("open");
});

test("re-binding a step to the SAME node is a plain re-derive, not a re-home", () => {
  let run = syncBridgedPlanStep(freshRun(), "P1", report(), { bind: true }, "2026-08-06T10:02:00.000Z");
  run = syncBridgedPlanStep(run, "P1", report({ status: "closed" }), { bind: true }, "2026-08-06T10:03:00.000Z");

  expect(stepOf(run, "P1").status).toBe("done");
});

// --- the other write paths -------------------------------------------------

test("setAlgorithmPlan refuses to AUTHOR a bridged step — bridging is not a planning act", () => {
  const run = createAlgorithmRun({
    id: "bridge-run",
    timestamp: "2026-08-06T10:00:00.000Z",
    prompt: "Bridge a plan step to a work-graph node",
    intent: "Status derives from the node.",
    currentState: "planSteps own their status outright.",
    goal: "A bridged step defers to its node.",
    criteria: [{ id: "C1", text: "Direct status writes on a bridged step are refused." }],
  });

  // The third write path: `setAlgorithmPlan` replaces planSteps[] wholesale with
  // caller-authored status, so it could mint a bridged step whose `done` never
  // came from a node.
  expect(() =>
    setAlgorithmPlan(run, [{ id: "P1", text: "Bridged work", criteriaIds: ["C1"], status: "done", nodeId: "501" }]),
  ).toThrow(/cannot be bridged to work-graph node 501 by setAlgorithmPlan/u);
});

test("setAlgorithmPlan refuses to UN-bridge a step by reusing its id without the nodeId", () => {
  const bridged = syncBridgedPlanStep(freshRun(), "P1", report(), { bind: true }, "2026-08-06T10:02:00.000Z");

  // The incoming-only guard left this open: an unbridged step reusing a bridged
  // id dropped the bridge silently, after which a hand-written `done` was
  // accepted on a step a reader still believed was node-derived.
  expect(() =>
    setAlgorithmPlan(bridged, [
      { id: "P1", text: "Bridged work", criteriaIds: ["C1"], status: "done" },
      { id: "P2", text: "Run-owned work", criteriaIds: ["C1"], status: "open" },
    ]),
  ).toThrow(/bridged to work-graph node 501; setAlgorithmPlan cannot un-bridge it/u);

  // Dropping the step is a different act and stays legal — the step ceases to
  // exist, so nothing claims a node backs it.
  const replanned = setAlgorithmPlan(
    bridged,
    [{ id: "P2", text: "Run-owned work", criteriaIds: ["C1"], status: "open" }],
    "2026-08-06T10:03:00.000Z",
  );
  expect(replanned.planSteps.map((step) => step.id)).toEqual(["P2"]);
});

test("the un-bridge refusal is a speed bump, not a seal — remove-then-re-add reaches the same end state", () => {
  // Pinning the LIMIT, not the guarantee. The refusal is per-call and nothing
  // sees across two, so this sequence works — and the docs and the `status`
  // docblock must keep saying so. If a future change closes it, this test fails
  // and the claim gets upgraded deliberately rather than by accident.
  const bridged = syncBridgedPlanStep(freshRun(), "P1", report(), { bind: true }, "2026-08-06T10:02:00.000Z");

  const removed = setAlgorithmPlan(
    bridged,
    [{ id: "P2", text: "Run-owned work", criteriaIds: ["C1"], status: "open" }],
    "2026-08-06T10:03:00.000Z",
  );
  const readded = setAlgorithmPlan(
    removed,
    [
      { id: "P1", text: "Bridged work", criteriaIds: ["C1"], status: "open" },
      { id: "P2", text: "Run-owned work", criteriaIds: ["C1"], status: "open" },
    ],
    "2026-08-06T10:04:00.000Z",
  );

  expect(stepOf(readded, "P1").nodeId).toBeUndefined();
  // …and the step is now genuinely run-owned, so a direct write is correct.
  const written = updateAlgorithmPlanStep(readded, "P1", "done", "run owns it now", "2026-08-06T10:05:00.000Z");
  expect(stepOf(written, "P1").status).toBe("done");
});

test("a real NodeState is accepted verbatim as a BridgedNodeReport", () => {
  // The type claims `NodeState` satisfies it; this is the claim being exercised
  // with a value rather than restated in a comment.
  const state = realNodeState({ status: "closed" });
  const run = syncBridgedPlanStep(freshRun(), "P1", state, { bind: true }, "2026-08-06T10:02:00.000Z");

  expect(stepOf(run, "P1")).toMatchObject({ nodeId: "501", status: "done" });
  expect(deriveBridgedPlanStepStatus(realNodeState({ blockedBy: [{ id: "499", status: "open" }] }))).toBe("blocked");
  expect(deriveBridgedPlanStepStatus(realNodeState())).toBe("open");
});

// --- the other write path: the VSA sync's bulk flip ------------------------

test("an OPEN bridged step really does hold the run short of the VERIFY gate", () => {
  // The skip's advertised cost — "leaves the run short of the VERIFY gate until
  // its node closes" — was asserted in a comment and verified nowhere. If the
  // gate read criteria alone, the cost would not exist and the skip would be
  // silent (Sage, PR #555). Walk the run to EXECUTE and try to advance.
  let run = freshRun();
  run = syncBridgedPlanStep(run, "P1", report({ status: "open" }), { bind: true }, "2026-08-06T10:02:00.000Z");
  run = updateAlgorithmPlanStep(run, "P2", "done", "run-owned, finished", "2026-08-06T10:03:00.000Z");
  run = {
    ...run,
    observations: [
      { timestamp: "2026-08-06T10:04:00.000Z", claim: "the gate fires", evidence: "this test", evidenceKind: "tested" },
    ],
    capabilities: ["sequential-analysis"],
    changelog: [{ timestamp: "2026-08-06T10:06:00.000Z", phase: "build", text: "bridged the step" }],
  };
  while (getRunPhase(run) !== "execute") {
    run = advanceAlgorithmRun(run, "2026-08-06T10:07:00.000Z");
  }

  expect(() => advanceAlgorithmRun(run, "2026-08-06T10:08:00.000Z")).toThrow(/every plan step is done or blocked/u);

  // …and closing the node releases it. The cost is real and it is bounded.
  const closed = syncBridgedPlanStep(run, "P1", report({ status: "closed" }), {}, "2026-08-06T10:09:00.000Z");
  expect(getRunPhase(advanceAlgorithmRun(closed, "2026-08-06T10:10:00.000Z"))).toBe("verify");
});

test("the VERIFY sweep skips bridged steps rather than forging `done`", () => {
  const run = syncBridgedPlanStep(freshRun(), "P1", report({ status: "open" }), { bind: true }, "2026-08-06T10:02:00.000Z");
  const swept = markUnbridgedPlanStepsDone(run.planSteps, "synced from VSA");

  expect(swept.find((step) => step.id === "P1")).toMatchObject({
    status: "open",
    evidence: "derived from work-graph node 501 (open) at 2026-08-06T10:02:00.000Z",
  });
  expect(swept.find((step) => step.id === "P2")).toMatchObject({ status: "done", evidence: "synced from VSA" });
});

// --- the reader itself ----------------------------------------------------

test("readNodeForBridge returns a report the derivation accepts, through the real WorkGraph", async () => {
  // The reader had no test of its own: the CLI tests inject past it, so nothing
  // showed a `GraphStore` response surviving `WorkGraph.readNode` as a conformant
  // `BridgedNodeReport`. Inject at the STORE seam instead of at the reader, so the
  // contract layer actually runs.
  const calls: string[] = [];
  const store = stubStore((ref) => {
    calls.push(ref.id);
    return realNodeState({ ref, status: "open", blockedBy: [{ id: "499", status: "open" }] });
  });

  const state = await readNodeForBridge("501", { repo: "the-metafactory/soma", createStore: () => store });

  expect(calls).toEqual(["501"]);
  // The returned NodeState is passed straight to the derivation — no adaptation
  // step, which is the whole claim of `Pick`ing the report type from `NodeState`.
  expect(deriveBridgedPlanStepStatus(state)).toBe("blocked");
  const run = syncBridgedPlanStep(freshRun(), "P1", state, { bind: true }, "2026-08-06T10:02:00.000Z");
  expect(stepOf(run, "P1")).toMatchObject({ nodeId: "501", status: "blocked" });
});

test("readNodeForBridge resolves the repo when none is passed", async () => {
  const repos: string[] = [];
  await readNodeForBridge("501", {
    resolveRepo: async () => "the-metafactory/soma",
    createStore: (repo: string) => {
      repos.push(repo);
      return stubStore((ref) => realNodeState({ ref }));
    },
  });

  expect(repos).toEqual(["the-metafactory/soma"]);
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

test("a concurrent re-bind between the two reads fails CLOSED, not silently", async () => {
  await withTempHome(async (homeDir) => {
    // `--sync` reads the run to learn which node the step defers to, then
    // `updateAndReportAlgorithmRun` reads it again to mutate. A concurrent write
    // between the two could bind against a stale nodeId — but the mutator derives
    // `nodeId` from the FRESH run and `syncBridgedPlanStep` refuses a report that
    // names a different node, so the race is caught rather than absorbed. Simulate
    // it by rewriting the run inside the injected read.
    await writeAlgorithmRun(
      syncBridgedPlanStep(freshRun(), "P1", report(), { bind: true }, "2026-08-06T10:02:00.000Z"),
      { homeDir },
    );

    await expect(
      runAlgorithmCli(
        parseAlgorithmArgs(["algorithm", "step", "--home-dir", homeDir, "--id", "bridge-run", "--step-id", "P1", "--sync"]),
        {
          readNode: async (nodeId: string) => {
            // Someone re-plans the step onto node 777 while we hold node 501's state.
            await writeAlgorithmRun(
              syncBridgedPlanStep(freshRun(), "P1", report({ ref: { id: "777" } }), { bind: true }, "2026-08-06T10:03:00.000Z"),
              { homeDir },
            );
            return report({ ref: { id: nodeId }, status: "closed" });
          },
        },
      ),
    ).rejects.toThrow(/bridged to work-graph node 777, but the reported node is 501/u);

    // The stale `closed` was NOT written.
    const { run } = await readAlgorithmRunById("bridge-run", { homeDir });
    expect(stepOf(run, "P1")).toMatchObject({ nodeId: "777", status: "open" });
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

test("`--status` or `--evidence` combined with `--node`/`--sync` is refused rather than silently preferring one", async () => {
  await withTempHome(async (homeDir) => {
    await writeAlgorithmRun(freshRun(), { homeDir });
    const deps = { readNode: async (nodeId: string) => report({ ref: { id: nodeId } }) };
    const base = ["algorithm", "step", "--home-dir", homeDir, "--id", "bridge-run", "--step-id", "P1"];

    await expect(
      runAlgorithmCli(parseAlgorithmArgs([...base, "--node", "501", "--status", "done"]), deps),
    ).rejects.toThrow(/--status cannot be combined with --node or --sync/u);

    // --evidence was accepted and then silently discarded by the derived pointer.
    await expect(
      runAlgorithmCli(parseAlgorithmArgs([...base, "--node", "501", "--evidence", "I checked"]), deps),
    ).rejects.toThrow(/--evidence cannot be combined with --node or --sync/u);

    await expect(runAlgorithmCli(parseAlgorithmArgs([...base, "--node", "501", "--sync"]), deps)).rejects.toThrow(
      /pass one of --node or --sync/u,
    );
  });
});

test("the bridge flags are scoped to `step` — they do not widen every subcommand", () => {
  for (const flags of [["--node", "501"], ["--sync"], ["--repo", "the-metafactory/soma"]]) {
    expect(() => parseAlgorithmArgs(["algorithm", "decision", "--id", "r", "--text", "t", ...flags])).toThrow(
      /is only valid for step/u,
    );
  }
  // …and still parse on `step` itself.
  expect(() =>
    parseAlgorithmArgs(["algorithm", "step", "--id", "r", "--step-id", "P1", "--node", "501", "--repo", "o/n"]),
  ).not.toThrow();
});

test("the `--status`-required message names the flag that is actually missing", async () => {
  await withTempHome(async (homeDir) => {
    await writeAlgorithmRun(freshRun(), { homeDir });
    await expect(
      runAlgorithmCli(
        parseAlgorithmArgs(["algorithm", "step", "--home-dir", homeDir, "--id", "bridge-run", "--step-id", "P1"]),
        { readNode: async (nodeId: string) => report({ ref: { id: nodeId } }) },
      ),
    ).rejects.toThrow("--status is required (or use --node/--sync for a bridged step).");
  });
});
