import { expect, test } from "bun:test";
import { SomaCliError } from "../src/cli/errors";
import {
  GRAPH_COMMAND_HELP,
  parseGraphArgs,
  parseProbeTreeStatus,
  runGraphCli,
  selectRatification,
  type GraphCliDeps,
} from "../src/cli/graph";
import { parseRepoFromRemote } from "../src/work-graph-bridge";
import {
  WorkGraphError,
  runProbes,
  type ClaimResult,
  type CloseReceipt,
  type CommentRef,
  type CreateNodeSpec,
  type GraphStore,
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
    now: () => AT,
    warn: () => undefined,
    fromDevTree: false,
    ...overrides,
  };
}

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

test("the parser accepts exactly the five verbs of §2.6", () => {
  for (const action of ["frontier", "node", "claim", "add", "close"]) {
    const parsed = parseGraphArgs(
      action === "add" ? ["graph", action, "495", "--title", "t", "--autonomy", "approve"] : ["graph", action, "495"],
    );
    expect(parsed.action).toBe(action as never);
  }
  expect(() => parseGraphArgs(["graph", "delete", "495"])).toThrow(/frontier\|node\|claim\|add\|close/u);
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
    ["graph", "add", "495", "--title", "t", "--autonomy", "auto", "--repo", REPO],
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
  const output = await run(["graph", "close", "520", "--repo", REPO], store);

  expect(store.closed).toHaveLength(1);
  const receipt = store.closed[0].receipt;
  expect(receipt.checkpointId).toBe("cp-520");
  expect(receipt.probeResults).toHaveLength(1);
  expect(
    receipt.evidence.some(
      (entry) => entry.kind === "probed" && entry.pointer === "HEAD abc1234 in /repo (clean)",
    ),
  ).toBe(true);
  expect(receipt.probeTree).toEqual({ dir: "/repo", head: "abc1234", dirty: false });
  expect(output).toContain("Closed node 520");
});

test("a failing probe refuses the close — nothing reaches the tracker", async () => {
  const store = autoGraph();
  const message = await failure(["graph", "close", "520", "--repo", REPO], store, {
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

  const message = await failure(["graph", "close", "520", "--repo", REPO], store);
  expect(message).toContain("no attached checkpoint");
  expect(store.closed).toHaveLength(0);
});

test("an auto receipt is honestly unverified — no human ratified it", async () => {
  const store = autoGraph();
  await run(["graph", "close", "520", "--repo", REPO], store);

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

  const output = await run(["graph", "close", "530", "--repo", REPO], store);

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
  const output = await run(["graph", "close", "520", "--dry-run", "--repo", REPO], store);

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

/** Wires the real runner behind the CLI so the registry actually gates something. */
function realRunner(registry: ProbeRegistry, overrides: Partial<GraphCliDeps> = {}): Partial<GraphCliDeps> {
  return {
    loadProbeRegistry: async () => registry,
    // Takes the cwd the CLI resolved rather than naming one of its own: the
    // thing under test in #580 is that one stated value reaches the runner.
    runProbes: async (probes, supplied, cwd) =>
      await runProbes(probes, {
        cwd,
        registry: supplied,
        deps: {
          runCommand: async () => ({ exitCode: 0, stdout: "640 pass", stderr: "", timedOut: false }),
          now: () => AT,
        },
      }),
    ...overrides,
  };
}

test("close refuses an undeclared command probe and hands back the entry to add", async () => {
  const store = autoGraph();
  const message = await failure(
    ["graph", "close", "520", "--repo", REPO],
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
    ["graph", "close", "520", "--repo", REPO],
    store,
    realRunner({ status: "absent", repo: REPO, path: REGISTRY_PATH }),
  );

  expect(store.closed).toHaveLength(0);
  expect(message).toContain("no registry exists at");
});

test("a declared command probe closes exactly as before — the gate is not a new hurdle", async () => {
  const store = autoGraph();
  const output = await run(["graph", "close", "520", "--repo", REPO], store, realRunner(DECLARED));

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
  const output = await run(["graph", "close", "520", "--repo", REPO], store, {
    probeCwd: () => stated,
    loadProbeRegistry: async () => declaredIn(stated),
    runProbes: async (probes, registry, cwd) =>
      await runProbes(probes, {
        cwd,
        registry,
        deps: {
          runCommand: async (request) => {
            spawned.push(request.cwd ?? "<inherited>");
            return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
          },
          now: () => AT,
        },
      }),
    describeProbeTree: async (dir) => ({ dir, head: "f00dcafe", dirty: false }),
  });

  expect(output).toContain("Closed node 520");
  // Where it actually ran …
  expect(spawned).toEqual([stated]);
  // … and what the receipt says about it — the two agreeing is the whole fix.
  const receipt = store.closed[0].receipt;
  expect(receipt.probeTree).toEqual({ dir: stated, head: "f00dcafe", dirty: false });
  expect(receipt.evidence.some((entry) => entry.kind === "probed" && entry.pointer?.includes(stated))).toBe(true);
});

test("the registry match follows the stated tree, so a declaration for another checkout does not authorise", async () => {
  // #579's second half: the install tree was declared, so the gate was satisfied
  // by a directory the caller never chose. Authorisation has to track the value
  // the runner is handed, not whatever tree happens to hold a declaration.
  const store = autoGraph();
  const message = await failure(["graph", "close", "520", "--repo", REPO], store, {
    probeCwd: () => "/work/tree-under-review",
    loadProbeRegistry: async () => declaredIn("/install/tree"),
    runProbes: async (probes, registry, cwd) =>
      await runProbes(probes, {
        cwd,
        registry,
        deps: { runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }), now: () => AT },
      }),
  });

  expect(store.closed).toHaveLength(0);
  expect(message).toContain("not authorised on this machine");
  expect(message).toContain(`{"run": "bun test", "cwd": "/work/tree-under-review"}`);
});

test("a dirty probe tree is recorded, never refused (#579)", async () => {
  const store = autoGraph();
  const output = await run(["graph", "close", "520", "--repo", REPO], store, {
    describeProbeTree: async (dir) => ({ dir, head: "abc1234", dirty: true }),
  });

  expect(output).toContain("Closed node 520");
  expect(store.closed[0].receipt.probeTree?.dirty).toBe(true);
  const pointer = store.closed[0].receipt.evidence.find((entry) => entry.kind === "probed")?.pointer;
  expect(pointer).toBe("HEAD abc1234 in /repo (dirty)");
});

test("a tree with no readable HEAD anchors nothing, so an auto close still refuses", async () => {
  // Unchanged from before #580 — moving where the sha is read must not widen
  // what closes an `auto` node.
  const store = autoGraph();
  const message = await failure(["graph", "close", "520", "--repo", REPO], store, {
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
    ["graph", "close", "520", "--repo", REPO, "--evidence", '{"kind":"approved","summary":"looks fine","pointer":"trust me"}'],
    hitl,
  );
  expect(forged).toContain("--evidence cannot carry `approved`");
  expect(forged).toContain("ratified proposal comment");
  expect(hitl.closed).toHaveLength(0);

  // Same rule on the AFK side: `probed`/`tested` are what a passed probe earns.
  const afk = autoGraph();
  const selfReport = await failure(
    ["graph", "close", "520", "--repo", REPO, "--evidence", '{"kind":"tested","summary":"ran it myself","pointer":"HEAD"}'],
    afk,
  );
  expect(selfReport).toContain("--evidence cannot carry");
  expect(afk.closed).toHaveLength(0);

  // Informational kinds still pass through.
  const informed = autoGraph();
  await run(
    ["graph", "close", "520", "--repo", REPO, "--evidence", '{"kind":"judged","summary":"sage reviewed","pointer":"pr#1"}'],
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
    ["graph", "close", "520", "--repo", REPO],
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
  await run(["graph", "close", "520", "--repo", REPO], store, {
    fromDevTree: true,
    warn: (message) => warnings.push(message),
  });

  expect(warnings.join(" ")).toContain("installed binary");
});

test("a closed node is not closed twice", async () => {
  const store = autoGraph().seed("520", { node: autoNode("520"), parent: "495", status: "closed" });
  expect(await failure(["graph", "close", "520", "--repo", REPO], store)).toContain("already closed");
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
