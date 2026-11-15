import { expect, test } from "bun:test";
import { parseGraphArgs, runGraphCli } from "../src/cli/graph";
import { rankSubtree, type GraphStore, type NodeState, type WorkGraphNode } from "../src/graph/index";
import { walkFakeSubtree } from "./fixtures/work-graph-fixtures";

const REPO = { forge: "github", host: "github.com", path: "the-metafactory/soma" } as const;

interface Seed { status?: "open" | "closed"; children?: string[]; blockedBy?: string[] }

function fixture(seeds: Record<string, Seed>) {
  const unsupported = async (): Promise<never> => { throw new Error("Unexpected store operation"); };
  const readNode = async ({ id }: { id: string }): Promise<NodeState> => {
    const seed = seeds[id];
    if (seed === undefined) throw new Error(`no such node ${id}`);
    return {
      ref: { id }, node: { id, title: `node ${id}`, autonomy: "propose", checkpointId: "cp" } as WorkGraphNode,
      status: seed.status ?? "open", updatedAt: "2026-11-15T10:00:00Z", assignees: [], author: "ivy-bot", typed: true,
      blockedBy: (seed.blockedBy ?? []).map((blocker) => ({ id: blocker, status: seeds[blocker]?.status ?? "open" })),
    };
  };
  const store: GraphStore = {
    attestation: "verifiable", actingIdentity: async () => "ivy-bot", checkConfinement: unsupported,
    createNode: unsupported, attachToParent: unsupported, addBlockingEdge: unsupported, readNode,
    readSubtree: async (root) => await walkFakeSubtree(root, (id) => seeds[id]?.children ?? [], readNode),
    claim: unsupported, release: unsupported, postComment: unsupported, readComment: unsupported,
    readCommentReactions: unsupported, listComments: unsupported, readRawBody: unsupported, writeRawBody: unsupported, close: unsupported,
  };
  const run = async (args: string[]) => await runGraphCli(parseGraphArgs(["graph", "frontier", "1", ...args, "--repo", REPO.path]), {
    createStore: () => store, resolveRepo: async () => REPO, assertInstalledRuntime: async () => undefined,
  });
  const order = async (): Promise<{ id: string; rank: { unblocks: number; depth: number } }[]> =>
    (JSON.parse(await run(["--json"])) as { frontier: { ref: { id: string }; rank: { unblocks: number; depth: number } }[] }).frontier
      .map((state) => ({ id: state.ref.id, rank: state.rank }));
  return { run, order };
}

const MAP = (rootChildren: string[]): Record<string, Seed> => ({
  "1": { children: rootChildren },
  "2": { children: ["99"] },
  "3": { status: "closed", children: ["10", "11", "12", "13", "14"] },
  "10": {},
  "11": { blockedBy: ["10"] },
  "12": { blockedBy: ["10"] },
  "13": { blockedBy: ["12"] },
  "14": { status: "closed", blockedBy: ["2"] },
  "99": { status: "closed" },
  "77": { blockedBy: ["2"] },
});

test("a deep node that blocks three open nodes outranks a shallow one that blocks none", async () => {
  const fx = fixture(MAP(["2", "3"]));
  expect(await fx.order()).toEqual([
    { id: "10", rank: { unblocks: 3, depth: 2 } },
    { id: "2", rank: { unblocks: 0, depth: 1 } },
  ]);
  expect(await fx.run([])).toContain("- 10 node 10 [propose, no kind, typed] — unblocks 3 · depth 2\n- 2 node 2 [propose, no kind, typed] — unblocks 0 · depth 1\n");
});

test("a blocked node outside the map subtree, or a closed one, does not count toward unblocks", () => {
  const blocked = (id: string, blockers: string[], status: "open" | "closed" = "open"): NodeState => ({
    ref: { id }, node: { id, title: id, autonomy: "propose" }, status, updatedAt: "", assignees: [], author: "", typed: true,
    blockedBy: blockers.map((blocker) => ({ id: blocker, status: "open" })), parent: { id: "1" },
  });
  const ranks = rankSubtree({ id: "1" }, [blocked("2", []), blocked("14", ["2"], "closed")]);
  expect(ranks.get("2")).toEqual({ unblocks: 0, depth: 1 });
});

test("with equal unblocks, the shallower node comes first even when the deeper one is older", async () => {
  const fx = fixture({ "1": { children: ["30", "5"] }, "30": {}, "5": { status: "closed", children: ["4"] }, "4": {} });
  expect((await fx.order()).map((entry) => entry.id)).toEqual(["30", "4"]);
});

test("with equal unblocks and depth, the older node (lower number) comes first, compared as numbers", async () => {
  const fx = fixture({ "1": { children: ["30", "8", "100"] }, "30": {}, "8": {}, "100": {} });
  expect((await fx.order()).map((entry) => entry.id)).toEqual(["8", "30", "100"]);
});

test("the order does not depend on store order, and ids without a number tie-break on the id", async () => {
  const seeds = (children: string[]): Record<string, Seed> => ({ ...MAP(children), "b": {}, "a": {} });
  const first = await fixture(seeds(["2", "3", "b", "a"])).order();
  const second = await fixture(seeds(["a", "3", "b", "2"])).order();
  expect(first).toEqual(second);
  expect(first.map((entry) => entry.id)).toEqual(["10", "2", "a", "b"]);
});
