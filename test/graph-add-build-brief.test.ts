import { expect, test } from "bun:test";
import { parseGraphArgs, runGraphCli } from "../src/cli/graph";
import { renderCloseReceipt, type GraphStore, type NodeState } from "../src/work-graph";
import { walkFakeSubtree } from "./fixtures/work-graph-fixtures";

const REPO = { forge: "github", host: "github.com", path: "the-metafactory/soma" } as const;
const READY = "## Deliverable\nReport readiness.\n\n## Acceptance criteria\n- Audit reports gaps.\n";

function state(id: string, body: string | undefined, kind: string | undefined = "build"): NodeState {
  return {
    ref: { id },
    node: { id, title: `Brief ${id}`, autonomy: "propose", checkpointId: `cp-${id}`, ...(kind === undefined ? {} : { kind }) },
    status: "open",
    assignees: [],
    blockedBy: [],
    author: "ivy-agent",
    typed: true,
    ...(body === undefined ? {} : { body }),
  };
}

function fixture(...children: NodeState[]) {
  const root = state("1", "Map destination", "map");
  const nodes = new Map([root, ...children.map((child) => ({ ...child, parent: child.parent ?? { id: "1" } }))].map((node) => [node.ref.id, node]));
  const lookup = (id: string): NodeState => {
    const node = nodes.get(id);
    if (node === undefined) throw new Error(`No fixture node ${id}`);
    return node;
  };
  const unsupported = async (): Promise<never> => { throw new Error("Unexpected store operation"); };
  const store: GraphStore = {
    attestation: "unverified",
    actingIdentity: async () => "ivy-agent",
    checkConfinement: unsupported,
    createNode: async (spec, _rehome, options) => {
      const id = "900";
      nodes.set(id, {
        ...state(id, spec.body, spec.kind), node: { ...spec, id },
        ...(options?.detached === true || spec.parent === undefined ? {} : { parent: spec.parent }),
      });
      return { id };
    },
    attachToParent: async (child, parent) => { lookup(child.id).parent = parent; },
    addBlockingEdge: unsupported,
    readNode: async (ref) => lookup(ref.id),
    readSubtree: async (rootRef) => walkFakeSubtree(
      rootRef,
      (id) => [...nodes.values()].filter((node) => node.parent?.id === id).map((node) => node.ref.id),
      async (ref) => lookup(ref.id),
    ),
    claim: unsupported,
    release: unsupported,
    postComment: unsupported,
    readComment: unsupported,
    readCommentReactions: unsupported,
    listComments: async (ref) => [{
      id: `receipt-${ref.id}`,
      author: "ivy-agent",
      body: renderCloseReceipt({
        checkpointId: `cp-${ref.id}`, closedBy: "ivy-agent", at: "2026-10-07T10:00:00Z",
        evidence: [{ kind: "tested", summary: "passed" }], probeResults: [], attestation: "unverified",
      }),
    }],
    readRawBody: async (ref) => lookup(ref.id).body ?? "",
    writeRawBody: unsupported,
    close: unsupported,
  };
  return async (args: string[]) => runGraphCli(parseGraphArgs(["graph", ...args, "--repo", REPO.path]), {
    createStore: () => store,
    resolveRepo: async () => REPO,
    assertInstalledRuntime: async () => undefined,
  });
}

function findings(output: string): unknown {
  return (JSON.parse(output) as { buildBriefNotReady: unknown }).buildBriefNotReady;
}

test("audit reports an open build brief missing Acceptance criteria in JSON and text", async () => {
  const run = fixture(state("2", "## Deliverable\nReport readiness.\n"));
  expect(findings(await run(["audit", "1", "--json"]))).toEqual([
    { id: "2", missing: ["## Acceptance criteria"] },
  ]);
  const text = await run(["audit", "1"]);
  expect(text).toContain("build-brief-not-ready");
  expect(text).toContain("2 Brief 2");
  expect(text).toContain("## Acceptance criteria");
  expect(text).not.toContain("Clean:");
});

test("audit names a literal clarification marker anywhere in an open build body", async () => {
  const run = fixture(state("2", `${READY}\n[NEEDS CLARIFICATION]\n`));
  expect(findings(await run(["audit", "1", "--json"]))).toEqual([
    { id: "2", missing: ["[NEEDS CLARIFICATION]"] },
  ]);
  expect(await run(["audit", "1"])).toContain("[NEEDS CLARIFICATION]");
});

test("audit reports an open build brief missing Deliverable in JSON and text", async () => {
  const run = fixture(state("2", "## Acceptance criteria\n- Audit reports gaps.\n"));
  expect(findings(await run(["audit", "1", "--json"]))).toEqual([
    { id: "2", missing: ["## Deliverable"] },
  ]);
  expect(await run(["audit", "1"])).toContain("## Deliverable");
});

test("audit reports every incomplete open build, including descendants of a closed node", async () => {
  const run = fixture(
    { ...state("4", "", "task"), status: "closed" },
    { ...state("2", undefined), parent: { id: "4" } },
    state("3", "[NEEDS CLARIFICATION]"),
  );
  expect(findings(await run(["audit", "1", "--json"]))).toEqual([
    { id: "2", missing: ["## Deliverable", "## Acceptance criteria"] },
    { id: "3", missing: ["## Deliverable", "## Acceptance criteria", "[NEEDS CLARIFICATION]"] },
  ]);
});

test("audit excludes closed builds and every other kind with the same incomplete body", async () => {
  const body = "[NEEDS CLARIFICATION]";
  const otherKinds = ["grilling", "research", "task", "prototype", "custom"].map((kind, index) => state(String(index + 3), body, kind));
  const noKind = state("8", body);
  delete noKind.node.kind;
  const run = fixture({ ...state("2", body), status: "closed" }, ...otherKinds, noKind);
  expect(findings(await run(["audit", "1", "--json"]))).toEqual([]);
  expect(await run(["audit", "1"])).toContain("Clean:");
});

test("a ready open build keeps audit clean even when its criteria are empty", async () => {
  const run = fixture(state("2", "## Deliverable\r\n\r\n## Acceptance criteria\t\r\n[needs clarification]\r\nTBD\r\n"));
  expect(findings(await run(["audit", "1", "--json"]))).toEqual([]);
  expect(await run(["audit", "1"])).toContain("Clean:");
});

test("audit checks headings as whole lines and only the literal clarification marker", async () => {
  const run = fixture(state("2", "Mention ## Deliverable\n### Acceptance criteria\n[needs clarification]"));
  expect(findings(await run(["audit", "1", "--json"]))).toEqual([
    { id: "2", missing: ["## Deliverable", "## Acceptance criteria"] },
  ]);
});

test("audit checks a standalone open build root too", async () => {
  const run = fixture(state("2", ""));
  expect(findings(await run(["audit", "2", "--json"]))).toEqual([
    { id: "2", missing: ["## Deliverable", "## Acceptance criteria"] },
  ]);
});

test.each([
  { body: undefined, missing: ["## Deliverable", "## Acceptance criteria"] },
  { body: "[NEEDS CLARIFICATION]", missing: ["## Deliverable", "## Acceptance criteria", "[NEEDS CLARIFICATION]"] },
  { body: "## Deliverable", missing: ["## Acceptance criteria"] },
  { body: "## Acceptance criteria", missing: ["## Deliverable"] },
])(
  "graph add accepts an incomplete build brief: %j",
  async ({ body, missing }) => {
    const run = fixture();
    const created = JSON.parse(await run([
      "add", "1", "--title", "Incomplete build", "--kind", "build", "--autonomy", "propose",
      "--checkpoint", "cp-build", ...(body === undefined ? [] : ["--body", body]), "--json",
    ])) as { node: string; parent: string };
    expect(created).toMatchObject({ node: "900", parent: "1" });
    const node = JSON.parse(await run(["node", "900", "--json"])) as NodeState;
    expect(node.node.kind).toBe("build");
    expect(node.body).toBe(body);
    expect(findings(await run(["audit", "1", "--json"]))).toEqual([
      { id: "900", missing },
    ]);
  },
);
