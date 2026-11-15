import { expect, test } from "bun:test";
import { SomaCliError } from "../src/cli/errors";
import { parseGraphArgs, runGraphCli } from "../src/cli/graph";
import { decodeNodeBlock, encodeNodeBlock, parseNodeSpec, type CreateNodeSpec, type GraphStore, type LabeledNode, type NodeState, type WorkGraphNode } from "../src/graph/index";
import { walkFakeSubtree } from "./fixtures/work-graph-fixtures";

const REPO = { forge: "github", host: "github.com", path: "the-metafactory/soma" } as const;
const MARKER = "<!-- ranger:intake discord=7 -->";
const LABEL = "ranger:principal-intake";

interface Seed { status?: "open" | "closed"; parent?: string; children?: string[]; node?: Partial<WorkGraphNode> }

function fixture(seeds: Record<string, Seed>, listed: LabeledNode[] = []) {
  const created: CreateNodeSpec[] = [];
  const unsupported = async (): Promise<never> => { throw new Error("Unexpected store operation"); };
  const readNode = async ({ id }: { id: string }): Promise<NodeState> => {
    const seed = seeds[id];
    if (seed === undefined) throw new Error(`no such node ${id}`);
    return {
      ref: { id }, node: { id, title: `node ${id}`, autonomy: "propose", checkpointId: "cp", ...seed.node } as WorkGraphNode,
      status: seed.status ?? "open", updatedAt: "2026-11-15T10:00:00Z", assignees: [], blockedBy: [], author: "ivy-bot", typed: true,
      ...(seed.parent === undefined ? {} : { parent: { id: seed.parent } }),
    };
  };
  const store: GraphStore = {
    attestation: "verifiable",
    actingIdentity: async () => "ivy-bot",
    checkConfinement: unsupported,
    createNode: async (spec) => { created.push(spec); return { id: "900" }; },
    attachToParent: unsupported,
    addBlockingEdge: unsupported,
    readNode,
    readSubtree: async (root) => await walkFakeSubtree(root, (id) => seeds[id]?.children ?? [], readNode),
    claim: unsupported,
    release: unsupported,
    postComment: unsupported,
    readComment: unsupported,
    readCommentReactions: unsupported,
    listComments: async () => [],
    readRawBody: unsupported,
    writeRawBody: unsupported,
    close: unsupported,
    listNodesByLabel: async () => listed,
  };
  const deps = {
    createStore: () => store,
    resolveRepo: async () => REPO,
    assertInstalledRuntime: async () => undefined,
    listProbeRegistryEntries: async () => ({ status: "absent" as const, path: "/registry.json" }),
  };
  const run = async (args: string[]) => await runGraphCli(parseGraphArgs(args), deps);
  const add = async (parent: string, args: string[] = []) =>
    await run(["graph", "add", parent, "--title", "t", "--autonomy", "propose", "--checkpoint", "cp", ...args, "--repo", REPO.path]);
  const refusal = async (parent: string, args: string[] = []): Promise<SomaCliError> => {
    try {
      await add(parent, args);
    } catch (error) {
      if (error instanceof SomaCliError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  };
  return { created, add, refusal, run };
}

const atDefaultCap = (): Record<string, Seed> => ({
  "1": { children: ["2", "3", "4"] },
  "2": { parent: "1", status: "closed" },
  "3": { parent: "1", status: "closed" },
  "4": { parent: "1" },
});

test("add refuses under a parent that already has the default three children, closed ones included", async () => {
  const fx = fixture(atDefaultCap());
  const error = await fx.refusal("1");
  expect(error.exitCode).toBe(1);
  expect(error.message).toBe([
    "soma graph add refused: over the spawn budget, so nothing is filed.",
    "- node 1 has 3 children (open and closed), at the cap of 3 per node (the default)",
    `File it under another node, close or abandon open ones, or pass --over-budget "<reason>" to file it anyway; the reason is recorded on the node.`,
  ].join("\n"));
  expect(fx.created).toEqual([]);
});

test("add files under a parent below the cap, and counts only direct children", async () => {
  const fx = fixture({
    "1": { children: ["2", "3"] },
    "2": { parent: "1", children: ["5", "6", "7"] },
    "3": { parent: "1" },
    "5": { parent: "2" }, "6": { parent: "2" }, "7": { parent: "2" },
  });
  await fx.add("1");
  expect(fx.created).toHaveLength(1);
  expect(fx.created[0]?.body).toBeUndefined();
});

test("add refuses at a map's declared open-node cap, walking up from a deep parent", async () => {
  const seeds: Record<string, Seed> = {
    "1": { children: ["2"], node: { spawnBudget: { childrenPerNode: 10, openNodes: 2 } } },
    "2": { parent: "1", children: ["3", "4"] },
    "3": { parent: "2" },
    "4": { parent: "2", status: "closed" },
  };
  const fx = fixture(seeds);
  expect((await fx.refusal("3")).message).toContain("- map 1 has 2 open nodes, at its cap of 2\n");
  const json = JSON.parse((await fx.refusal("3", ["--json"])).message) as unknown;
  expect(json).toEqual({ refused: true, written: [], overBudget: [{ cap: "openNodes", node: "1", count: 2, limit: 2 }] });
  expect(fx.created).toEqual([]);
});

test("a declared children cap replaces the default", async () => {
  const seeds = { ...atDefaultCap(), "1": { children: ["2", "3", "4"], node: { spawnBudget: { childrenPerNode: 4 } } } };
  const fx = fixture(seeds);
  await fx.add("1");
  expect(fx.created).toHaveLength(1);
  seeds["1"] = { ...seeds["1"], node: { spawnBudget: { childrenPerNode: 2 } } };
  expect((await fx.refusal("1")).message).toContain("- node 1 has 3 children (open and closed), at the cap of 2 per node\n");
});

test("--over-budget files anyway and records the reason and the cap under ## Over budget", async () => {
  const fx = fixture(atDefaultCap());
  const out = JSON.parse(await fx.add("1", ["--body", "words\n", "--over-budget", " the fog needs a fourth probe ", "--json"])) as Record<string, unknown>;
  expect(out.overBudget).toEqual({ reason: "the fog needs a fourth probe", exceeded: [{ cap: "childrenPerNode", node: "1", count: 3, limit: 3 }] });
  expect(fx.created[0]?.body).toBe("words\n\n## Over budget\n\nthe fog needs a fourth probe\n\nExceeded: node 1 had 3 children, cap 3 per node.");
});

test("--over-budget keeps a --once marker as the body's last line", async () => {
  const fx = fixture(atDefaultCap());
  await fx.add("1", ["--over-budget", "why", "--label", LABEL, "--once", MARKER]);
  expect(fx.created[0]?.body).toBe(`## Over budget\n\nwhy\n\nExceeded: node 1 had 3 children, cap 3 per node.\n\n${MARKER}`);
});

test("--over-budget under budget is accepted and appends nothing", async () => {
  const fx = fixture({ "1": {} });
  const out = JSON.parse(await fx.add("1", ["--body", "words", "--over-budget", "why", "--json"])) as Record<string, unknown>;
  expect(out).not.toHaveProperty("overBudget");
  expect(fx.created[0]?.body).toBe("words");
});

test("--over-budget needs a non-empty reason and belongs to add only", () => {
  const add = ["graph", "add", "1", "--title", "t", "--autonomy", "propose", "--checkpoint", "cp"];
  expect(() => parseGraphArgs([...add, "--over-budget", "   "])).toThrow("--over-budget needs a non-empty reason.");
  expect(() => parseGraphArgs([...add, "--over-budget", ""])).toThrow("--over-budget requires a value.");
  expect(() => parseGraphArgs([...add, "--over-budget"])).toThrow("--over-budget requires a value.");
  expect(() => parseGraphArgs(["graph", "chart", "--title", "m", "--autonomy", "approve", "--checkpoint", "cp", "--over-budget", "why"])).toThrow(/no parent/u);
  expect(() => parseGraphArgs([...add, "--spawn-open-nodes", "5"])).toThrow(/map root only/u);
});

test("an --once hit returns the existing node without a budget refusal", async () => {
  const listed = [{ id: "4", author: "ivy-bot", body: MARKER }];
  const fx = fixture(atDefaultCap(), listed);
  const out = await fx.add("1", ["--label", LABEL, "--once", MARKER]);
  expect(out).toBe(`Node 4 already carries ${MARKER} and sits under 1 (the-metafactory/soma); nothing new filed.`);
  expect(await fx.add("1", ["--label", LABEL, "--once", MARKER, "--dry-run"])).toBe(`Node 4 carries ${MARKER} and sits under 1 (the-metafactory/soma); nothing filed.`);
  expect(fx.created).toEqual([]);
});

test("chart writes spawnBudget into the root's typed block, and it reads back", async () => {
  const fx = fixture({});
  await fx.run(["graph", "chart", "--title", "map", "--autonomy", "approve", "--checkpoint", "cp", "--spawn-children-per-node", "2", "--spawn-open-nodes", "40", "--repo", REPO.path]);
  const spec = fx.created[0];
  expect(spec?.spawnBudget).toEqual({ childrenPerNode: 2, openNodes: 40 });
  const raw = JSON.parse(decodeNodeBlock(encodeNodeBlock(spec)).raw!) as Record<string, unknown>;
  expect(raw.spawnBudget).toEqual({ childrenPerNode: 2, openNodes: 40 });
  expect(parseNodeSpec({ ...raw, title: "map" }).spawnBudget).toEqual({ childrenPerNode: 2, openNodes: 40 });
});

test("spawnBudget takes positive integers, at least one cap, and only on a root", () => {
  const spec = { title: "m", autonomy: "approve" };
  for (const bad of [{ openNodes: 0 }, { childrenPerNode: 2.5 }, { openNodes: -1 }, { childrenPerNode: "3" }, {}]) {
    expect(() => parseNodeSpec({ ...spec, spawnBudget: bad })).toThrow(/spawnBudget/u);
  }
  expect(() => parseNodeSpec({ ...spec, spawnBudget: { openNodes: 3 }, parent: { id: "1" } })).toThrow("spawnBudget belongs on the map root only");
  expect(() => parseGraphArgs(["graph", "chart", "--title", "m", "--autonomy", "approve", "--checkpoint", "cp", "--spawn-open-nodes", "1.5"])).toThrow(/positive integer/u);
});

const AUDIT_TREE: Record<string, Seed> = {
  "1": { children: ["2", "3", "4"], node: { spawnBudget: { childrenPerNode: 2, openNodes: 3 } } },
  "2": { parent: "1", status: "closed", children: ["5", "6", "7"] },
  "3": { parent: "1", status: "closed", children: ["8"] },
  "4": { parent: "1" },
  "5": { parent: "2", status: "closed" },
  "6": { parent: "2" },
  "7": { parent: "2" },
  "8": { parent: "3" },
};

test("audit reports open and closed counts, the spawn rate, the caps and the nodes over them", async () => {
  const fx = fixture(AUDIT_TREE);
  const json = JSON.parse(await fx.run(["graph", "audit", "1", "--repo", REPO.path, "--json"])) as { spawn: unknown };
  expect(json.spawn).toEqual({
    open: 4,
    closed: 3,
    spawnRate: 1.33,
    caps: { childrenPerNode: 2, childrenPerNodeDeclared: true, openNodes: 3 },
    overChildrenCap: [{ id: "1", title: "node 1", children: 3 }, { id: "2", title: "node 2", children: 3 }],
    openOverCap: true,
  });
  const text = await fx.run(["graph", "audit", "1", "--repo", REPO.path]);
  expect(text).toContain([
    "Spawn: 4 open, 3 closed below the root; spawn rate R = 1.33 children per closed node.",
    "Caps: 2 children per node; 3 open nodes.",
    "Over the children cap:",
    "- 1 node 1 — 3 children",
    "- 2 node 2 — 3 children",
    "Open nodes exceed the cap: 4 > 3.",
  ].join("\n"));
});

test("audit of a map with no closed node and no declared caps reports the default and no rate", async () => {
  const fx = fixture({ "1": { children: ["2"] }, "2": { parent: "1" } });
  const text = await fx.run(["graph", "audit", "1", "--repo", REPO.path]);
  expect(text).toContain("Spawn: 1 open, 0 closed below the root; spawn rate R = no closed node below the root yet.\nCaps: 3 children per node (default); no open-node cap declared.\n");
});
