import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SomaCliError } from "../src/cli/errors";
import {
  GRAPH_COMMAND_HELP,
  parseGraphArgs,
  parseProbeTreeStatus,
  probeTreeStatusArgv,
  runGraphCli,
  selectRatification,
  type GraphCliDeps,
} from "../src/cli/graph";
import { parseRepoFromRemote } from "../src/work-graph-bridge";
// Receipt-rendering helpers are deliberately not on the public barrel (sage on
// #584): they are internals of `renderCloseReceipt`, so the test reaches for
// them where they live.
import { collapseHome, describeProbeTree } from "../src/work-graph";
import {
  WorkGraphError,
  renderCloseReceipt,
  runProbe,
  runProbes,
  scanCommentsForReceipt,
  type ClaimResult,
  type ReleaseResult,
  type CloseReceipt,
  type CommentRef,
  type CreateNodeSpec,
  type GraphStore,
  type NodeComment,
  type NodeRef,
  type NodeState,
  type Probe,
  type ProbeRegistry,
  type ProbeResult,
  type Reaction,
  type WorkGraphNode,
} from "../src/index";
import { walkFakeSubtree } from "./fixtures/work-graph-fixtures";

const REPO = "the-metafactory/soma";
const AT = new Date("2026-08-04T09:00:00.000Z");
const PROBE_RUN = "bun test";
const PROBE: Probe = { type: "command", run: PROBE_RUN, timeoutSec: 600, expectExit: 0 };
const REGISTRY_PATH = "/home/.soma/policy/probe-registry.json";
/** What a machine that has authorised this repo's one probe looks like (§2.2). */
const DECLARED: ProbeRegistry = {
  status: "loaded",
  repo: REPO,
  path: REGISTRY_PATH,
  commands: [{ run: PROBE_RUN, cwd: "/repo" }],
  urlHosts: [],
};

interface SeedNode {
  node: WorkGraphNode;
  status?: "open" | "closed";
  assignees?: string[];
  blockedBy?: { id: string; status: "open" | "closed" }[];
  author?: string;
  parent?: string;
  typed?: boolean;
  children?: string[];
  rawBody?: string;
}

class FakeStore implements GraphStore {
  readonly attestation = "verifiable" as const;
  readonly nodes = new Map<string, SeedNode>();
  readonly comments = new Map<string, { author: string; body: string; nodeId: string }>();
  readonly reactions = new Map<string, Reaction[]>();
  readonly closed: { ref: NodeRef; receipt: CloseReceipt }[] = [];
  readonly created: CreateNodeSpec[] = [];
  readonly edges: [string, string][] = [];
  claimResult: ClaimResult | undefined;
  releaseResult: ReleaseResult | undefined;
  private nextId = 900;

  seed(id: string, seed: SeedNode): this {
    this.nodes.set(id, seed);
    return this;
  }

  async createNode(spec: CreateNodeSpec): Promise<NodeRef> {
    this.created.push(spec);
    const id = String(this.nextId++);
    this.nodes.set(id, { node: { ...spec, id } as WorkGraphNode });
    return { id };
  }

  async addBlockingEdge(blocker: NodeRef, blocked: NodeRef): Promise<void> {
    this.edges.push([blocker.id, blocked.id]);
  }

  async readNode(ref: NodeRef): Promise<NodeState> {
    const seed = this.nodes.get(ref.id);
    if (seed === undefined) throw new WorkGraphError("backend", `no such node ${ref.id}`);
    return {
      ref: { id: ref.id },
      node: seed.node,
      status: seed.status ?? "open",
      assignees: seed.assignees ?? [],
      blockedBy: seed.blockedBy ?? [],
      author: seed.author ?? "jcfischer",
      typed: seed.typed ?? true,
      ...(seed.parent === undefined ? {} : { parent: { id: seed.parent } }),
    };
  }

  async readSubtree(root: NodeRef): Promise<NodeState[]> {
    return walkFakeSubtree(root, (id) => this.nodes.get(id)?.children ?? [], (ref) => this.readNode(ref));
  }

  async claim(_ref: NodeRef, identity: string): Promise<ClaimResult> {
    return this.claimResult ?? { held: true, identity, holder: identity, assignees: [identity] };
  }

  async release(_ref: NodeRef, identity: string): Promise<ReleaseResult> {
    return this.releaseResult ?? { released: true, identity, assignees: [identity] };
  }

  async postComment(ref: NodeRef, body: string): Promise<CommentRef> {
    const id = `c${this.comments.size + 1}`;
    this.comments.set(id, { author: "ivy-agent", body, nodeId: ref.id });
    return { id, nodeId: ref.id, author: "ivy-agent", url: `https://github.test/c/${id}` };
  }

  async readComment(ref: CommentRef): Promise<CommentRef> {
    const comment = this.comments.get(ref.id);
    if (comment === undefined) throw new WorkGraphError("backend", `no such comment ${ref.id}`);
    return { id: ref.id, nodeId: comment.nodeId, author: comment.author, url: `https://github.test/c/${ref.id}` };
  }

  async readCommentReactions(ref: CommentRef): Promise<Reaction[]> {
    return this.reactions.get(ref.id) ?? [];
  }

  async listComments(ref: NodeRef): Promise<NodeComment[]> {
    return [...this.comments.entries()]
      .filter(([, comment]) => comment.nodeId === ref.id)
      .map(([id, comment]) => ({ id, author: comment.author, body: comment.body }));
  }

  async readRawBody(ref: NodeRef): Promise<string> {
    return this.nodes.get(ref.id)?.rawBody ?? "";
  }

  async writeRawBody(ref: NodeRef, body: string): Promise<void> {
    const seed = this.nodes.get(ref.id);
    if (seed === undefined) throw new WorkGraphError("backend", `no such node ${ref.id}`);
    seed.rawBody = body;
  }

  async close(ref: NodeRef, receipt: CloseReceipt): Promise<void> {
    this.closed.push({ ref, receipt });
  }
}

function deps(store: FakeStore, overrides: Partial<GraphCliDeps> = {}): Partial<GraphCliDeps> {
  return {
    createStore: () => store,
    resolveRepo: async () => REPO,
    resolveIdentity: async () => "ivy-agent",
    // Hermetic: the default would read the developer's own ~/.soma.
    loadProbeRegistry: async () => DECLARED,
    runProbes: async (probes) =>
      probes.map<ProbeResult>((probe) => ({
        probe,
        state: "probed",
        outcome: "pass",
        observed: "exit 0",
        at: AT.toISOString(),
      })),
    checkConfinement: async () => ({
      checked: true,
      reachableIdentities: ["ivy-agent"],
      at: AT.toISOString(),
      probes: [],
    }),
    probeCwd: () => "/repo",
    describeProbeTree: async (dir) => ({ dir, head: "abc1234", dirty: false }),
    readTextFile: async () => "proposal body",
    // Hermetic: the default shells out to git for the tool stamp.
    describeTool: async () => "soma 0.0.0-test (dev tree)",
    now: () => AT,
    warn: () => undefined,
    fromDevTree: false,
    ...overrides,
  };
}

/**
 * Every close carries prose (#556), so every close test that is not *about* that
 * rule has to supply it. Spread in explicitly rather than injected by `run`: a
 * helper that quietly satisfied the requirement would leave no test exercising
 * the argv a walker actually types.
 */
const RESOLUTION = ["--resolution-file", "resolution.md"] as const;

async function run(args: string[], store: FakeStore, overrides: Partial<GraphCliDeps> = {}): Promise<string> {
  return await runGraphCli(parseGraphArgs(args), deps(store, overrides));
}

async function failure(args: string[], store: FakeStore, overrides: Partial<GraphCliDeps> = {}): Promise<string> {
  try {
    await run(args, store, overrides);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no-throw";
}

function autoNode(id: string, overrides: Partial<WorkGraphNode> = {}): WorkGraphNode {
  return { id, title: `node ${id}`, autonomy: "auto", probes: [PROBE], checkpointId: `cp-${id}`, ...overrides } as WorkGraphNode;
}

// --- parsing ---------------------------------------------------------------

test("the parser accepts exactly the verbs of §2.6, release included", () => {
  for (const action of ["frontier", "node", "claim", "release", "add", "close", "audit", "decisions"]) {
    const parsed = parseGraphArgs(
      action === "add"
        ? ["graph", action, "495", "--title", "t", "--autonomy", "approve", "--checkpoint", "cp-t"]
        : ["graph", action, "495"],
    );
    expect(parsed.action).toBe(action as never);
  }
  expect(() => parseGraphArgs(["graph", "delete", "495"])).toThrow(
    /frontier\|node\|claim\|release\|add\|close\|audit\|decisions/u,
  );
});

test("add refuses a node with no checkpoint — it could never close, and no verb attaches one later", () => {
  // Three of map #495's scaffold nodes shipped checkpoint-less and every one
  // needed its node block hand-edited on the tracker. The verb now refuses at
  // the cheap end instead.
  expect(() => parseGraphArgs(["graph", "add", "495", "--title", "t", "--autonomy", "approve"])).toThrow(
    /--checkpoint.*never close/u,
  );
});

test("a verb without a target is a usage error, not a request against node 'undefined'", () => {
  expect(() => parseGraphArgs(["graph", "node"])).toThrow(/soma graph node/u);
  expect(() => parseGraphArgs(["graph", "node", "--json"])).toThrow(/soma graph node/u);
});

test("--evidence is typed at the boundary", () => {
  expect(() => parseGraphArgs(["graph", "close", "1", "--evidence", "not json"])).toThrow(/valid JSON/u);
  expect(() => parseGraphArgs(["graph", "close", "1", "--evidence", '{"kind":"vibes","summary":"s"}'])).toThrow(
    /"kind" must be one of/u,
  );
  const parsed = parseGraphArgs(["graph", "close", "1", "--evidence", '{"kind":"tested","summary":"s","pointer":"p"}']);
  expect(parsed.action === "close" ? parsed.options.evidence : []).toEqual([
    { kind: "tested", summary: "s", pointer: "p" },
  ]);
});

test("the repo is derived from any remote URL shape", () => {
  expect(parseRepoFromRemote("git@github.com:the-metafactory/soma.git")).toBe(REPO);
  expect(parseRepoFromRemote("https://github.com/the-metafactory/soma.git")).toBe(REPO);
  expect(parseRepoFromRemote("https://github.com/the-metafactory/soma")).toBe(REPO);
  expect(parseRepoFromRemote("https://gitlab.com/x/y.git")).toBeUndefined();
});

// --- frontier ---------------------------------------------------------------

test("frontier reports open, unassigned, unblocked children and says it is advisory", async () => {
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), children: ["498", "499", "500", "501"] })
    .seed("498", { node: autoNode("498") })
    .seed("499", { node: autoNode("499"), blockedBy: [{ id: "498", status: "open" }] })
    .seed("500", { node: autoNode("500"), assignees: ["jcfischer"] })
    .seed("501", { node: autoNode("501"), status: "closed" });

  const output = await run(["graph", "frontier", "495", "--repo", REPO], store);

  expect(output).toContain("- 498");
  expect(output).not.toContain("- 499");
  expect(output).not.toContain("- 500");
  expect(output).not.toContain("- 501");
  expect(output).toContain("1 node(s) open, unassigned, and unblocked.");
  expect(output).toContain("Advisory (§2.4)");
});

test("frontier --json emits the confirmed node states", async () => {
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), children: ["498"] })
    .seed("498", { node: autoNode("498") });

  const parsed = JSON.parse(await run(["graph", "frontier", "495", "--repo", REPO, "--json"], store)) as {
    root: string;
    frontier: { ref: { id: string } }[];
  };

  expect(parsed.root).toBe("495");
  expect(parsed.frontier.map((state) => state.ref.id)).toEqual(["498"]);
});

// --- node -------------------------------------------------------------------

test("node renders a hand-authored ticket as the fail-safe class it reports", async () => {
  const store = new FakeStore().seed("498", {
    node: { id: "498", title: "soma graph verbs", autonomy: "approve" },
    typed: false,
    parent: "495",
    blockedBy: [{ id: "497", status: "closed" }],
  });

  const output = await run(["graph", "node", "498", "--repo", REPO], store);

  expect(output).toContain("autonomy: approve");
  expect(output).toContain("typed: false");
  expect(output).toContain("no readable node block");
  expect(output).toContain("probes: none declared");
  expect(output).toContain("blocked by: 497 (closed)");
  expect(output).toContain("parent: 495");
});

// --- claim ------------------------------------------------------------------

test("claim reports the holder and exits non-zero when the tie-break goes the other way", async () => {
  const store = new FakeStore().seed("498", { node: autoNode("498") });
  store.claimResult = { held: false, identity: "ivy-agent", holder: "aaa-bot", assignees: ["aaa-bot"] };

  const message = await failure(["graph", "claim", "498", "--repo", REPO], store);
  expect(message).toContain("held by aaa-bot");
  expect(message).toContain("code-point tie-break");

  store.claimResult = { held: true, identity: "ivy-agent", holder: "ivy-agent", assignees: ["ivy-agent"] };
  expect(await run(["graph", "claim", "498", "--repo", REPO], store)).toContain("Claimed node 498 as ivy-agent");
});

test("claim refuses a closed node rather than reopening a settled race", async () => {
  const store = new FakeStore().seed("498", { node: autoNode("498"), status: "closed" });
  expect(await failure(["graph", "claim", "498", "--repo", REPO], store)).toContain("nothing to claim");
});

// --- release ------------------------------------------------------------------

test("release abandons a held claim and reports the resulting assignee set", async () => {
  const store = new FakeStore().seed("498", { node: autoNode("498") });
  store.releaseResult = { released: true, identity: "ivy-agent", assignees: [] };

  const output = await run(["graph", "release", "498", "--repo", REPO], store);
  expect(output).toContain("Released node 498 as ivy-agent");
  expect(output).toContain("assignees: —");
});

test("release of a claim you do not hold is a non-error no-op", async () => {
  const store = new FakeStore().seed("498", { node: autoNode("498") });
  store.releaseResult = { released: false, identity: "ivy-agent", assignees: ["Ada"] };

  const output = await run(["graph", "release", "498", "--repo", REPO], store);
  expect(output).toContain("is not claimed by ivy-agent");
  expect(output).toContain("assignees: Ada");
});

test("release refuses a closed node", async () => {
  const store = new FakeStore().seed("498", { node: autoNode("498"), status: "closed" });
  expect(await failure(["graph", "release", "498", "--repo", REPO], store)).toContain("nothing to release");
});

// --- add --------------------------------------------------------------------

test("add attaches the node under the root it was given and wires blocking edges", async () => {
  const store = new FakeStore().seed("495", { node: autoNode("495") }).seed("498", { node: autoNode("498") });

  const output = await run(
    [
      "graph",
      "add",
      "495",
      "--title",
      "scaffold node",
      "--autonomy",
      "auto",
      "--kind",
      "  TASK ",
      "--checkpoint",
      "cp-1",
      "--probe",
      JSON.stringify(PROBE),
      "--blocked-by",
      "498",
      "--repo",
      REPO,
    ],
    store,
  );

  expect(store.created).toHaveLength(1);
  expect(store.created[0].parent).toEqual({ id: "495" });
  expect(store.created[0].kind).toBe("task");
  expect(store.edges).toEqual([["498", "900"]]);
  expect(output).toContain("Created node 900 under 495");
});

test("add refuses an auto node with no probes — zero machine-checkable evidence at close", async () => {
  const store = new FakeStore().seed("495", { node: autoNode("495") });
  const message = await failure(
    ["graph", "add", "495", "--title", "t", "--autonomy", "auto", "--checkpoint", "cp-t", "--repo", REPO],
    store,
  );

  expect(message).toContain("at least one probe");
  expect(store.created).toHaveLength(0);
});

// --- close ------------------------------------------------------------------

function autoGraph(): FakeStore {
  return new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("520", { node: autoNode("520"), parent: "495", author: "ivy-agent" });
}

test("an auto close runs the probes, derives probed evidence, and writes the receipt", async () => {
  const store = autoGraph();
  const output = await run(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store);

  expect(store.closed).toHaveLength(1);
  const receipt = store.closed[0].receipt;
  expect(receipt.checkpointId).toBe("cp-520");
  expect(receipt.probeResults).toHaveLength(1);
  expect(
    receipt.evidence.some(
      (entry) => entry.kind === "probed" && entry.pointer === "HEAD abc1234 in /repo (clean)",
    ),
  ).toBe(true);
  expect(receipt.probeTrees).toEqual([{ dir: "/repo", head: "abc1234", dirty: false }]);
  expect(output).toContain("Closed node 520");
});

test("a failing probe refuses the close — nothing reaches the tracker", async () => {
  const store = autoGraph();
  const message = await failure(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, {
    runProbes: async (probes) =>
      probes.map<ProbeResult>((probe) => ({
        probe,
        state: "probed",
        outcome: "fail",
        observed: "exit 1",
        at: AT.toISOString(),
      })),
  });

  expect(message).toContain("ran and failed");
  expect(store.closed).toHaveLength(0);
});

test("a node with no attached checkpoint cannot be closed at all", async () => {
  const store = new FakeStore().seed("520", {
    node: { id: "520", title: "no checkpoint", autonomy: "auto", probes: [PROBE] },
  });

  const message = await failure(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store);
  expect(message).toContain("no attached checkpoint");
  expect(store.closed).toHaveLength(0);
});

test("an auto receipt is honestly unverified — no human ratified it", async () => {
  const store = autoGraph();
  await run(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store);

  const receipt = store.closed[0].receipt;
  expect(receipt.attestation).toBe("unverified");
  expect(receipt.attestationFacts?.reasons ?? []).toContain(
    "no ratification found — nothing was attested by a second credential",
  );
});

test("a bare `close` on a HITL node works — no proposal, no ratification", async () => {
  // The exact command closing.md documents, and the exact shape #499 was stuck
  // in. Relaxing `assertClosable` alone did not fix it: this CLI branch still
  // refused, which is the layer #499 actually hit.
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("530", { node: { id: "530", title: "hitl", autonomy: "approve", checkpointId: "cp-530" }, parent: "495" });

  const output = await run(["graph", "close", "530", "--repo", REPO, ...RESOLUTION], store);

  expect(store.closed).toHaveLength(1);
  expect(output).toContain("Closed node 530");
  // No proposal was read, so the receipt names none — and RECORDS THE ABSENCE.
  // That record is the whole after-the-fact audit story for a multi-party
  // deployment, so it is pinned here rather than left to prose.
  const receipt = store.closed[0].receipt;
  expect(receipt.attestation).toBe("unverified");
  expect(receipt.attestationFacts?.proposal).toBeUndefined();
  const reasons = receipt.attestationFacts?.reasons?.join(" ") ?? "";
  expect(reasons).toContain("no proposal comment recorded");
  expect(reasons).toContain("no ratification found");
});

test("--propose posts the proposal comment and closes nothing", async () => {
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("530", { node: { id: "530", title: "hitl", autonomy: "approve", checkpointId: "cp-530" }, parent: "495" });

  const output = await run(["graph", "close", "530", "--propose", "--body", "the resolution", "--repo", REPO], store);

  expect(store.comments.size).toBe(1);
  expect(store.closed).toHaveLength(0);
  expect(output).toContain("Posted proposal comment c1");
  expect(output).toContain("--proposal-comment c1");
});

test("a 👍 from the graph root's author on an isolated session yields a verified receipt", async () => {
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("530", { node: { id: "530", title: "hitl", autonomy: "approve", checkpointId: "cp-530" }, parent: "495" });

  await run(["graph", "close", "530", "--propose", "--body", "the resolution", "--repo", REPO], store);
  store.reactions.set("c1", [{ id: "r1", content: "+1", author: "jcfischer" }]);

  const output = await run(["graph", "close", "530", "--proposal-comment", "c1", "--repo", REPO], store);

  const receipt = store.closed[0].receipt;
  expect(receipt.attestation).toBe("verified");
  expect(receipt.evidence.some((entry) => entry.kind === "approved")).toBe(true);
  expect(receipt.attestationFacts?.ratification?.author).toBe("jcfischer");
  expect(output).toContain("attestation: verified");
});

test("the same reaction with the principal's credential reachable is unverified — #496's case", async () => {
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("530", { node: { id: "530", title: "hitl", autonomy: "approve", checkpointId: "cp-530" }, parent: "495" });

  await run(["graph", "close", "530", "--propose", "--body", "the resolution", "--repo", REPO], store);
  store.reactions.set("c1", [{ id: "r1", content: "+1", author: "jcfischer" }]);

  await run(["graph", "close", "530", "--proposal-comment", "c1", "--repo", REPO], store, {
    checkConfinement: async () => ({
      checked: true,
      reachableIdentities: ["ivy-agent", "jcfischer"],
      at: AT.toISOString(),
      probes: [],
    }),
  });

  expect(store.closed[0].receipt.attestation).toBe("unverified");
});

test("a 👍 from someone other than the root author closes, but never as verified", async () => {
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("530", { node: { id: "530", title: "hitl", autonomy: "approve", checkpointId: "cp-530" }, parent: "495" });

  await run(["graph", "close", "530", "--propose", "--body", "x", "--repo", REPO], store);
  store.reactions.set("c1", [{ id: "r1", content: "+1", author: "mellanon" }]);

  await run(["graph", "close", "530", "--proposal-comment", "c1", "--repo", REPO], store);

  expect(store.closed[0].receipt.attestation).toBe("unverified");
  expect(store.closed[0].receipt.attestationFacts?.reasons?.join(" ")).toContain("not the author of graph root");
});

test("a 👎 from the root author blocks ratification, so the close is refused", async () => {
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("530", { node: { id: "530", title: "hitl", autonomy: "approve", checkpointId: "cp-530" }, parent: "495" });

  await run(["graph", "close", "530", "--propose", "--body", "x", "--repo", REPO], store);
  store.reactions.set("c1", [
    { id: "r1", content: "-1", author: "jcfischer" },
    { id: "r2", content: "+1", author: "mellanon" },
  ]);

  // Ratification is no longer required, but an explicit refusal is still
  // honoured: dropping "you must be approved" must not become "you may ignore
  // being refused". A 👎 from the map's owner is the one reaction that
  // unambiguously means no — even with a second account's 👍 present.
  const message = await failure(["graph", "close", "530", "--proposal-comment", "c1", "--repo", REPO], store);
  expect(message).toContain("was refused");
  expect(message).toContain("jcfischer");
  expect(store.closed).toHaveLength(0);
});

test("a proposal comment on an auto node is read on the same terms", async () => {
  // Keying the block on the comment id alone (rather than on autonomy) made
  // `--proposal-comment` take effect for `auto` nodes too. That is a real
  // behaviour change and it is pinned here rather than asserted in a comment:
  // a root-author 👎 refuses an auto close, because an explicit human "no"
  // should not depend on the node's class.
  const store = autoGraph();
  await run(["graph", "close", "520", "--propose", "--body", "x", "--repo", REPO], store);
  store.reactions.set("c1", [{ id: "r1", content: "-1", author: "jcfischer" }]);

  expect(await failure(["graph", "close", "520", "--proposal-comment", "c1", "--repo", REPO], store)).toContain(
    "was refused",
  );
  expect(store.closed).toHaveLength(0);

  // And with a ratification instead, the auto close proceeds — its probe-derived
  // evidence is what gates it, with the approval recorded alongside.
  const ratified = autoGraph();
  await run(["graph", "close", "520", "--propose", "--body", "x", "--repo", REPO], ratified);
  ratified.reactions.set("c1", [{ id: "r1", content: "+1", author: "jcfischer" }]);
  await run(["graph", "close", "520", "--proposal-comment", "c1", "--repo", REPO], ratified);

  expect(ratified.closed).toHaveLength(1);
  expect(ratified.closed[0].receipt.evidence.some((e) => e.kind === "approved")).toBe(true);
  expect(ratified.closed[0].receipt.evidence.some((e) => e.kind === "probed")).toBe(true);
});

test("the veto is one close deep — a fresh proposal carries no refusal", async () => {
  // Pins a documented LIMIT rather than a guarantee. The docs call the veto a
  // speed bump and say re-proposing closes cleanly; that claim is executable
  // here so it cannot quietly become false in either direction.
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("530", { node: { id: "530", title: "hitl", autonomy: "approve", checkpointId: "cp-530" }, parent: "495" });

  await run(["graph", "close", "530", "--propose", "--body", "x", "--repo", REPO], store);
  store.reactions.set("c1", [{ id: "r1", content: "-1", author: "jcfischer" }]);
  expect(await failure(["graph", "close", "530", "--proposal-comment", "c1", "--repo", REPO], store)).toContain(
    "was refused",
  );

  // Re-propose: a new comment id, no reactions on it, and the close proceeds.
  await run(["graph", "close", "530", "--propose", "--body", "x", "--repo", REPO], store);
  await run(["graph", "close", "530", "--proposal-comment", "c2", "--repo", REPO], store);
  expect(store.closed).toHaveLength(1);
});

test("an amended proposal inherits no ratification — the replay-rebind invariant", async () => {
  // §3.2's amendment rule: a materially amended proposal is re-posted and needs
  // FRESH ratification. #525 was going to enforce it; #549 removed the gate it
  // would have served, so nothing enforces it now — it is CALLER DISCIPLINE, and
  // this test pins the half the runtime does supply: ratification is read from
  // the comment id passed, so the new proposal starts unratified. Pass the
  // superseded id instead and the old 👍 still ratifies; nothing rejects that.
  //
  // Both arms run against the SAME seeded 👍, because asserting the amended
  // close is unratified proves nothing on its own: it follows from c2 carrying
  // no reactions, and would read identically if the 👍 on c1 had never been
  // admissible. Arm A establishes that this exact reaction, in this exact
  // store, does derive a ratified `verified` receipt. Arm B then shows the
  // amended close declining to reach it. The discrimination is between the two
  // arms; neither carries it alone.
  const seeded = () =>
    new FakeStore()
      .seed("495", { node: autoNode("495"), author: "jcfischer" })
      .seed("530", { node: { id: "530", title: "hitl", autonomy: "approve", checkpointId: "cp-530" }, parent: "495" });

  // Arm A — the ratification is live and sufficient.
  const ratified = seeded();
  await run(["graph", "close", "530", "--propose", "--body", "the resolution", "--repo", REPO], ratified);
  ratified.reactions.set("c1", [{ id: "r1", content: "+1", author: "jcfischer" }]);
  await run(["graph", "close", "530", "--proposal-comment", "c1", "--repo", REPO], ratified);

  expect(ratified.closed[0].receipt.attestationFacts?.ratification?.id).toBe("r1");
  expect(ratified.closed[0].receipt.attestation).toBe("verified");

  // Arm B — same proposal, same 👍, then amended. The 👍 stays on c1, live and
  // unretracted; the close against the amended comment must not reach it.
  const amended = seeded();
  await run(["graph", "close", "530", "--propose", "--body", "the resolution", "--repo", REPO], amended);
  amended.reactions.set("c1", [{ id: "r1", content: "+1", author: "jcfischer" }]);
  await run(["graph", "close", "530", "--propose", "--body", "the AMENDED resolution", "--repo", REPO], amended);
  await run(["graph", "close", "530", "--proposal-comment", "c2", "--repo", REPO], amended);

  const receipt = amended.closed[0].receipt;
  expect(amended.reactions.get("c1")).toHaveLength(1); // still there — not consumed, not retracted
  expect(receipt.attestationFacts?.proposal?.commentId).toBe("c2");
  expect(receipt.attestationFacts?.ratification).toBeUndefined();
  expect(receipt.evidence.some((entry) => entry.kind === "approved")).toBe(false);
  expect(receipt.attestation).toBe("unverified");
  expect(receipt.attestationFacts?.reasons?.join(" ")).toContain("no ratification found");
});

test("without a 👎, a HITL node closes on the session's say-so", async () => {
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("530", { node: { id: "530", title: "hitl", autonomy: "approve", checkpointId: "cp-530" }, parent: "495" });

  await run(["graph", "close", "530", "--propose", "--body", "x", "--repo", REPO], store);
  // No reactions at all — the #499 case, which used to be unclosable.
  await run(["graph", "close", "530", "--proposal-comment", "c1", "--repo", REPO], store);

  expect(store.closed).toHaveLength(1);
  // The receipt still records what it always did; the label is unchanged.
  expect(store.closed[0].receipt.attestation).toBe("unverified");
});

test("only 👍 ratifies — every other reaction is inert", () => {
  // §3.2 states this as an absolute ("matched on `+1`, so no other emoji
  // ratifies"), and until now nothing exercised it: every test seeded `+1`.
  // A spec absolute with no probe behind it is the claim this repo keeps
  // learning not to make.
  const enthusiasm: Reaction[] = [
    { id: "r1", content: "heart", author: "jcfischer" },
    { id: "r2", content: "hooray", author: "jcfischer" },
    { id: "r3", content: "rocket", author: "jcfischer" },
    { id: "r4", content: "eyes", author: "jcfischer" },
  ];
  expect(selectRatification(enthusiasm, "ivy-agent", "jcfischer")).toBeUndefined();

  // And the companion half of the same sentence: whose 👍 it is decides
  // `attestation`, not admissibility — a non-proposer stranger still ratifies.
  expect(selectRatification([{ id: "r5", content: "+1", author: "a-stranger" }], "ivy-agent", "jcfischer")).toEqual({
    kind: "reaction",
    id: "r5",
    author: "a-stranger",
  });
});

test("selectRatification prefers the root author and ignores the proposer's own reaction", () => {
  const reactions: Reaction[] = [
    { id: "r1", content: "+1", author: "ivy-agent" },
    { id: "r2", content: "+1", author: "mellanon" },
    { id: "r3", content: "+1", author: "jcfischer" },
  ];

  expect(selectRatification(reactions, "ivy-agent", "jcfischer")?.author).toBe("jcfischer");
  expect(selectRatification(reactions, "ivy-agent", undefined)?.author).toBe("jcfischer");
  expect(selectRatification([{ id: "r1", content: "+1", author: "ivy-agent" }], "ivy-agent", "jcfischer")).toBeUndefined();
});

test("--dry-run previews the verdict and the receipt without writing either", async () => {
  const store = autoGraph();
  const output = await run(["graph", "close", "520", "--dry-run", "--repo", REPO, ...RESOLUTION], store);

  expect(store.closed).toHaveLength(0);
  expect(store.comments.size).toBe(0);
  expect(output).toContain("nothing written");
  expect(output).toContain("would be ACCEPTED");
  expect(output).toContain("## Close receipt");
});

test("--dry-run names the refusal instead of throwing it away", async () => {
  const store = autoGraph();
  const output = await run(["graph", "close", "520", "--dry-run", "--repo", REPO], store, {
    runProbes: async (probes) =>
      probes.map<ProbeResult>((probe) => ({
        probe,
        state: "probed",
        outcome: "fail",
        observed: "exit 1",
        at: AT.toISOString(),
      })),
  });

  expect(output).toContain("would be REFUSED");
  expect(store.closed).toHaveLength(0);
});

// --- the probe registry gate (DD-16 Amendment A, #526) ----------------------

/**
 * Wires the real runner behind the CLI so the registry actually gates something,
 * and so the directory the CLI resolved is the one probes are dispatched to.
 *
 * `spawned` collects each spawn's cwd for the tests that assert on *where* a
 * probe ran rather than on what the gate said.
 */
function realRunner(
  registry: ProbeRegistry,
  overrides: Partial<GraphCliDeps> = {},
  spawned?: string[],
): Partial<GraphCliDeps> {
  return {
    loadProbeRegistry: async () => registry,
    // Takes the cwd the CLI resolved rather than naming one of its own: the
    // thing under test in #580 is that one stated value reaches the runner.
    runProbes: async (probes, supplied, cwd) =>
      await runProbes(probes, {
        cwd,
        registry: supplied,
        deps: {
          runCommand: async (request) => {
            spawned?.push(request.cwd ?? "<inherited>");
            return { exitCode: 0, stdout: "640 pass", stderr: "", timedOut: false };
          },
          now: () => AT,
        },
      }),
    ...overrides,
  };
}

test("close refuses an undeclared command probe and hands back the entry to add", async () => {
  const store = autoGraph();
  const message = await failure(
    ["graph", "close", "520", "--repo", REPO, ...RESOLUTION],
    store,
    realRunner({ status: "loaded", repo: REPO, path: REGISTRY_PATH, commands: [], urlHosts: [] }),
  );

  expect(store.closed).toHaveLength(0);
  expect(message).toContain("not authorised on this machine");
  expect(message).toContain(PROBE_RUN);
  expect(message).toContain(`{"run": "bun test", "cwd": "/repo"}`);
  expect(message).toContain(REGISTRY_PATH);
});

test("close on a machine with no registry refuses rather than running tracker content", async () => {
  const store = autoGraph();
  const message = await failure(
    ["graph", "close", "520", "--repo", REPO, ...RESOLUTION],
    store,
    realRunner({ status: "absent", repo: REPO, path: REGISTRY_PATH }),
  );

  expect(store.closed).toHaveLength(0);
  expect(message).toContain("no registry exists at");
});

test("a declared command probe closes exactly as before — the gate is not a new hurdle", async () => {
  const store = autoGraph();
  const output = await run(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, realRunner(DECLARED));

  expect(store.closed).toHaveLength(1);
  expect(output).toContain("Closed node 520");
});

test("--dry-run still renders the receipt when the registry refused a probe", async () => {
  const store = autoGraph();
  const output = await run(
    ["graph", "close", "520", "--dry-run", "--repo", REPO],
    store,
    realRunner({ status: "absent", repo: REPO, path: REGISTRY_PATH }),
  );

  expect(store.closed).toHaveLength(0);
  expect(output).toContain("would be REFUSED");
  expect(output).toContain("1 of 1 probe(s) refused");
  expect(output).toContain("## Close receipt");
});

// --- the probe tree is stated, not inherited (#579, #580) -------------------

/** A registry that authorises the one probe in the tree the CLI states it will use. */
function declaredIn(dir: string): ProbeRegistry {
  return { status: "loaded", repo: REPO, path: REGISTRY_PATH, commands: [{ run: PROBE_RUN, cwd: dir }], urlHosts: [] };
}

test("probes run in the stated directory, not the process's — and the receipt names it", async () => {
  // The test #579 needed and did not have. Asserting "probes run in the session
  // cwd" passes on the broken code too, because on the developer's machine the
  // two were the same directory; the only falsifiable version makes them differ.
  const stated = "/work/tree-under-review";
  expect(stated).not.toBe(process.cwd());

  const spawned: string[] = [];
  const store = autoGraph();
  const output = await run(
    ["graph", "close", "520", "--repo", REPO, ...RESOLUTION],
    store,
    realRunner(
      declaredIn(stated),
      { probeCwd: () => stated, describeProbeTree: async (dir) => ({ dir, head: "f00dcafe", dirty: false }) },
      spawned,
    ),
  );

  expect(output).toContain("Closed node 520");
  // Where it actually ran …
  expect(spawned).toEqual([stated]);
  // … and what the receipt says about it — the two agreeing is the whole fix.
  const receipt = store.closed[0].receipt;
  expect(receipt.probeTrees).toEqual([{ dir: stated, head: "f00dcafe", dirty: false }]);
  expect(receipt.evidence.some((entry) => entry.kind === "probed" && entry.pointer?.includes(stated))).toBe(true);
});

test("the registry match follows the stated tree, so a declaration for another checkout does not authorise", async () => {
  // #579's second half: the install tree was declared, so the gate was satisfied
  // by a directory the caller never chose. Authorisation has to track the value
  // the runner is handed, not whatever tree happens to hold a declaration.
  const store = autoGraph();
  const message = await failure(
    ["graph", "close", "520", "--repo", REPO, ...RESOLUTION],
    store,
    realRunner(declaredIn("/install/tree"), { probeCwd: () => "/work/tree-under-review" }),
  );

  expect(store.closed).toHaveLength(0);
  expect(message).toContain("not authorised on this machine");
  expect(message).toContain(`{"run": "bun test", "cwd": "/work/tree-under-review"}`);
});

test("every tree the probes ran in is described, and each line says which one", async () => {
  // Sage on #584: a `command` probe may carry its own absolute `cwd`, so one
  // recorded tree would speak for a probe that never touched it — #579's
  // mislabel one level down. Every directory the probes resolve to is described.
  const elsewhere = "/some/other/checkout";
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("520", {
      node: autoNode("520", { probes: [PROBE, { ...PROBE, cwd: elsewhere }] }),
      parent: "495",
      author: "ivy-agent",
    });

  await run(
    ["graph", "close", "520", "--repo", REPO, ...RESOLUTION],
    store,
    realRunner({
      status: "loaded",
      repo: REPO,
      path: REGISTRY_PATH,
      commands: [
        { run: PROBE_RUN, cwd: "/repo" },
        { run: PROBE_RUN, cwd: elsewhere },
      ],
      urlHosts: [],
    }),
  );

  const receipt = store.closed[0].receipt;
  expect(receipt.probeResults.map((result) => (result.state === "probed" ? result.cwd : undefined))).toEqual([
    "/repo",
    elsewhere,
  ]);
  expect(receipt.probeTrees?.map((tree) => tree.dir)).toEqual(["/repo", elsewhere]);
  const probed = receipt.evidence.find((entry) => entry.kind === "probed");
  expect(probed?.summary).toContain("across 2 trees");
  // Both trees in the pointer: one standing in for the other is the whole bug.
  expect(probed?.pointer).toContain("/repo");
  expect(probed?.pointer).toContain(elsewhere);
  const rendered = renderCloseReceipt(receipt);
  expect(rendered).toContain("Ran across 2 trees:");
  expect(rendered).toContain(`[in ${elsewhere}]`);
  expect(rendered).toContain(`[in /repo]`);
});

test("a base tree no probe ran in is never described, let alone used as the anchor", async () => {
  // Sage on #584 round 3: with every probe naming an absolute `cwd`, describing
  // the base would anchor the close on a HEAD nothing was tested against — and
  // would paper over that tree's own missing HEAD.
  const only = "/some/other/checkout";
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("520", { node: autoNode("520", { probes: [{ ...PROBE, cwd: only }] }), parent: "495", author: "ivy-agent" });

  const described: string[] = [];
  await run(
    ["graph", "close", "520", "--repo", REPO, ...RESOLUTION],
    store,
    realRunner(declaredIn(only), {
      describeProbeTree: async (dir) => {
        described.push(dir);
        return { dir, head: "f00dcafe", dirty: false };
      },
    }),
  );

  expect(described).toEqual([only]);
  expect(store.closed[0].receipt.probeTrees?.map((tree) => tree.dir)).toEqual([only]);
  expect(store.closed[0].receipt.evidence.find((entry) => entry.kind === "probed")?.pointer).toContain(only);
});

test("a probe tree outside the stated tree is never read, let alone described (#582)", async () => {
  // The pre-flight spawns `git status` in a directory a **node body** names, and
  // it runs before any gate has refused anything. An escaping `repo` would get
  // that tree read and its HEAD published on the way to being refused, which is
  // the disclosure containment exists to remove — so the uncontained directory
  // is dropped before the read, not after it.
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("520", {
      node: autoNode("520", { probes: [{ type: "git-ref-exists", ref: "HEAD", repo: "/elsewhere" }] }),
      parent: "495",
      author: "ivy-agent",
    });

  const described: string[] = [];
  const message = await failure(
    ["graph", "close", "520", "--repo", REPO, ...RESOLUTION],
    store,
    realRunner(DECLARED, {
      describeProbeTree: async (dir) => {
        described.push(dir);
        return { dir, head: "f00dcafe", dirty: false };
      },
    }),
  );

  expect(described).toEqual([]);
  expect(store.closed).toHaveLength(0);
  // Surfaced with its reason, not swallowed into assertClosable's generic "ran
  // and failed" — the message names the path and the tree, and the fix is the
  // node, never the registry.
  expect(message).toContain("outside the probe tree");
  expect(message).toContain("/elsewhere");
  expect(message).toContain("Make the path tree-relative on the node");
  expect(message).not.toContain("The registry is yours to edit");
});

test("one probe tree without a HEAD unanchors the whole set", async () => {
  // `2/2 passed` beside a pointer that can only account for one of the trees is
  // the overstatement this change exists to remove, so it withholds instead.
  const other = "/some/other/checkout";
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("520", {
      node: autoNode("520", { probes: [PROBE, { ...PROBE, cwd: other }] }),
      parent: "495",
      author: "ivy-agent",
    });

  const message = await failure(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, {
    describeProbeTree: async (dir) => (dir === other ? { dir } : { dir, head: "abc1234", dirty: false }),
  });

  expect(store.closed).toHaveLength(0);
  expect(message).toContain("needs at least one");
});

test("the probe tree is read before the probes run, not after they have written to it", async () => {
  // A probe is free to dirty the tree it tests — `bun test` leaving a fixture
  // behind would otherwise make the receipt report dirt the probes caused
  // rather than the state they ran against.
  const order: string[] = [];
  const store = autoGraph();
  await run(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, {
    describeProbeTree: async (dir) => {
      order.push("describe");
      return { dir, head: "abc1234", dirty: false };
    },
    runProbes: async (probes) => {
      order.push("probes");
      return probes.map<ProbeResult>((probe) => ({
        probe,
        state: "probed",
        outcome: "pass",
        observed: "exit 0",
        at: AT.toISOString(),
        cwd: "/repo",
      }));
    },
  });

  expect(order).toEqual(["describe", "probes"]);
});

test("a url-only close records no tree, and anchors on the targets it actually checked", async () => {
  // Sage on #584 round 2: a `url` probe runs against a host. Rendering "Ran in
  // HEAD … " over it would name a checkout the close never read — the same
  // mislabel, pointing the other way.
  const target = "https://status.example.test/health";
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("520", {
      node: autoNode("520", { probes: [{ type: "url", target, expectStatus: 200 }] }),
      parent: "495",
      author: "ivy-agent",
    });

  let described = 0;
  await run(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, {
    describeProbeTree: async (dir) => {
      described += 1;
      return { dir, head: "abc1234", dirty: false };
    },
  });

  const receipt = store.closed[0].receipt;
  expect(described).toBe(0);
  expect(receipt.probeTrees).toBeUndefined();
  expect(receipt.evidence.find((entry) => entry.kind === "probed")?.pointer).toBe(`targets: ${target}`);
  expect(renderCloseReceipt(receipt)).not.toContain("Ran in");
});

test("a mixed close anchors on both halves — trees and targets", async () => {
  // Sage on #584 round 7: naming only the trees would put `n/n passed` beside a
  // pointer that silently drops the host checks, which is the same partial
  // accounting the all-or-nothing tree rule refuses.
  const target = "https://status.example.test/health";
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("520", {
      node: autoNode("520", { probes: [PROBE, { type: "url", target, expectStatus: 200 }] }),
      parent: "495",
      author: "ivy-agent",
    });

  await run(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store);

  const pointer = store.closed[0].receipt.evidence.find((entry) => entry.kind === "probed")?.pointer;
  expect(pointer).toContain("HEAD abc1234 in /repo");
  expect(pointer).toContain(`targets: ${target}`);
});

test("pre-flight tree reads are bounded, however many directories the tracker names", async () => {
  // The directory list is tracker content. Unbounded, a node body declaring a
  // hundred probes with a hundred `cwd`s fans out a hundred git processes on the
  // closing machine before the registry has refused any of them.
  const dirs = Array.from({ length: 12 }, (_unused, index) => `/tree-${index}`);
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("520", {
      node: autoNode("520", { probes: dirs.map((dir) => ({ ...PROBE, cwd: dir })) }),
      parent: "495",
      author: "ivy-agent",
    });

  let inFlight = 0;
  let peak = 0;
  await run(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, {
    describeProbeTree: async (dir) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { dir, head: "abc1234", dirty: false };
    },
  });

  expect(store.closed[0].receipt.probeTrees?.map((tree) => tree.dir)).toEqual(dirs);
  expect(peak).toBeLessThanOrEqual(4);
});

test("a relative probe directory is resolved before it is recorded or compared", async () => {
  // The runner resolves its cwd; if the receipt kept the relative spelling, every
  // "did this run outside the tree?" comparison is between two spellings of the
  // same directory and every probe reads as elsewhere.
  const store = autoGraph();
  await run(
    ["graph", "close", "520", "--repo", REPO, ...RESOLUTION],
    store,
    realRunner(declaredIn(process.cwd()), {
      probeCwd: () => ".",
      describeProbeTree: async (dir) => ({ dir, head: "abc1234", dirty: false }),
    }),
  );

  const receipt = store.closed[0].receipt;
  expect(receipt.probeTrees?.[0]?.dir).toBe(process.cwd());
  expect(renderCloseReceipt(receipt)).not.toContain("[in ");
});

test("a dirty probe tree is recorded, never refused (#579)", async () => {
  const store = autoGraph();
  const output = await run(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, {
    describeProbeTree: async (dir) => ({ dir, head: "abc1234", dirty: true }),
  });

  expect(output).toContain("Closed node 520");
  expect(store.closed[0].receipt.probeTrees?.[0]?.dirty).toBe(true);
  const pointer = store.closed[0].receipt.evidence.find((entry) => entry.kind === "probed")?.pointer;
  expect(pointer).toBe("HEAD abc1234 in /repo (dirty)");
});

test("a tree with no readable HEAD anchors nothing, so an auto close still refuses", async () => {
  // Unchanged from before #580 — moving where the sha is read must not widen
  // what closes an `auto` node.
  const store = autoGraph();
  const message = await failure(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, {
    describeProbeTree: async (dir) => ({ dir }),
  });

  expect(store.closed).toHaveLength(0);
  expect(message).toContain("needs at least one");
});

test("the rendered receipt names the probe tree next to the probe results", async () => {
  const store = autoGraph();
  const output = await run(["graph", "close", "520", "--dry-run", "--repo", REPO], store, {
    describeProbeTree: async (dir) => ({ dir, head: "abc1234", dirty: true }),
  });

  expect(output).toContain("### Probes");
  expect(output).toContain("Ran in HEAD abc1234 in /repo (dirty).");
});

test("the pre-flight status call refuses the target repo's choice of program", () => {
  // The directory comes from a node body, and this read happens before the
  // registry has refused anything — so `core.fsmonitor`, a program path in the
  // target repo's own config, would be tracker content reaching execution on a
  // probe the gate was about to reject.
  const argv = probeTreeStatusArgv("/some/other/checkout");

  expect(argv).toEqual([
    "git",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.pager=cat",
    "-C",
    "/some/other/checkout",
    "status",
    "--porcelain=v2",
    "--branch",
  ]);
});

test("a published tree path drops the home prefix but keeps what distinguishes checkouts", () => {
  const home = "/Users/someone";
  const tree = { dir: `${home}/work/soma/.worktrees/x`, head: "abc1234", dirty: false };

  expect(describeProbeTree(tree, home)).toBe("HEAD abc1234 in ~/work/soma/.worktrees/x (clean)");
  // Outside home, and home itself: unchanged, and not mangled.
  expect(describeProbeTree({ ...tree, dir: "/srv/build" }, home)).toContain("in /srv/build ");
  expect(describeProbeTree({ ...tree, dir: home }, home)).toContain("in ~ ");
  // A prefix that is not a path boundary is not a home match.
  expect(describeProbeTree({ ...tree, dir: "/Users/someone-else/x" }, home)).toContain("in /Users/someone-else/x ");
  // The runner has a win32 branch, so a backslash-separated directory can reach
  // here — and a `/`-only boundary check would publish the full path on exactly
  // the platform this is protecting.
  expect(describeProbeTree({ ...tree, dir: String.raw`C:\Users\someone\work\x` }, String.raw`C:\Users\someone`)).toContain(
    String.raw`in ~\work\x `,
  );
});

test("parseProbeTreeStatus reads HEAD and dirt out of one git call", () => {
  const clean = parseProbeTreeStatus("/repo", "# branch.oid abc1234\n# branch.head main\n");
  expect(clean).toEqual({ dir: "/repo", head: "abc1234", dirty: false });

  const dirty = parseProbeTreeStatus(
    "/repo",
    "# branch.oid abc1234\n# branch.head main\n1 .M N... 100644 100644 100644 aaa bbb src/x.ts\n? scratch.md\n",
  );
  expect(dirty).toEqual({ dir: "/repo", head: "abc1234", dirty: true });

  // A repo with no commit yet has no HEAD to name — and no sha to invent.
  expect(parseProbeTreeStatus("/repo", "# branch.oid (initial)\n# branch.head main\n")).toEqual({
    dir: "/repo",
    dirty: false,
  });
});

test("--evidence cannot supply the kind that closes the node", async () => {
  // The hole this closes: assertClosable counts any admissible-kind entry with a
  // pointer and cannot tell derived from hand-written, so without a boundary
  // check a caller closes an approve-class node with no proposal and no human.
  const hitl = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("520", {
      node: { id: "520", title: "hitl", autonomy: "approve", checkpointId: "cp-520" },
      parent: "495",
      author: "ivy-agent",
    });

  const forged = await failure(
    ["graph", "close", "520", "--repo", REPO, ...RESOLUTION, "--evidence", '{"kind":"approved","summary":"looks fine","pointer":"trust me"}'],
    hitl,
  );
  expect(forged).toContain("--evidence cannot carry `approved`");
  expect(forged).toContain("ratified proposal comment");
  expect(hitl.closed).toHaveLength(0);

  // Same rule on the AFK side: `probed`/`tested` are what a passed probe earns.
  const afk = autoGraph();
  const selfReport = await failure(
    ["graph", "close", "520", "--repo", REPO, ...RESOLUTION, "--evidence", '{"kind":"tested","summary":"ran it myself","pointer":"HEAD"}'],
    afk,
  );
  expect(selfReport).toContain("--evidence cannot carry");
  expect(afk.closed).toHaveLength(0);

  // Informational kinds still pass through.
  const informed = autoGraph();
  await run(
    ["graph", "close", "520", "--repo", REPO, ...RESOLUTION, "--evidence", '{"kind":"judged","summary":"sage reviewed","pointer":"pr#1"}'],
    informed,
  );
  expect(informed.closed[0].receipt.evidence.some((entry) => entry.kind === "judged")).toBe(true);
});

test("close takes no flag that relocates the probe registry", async () => {
  // A caller-selectable registry path is the hole the soma-home placement closes:
  // point it at a file you just wrote and the exact-match authorises itself.
  const store = autoGraph();
  const message = await failure(["graph", "close", "520", "--repo", REPO, "--soma-home", "/tmp/mine"], store);

  expect(message).toContain("Unknown option: --soma-home");
  expect(store.closed).toHaveLength(0);
  expect(GRAPH_COMMAND_HELP.subcommands.close).not.toContain("--soma-home");
});

test("--propose refuses to publish a proposal on a node that cannot close", async () => {
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("520", {
      node: { id: "520", title: "no checkpoint", autonomy: "approve" },
      parent: "495",
      author: "ivy-agent",
    });

  const message = await failure(["graph", "close", "520", "--propose", "--body", "done", "--repo", REPO], store);

  expect(message).toContain("no attached checkpoint");
  expect(store.comments.size).toBe(0); // nothing published for a 👍 that could never be used
});

test("--propose refuses --dry-run rather than posting under a preview flag", () => {
  expect(() => parseGraphArgs(["graph", "close", "520", "--propose", "--body", "x", "--dry-run"])).toThrow(
    /cannot be combined with --dry-run/u,
  );
});

test("the gate is uniform — a HITL node is refused on the same terms as an auto one", async () => {
  const store = autoGraph().seed("520", {
    node: { id: "520", title: "hitl", autonomy: "approve", checkpointId: "cp-520", probes: [PROBE] },
    parent: "495",
    author: "ivy-agent",
  });

  const message = await failure(
    ["graph", "close", "520", "--repo", REPO, ...RESOLUTION],
    store,
    realRunner({ status: "absent", repo: REPO, path: REGISTRY_PATH }),
  );

  // Refused before the proposal path is even reached: the registry answers
  // whose code this is, which is not an autonomy question.
  expect(message).toContain("not authorised on this machine");
  expect(message).not.toContain("--propose");
  expect(store.closed).toHaveLength(0);
});

test("reading is not executing — node and frontier never consult the registry", async () => {
  const store = autoGraph();
  const explode = async (): Promise<never> => {
    throw new Error("the read path must not consult the probe registry — a node is data");
  };

  const node = await run(["graph", "node", "520", "--repo", REPO], store, { loadProbeRegistry: explode });
  expect(node).toContain("node: 520");
  expect(node).toContain(PROBE_RUN); // the undeclared probe still reads back verbatim

  const rooted = autoGraph().seed("495", { node: autoNode("495"), author: "jcfischer", children: ["520"] });
  const frontier = await run(["graph", "frontier", "495", "--repo", REPO], rooted, { loadProbeRegistry: explode });
  expect(frontier).toContain("- 520");
});

test("closing from the dev tree warns that the gate is not where §1 clause 5 puts it", async () => {
  const store = autoGraph();
  const warnings: string[] = [];
  await run(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, {
    fromDevTree: true,
    warn: (message) => warnings.push(message),
  });

  expect(warnings.join(" ")).toContain("installed binary");
});

test("a closed node is not closed twice", async () => {
  const store = autoGraph().seed("520", { node: autoNode("520"), parent: "495", status: "closed" });
  expect(await failure(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store)).toContain("already closed");
});

// --- every close carries prose (#556) --------------------------------------

test("an auto close with no --resolution-file refuses, before a single probe runs", async () => {
  const store = autoGraph();
  const probed: string[] = [];
  const message = await failure(["graph", "close", "520", "--repo", REPO], store, {
    runProbes: async (probes) => {
      probed.push("ran");
      return probes.map<ProbeResult>((probe) => ({
        probe,
        state: "probed",
        outcome: "pass",
        observed: "exit 0",
        at: AT.toISOString(),
      }));
    },
  });

  expect(message).toContain("has no resolution");
  expect(message).toContain("--resolution-file");
  // Before the probes, deliberately: a missing paragraph must not cost a
  // 900-second `bun test` before the refusal arrives.
  expect(probed).toEqual([]);
  expect(store.closed).toHaveLength(0);
  expect(store.comments.size).toBe(0);
});

test("a bare HITL close needs prose too — it has no proposal body to stand in", async () => {
  // The hole #556 found: closing.md makes the bare close the normal
  // single-operator route, so exempting HITL wholesale would let a grilling node
  // — whose entire output IS a decision — close with no human-readable half.
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("530", { node: { id: "530", title: "hitl", autonomy: "approve", checkpointId: "cp-530" }, parent: "495" });

  expect(await failure(["graph", "close", "530", "--repo", REPO], store)).toContain("has no resolution");
  expect(store.closed).toHaveLength(0);
});

test("a close naming a ratified proposal needs no --resolution-file — that body is the resolution", async () => {
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("530", { node: { id: "530", title: "hitl", autonomy: "approve", checkpointId: "cp-530" }, parent: "495" });
  await run(["graph", "close", "530", "--propose", "--body", "the resolution", "--repo", REPO], store);
  store.reactions.set("c1", [{ id: "r1", content: "+1", author: "jcfischer" }]);

  const output = await run(["graph", "close", "530", "--proposal-comment", "c1", "--repo", REPO], store);

  expect(output).toContain("Closed node 530");
  expect(store.closed).toHaveLength(1);
});

test("the resolution rides the receipt — no comment of its own is posted", async () => {
  const store = autoGraph();
  await run(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, {
    readTextFile: async () => "Containment holds: the resolved path must stay under the stated tree.",
  });

  // On the receipt, not beside it: the backend's `close` posts one comment from
  // exactly this value, so there is no ordering in which one half lands without
  // the other. (The rendered order is pinned in work-graph.test.ts.)
  expect(store.closed[0].receipt.resolution).toContain("Containment holds");
  expect(store.comments.size).toBe(0);
});

test("--dry-run renders the prose and writes nothing", async () => {
  const store = autoGraph();
  const output = await run(["graph", "close", "520", "--dry-run", "--repo", REPO, ...RESOLUTION], store, {
    readTextFile: async () => "Why this closed.",
  });

  expect(output).toContain("would be ACCEPTED");
  expect(output).toContain("## Resolution");
  expect(output).toContain("Why this closed.");
  expect(store.closed).toHaveLength(0);
  expect(store.comments.size).toBe(0);
});

test("an empty resolution file refuses — a blank paragraph satisfies nothing", async () => {
  const store = autoGraph();
  const message = await failure(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, {
    readTextFile: async () => "   \n\n  ",
  });

  expect(message).toContain("is empty");
  expect(store.closed).toHaveLength(0);
});

// --- the receipt has to fit in a tracker comment (#527/#592) ---------------

test("a node whose worst-case receipt cannot fit refuses before any probe runs", async () => {
  // GitHub caps a comment at 65,536 characters and the receipt POST happens
  // AFTER every probe — so without this the wall sits at the far end of the
  // expensive part. 60 probes at their failing-case size overruns the budget.
  const many = Array.from({ length: 60 }, (_, i) => ({
    type: "command" as const,
    run: `check-${i}`,
    timeoutSec: 60,
    expectExit: 0,
  }));
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), author: "jcfischer" })
    .seed("520", { node: autoNode("520", { probes: many }), parent: "495", author: "ivy-agent" });

  const probed: string[] = [];
  const message = await failure(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, {
    runProbes: async () => {
      probed.push("ran");
      return [];
    },
  });

  expect(message).toContain("too large for the tracker");
  expect(message).toContain("60 declared probe(s)");
  expect(probed).toEqual([]);
  expect(store.closed).toHaveLength(0);
});

test("a long resolution pushes an otherwise-fitting node over, and the refusal says so", async () => {
  // #588's prose rides the same comment as the receipt. Neither half is at fault
  // alone; they overrun together, so the estimate counts both.
  const store = autoGraph();
  const message = await failure(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, {
    readTextFile: async () => "p".repeat(70_000),
  });

  expect(message).toContain("too large for the tracker");
  expect(message).toContain("70,000 characters of resolution prose");
  expect(store.closed).toHaveLength(0);
});

test("an ordinary close is nowhere near the budget", async () => {
  const store = autoGraph();
  const output = await run(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store);
  expect(output).toContain("Closed node 520");
});

test("an unreadable resolution file names the path, not an ENOENT stack", async () => {
  const store = autoGraph();
  const message = await failure(["graph", "close", "520", "--repo", REPO, ...RESOLUTION], store, {
    readTextFile: async () => {
      throw new Error("ENOENT: no such file or directory");
    },
  });

  expect(message).toContain("resolution.md");
  expect(message).toContain("could not be read");
  expect(store.closed).toHaveLength(0);
});

test("--propose with --resolution-file refuses rather than posting the prose twice", () => {
  expect(() =>
    parseGraphArgs(["graph", "close", "520", "--propose", "--body", "x", ...RESOLUTION]),
  ).toThrow(/the proposal body is the resolution/u);
});

// --- node prints its body; audit and decisions read the graph (#495 review) --

test("soma graph node prints the body — reading a node must not require the tracker's own CLI", async () => {
  class BodyStore extends FakeStore {
    override async readNode(ref: NodeRef): Promise<NodeState> {
      const state = await super.readNode(ref);
      return { ...state, body: "## The question\n\nDoes the verb show this?" };
    }
  }
  const store = new BodyStore().seed("495", { node: autoNode("495") });

  const output = await run(["graph", "node", "495", "--repo", REPO], store);

  expect(output).toContain("## The question");
  expect(output).toContain("Does the verb show this?");
});

test("audit flags a closed node with no receipt — the tracker closed it, the gate never ran", async () => {
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), children: ["520", "521", "522"] })
    .seed("520", { node: autoNode("520"), status: "closed", parent: "495" })
    .seed("521", { node: autoNode("521"), status: "closed", parent: "495" })
    .seed("522", {
      node: { id: "522", title: "no gate", autonomy: "approve" },
      typed: false,
      parent: "495",
      assignees: ["ivy-agent"],
    });
  // 520 closed properly — its receipt comment is on the node. 521 was
  // auto-closed by the tracker: closed, no receipt anywhere.
  await store.postComment({ id: "520" }, `## Resolution\n\nfine\n\n## Close receipt\n\n- **checkpoint:** \`cp-520\``);

  const output = await run(["graph", "audit", "495", "--repo", REPO], store);

  expect(output).toContain("Closed without a close receipt");
  expect(output).toContain("521");
  expect(output).not.toMatch(/receipt[\s\S]*- 520 /u);
  expect(output).toContain("Open with no checkpoint");
  expect(output).toContain("522");
  expect(output).toContain("Open and claimed");
});

test("a clean subtree audits clean", async () => {
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), children: ["520"] })
    .seed("520", { node: autoNode("520"), status: "closed", parent: "495" });
  await store.postComment({ id: "520" }, `## Close receipt\n\n- **checkpoint:** \`cp-520\``);

  const output = await run(["graph", "audit", "495", "--repo", REPO], store);

  expect(output).toContain("Clean");
});

test("decisions derives the index from receipts — gist when recorded, honest fallbacks otherwise", async () => {
  const store = new FakeStore()
    .seed("495", { node: autoNode("495"), children: ["520", "521", "522"] })
    .seed("520", { node: autoNode("520", { title: "contain the probes" }), status: "closed", parent: "495" })
    .seed("521", { node: autoNode("521", { title: "prose on every close" }), status: "closed", parent: "495" })
    .seed("522", { node: autoNode("522", { title: "auto-closed by the tracker" }), status: "closed", parent: "495" });
  await store.postComment(
    { id: "520" },
    `## Close receipt\n\n- **checkpoint:** \`cp-520\`\n- **gist:** resolved paths must stay under the stated tree\n- **closed by:** ivy-agent`,
  );
  await store.postComment({ id: "521" }, `## Close receipt\n\n- **checkpoint:** \`cp-521\``);

  const output = await run(["graph", "decisions", "495", "--repo", REPO], store);

  expect(output).toContain("[contain the probes]");
  expect(output).toContain("resolved paths must stay under the stated tree");
  expect(output).toContain("no gist on the receipt");
  expect(output).toContain("closed without a receipt");
});

test("decisions --write splices between the markers and refuses without them", async () => {
  const withMarkers = new FakeStore()
    .seed("495", {
      node: autoNode("495"),
      children: ["520"],
      rawBody: `# Map\n\nprose above\n\n<!-- soma:decisions:begin -->\nstale hand-written list\n<!-- soma:decisions:end -->\n\nprose below`,
    })
    .seed("520", { node: autoNode("520", { title: "a decision" }), status: "closed", parent: "495" });
  await withMarkers.postComment({ id: "520" }, `## Close receipt\n\n- **gist:** the decided thing`);

  await run(["graph", "decisions", "495", "--write", "--repo", REPO], withMarkers);
  const body = await withMarkers.readRawBody({ id: "495" });

  expect(body).toContain("the decided thing");
  expect(body).not.toContain("stale hand-written list");
  // The verb owns the section, never the prose around it.
  expect(body).toContain("prose above");
  expect(body).toContain("prose below");
  expect(body).toContain("<!-- soma:decisions:begin -->");

  const withoutMarkers = new FakeStore()
    .seed("495", { node: autoNode("495"), children: [], rawBody: "# Map with no markers" })
    .seed("520", { node: autoNode("520"), status: "closed", parent: "495" });
  const message = await failure(["graph", "decisions", "495", "--write", "--repo", REPO], withoutMarkers);
  expect(message).toContain("no decisions markers");
  expect(await withoutMarkers.readRawBody({ id: "495" })).toBe("# Map with no markers");
});

test("the close stamps gist and tool into the receipt, and the renderer's gist line is what decisions parses", async () => {
  const store = autoGraph();
  await run(
    ["graph", "close", "520", "--repo", REPO, ...RESOLUTION, "--gist", "one line for the index"],
    store,
    { describeTool: async () => "soma 9.9.9 @ abc1234 (dev tree)" },
  );

  const receipt = store.closed[0].receipt;
  expect(receipt.gist).toBe("one line for the index");
  expect(receipt.closedWith).toBe("soma 9.9.9 @ abc1234 (dev tree)");

  // Round-trip: the rendered receipt is exactly what scanCommentsForReceipt
  // reads. One renderer, one parser — this is the pin that keeps them together.
  const scan = scanCommentsForReceipt([renderCloseReceipt(receipt)]);
  expect(scan.hasReceipt).toBe(true);
  expect(scan.gist).toBe("one line for the index");
});

test("--gist refuses multi-line text — it is the index entry, not the resolution", () => {
  expect(() =>
    parseGraphArgs(["graph", "close", "520", ...RESOLUTION, "--gist", "line one\nline two"]),
  ).toThrow(/one non-empty line/u);
});

test("SomaCliError carries a non-zero exit for a lost claim", async () => {
  const store = new FakeStore().seed("498", { node: autoNode("498") });
  store.claimResult = { held: false, identity: "ivy-agent", holder: "aaa-bot", assignees: ["aaa-bot"] };

  try {
    await run(["graph", "claim", "498", "--repo", REPO], store);
    throw new Error("expected a refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(SomaCliError);
    expect((error as SomaCliError).exitCode).toBe(1);
  }
});

// --- the probe tree is the tree soma was invoked from (#662) ----------------

/**
 * A real git repository, somewhere that is emphatically not soma's own tree,
 * with one committed artifact.
 *
 * Real rather than stubbed because the failure being closed lives *inside* git:
 * `git cat-file -e HEAD:<path>` run in the wrong directory exits 128, and a fake
 * runner returning a chosen exit code would be asserting the fix on the way in.
 */
async function repoContaining(path: string): Promise<string> {
  // `realpath` because $TMPDIR is a symlink on macOS and every comparison below
  // is string equality against a path the CLI resolved lexically.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "soma-662-")));
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, path), "the artifact the node claims\n", "utf8");
  for (const argv of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "test@example.test"],
    ["config", "user.name", "soma test"],
    ["add", "."],
    ["commit", "-m", "seed"],
  ]) {
    const proc = Bun.spawn(["git", "-C", dir, ...argv], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  }
  return dir;
}

test("a close probes the repo it was invoked from, even when the launcher cd'd elsewhere (#662)", async () => {
  // AC-2. The failure: an arc-generated shim `cd`s into soma's install tree
  // before `exec`, so `process.cwd()` is that tree and every declared probe
  // resolved against it — `git cat-file` reported the node's artifact "absent"
  // while it sat, committed, in the checkout the operator ran the close from.
  //
  // Falsifiable by construction: `docs/only-here.md` exists in the temp repo and
  // in no soma checkout, so a probe base that fell back to `process.cwd()` (this
  // test file's own tree) fails the probe and the close refuses.
  const repoDir = await repoContaining("docs/only-here.md");
  const previous = process.env.ARC_INVOCATION_CWD;
  process.env.ARC_INVOCATION_CWD = repoDir;

  try {
    const probe: Probe = { type: "artifact-exists", path: "docs/only-here.md", atRef: "HEAD" };
    const store = new FakeStore()
      .seed("495", { node: autoNode("495"), author: "jcfischer" })
      .seed("520", { node: autoNode("520", { probes: [probe] }), parent: "495", author: "ivy-agent" });

    // `probeCwd` and `describeProbeTree` are dropped rather than stubbed: the
    // thing under test *is* the default `probeCwd`, and a test that injected one
    // would pass against the broken code. Everything else stays hermetic.
    const { probeCwd: _useTheDefault, describeProbeTree: _readTheRealTree, ...overrides } = deps(store, {
      runProbes: async (probes, registry, cwd) => await runProbes(probes, { cwd, registry, deps: { now: () => AT } }),
    });

    const output = await runGraphCli(
      parseGraphArgs(["graph", "close", "520", "--repo", REPO, ...RESOLUTION]),
      overrides,
    );

    expect(output).toContain("Closed node 520");
    const receipt = store.closed[0].receipt;
    // Where it ran …
    const [result] = receipt.probeResults;
    if (result.state !== "probed") throw new Error("the runner returned a specified result — it must run the probe");
    expect(result.outcome).toBe("pass");
    expect(result.cwd).toBe(repoDir);
    // … and what the receipt says about it, read from the real tree.
    const [tree] = receipt.probeTrees ?? [];
    expect(tree?.dir).toBe(repoDir);
    expect(tree?.head).toMatch(/^[0-9a-f]{4,40}$/u);
  } finally {
    if (previous === undefined) delete process.env.ARC_INVOCATION_CWD;
    else process.env.ARC_INVOCATION_CWD = previous;
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("the same close, run from a directory that is not a repository, says so instead of 'absent' (#662)", async () => {
  // AC-3 at the CLI seam. The half of #662 that cost the reporter the most time
  // was not the wrong directory — it was the receipt describing the wrong
  // directory in the vocabulary of a missing file.
  const notARepo = await realpath(await mkdtemp(join(tmpdir(), "soma-662-bare-")));
  const previous = process.env.ARC_INVOCATION_CWD;
  process.env.ARC_INVOCATION_CWD = notARepo;

  try {
    const probe: Probe = { type: "artifact-exists", path: "docs/only-here.md", atRef: "HEAD" };
    const store = new FakeStore()
      .seed("495", { node: autoNode("495"), author: "jcfischer" })
      .seed("520", { node: autoNode("520", { probes: [probe] }), parent: "495", author: "ivy-agent" });

    const { probeCwd: _useTheDefault, ...overrides } = deps(store, {
      runProbes: async (probes, registry, cwd) => await runProbes(probes, { cwd, registry, deps: { now: () => AT } }),
    });

    // `--dry-run` rather than the refusal: the refusal message summarises
    // ("ran and failed"), and the string the operator actually reads their
    // diagnosis out of is the rendered receipt.
    const output = await runGraphCli(
      parseGraphArgs(["graph", "close", "520", "--dry-run", "--repo", REPO]),
      overrides,
    );

    expect(store.closed).toHaveLength(0);
    expect(output).toContain("would be REFUSED");
    expect(output).toContain(`could not reach HEAD in ${notARepo}`);
    // Our wording and a verified exit code, never git's prose. This line used to
    // assert `not a git repository` — real git's phrasing, in a real-git test,
    // which is the same assumption class that turned the B2 arm red on CI. It
    // happens to hold on both platforms; it is still the wrong thing to depend
    // on, since git reworders and localises its messages and we control neither.
    expect(output).toContain("git exited 128");
    expect(output).not.toContain("absent");
  } finally {
    if (previous === undefined) delete process.env.ARC_INVOCATION_CWD;
    else process.env.ARC_INVOCATION_CWD = previous;
    await rm(notARepo, { recursive: true, force: true });
  }
});

test("artifact-exists at a ref: the four outcomes, against real git (#662 review B1/m3)", async () => {
  // The test whose absence let B1 ship green. Every other assertion about this
  // branch's exit codes runs against a stub, and the stub encoded a value real
  // git never returns: `cat-file -e <ref>:<path>` reports a MISSING PATH as a
  // fatal (128), not as exit 1 — the same code a missing repository gives. A
  // split that read reachability off that call therefore called every genuine
  // absence "unreachable". Only real git can hold this contract honest.
  const repoDir = await repoContaining("docs/only-here.md");
  const notARepo = await realpath(await mkdtemp(join(tmpdir(), "soma-662-nonrepo-")));

  const run = async (dir: string, path: string, atRef: string) => {
    const result = await runProbe({ type: "artifact-exists", path, atRef }, { cwd: dir, deps: { now: () => AT } });
    if (result.state !== "probed") throw new Error("the runner must always run the probe");
    return result;
  };

  try {
    // 1. Present at a valid ref.
    const present = await run(repoDir, "docs/only-here.md", "HEAD");
    expect(present.outcome).toBe("pass");
    expect(present.observed).toBe("docs/only-here.md present at HEAD");

    // 2. Genuinely absent at a valid ref, in a reachable repo. This is the one
    //    B1 broke: real git exits 128 here.
    const absent = await run(repoDir, "docs/never-committed.md", "HEAD");
    expect(absent.outcome).toBe("fail");
    expect(absent.observed).toBe("docs/never-committed.md absent at HEAD");
    expect(absent.observed).not.toContain("could not reach");

    // 3. Reachable repo, ref that does not resolve.
    const badRef = await run(repoDir, "docs/only-here.md", "nosuchref");
    expect(badRef.outcome).toBe("fail");
    expect(badRef.observed).toBe(`nosuchref does not resolve in ${collapseHome(repoDir)}`);

    // 4. Not a repository at all — #662's reported symptom.
    const unreachable = await run(notARepo, "docs/only-here.md", "HEAD");
    expect(unreachable.outcome).toBe("fail");
    expect(unreachable.observed).toContain(`could not reach HEAD in ${collapseHome(notARepo)}`);
    expect(unreachable.observed).not.toContain("absent");
  } finally {
    await rm(repoDir, { recursive: true, force: true });
    await rm(notARepo, { recursive: true, force: true });
  }
});

/** Run `body` with `HOME` pointed somewhere else, restoring it whatever happens. */
async function withHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

test("a probe failure never publishes the operator's home path — deterministic arm (#662 review B2)", async () => {
  // THE POSITIVE PROOF LIVES HERE, on injected deps, because it is the only arm
  // that behaves the same on every git.
  //
  // The first version of this test asserted `~/…` against REAL git's stderr and
  // went red on CI: a gitfile whose target is missing makes Linux git say
  // `fatal: not a git repository: (null)` while macOS git names the path. So
  // there was nothing to redact there and the assertion waited for a string that
  // could not appear. That is this branch's own lesson one layer out — I asserted
  // a git MESSAGE FORMAT, having spent four rounds learning not to assume git's
  // exit codes.
  //
  // A crafted stderr is honest here in a way it was not for B1: the unit under
  // test is *our redaction of arbitrary subprocess text*, not git's phrasing, so
  // the stub encodes no belief about git at all.
  const home = "/Users/tester";
  const leaked = `${home}/.ssh/secret/.git`;

  const result = await withHome(home, async () =>
    await runProbe(
      { type: "artifact-exists", path: "docs/x.md", atRef: "HEAD" },
      {
        cwd: "/repo",
        deps: {
          runCommand: async () => ({
            exitCode: 128,
            stdout: "",
            stderr: `fatal: not a git repository: ${leaked}\n`,
            timedOut: false,
          }),
          now: () => AT,
        },
      },
    ),
  );
  if (result.state !== "probed") throw new Error("the runner must always run the probe");

  expect(result.outcome).toBe("fail");
  // The negative — the property we actually care about.
  expect(result.observed).not.toContain(home);
  // …and the positive: the redirect is still named, wearing `~`, so the redaction
  // is proved to have FIRED rather than the message merely having lost its path.
  expect(result.observed).toContain("~/.ssh/secret/.git");
});

test("…and the same holds against real git, when this git names the path at all (#662 review B2)", async () => {
  // The real-git arm, kept but made SELF-CHECKING rather than assuming.
  //
  // Kept, rather than dropped, because the gitfile redirect is the shape that
  // beats containment — git reaching a path no probe was allowed to read — and
  // retiring it would leave that scenario covered only by a string I wrote
  // myself. Made conditional because whether git echoes the target is a message
  // format, and this branch's whole subject is not assuming those.
  //
  // `HOME` points at a temp directory (#662 review n3) so an interrupted run
  // cannot litter the operator's real home. `redactHome` reads `HOME` at call
  // time through the same ambient default it uses in production, so the real
  // lookup is still exercised; git is told nothing about the swap.
  const home = await realpath(await mkdtemp(join(tmpdir(), "soma-662-home-")));
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "soma-662-notahome-")));
  const redirected = join(home, ".soma-662-b2-fixture");
  const probeTree = await realpath(await mkdtemp(join(tmpdir(), "soma-662-gitfile-")));

  try {
    await mkdir(redirected, { recursive: true });
    await writeFile(join(probeTree, ".git"), `gitdir: ${join(redirected, ".git")}\n`, "utf8");

    const probe = async (): Promise<string> => {
      const result = await runProbe(
        { type: "artifact-exists", path: "docs/x.md", atRef: "HEAD" },
        { cwd: probeTree, deps: { now: () => AT } },
      );
      if (result.state !== "probed") throw new Error("the runner must always run the probe");
      expect(result.outcome).toBe("fail");
      return result.observed;
    };

    // Control: HOME somewhere unrelated, so nothing is redacted and the raw
    // message is visible. This is how we learn what THIS git says, instead of
    // deciding in advance.
    const control = await withHome(elsewhere, probe);
    const namesThePath = control.includes(redirected);

    const observed = await withHome(home, probe);

    // Unconditional, true on every git: the raw home prefix is never published.
    expect(observed).not.toContain(home);

    if (namesThePath) {
      // This git echoes the gitfile target, so redaction had something to do and
      // must be seen to have done it.
      expect(observed).toContain("~/.soma-662-b2-fixture");
    } else {
      // This git does not name the path (Linux says `(null)`), so there is
      // nothing to redact. Assert the message is still the useful one rather than
      // letting the test pass vacuously.
      expect(observed).toContain("could not reach HEAD");
    }
  } finally {
    await rm(probeTree, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});
