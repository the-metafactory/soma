import { expect, test } from "bun:test";
import { SomaCliError } from "../src/cli/errors";
import { parseGraphArgs, runGraphCli } from "../src/cli/graph";
import { decodeNodeBlock, encodeNodeBlock, parseNodeSpec, toNode, type CreateNodeSpec, type GraphStore, type LabeledNode, type NodeState, type WorkGraphNode } from "../src/graph/index";
import { walkFakeSubtree } from "./fixtures/work-graph-fixtures";

const REPO = { forge: "github", host: "github.com", path: "the-metafactory/soma" } as const;
const MARKER = "<!-- ranger:intake discord=7 -->";
const LABEL = "ranger:principal-intake";

interface Seed { status?: "open" | "closed"; parent?: string; children?: string[]; node?: Partial<WorkGraphNode>; raw?: string; parseError?: string }

function fixture(seeds: Record<string, Seed>, listed: LabeledNode[] = []) {
  const created: CreateNodeSpec[] = [];
  const subtreeReads: string[] = [];
  const edits: { id: string; changes: { title?: string; body?: string } }[] = [];
  const unsupported = async (): Promise<never> => { throw new Error("Unexpected store operation"); };
  const readNode = async ({ id }: { id: string }): Promise<NodeState> => {
    const seed = seeds[id];
    if (seed === undefined) throw new Error(`no such node ${id}`);
    const raw = seed.raw === undefined ? undefined : decodeNodeBlock(seed.raw).raw;
    const node = raw === undefined
      ? { id, title: `node ${id}`, autonomy: "propose", checkpointId: "cp", ...seed.node } as WorkGraphNode
      : toNode(id, parseNodeSpec({ ...JSON.parse(raw) as object, title: `node ${id}` }));
    return {
      ref: { id }, node,
      status: seed.status ?? "open", updatedAt: "2026-11-15T10:00:00Z", assignees: [], blockedBy: [], author: "ivy-bot",
      ...(seed.parseError === undefined ? { typed: true } : { typed: false, parseError: seed.parseError }),
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
    readSubtree: async (root) => {
      subtreeReads.push(root.id);
      return await walkFakeSubtree(root, (id) => seeds[id]?.children ?? [], readNode);
    },
    claim: unsupported,
    release: unsupported,
    postComment: unsupported,
    readComment: unsupported,
    readCommentReactions: unsupported,
    listComments: async () => [],
    readRawBody: async ({ id }) => seeds[id]?.raw ?? "",
    editContent: async ({ id }, changes) => {
      edits.push({ id, changes });
      if (changes.body !== undefined) seeds[id] = { ...seeds[id], raw: changes.body };
    },
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
  const failure = async (args: string[]): Promise<Error> => {
    try {
      await run(args);
    } catch (error) {
      if (error instanceof Error) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  };
  return { created, subtreeReads, edits, add, refusal, run, failure };
}

const atCap = (): Record<string, Seed> => ({
  "1": { children: ["2", "3", "4"], node: { spawnBudget: { childrenPerNode: 3 } } },
  "2": { parent: "1", status: "closed" },
  "3": { parent: "1", status: "closed" },
  "4": { parent: "1" },
});

test("add refuses under a parent at its map's declared children cap, closed children included", async () => {
  const fx = fixture(atCap());
  const error = await fx.refusal("1");
  expect(error.exitCode).toBe(1);
  expect(error.message).toBe([
    "soma graph add refused: over the spawn budget, so nothing is filed.",
    "- node 1 has 3 children (open and closed), at the cap of 3 per node",
    `File it under another node, close or abandon open ones, or pass --over-budget "<reason>" to file it anyway; the reason is recorded on the node.`,
  ].join("\n"));
  expect(fx.created).toEqual([]);
});

test("without a declared cap, add files under any parent and reads no subtree", async () => {
  const fx = fixture({ "1": { children: ["2", "3", "4", "5", "6"] }, "2": { parent: "1" }, "3": { parent: "1" }, "4": { parent: "1" }, "5": { parent: "1" }, "6": { parent: "1" } });
  await fx.add("1");
  expect(fx.created).toHaveLength(1);
  expect(fx.subtreeReads).toEqual([]);
});

test("add files under a parent below the cap, and counts only direct children", async () => {
  const fx = fixture({
    "1": { children: ["2", "3"], node: { spawnBudget: { childrenPerNode: 3 } } },
    "2": { parent: "1", children: ["5", "6", "7"] },
    "3": { parent: "1" },
    "5": { parent: "2" }, "6": { parent: "2" }, "7": { parent: "2" },
  });
  await fx.add("1");
  expect(fx.subtreeReads).toEqual(["1"]);
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

test("the children cap is the one the root declares", async () => {
  const seeds = { ...atCap(), "1": { children: ["2", "3", "4"], node: { spawnBudget: { childrenPerNode: 4 } } } };
  const fx = fixture(seeds);
  await fx.add("1");
  expect(fx.created).toHaveLength(1);
  seeds["1"] = { ...seeds["1"], node: { spawnBudget: { childrenPerNode: 2 } } };
  expect((await fx.refusal("1")).message).toContain("- node 1 has 3 children (open and closed), at the cap of 2 per node\n");
});

test("--over-budget files anyway and records the reason and the cap under ## Over budget", async () => {
  const fx = fixture(atCap());
  const out = JSON.parse(await fx.add("1", ["--body", "words\n", "--over-budget", " the fog needs a fourth probe ", "--json"])) as Record<string, unknown>;
  expect(out.overBudget).toEqual({ reason: "the fog needs a fourth probe", exceeded: [{ cap: "childrenPerNode", node: "1", count: 3, limit: 3 }] });
  expect(fx.created[0]?.body).toBe("words\n\n## Over budget\n\nthe fog needs a fourth probe\n\nExceeded: node 1 had 3 children, cap 3 per node.");
});

test("--over-budget keeps a --once marker as the body's last line", async () => {
  const fx = fixture(atCap());
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
  const fx = fixture(atCap(), listed);
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
    caps: { childrenPerNode: 2, openNodes: 3 },
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

test("audit without declared caps still reports counts and R, and lists no node as over a cap", async () => {
  const seeds = { ...AUDIT_TREE, "1": { children: ["2", "3", "4"] } };
  const fx = fixture(seeds);
  const json = JSON.parse(await fx.run(["graph", "audit", "1", "--repo", REPO.path, "--json"])) as { spawn: unknown };
  expect(json.spawn).toEqual({ open: 4, closed: 3, spawnRate: 1.33, caps: {} });
  const text = await fx.run(["graph", "audit", "1", "--repo", REPO.path]);
  expect(text).toContain("Spawn: 4 open, 3 closed below the root; spawn rate R = 1.33 children per closed node.\nCaps: no children cap declared; no open-node cap declared.\n\n");
  expect(text).not.toContain("Over the children cap");
});

test("audit of a map with no closed node reports no rate", async () => {
  const fx = fixture({ "1": { children: ["2"] }, "2": { parent: "1" } });
  expect(await fx.run(["graph", "audit", "1", "--repo", REPO.path])).toContain("spawn rate R = no closed node below the root yet.");
});

test("ranger's add: --over-budget with --once, --label and --json files once and keeps a stable JSON shape", async () => {
  const fx = fixture(atCap());
  const args = ["--label", LABEL, "--once", MARKER, "--over-budget", "ranger intake from discord=7", "--json"];
  const out = await fx.add("1", args);
  expect(Object.keys(JSON.parse(out) as object)).toEqual(["repo", "node", "parent", "blockedBy", "existing", "overBudget"]);
  expect(JSON.parse(out)).toEqual({
    repo: "the-metafactory/soma", node: "900", parent: "1", blockedBy: [], existing: false,
    overBudget: { reason: "ranger intake from discord=7", exceeded: [{ cap: "childrenPerNode", node: "1", count: 3, limit: 3 }] },
  });
  expect(fx.created[0]?.labels).toEqual([LABEL]);
  expect(fx.created[0]?.body?.endsWith(`ranger intake from discord=7\n\nExceeded: node 1 had 3 children, cap 3 per node.\n\n${MARKER}`)).toBe(true);
  const again = fixture({ ...atCap(), "900": { parent: "1" } }, [{ id: "900", author: "ivy-bot", body: MARKER }]);
  expect(JSON.parse(await again.add("1", args))).toEqual({ repo: "the-metafactory/soma", node: "900", parent: "1", blockedBy: [], existing: true });
  expect(again.created).toEqual([]);
});

const ROOT_BLOCK = encodeNodeBlock({ title: "map", autonomy: "approve", checkpointId: "cp-map", serves: "G5", budget: { tokens: 1000 } });
const rootRaw = (block = ROOT_BLOCK): string => `The map.\n\n${block}\n\ntrailing prose`;

test("edit sets a spawn budget on an existing root, changing only that field of the typed block", async () => {
  const fx = fixture({ "1": { raw: rootRaw() } });
  const out = await fx.run(["graph", "edit", "1", "--spawn-children-per-node", "3", "--repo", REPO.path]);
  expect(out).toContain('spawn budget: {"childrenPerNode":3}');
  const expected = ROOT_BLOCK.replace('"tokens": 1000\n  }\n', '"tokens": 1000\n  },\n  "spawnBudget": {\n    "childrenPerNode": 3\n  }\n');
  expect(expected).not.toBe(ROOT_BLOCK);
  expect(fx.edits).toEqual([{ id: "1", changes: { body: rootRaw(expected) } }]);
});

test("edit changes one cap and keeps the other, and --spawn-budget none restores the original block", async () => {
  const fx = fixture({ "1": { raw: rootRaw() } });
  await fx.run(["graph", "edit", "1", "--spawn-children-per-node", "3", "--spawn-open-nodes", "40", "--repo", REPO.path]);
  await fx.run(["graph", "edit", "1", "--spawn-open-nodes", "60", "--repo", REPO.path]);
  const json = JSON.parse(await fx.run(["graph", "node", "1", "--json", "--repo", REPO.path])) as { node: WorkGraphNode };
  expect(json.node.spawnBudget).toEqual({ childrenPerNode: 3, openNodes: 60 });
  await fx.run(["graph", "edit", "1", "--spawn-budget", "none", "--repo", REPO.path]);
  expect(fx.edits.at(-1)?.changes).toEqual({ body: rootRaw() });
});

test("edit refuses a spawn budget on a node with a parent, on a block soma did not write, and bad values", async () => {
  const fx = fixture({
    "1": { raw: rootRaw(), children: ["2"] },
    "2": { parent: "1", raw: rootRaw() },
    "3": { raw: 'x\n<!-- soma:work-graph-node\n{ "autonomy": "approve" }\n-->' },
  });
  expect((await fx.failure(["graph", "edit", "2", "--spawn-open-nodes", "5", "--repo", REPO.path])).message).toContain("node 2 sits under 1; spawnBudget belongs on the map root only");
  expect((await fx.failure(["graph", "edit", "3", "--spawn-open-nodes", "5", "--repo", REPO.path])).message).toContain("not in the form soma writes");
  expect(fx.edits).toEqual([]);
  const edit = ["graph", "edit", "1"];
  expect(() => parseGraphArgs([...edit, "--spawn-open-nodes", "0"])).toThrow(/positive integer/u);
  expect(() => parseGraphArgs([...edit, "--spawn-children-per-node", "2.5"])).toThrow(/positive integer/u);
  expect(() => parseGraphArgs([...edit, "--spawn-budget", "off"])).toThrow(/takes only none/u);
  expect(() => parseGraphArgs([...edit, "--spawn-budget", "none", "--spawn-open-nodes", "3"])).toThrow(/cannot be combined/u);
  expect(() => parseGraphArgs([...edit, "--spawn-open-nodes", "3", "--title", "t"])).toThrow(/not both/u);
});

const BROKEN = 'spawnBudget: "openNodes" must be a positive integer';
const brokenRoot = (): Record<string, Seed> => ({ "1": { children: ["2"], parseError: BROKEN }, "2": { parent: "1" } });

test("a root whose typed block does not parse refuses add, naming the root and the error, and reads no subtree", async () => {
  const fx = fixture(brokenRoot());
  expect((await fx.refusal("2")).message).toBe(
    `soma graph add refused: map root 1 has a typed block that does not parse, so its spawn budget is unknown: ${BROKEN}. Repair the root's typed block, or pass --over-budget "<reason>" to file it anyway; the reason is recorded on the node.`,
  );
  expect(JSON.parse((await fx.refusal("2", ["--json"])).message)).toEqual({ refused: true, written: [], budgetError: { root: "1", error: BROKEN } });
  expect(fx.created).toEqual([]);
  expect(fx.subtreeReads).toEqual([]);
});

test("--over-budget files under a root whose budget does not parse and records that it was not checked", async () => {
  const fx = fixture(brokenRoot());
  const out = JSON.parse(await fx.add("2", ["--over-budget", "intake", "--json"])) as Record<string, unknown>;
  const unread = `map root 1 has a typed block that does not parse, so its spawn budget is unknown: ${BROKEN}`;
  expect(out.overBudget).toEqual({ reason: "intake", budgetUnreadable: unread });
  expect(fx.created[0]?.body).toBe(`## Over budget\n\nintake\n\nBudget not checked: ${unread}.`);
});

test("an unreadable ancestor refuses add without --over-budget, and files with it, recording the failed read", async () => {
  const seeds: Record<string, Seed> = { "2": { parent: "404" } };
  const fx = fixture(seeds);
  expect((await fx.refusal("2")).message).toBe("soma graph add refused: cannot read the spawn budget above 2: no such node 404, so nothing is filed.");
  expect(fx.created).toEqual([]);
  const out = JSON.parse(await fx.add("2", ["--over-budget", "ranger intake", "--label", LABEL, "--once", MARKER, "--json"])) as Record<string, unknown>;
  expect(out).toEqual({
    repo: "the-metafactory/soma", node: "900", parent: "2", blockedBy: [], existing: false,
    overBudget: { reason: "ranger intake", budgetUnreadable: "cannot read the spawn budget above 2: no such node 404" },
  });
  expect(fx.created[0]?.body).toBe(`## Over budget\n\nranger intake\n\nBudget not checked: cannot read the spawn budget above 2: no such node 404.\n\n${MARKER}`);
});

test("audit reports a root budget that does not parse as broken, not as no cap", async () => {
  const fx = fixture(brokenRoot());
  const json = JSON.parse(await fx.run(["graph", "audit", "1", "--repo", REPO.path, "--json"])) as { spawn: unknown };
  expect(json.spawn).toEqual({ open: 1, closed: 0, spawnRate: null, caps: {}, budgetError: BROKEN });
  const text = await fx.run(["graph", "audit", "1", "--repo", REPO.path]);
  expect(text).toContain(`Caps: BROKEN — the root's typed block does not parse, so its spawn budget is unknown: ${BROKEN}`);
  expect(text).not.toContain("no children cap declared");
});
