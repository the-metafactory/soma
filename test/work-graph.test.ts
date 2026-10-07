import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { walkFakeSubtree } from "./fixtures/work-graph-fixtures";
import {
  WorkGraph,
  WorkGraphError,
  assertClosable,
  hashGatedNodeFields,
  estimateReceiptChars,
  scanCommentsForReceipt,
  spliceSection,
  DECISIONS_BEGIN,
  DECISIONS_END,
  parseNodeSpec,
  parseProbe,
  renderCloseReceipt,
  RECEIPT_COMMENT_BUDGET,
  RECEIPT_COMMENT_LIMIT,
  resolveClaimRace,
  toNode,
  type ClaimResult,
  type ReleaseResult,
  type CloseReceipt,
  type CommentRef,
  type CreateNodeOptions,
  type CreateNodeSpec,
  type RehomeSelection,
  type ConfinementResult,
  type GraphStore,
  type NodeRef,
  type NodeState,
  type Probe,
  type WorkGraphNode,
} from "../src/index";

test("the close hash binds store-owned home without changing other node hashes", () => {
  const base = { autonomy: "approve" as const };
  expect(hashGatedNodeFields(base, { home: "group/one" })).not.toBe(hashGatedNodeFields(base, { home: "group/two" }));
  expect(hashGatedNodeFields(base)).toBe(hashGatedNodeFields(base, {}));
});

test("creation refuses top-level home instead of dropping store-owned routing data", () => {
  expect(() => parseNodeSpec({ title: "child", autonomy: "approve", parent: { id: "map" }, home: "group/project" })).toThrow(/home is store-owned/u);
});

const PASSING_PROBE: Probe = { type: "command", run: "bun test", timeoutSec: 600, expectExit: 0 };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof WorkGraphError ? error.code : `not-a-WorkGraphError:${String(error)}`;
  }
  return "no-throw";
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof WorkGraphError ? error.code : `not-a-WorkGraphError:${String(error)}`;
  }
  return "no-throw";
}

// --- parsing: the authoritative barrier at the store boundary (§2.1) --------

test("an auto node without probes is rejected at the boundary, whatever the caller's typing says", () => {
  // The tuple type guards literal construction; this is the JSON path that
  // bypasses it entirely.
  const fromJson: unknown = JSON.parse('{"title":"headless work","autonomy":"auto"}');
  expect(codeOf(() => parseNodeSpec(fromJson))).toBe("invalid-node");
  expect(codeOf(() => parseNodeSpec({ title: "headless work", autonomy: "auto", probes: [] }))).toBe("invalid-node");
});

test("an auto node with at least one probe parses, and keeps the probe", () => {
  const spec = parseNodeSpec({ title: "seam", autonomy: "auto", probes: [PASSING_PROBE] });
  expect(spec.autonomy).toBe("auto");
  expect(spec.probes).toEqual([PASSING_PROBE]);
});

test("HITL nodes may carry no probes", () => {
  expect(parseNodeSpec({ title: "grill the credential topology", autonomy: "approve" }).probes).toBeUndefined();
});

test("kind is normalized in form and never interpreted in meaning", () => {
  expect(parseNodeSpec({ title: "t", autonomy: "approve", kind: "  Grilling  " }).kind).toBe("grilling");
  expect(parseNodeSpec({ title: "t", autonomy: "approve", kind: "wholly-invented-kind" }).kind).toBe("wholly-invented-kind");
  expect(parseNodeSpec({ title: "t", autonomy: "approve" }).kind).toBeUndefined();
  expect(codeOf(() => parseNodeSpec({ title: "t", autonomy: "approve", kind: "   " }))).toBe("invalid-node");
});

test("labels are validated as form only, and never become node state", () => {
  const spec = parseNodeSpec({
    title: "t",
    autonomy: "propose",
    kind: "grilling",
    labels: ["orienteer:grilling", "orienteer:grilling", " orienteer:map "],
  });
  // Deduplicated and trimmed; no vocabulary is enforced, exactly as for `kind`.
  expect(spec.labels).toEqual(["orienteer:grilling", "orienteer:map"]);

  // Creation input, not node state: one authoritative home for `kind`, and the
  // label is a derived view of it that no verb ever reads back.
  expect("labels" in toNode("520", spec)).toBe(false);

  expect(codeOf(() => parseNodeSpec({ title: "t", autonomy: "propose", labels: "grilling" }))).toBe("invalid-node");
  expect(codeOf(() => parseNodeSpec({ title: "t", autonomy: "propose", labels: [""] }))).toBe("invalid-node");
  expect(codeOf(() => parseNodeSpec({ title: "t", autonomy: "propose", labels: [7] }))).toBe("invalid-node");
});

test("ids are store-assigned, so a caller-supplied one is refused", () => {
  expect(codeOf(() => parseNodeSpec({ id: "42", title: "t", autonomy: "approve" }))).toBe("invalid-node");
});

test("titles and autonomy are required", () => {
  expect(codeOf(() => parseNodeSpec({ autonomy: "approve" }))).toBe("invalid-node");
  expect(codeOf(() => parseNodeSpec({ title: "   ", autonomy: "approve" }))).toBe("invalid-node");
  expect(codeOf(() => parseNodeSpec({ title: "t", autonomy: "whenever" }))).toBe("invalid-node");
  expect(codeOf(() => parseNodeSpec("not an object"))).toBe("invalid-node");
});

test("budgets must declare a positive cap", () => {
  expect(parseNodeSpec({ title: "t", autonomy: "approve", budget: { tokens: 100 } }).budget).toEqual({ tokens: 100 });
  expect(codeOf(() => parseNodeSpec({ title: "t", autonomy: "approve", budget: {} }))).toBe("invalid-node");
  expect(codeOf(() => parseNodeSpec({ title: "t", autonomy: "approve", budget: { tokens: 0 } }))).toBe("invalid-node");
});

test("every probe variant parses, and prose is not one of them", () => {
  const probes: unknown[] = [
    { type: "command", run: "bunx tsc --noEmit", timeoutSec: 120, expectExit: 0 },
    { type: "url", target: "https://example.test/health", expectStatus: 200 },
    { type: "git-ref-exists", ref: "refs/heads/feat/work-graph-primitive" },
    { type: "git-merged-into", ref: "feat/work-graph-primitive", into: "main" },
    { type: "artifact-exists", path: "src/work-graph.ts", atRef: "HEAD" },
  ];
  for (const probe of probes) expect(parseProbe(probe)).toEqual(probe as Probe);

  expect(codeOf(() => parseProbe({ type: "reviewer-says-it-is-fine", run: "trust me" }))).toBe("invalid-probe");
  expect(codeOf(() => parseProbe({ type: "command", run: "bun test", timeoutSec: 0, expectExit: 0 }))).toBe("invalid-probe");
  expect(codeOf(() => parseProbe({ type: "url", target: "https://x.test", expectStatus: 999 }))).toBe("invalid-probe");
});

// --- claim race (§2.4) ------------------------------------------------------

test("the sole assignee holds the claim", () => {
  expect(resolveClaimRace("ivy-agent", ["ivy-agent"])).toEqual({ held: true, holder: "ivy-agent" });
});

test("a race converges on the code-point-first login, and every racer computes the same winner", () => {
  const assignees = ["jcfischer", "ivy-agent", "Zed"];
  expect(resolveClaimRace("Zed", assignees)).toEqual({ held: true, holder: "Zed" });
  expect(resolveClaimRace("ivy-agent", assignees)).toEqual({ held: false, holder: "Zed" });
  expect(resolveClaimRace("jcfischer", assignees)).toEqual({ held: false, holder: "Zed" });
  // Uppercase sorts before lowercase by code point — the rule is arbitrary but
  // identical on every machine, which is the property that matters.
  expect(resolveClaimRace("Zed", ["Zed", "aaa"]).held).toBe(true);
});

test("an empty assignee set means the write did not land — nobody holds it", () => {
  expect(resolveClaimRace("ivy-agent", [])).toEqual({ held: false, holder: null });
});

// --- close gating (§2.1, §3.1, §3.2) ---------------------------------------

const AUTO_NODE: WorkGraphNode = {
  id: "497",
  title: "GraphStore seam",
  autonomy: "auto",
  checkpointId: "cp-497",
  probes: [PASSING_PROBE],
};

function receipt(overrides: Partial<CloseReceipt> = {}): CloseReceipt {
  return {
    checkpointId: "cp-497",
    closedBy: "ivy-agent",
    at: "2026-08-04T10:00:00.000Z",
    // Every close carries prose (#556). Defaulted here so the tests that are
    // about the other conjuncts stay about them; the ones about this conjunct
    // override it away.
    resolution: "The seam ships with its GitHub backend; the typed contracts hold.",
    evidence: [{ kind: "probed", summary: "bun test exit 0", pointer: "https://example.test/run/1" }],
    probeResults: [
      { probe: PASSING_PROBE, state: "probed", outcome: "pass", observed: "exit 0", at: "2026-08-04T09:59:00.000Z" },
    ],
    attestation: "unverified",
    // `auto` closes must cite a successful CI check run (§3.1) — defaulted here
    // so the tests about the other conjuncts stay about them.
    ci: { checkRunId: "12345", headSha: "abc123def456" },
    ...overrides,
  };
}

test("a node with no attached checkpoint cannot close", () => {
  const { checkpointId: _unused, ...noCheckpoint } = AUTO_NODE;
  expect(codeOf(() => { assertClosable(noCheckpoint, receipt()); })).toBe("close-refused");
});

test("the receipt must name the node's own checkpoint", () => {
  expect(codeOf(() => { assertClosable(AUTO_NODE, receipt({ checkpointId: "cp-somewhere-else" })); })).toBe("close-refused");
});

test("a probe that was specified but never run refuses the close", () => {
  const hollow = receipt({ probeResults: [{ probe: PASSING_PROBE, state: "specified" }] });
  expect(codeOf(() => { assertClosable(AUTO_NODE, hollow); })).toBe("close-refused");
  expect(codeOf(() => { assertClosable(AUTO_NODE, receipt({ probeResults: [] })); })).toBe("close-refused");
});

test("a probe that ran and failed refuses the close", () => {
  const failed = receipt({
    probeResults: [
      { probe: PASSING_PROBE, state: "probed", outcome: "fail", observed: "exit 1", at: "2026-08-04T09:59:00.000Z" },
    ],
  });
  expect(codeOf(() => { assertClosable(AUTO_NODE, failed); })).toBe("close-refused");
});

test("judged evidence never suffices alone — a model's opinion informs, never decides", () => {
  const judged = receipt({ evidence: [{ kind: "judged", summary: "sage approved", pointer: "https://example.test/review" }] });
  expect(codeOf(() => { assertClosable(AUTO_NODE, judged); })).toBe("close-refused");
});

test("agent-external evidence without a pointer is a self-report, not a receipt", () => {
  const pointerless = receipt({ evidence: [{ kind: "probed", summary: "it worked on my machine" }] });
  expect(codeOf(() => { assertClosable(AUTO_NODE, pointerless); })).toBe("close-refused");
});

test("an auto node closes on probed evidence with a pointer and every probe passed", () => {
  expect(() => { assertClosable(AUTO_NODE, receipt()); }).not.toThrow();
});

test("a HITL node closes without a ratification — the human walking it is present", () => {
  // The original rule required `approved` evidence here. It named no consumer on
  // a single-operator deployment: there was nobody else to ratify, so it did not
  // verify the close, it only prevented it (#499). Dropped deliberately.
  const hitl: WorkGraphNode = { id: "511", title: "credential confinement", autonomy: "approve", checkpointId: "cp-511" };
  expect(() => { assertClosable(hitl, receipt({ checkpointId: "cp-511", probeResults: [] })); }).not.toThrow();

  // A ratification is still admissible when one exists — it is a tool, not a toll.
  const ratified = receipt({
    checkpointId: "cp-511",
    probeResults: [],
    evidence: [{ kind: "approved", summary: "👍 by jcfischer", pointer: "https://example.test/#issuecomment-1" }],
  });
  expect(() => { assertClosable(hitl, ratified); }).not.toThrow();
});

test("an auto node still needs evidence its probes actually produced", () => {
  // The gate that survives: machine-checkable, free (the entry is derived from
  // probes that ran), and it names a real consumer — nobody watched this close.
  const bare = receipt({ evidence: [] });
  expect(codeOf(() => { assertClosable(AUTO_NODE, bare); })).toBe("close-refused");
});

test("an unverified attestation still closes — gating on it would deadlock the bootstrap", () => {
  expect(() => { assertClosable(AUTO_NODE, receipt({ attestation: "unverified" })); }).not.toThrow();
});

test("the rendered receipt carries the checkpoint, the attestation and the evidence pointers", () => {
  const rendered = renderCloseReceipt(
    receipt({
      attestationFacts: { backendCapability: "verifiable", root: { nodeId: "495", author: "jcfischer" } },
    }),
  );
  expect(rendered).toContain("cp-497");
  expect(rendered).toContain("`unverified`");
  expect(rendered).toContain("https://example.test/run/1");
  expect(rendered).toContain("**pass**");
  expect(rendered).toContain('"backendCapability": "verifiable"');
});

test("the rendered receipt puts the resolution above it — one comment, human half first", () => {
  const rendered = renderCloseReceipt(receipt({ resolution: "The seam ships with its consumer." }));

  expect(rendered.indexOf("## Resolution")).toBeLessThan(rendered.indexOf("## Close receipt"));
  expect(rendered).toContain("The seam ships with its consumer.");
  // A later reader reads prose, not a probe table; burying it would make the
  // comment's first screen the half written for machines (#556).
  expect(rendered.startsWith("## Resolution")).toBe(true);
});

test("a receipt with no resolution renders no empty heading", () => {
  // The exempt case — a ratified proposal carries the prose — must not leave a
  // bare `## Resolution` with nothing under it.
  const rendered = renderCloseReceipt(receipt({ resolution: undefined }));
  expect(rendered).not.toContain("## Resolution");
  expect(rendered.startsWith("## Close receipt")).toBe(true);
});

test("a close with neither prose nor a proposal is refused, whatever its autonomy", () => {
  const bare = receipt({ resolution: undefined });
  expect(codeOf(() => { assertClosable(AUTO_NODE, bare); })).toBe("close-refused");

  const hitl: WorkGraphNode = { id: "530", title: "hitl", autonomy: "approve", checkpointId: "cp-530" };
  expect(codeOf(() => { assertClosable(hitl, receipt({ checkpointId: "cp-530", probeResults: [], resolution: undefined })); })).toBe(
    "close-refused",
  );

  // Whitespace is not prose.
  expect(codeOf(() => { assertClosable(AUTO_NODE, receipt({ resolution: "  \n " })); })).toBe("close-refused");
});

test("a recorded proposal exempts the close — its body already is the resolution", () => {
  const ratified = receipt({
    resolution: undefined,
    attestationFacts: {
      backendCapability: "verifiable",
      proposal: { commentId: "c1", author: "ivy-agent" },
    },
  });
  expect(() => { assertClosable(AUTO_NODE, ratified); }).not.toThrow();
});

test("the receipt estimate counts the prose and the failing-case probe size", () => {
  // Worst case is every probe FAILING: a close cannot know its outcomes before
  // it runs, and planning for the passing case would refuse nothing until the
  // day something breaks.
  const bare = estimateReceiptChars({ probeCount: 0 });
  const withProbes = estimateReceiptChars({ probeCount: 10 });
  const withProse = estimateReceiptChars({ probeCount: 0, resolution: "x".repeat(1_000) });

  expect(withProbes).toBeGreaterThan(bare);
  expect(withProse).toBe(bare + 1_000);
  // Two probes' worth of headroom below the hard cap, so the budget is a margin
  // rather than a second name for the limit.
  expect(RECEIPT_COMMENT_BUDGET).toBeLessThan(RECEIPT_COMMENT_LIMIT);
});

test("the receipt scan rejects marker-only comments and accepts a rendered receipt", () => {
  expect(scanCommentsForReceipt(["just a discussion comment", "## Close receipt\n\n- **checkpoint:** `cp-x`"])).toEqual({ hasReceipt: false });
  const receipt: CloseReceipt = { checkpointId: "cp-x", closedBy: "ivy", at: "2026-08-24T12:00:00.000Z", attestation: "unverified", evidence: [{ kind: "probed", summary: "test passed" }], probeResults: [] };
  expect(scanCommentsForReceipt([renderCloseReceipt(receipt)])).toEqual({ hasReceipt: true });
});

test("the receipt scan accepts a rendered HITL receipt without evidence", () => {
  const hitl: CloseReceipt = { checkpointId: "cp-hitl", closedBy: "jcfischer", at: "2026-08-24T12:00:00.000Z", attestation: "unverified", evidence: [], probeResults: [] };
  expect(scanCommentsForReceipt([renderCloseReceipt(hitl)])).toEqual({ hasReceipt: true });
});

// #685: #661 made the scan require an `autonomy` line, which receipts rendered
// before it never carried — audit called real closes receipt-less and
// `decisions --write` blanked their gists. The body is #646's receipt, verbatim.
const PRE_661_RECEIPT = [
  "## Resolution",
  "",
  "W1 inventory.",
  "",
  "## Close receipt",
  "",
  "- **checkpoint:** `cp-evolution-w1-inventory`",
  "- **gist:** Completion requires a receipt at the close write.",
  "- **closed by:** jcfischer",
  "- **closed with:** soma 0.18.0 @ fe6be2a (dev tree)",
  "- **at:** 2026-08-24T12:39:50.580Z",
  "- **attestation:** `unverified`",
  "",
  "### Evidence",
  "",
  "",
  "### Attestation facts",
].join("\n");

test("the receipt scan accepts a receipt rendered before the autonomy line existed (#685)", () => {
  expect(scanCommentsForReceipt([PRE_661_RECEIPT])).toEqual({ hasReceipt: true, gist: "Completion requires a receipt at the close write." });
});

test("the receipt's soma version, not its date, decides whether it predates the autonomy line (#685)", () => {
  const withSoma = (version: string, at = "2026-08-24T12:39:50.580Z") =>
    PRE_661_RECEIPT.replace("soma 0.18.0 @ fe6be2a (dev tree)", version).replace("2026-08-24T12:39:50.580Z", at);
  // An install older than 0.19.0 kept writing autonomy-less receipts after #661 merged.
  expect(scanCommentsForReceipt([withSoma("soma 0.18.3 @ 1234567", "2026-09-10T09:00:00.000Z")]).hasReceipt).toBe(true);
  expect(scanCommentsForReceipt([withSoma("soma 0.19.0 @ 1234567")]).hasReceipt).toBe(false);
  expect(scanCommentsForReceipt([withSoma("soma 1.0.0")]).hasReceipt).toBe(false);
  expect(scanCommentsForReceipt([withSoma("a hand-written note")]).hasReceipt).toBe(false);
});

test("a receipt with no version line falls back to the date #661 merged (#685)", () => {
  const unversioned = PRE_661_RECEIPT.replace("- **closed with:** soma 0.18.0 @ fe6be2a (dev tree)\n", "");
  expect(scanCommentsForReceipt([unversioned]).hasReceipt).toBe(true);
  const late = unversioned.replace("2026-08-24T12:39:50.580Z", "2026-08-28T09:00:00.000Z");
  expect(scanCommentsForReceipt([late]).hasReceipt).toBe(false);
});

test("a receipt with a malformed autonomy line is not read as legacy (#685)", () => {
  const malformed = PRE_661_RECEIPT.replace("- **attestation:**", "- **autonomy:** `sometimes`\n- **attestation:**");
  expect(scanCommentsForReceipt([malformed])).toEqual({ hasReceipt: false });
});

test("spliceSection replaces only the marked span, and refuses malformed markers", () => {
  const body = `above\n${DECISIONS_BEGIN}\nold\n${DECISIONS_END}\nbelow`;
  const spliced = spliceSection(body, "- new line");
  expect(spliced).toContain("- new line");
  expect(spliced).not.toContain("old");
  expect(spliced).toContain("above");
  expect(spliced).toContain("below");
  // Idempotent: splicing again over its own output still finds the markers.
  expect(spliceSection(spliced ?? "", "- newer")).toContain("- newer");

  expect(spliceSection("no markers here", "x")).toBeUndefined();
  // An end marker BEFORE the begin marker is malformed, not a zero-length span.
  expect(spliceSection(`${DECISIONS_END}\n${DECISIONS_BEGIN}`, "x")).toBeUndefined();
});

// The map body template and the splice are one contract in two files: the
// template is what a charted map is copied from, and `decisions --write`
// refuses a body without the markers. Shipped without them (#621), every map
// failed its first write — a defect no test could see, because each half was
// correct alone. Assert the template against the real splice, not against a
// copy of the marker strings.
test("the orienteer map template is writable by spliceSection (#621)", async () => {
  const template = await readFile(
    new URL("../src/skills/orienteer/references/map.md", import.meta.url),
    "utf8",
  );
  const spliced = spliceSection(template, "- [A closed node](link) — the gist");
  expect(spliced).toBeDefined();
  expect(spliced).toContain("- [A closed node](link) — the gist");
  // The placeholder line lives inside the span, so the first write clears it.
  expect(spliced).not.toContain("<closed node title>");
  // …and the prose around the span is untouched.
  expect(spliced).toContain("## Not yet specified");
});

// --- contract layer over a store -------------------------------------------

interface FakeNode {
  state: NodeState;
  blockers: string[];
}

class FakeStore implements GraphStore {
  readonly attestation = "verifiable" as const;
  actingIdentity = async (): Promise<string> => "ivy-agent";
  checkConfinement = async (): Promise<ConfinementResult> => ({ checked: false, reachableIdentities: [], at: "", probes: [] });
  readonly nodes = new Map<string, FakeNode>();
  readonly children = new Map<string, string[]>();
  readonly closed: { ref: NodeRef; receipt: CloseReceipt; expectedGatedNodeHash?: string }[] = [];
  readonly created: CreateNodeSpec[] = [];
  readonly edges: [string, string][] = [];
  readonly claims: string[] = [];
  /** Every topology write, in order, so a test can assert what landed before what (#740). */
  readonly calls: string[] = [];
  readonly failingEdges = new Set<string>();
  private nextId = 1000;

  add(id: string, overrides: Partial<NodeState> = {}, blockers: string[] = []): void {
    const node: WorkGraphNode = { id, title: `node ${id}`, autonomy: "approve", checkpointId: `cp-${id}` };
    this.nodes.set(id, {
      blockers,
      state: {
        ref: { id },
        node,
        status: "open",
        assignees: [],
        blockedBy: [],
        author: "jcfischer",
        typed: true,
        ...overrides,
      },
    });
  }

  async createNode(spec: CreateNodeSpec, _rehome?: RehomeSelection, options: CreateNodeOptions = {}): Promise<NodeRef> {
    this.created.push(spec);
    const id = String(this.nextId++);
    this.add(id);
    this.calls.push(`create ${id}`);
    if (spec.parent !== undefined && options.detached !== true) await this.attachToParent({ id }, spec.parent);
    return { id };
  }

  failAttach = false;

  async attachToParent(child: NodeRef, parent: NodeRef): Promise<void> {
    if (this.failAttach) throw new Error("sub_issues write failed");
    this.calls.push(`attach ${child.id} ${parent.id}`);
    this.children.set(parent.id, [...(this.children.get(parent.id) ?? []), child.id]);
    const entry = this.nodes.get(child.id);
    if (entry) entry.state = { ...entry.state, parent };
  }

  async addBlockingEdge(blocker: NodeRef, blocked: NodeRef): Promise<void> {
    if (this.failingEdges.has(blocker.id)) throw new Error(`edge write for ${blocker.id} failed`);
    this.calls.push(`edge ${blocker.id} ${blocked.id}`);
    this.edges.push([blocker.id, blocked.id]);
    const entry = this.nodes.get(blocked.id);
    if (entry) entry.blockers.push(blocker.id);
  }

  async readNode(ref: NodeRef): Promise<NodeState> {
    const entry = this.nodes.get(ref.id);
    if (!entry) throw new Error(`no such node ${ref.id}`);
    return {
      ...entry.state,
      blockedBy: entry.blockers.map((id) => ({ id, status: this.nodes.get(id)?.state.status ?? "open" })),
    };
  }

  /** Depth-first pre-order over the membership subtree, each node already confirmed (#576). */
  async readSubtree(root: NodeRef): Promise<NodeState[]> {
    return walkFakeSubtree(root, (id) => this.children.get(id) ?? [], (ref) => this.readNode(ref));
  }

  async claim(ref: NodeRef, identity: string): Promise<ClaimResult> {
    this.claims.push(`${ref.id}:${identity}`);
    return { held: true, identity, holder: identity, assignees: [identity] };
  }

  async release(ref: NodeRef, identity: string): Promise<ReleaseResult> {
    this.claims.push(`release:${ref.id}:${identity}`);
    return { released: true, identity, assignees: [] };
  }

  async postComment(ref: NodeRef, body: string): Promise<CommentRef> {
    return { id: `comment-${ref.id}-${body.length}`, nodeId: ref.id };
  }

  async readComment(ref: CommentRef): Promise<CommentRef> {
    return { ...ref, author: "ivy-agent" };
  }

  async readCommentReactions(): Promise<never[]> {
    return [];
  }

  async listComments(): Promise<never[]> {
    return [];
  }

  async readRawBody(): Promise<string> {
    return "";
  }

  async writeRawBody(): Promise<void> {
    // Nothing stores raw bodies in this fake; the CLI tests exercise the splice.
  }

  async close(ref: NodeRef, closeReceipt: CloseReceipt, expectedGatedNodeHash?: string): Promise<void> {
    this.closed.push({ ref, receipt: closeReceipt, expectedGatedNodeHash });
    const entry = this.nodes.get(ref.id);
    if (entry) entry.state = { ...entry.state, status: "closed" };
  }
}

test("createNode validates before the store is ever touched", async () => {
  const store = new FakeStore();
  const graph = new WorkGraph(store);
  expect(await asyncCodeOf(() => graph.createNode({ title: "t", autonomy: "auto" }))).toBe("invalid-node");
  expect(store.created).toHaveLength(0);

  await graph.createNode({ title: "t", autonomy: "auto", probes: [PASSING_PROBE] });
  expect(store.created).toHaveLength(1);
});

test("a Task parent re-homes to its nearest Issue and retains native provenance", async () => {
  const store = new FakeStore();
  Object.defineProperty(store, "selectRehomeParent", { value: async (requested: NodeState) => requested.trackerType === "Task" ? { parent: { id: "issue" } } : undefined });
  store.add("issue", { trackerType: "Issue" });
  store.add("task", { trackerType: "Task", parent: { id: "issue" } });
  const created = await new WorkGraph(store).createNode({ title: "scaffold", autonomy: "approve", checkpointId: "cp", parent: { id: "task" } });
  expect(store.created[0]?.parent).toEqual({ id: "issue" });
  expect(created.rehomedFrom).toEqual({ id: "task" });
  expect(created.rehomedTo).toEqual({ id: "issue" });
});

test("a node cannot block itself", async () => {
  const store = new FakeStore();
  store.add("1");
  const graph = new WorkGraph(store);
  expect(await asyncCodeOf(() => graph.addBlockingEdge({ id: "1" }, { id: "1" }))).toBe("invalid-edge");
  expect(store.edges).toHaveLength(0);
});

test("an edge that would close a cycle is rejected — directly and transitively", async () => {
  const store = new FakeStore();
  store.add("1");
  store.add("2");
  store.add("3");
  const graph = new WorkGraph(store);

  await graph.addBlockingEdge({ id: "1" }, { id: "2" }); // 1 blocks 2
  expect(await asyncCodeOf(() => graph.addBlockingEdge({ id: "2" }, { id: "1" }))).toBe("cycle");

  await graph.addBlockingEdge({ id: "2" }, { id: "3" }); // 1 → 2 → 3
  expect(await asyncCodeOf(() => graph.addBlockingEdge({ id: "3" }, { id: "1" }))).toBe("cycle");
  expect(store.edges).toEqual([
    ["1", "2"],
    ["2", "3"],
  ]);
});

test("a diamond is not a cycle", async () => {
  const store = new FakeStore();
  for (const id of ["1", "2", "3", "4"]) store.add(id);
  const graph = new WorkGraph(store);
  await graph.addBlockingEdge({ id: "1" }, { id: "2" });
  await graph.addBlockingEdge({ id: "1" }, { id: "3" });
  await graph.addBlockingEdge({ id: "2" }, { id: "4" });
  await graph.addBlockingEdge({ id: "3" }, { id: "4" });
  expect(store.edges).toHaveLength(4);
});

test("the frontier is open, unassigned and unblocked — each candidate confirmed by direct fetch", async () => {
  const store = new FakeStore();
  store.add("open-unassigned");
  store.add("assigned", { assignees: ["ivy-agent"] });
  store.add("already-closed", { status: "closed" });
  store.add("blocker");
  store.add("blocked", {}, ["blocker"]);
  store.add("released", {}, ["already-closed"]);
  store.children.set("map", ["open-unassigned", "assigned", "already-closed", "blocked", "released"]);

  const frontier = await new WorkGraph(store).frontier({ id: "map" });
  expect(frontier.map((state) => state.ref.id)).toEqual(["open-unassigned", "released"]);
});

test("a stale candidate list cannot put a closed or claimed node on the frontier", async () => {
  const store = new FakeStore();
  store.add("stale", { status: "closed" });
  store.children.set("map", ["stale", "stale"]);
  expect(await new WorkGraph(store).frontier({ id: "map" })).toHaveLength(0);
});

test("claiming a closed node is refused", async () => {
  const store = new FakeStore();
  store.add("done", { status: "closed" });
  const graph = new WorkGraph(store);
  expect(await asyncCodeOf(() => graph.claim({ id: "done" }, "ivy-agent"))).toBe("node-closed");
  expect(store.claims).toHaveLength(0);
});

test("the prose rule holds at the seam, not only in the CLI", async () => {
  // #556's actual complaint was that resolution-posting lived in one CLI branch
  // and nowhere else. A rule enforced only by `soma graph close` would reproduce
  // that, so it is pinned here: a direct consumer of the contract is refused too.
  const store = new FakeStore();
  store.add("497", {
    node: { id: "497", title: "seam", autonomy: "auto", checkpointId: "cp-497", probes: [PASSING_PROBE] },
  });
  const graph = new WorkGraph(store);

  expect(await asyncCodeOf(() => graph.close({ id: "497" }, receipt({ resolution: undefined })))).toBe("close-refused");
  expect(store.closed).toHaveLength(0);

  await graph.close({ id: "497" }, receipt());
  expect(store.closed).toHaveLength(1);
  expect(store.closed[0].receipt.resolution).toContain("The seam ships");
  expect(store.closed[0].expectedGatedNodeHash).toBe(hashGatedNodeFields(store.nodes.get("497")!.state.node));
});

test("close gates on the node as the store reports it, not on a caller-supplied copy", async () => {
  const store = new FakeStore();
  // The stored node is `auto` with a probe; a caller who omits the probe result
  // is refused even though their own receipt looks complete to them.
  store.add("497", {
    node: { id: "497", title: "seam", autonomy: "auto", checkpointId: "cp-497", probes: [PASSING_PROBE] },
  });
  const graph = new WorkGraph(store);

  expect(await asyncCodeOf(() => graph.close({ id: "497" }, receipt({ probeResults: [] })))).toBe("close-refused");
  expect(store.closed).toHaveLength(0);

  await graph.close({ id: "497" }, receipt());
  expect(store.closed).toHaveLength(1);
  expect(await asyncCodeOf(() => graph.close({ id: "497" }, receipt()))).toBe("node-closed");
});

// --- #740: no window in which a blocked node is reachable and unblocked -----

test("createNode with blockers writes every edge before the parent link", async () => {
  const store = new FakeStore();
  store.add("root");
  store.add("81");
  store.add("82");
  const created = await new WorkGraph(store).createNode({ title: "t", autonomy: "approve", checkpointId: "cp", parent: { id: "root" } }, [{ id: "81" }, { id: "82" }]);

  expect(store.calls).toEqual(["create 1000", "edge 81 1000", "edge 82 1000", "attach 1000 root"]);
  expect(created).toMatchObject({ id: "1000", attached: true, edges: { written: ["81", "82"], failed: [] } });
});

test("a failed edge leaves the node unattached, and the other edges still land", async () => {
  const store = new FakeStore();
  store.add("root");
  store.add("81");
  store.add("82");
  store.failingEdges.add("81");
  const graph = new WorkGraph(store);
  const created = await graph.createNode({ title: "t", autonomy: "approve", checkpointId: "cp", parent: { id: "root" } }, [{ id: "81" }, { id: "82" }]);

  expect(store.calls).toEqual(["create 1000", "edge 82 1000"]);
  expect(created).toMatchObject({ attached: false, edges: { written: ["82"], failed: [{ id: "81", reason: "edge write for 81 failed" }] } });
  expect((await graph.frontier({ id: "root" })).map((state) => state.ref.id)).toEqual([]);
});

test("createNode without blockers attaches in the create, as before", async () => {
  const store = new FakeStore();
  store.add("root");
  const created = await new WorkGraph(store).createNode({ title: "t", autonomy: "approve", checkpointId: "cp", parent: { id: "root" } });

  expect(store.calls).toEqual(["create 1000", "attach 1000 root"]);
  expect(created.attached).toBe(true);
});

test("attach links a parentless node, is a no-op under the same parent, and refuses a move or a cycle", async () => {
  const store = new FakeStore();
  store.add("root");
  store.add("orphan");
  store.add("other", { parent: { id: "root" } });
  store.add("deep", { parent: { id: "orphan" } });
  const graph = new WorkGraph(store);

  expect(await graph.attach({ id: "orphan" }, { id: "root" })).toEqual({ status: "attached" });
  expect(await graph.attach({ id: "orphan" }, { id: "root" })).toEqual({ status: "already" });
  expect(await asyncCodeOf(() => graph.attach({ id: "other" }, { id: "orphan" }))).toBe("invalid-edge");
  store.add("loop");
  store.add("below-loop", { parent: { id: "loop" } });
  expect(await asyncCodeOf(() => graph.attach({ id: "loop" }, { id: "below-loop" }))).toBe("cycle");
  expect(store.calls).toEqual(["attach orphan root"]);
});

test("claim refuses a node with an open blocker and writes no assignee", async () => {
  const store = new FakeStore();
  store.add("81");
  store.add("86", {}, ["81"]);

  const graph = new WorkGraph(store);
  const error = await graph.claim({ id: "86" }, "ivy-agent").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(WorkGraphError);
  expect((error as WorkGraphError).code).toBe("blocked");
  expect((error as WorkGraphError).message).toContain("81");
  expect(store.claims).toEqual([]);
});

test("claim takes a node whose blockers are all closed", async () => {
  const store = new FakeStore();
  store.add("81", { status: "closed" });
  store.add("86", {}, ["81"]);

  expect((await new WorkGraph(store).claim({ id: "86" }, "ivy-agent")).held).toBe(true);
  expect(store.claims).toEqual(["86:ivy-agent"]);
});

test("an attach that fails after every edge landed still returns the node, unattached, with the reason", async () => {
  const store = new FakeStore();
  store.add("root");
  store.add("81");
  store.failAttach = true;
  const created = await new WorkGraph(store).createNode({ title: "t", autonomy: "approve", checkpointId: "cp", parent: { id: "root" } }, [{ id: "81" }]);

  expect(created).toMatchObject({ id: "1000", attached: false, attachError: "sub_issues write failed", edges: { written: ["81"], failed: [] } });
});

test("a create with no parent reports attached: true — there was nothing to attach", async () => {
  const created = await new WorkGraph(new FakeStore()).createNode({ title: "t", autonomy: "approve", checkpointId: "cp" });
  expect(created.attached).toBe(true);
});
