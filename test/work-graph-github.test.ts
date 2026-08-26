import { expect, test } from "bun:test";
import {
  WorkGraph,
  WorkGraphError,
  SUBTREE_QUERY_PRIMARY_RATE_POINTS,
  createGitHubGraphStore,
  decodeNodeBlock,
  encodeNodeBlock,
  estimateSubtreeQueryPrimaryRatePoints,
  ghApiArgs,
  parseGhApiOutput,
  parseNodeSpec,
  type GitHubApiRequest,
  type GitHubApiTransport,
  type Probe,
} from "../src/index";

const REPO = "the-metafactory/soma";
const PROBE: Probe = { type: "command", run: "bun test", timeoutSec: 600, expectExit: 0 };

interface Recorded extends GitHubApiRequest {
  key: string;
}

/** A tracker that never leaves the process: canned responses keyed by `METHOD path`. */
function fakeTransport(responses: Record<string, unknown>): { transport: GitHubApiTransport; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const transport: GitHubApiTransport = async (request) => {
    const key = `${request.method} ${request.path}`;
    calls.push({ ...request, key });
    if (!(key in responses)) {
      // The ordinary issue payload omits the parent. Default the dedicated REST
      // endpoint to 404 and let parent-specific tests stub another result.
      if (request.path.endsWith("/parent")) {
        throw new WorkGraphError("backend", `gh api GET ${request.path} failed (exit 1): HTTP 404: Not Found`);
      }
      throw new Error(`unstubbed request: ${key}`);
    }
    return responses[key];
  };
  return { transport, calls };
}

function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 497,
    id: 5043603420,
    title: "GraphStore seam + GitHub backend",
    body: "## Task\n\nimplement the seam",
    state: "open",
    user: { login: "jcfischer" },
    assignees: [],
    html_url: "https://github.com/the-metafactory/soma/issues/497",
    ...overrides,
  };
}

function typedBody(block: Record<string, unknown>, text = "## Task\n\nimplement the seam"): string {
  return `${text}\n\n<!-- soma:work-graph-node\n${JSON.stringify(block)}\n-->`;
}

// --- transport and query budgets -------------------------------------------

test("paginated gh calls request slurped pages and flatten array responses", () => {
  const request: GitHubApiRequest = { method: "GET", path: `repos/${REPO}/issues/495/sub_issues`, paginate: true };

  expect(ghApiArgs(request)).toEqual([
    "api",
    "--method",
    "GET",
    `repos/${REPO}/issues/495/sub_issues`,
    "--paginate",
    "--slurp",
  ]);
  expect(parseGhApiOutput('[[{"number":501}],[{"number":510}]]', request)).toEqual([
    { number: 501 },
    { number: 510 },
  ]);
});

test("non-paginated gh responses retain their JSON shape", () => {
  const request: GitHubApiRequest = { method: "GET", path: `repos/${REPO}/issues/495` };
  expect(parseGhApiOutput('[[{"number":501}],[{"number":510}]]', request)).toEqual([
    [{ number: 501 }],
    [{ number: 510 }],
  ]);
});

test("the shipped subtree query stays inside its primary-rate budget", () => {
  expect(SUBTREE_QUERY_PRIMARY_RATE_POINTS).toBe(8);
  expect(SUBTREE_QUERY_PRIMARY_RATE_POINTS).toBeLessThanOrEqual(10);
  expect(estimateSubtreeQueryPrimaryRatePoints([50, 25, 10])).toBe(414);
});

// --- the node block ---------------------------------------------------------

test("the node block round-trips through the issue body and leaves the human text intact", () => {
  const spec = parseNodeSpec({
    title: "seam",
    autonomy: "auto",
    kind: "task",
    checkpointId: "cp-497",
    probes: [PROBE],
    body: "## Task\n\nimplement the seam",
  });
  const body = `${spec.body ?? ""}\n\n${encodeNodeBlock(spec)}`;
  const decoded = decodeNodeBlock(body);

  expect(decoded.text).toBe("## Task\n\nimplement the seam");
  expect(parseNodeSpec({ ...(JSON.parse(decoded.raw ?? "{}") as object), title: "seam" })).toEqual(
    parseNodeSpec({ title: "seam", autonomy: "auto", kind: "task", checkpointId: "cp-497", probes: [PROBE] }),
  );
});

test("an issue with no block decodes to plain text", () => {
  expect(decodeNodeBlock("just a question")).toEqual({ text: "just a question" });
});

// --- readNode ---------------------------------------------------------------

test("readNode types the node from the block and reports blockers with their status", async () => {
  const { transport } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload({
      body: typedBody({ autonomy: "auto", kind: "Task", checkpointId: "cp-497", probes: [PROBE] }),
      assignees: [{ login: "jcfischer" }],
    }),
    [`GET repos/${REPO}/issues/497/dependencies/blocked_by`]: [
      issuePayload({ number: 495, id: 1, state: "closed" }),
      issuePayload({ number: 502, id: 2, state: "open" }),
    ],
  });

  const state = await createGitHubGraphStore({ repo: REPO, transport }).readNode({ id: "497" });

  expect(state.typed).toBe(true);
  expect(state.node.autonomy).toBe("auto");
  expect(state.node.kind).toBe("task");
  expect(state.node.probes).toEqual([PROBE]);
  expect(state.node.id).toBe("497");
  expect(state.author).toBe("jcfischer");
  expect(state.assignees).toEqual(["jcfischer"]);
  expect(state.body).toBe("## Task\n\nimplement the seam");
  expect(state.blockedBy).toEqual([
    { id: "495", status: "closed" },
    { id: "502", status: "open" },
  ]);
});

test("the parent edge comes from the dedicated REST endpoint without spending GraphQL quota", async () => {
  const { transport, calls } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload(),
    [`GET repos/${REPO}/issues/497/parent`]: issuePayload({ number: 495, id: 5_000_495 }),
    [`GET repos/${REPO}/issues/497/dependencies/blocked_by`]: [],
  });

  const state = await createGitHubGraphStore({ repo: REPO, transport }).readNode({ id: "497" });

  expect(state.parent).toEqual({ id: "495" });
  expect(calls.map((call) => call.key)).toEqual([
    `GET repos/${REPO}/issues/497`,
    `GET repos/${REPO}/issues/497/parent`,
    `GET repos/${REPO}/issues/497/dependencies/blocked_by`,
  ]);
});

for (const status of [404, 410]) {
  test(`a REST parent ${status} is undefined, never an assumed root`, async () => {
    const transport: GitHubApiTransport = async (request) => {
      const key = `${request.method} ${request.path}`;
      if (key === `GET repos/${REPO}/issues/497`) return issuePayload();
      if (key === `GET repos/${REPO}/issues/497/parent`) {
        throw new WorkGraphError("backend", `gh api GET ${request.path} failed (exit 1): HTTP ${status}`);
      }
      if (key === `GET repos/${REPO}/issues/497/dependencies/blocked_by`) return [];
      throw new Error(`unstubbed request: ${key}`);
    };

    const state = await createGitHubGraphStore({ repo: REPO, transport }).readNode({ id: "497" });
    expect(state.parent).toBeUndefined();
  });
}

test("a non-missing REST parent error surfaces", async () => {
  const transport: GitHubApiTransport = async (request) => {
    const key = `${request.method} ${request.path}`;
    if (key === `GET repos/${REPO}/issues/497`) return issuePayload();
    if (key === `GET repos/${REPO}/issues/497/parent`) {
      throw new WorkGraphError("backend", `gh api GET ${request.path} failed (exit 1): HTTP 500`);
    }
    throw new Error(`unstubbed request: ${key}`);
  };

  expect(createGitHubGraphStore({ repo: REPO, transport }).readNode({ id: "497" })).rejects.toThrow(/HTTP 500/);
});

test("a hand-authored issue reads as the most-gated class, never as auto", async () => {
  const { transport } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload(),
    [`GET repos/${REPO}/issues/497/dependencies/blocked_by`]: [],
  });

  const state = await createGitHubGraphStore({ repo: REPO, transport }).readNode({ id: "497" });

  expect(state.typed).toBe(false);
  expect(state.node.autonomy).toBe("approve");
  expect(state.node.probes).toBeUndefined();
  expect(state.node.checkpointId).toBeUndefined(); // and therefore cannot close
  expect(state.parseError).toBeUndefined();
});

test("a corrupt node block downgrades visibly — fail-safe class plus the reason", async () => {
  const { transport } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload({
      body: typedBody({ autonomy: "auto", checkpointId: "cp-497" }), // auto with no probes
    }),
    [`GET repos/${REPO}/issues/497/dependencies/blocked_by`]: [],
  });

  const state = await createGitHubGraphStore({ repo: REPO, transport }).readNode({ id: "497" });

  expect(state.typed).toBe(false);
  expect(state.node.autonomy).toBe("approve");
  expect(state.parseError).toContain("probe");
});

// --- writes -----------------------------------------------------------------

test("createNode writes the block into the body and attaches to the parent by database id", async () => {
  const { transport, calls } = fakeTransport({
    [`POST repos/${REPO}/issues`]: issuePayload({ number: 513, id: 999 }),
    [`POST repos/${REPO}/issues/495/sub_issues`]: {},
  });

  const ref = await createGitHubGraphStore({ repo: REPO, transport }).createNode(
    parseNodeSpec({
      title: "verbs",
      autonomy: "auto",
      probes: [PROBE],
      body: "## Task\n\nbuild the verbs",
      parent: { id: "495" },
    }),
  );

  expect(ref).toEqual({ id: "513" });
  const created = calls[0]?.body as { title: string; body: string };
  expect(created.title).toBe("verbs");
  expect(created.body).toContain("## Task\n\nbuild the verbs");
  expect(created.body).toContain("soma:work-graph-node");
  // The sub-issue endpoint takes the database id, not the issue number.
  expect(calls[1]?.body).toEqual({ sub_issue_id: 999 });
});

test("createNode writes labels through, deduplicated and trimmed", async () => {
  const { transport, calls } = fakeTransport({
    [`POST repos/${REPO}/issues`]: issuePayload({ number: 514, id: 1000 }),
  });

  const spec = parseNodeSpec({
    title: "labelled",
    autonomy: "propose",
    kind: "grilling",
    body: "## Question\n\nwhich?",
    labels: ["orienteer:grilling", "orienteer:grilling", " orienteer:map "],
  });
  await createGitHubGraphStore({ repo: REPO, transport }).createNode(spec);

  // The whole POST body, not just the labels key — the transport contract is
  // what a reader trusts, so pin all of it rather than the part that changed.
  expect(calls[0]?.body).toEqual({
    title: "labelled",
    body: `## Question\n\nwhich?\n\n${encodeNodeBlock(spec)}`,
    labels: ["orienteer:grilling", "orienteer:map"],
  });
});

test("a node created without labels sends no labels key at all", async () => {
  const { transport, calls } = fakeTransport({
    [`POST repos/${REPO}/issues`]: issuePayload({ number: 515, id: 1001 }),
  });

  await createGitHubGraphStore({ repo: REPO, transport }).createNode(
    parseNodeSpec({ title: "bare", autonomy: "propose" }),
  );

  expect(calls[0]?.body).not.toHaveProperty("labels");
});

test("a label on the tracker cannot change what a verb decides", async () => {
  // The whole safety argument for labels: they are a derived view. An issue
  // labelled `orienteer:task` whose block says `grilling` reports grilling.
  const { transport } = fakeTransport({
    [`GET repos/${REPO}/issues/520`]: issuePayload({
      number: 520,
      id: 1,
      body: `## Question\n\n<!-- soma:work-graph-node\n{"autonomy":"approve","kind":"grilling"}\n-->`,
      labels: [{ name: "orienteer:task" }],
    }),
    [`GET repos/${REPO}/issues/520/dependencies/blocked_by`]: [],
  });

  const state = await createGitHubGraphStore({ repo: REPO, transport }).readNode({ id: "520" });
  expect(state.node.kind).toBe("grilling");
  expect(state.node.autonomy).toBe("approve");
});

test("addBlockingEdge resolves the blocker's database id and writes the native dependency", async () => {
  const { transport, calls } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload({ number: 497, id: 5043603420 }),
    [`POST repos/${REPO}/issues/498/dependencies/blocked_by`]: {},
  });

  await createGitHubGraphStore({ repo: REPO, transport }).addBlockingEdge({ id: "497" }, { id: "498" });

  expect(calls[1]?.key).toBe(`POST repos/${REPO}/issues/498/dependencies/blocked_by`);
  expect(calls[1]?.body).toEqual({ issue_id: 5043603420 });
});

// --- readSubtree: the membership subtree, confirmed (#557, #576) ------------
//
// These pin behaviour a direct-children fixture cannot reach, so it is worth
// recording how they were shown to bite. Each mutation below was applied to
// `src/work-graph-github.ts` by hand and reverted; there is no committed
// harness, so treat this as a reproduction recipe rather than a standing gate:
//
//   1. `readSubtree`: prune closed subtrees instead of descending — return
//      early from `visit` when the node is closed.     → 3 of these fail
//   2. `completeChildren`: drop the `childrenTruncated` check and always
//      return `node.children`.                         → 2 of these fail
//   3. `visit`: remove the `seen` guard.               → does not terminate
//   4. `readSubtree`: ignore `stateTruncated` and trust the short page.
//                                                      → 1 of these fails
//
// Mutation 3 is why the cycle case asserts at all: a `seen` set over a shape
// GitHub currently guarantees to be a tree reads like dead code until you take
// it out.

/** A `subIssues` connection as GraphQL returns it. */
function conn(nodes: unknown[], overrides: { totalCount?: number; hasNextPage?: boolean; endCursor?: string } = {}) {
  return {
    totalCount: overrides.totalCount ?? nodes.length,
    pageInfo: { hasNextPage: overrides.hasNextPage ?? false, endCursor: overrides.endCursor ?? null },
    nodes,
  };
}

/** A node on the walk's bottom row: counted, not fetched. */
function counted(totalCount: number) {
  return { totalCount };
}

/**
 * One node as the walk query returns it — every field of `NODE_FIELDS`, since
 * the whole point of #576 is that the walk carries a complete `NodeState`.
 */
function gql(
  number: number,
  state: "OPEN" | "CLOSED",
  subIssues: unknown = counted(0),
  overrides: Record<string, unknown> = {},
) {
  return {
    number,
    state,
    title: `node ${number}`,
    body: "",
    url: `https://github.com/${REPO}/issues/${number}`,
    databaseId: 5_000_000 + number,
    author: { login: "jcfischer" },
    assignees: { totalCount: 0, nodes: [] },
    blockedBy: { totalCount: 0, nodes: [] },
    subIssues,
    ...overrides,
  };
}

const ids = (states: { ref: { id: string } }[]) => states.map((state) => state.ref.id);

/**
 * Serves the walk query by `variables.number` (and by cursor where a test pages),
 * so one fake can answer the re-rooted follow-ups the walk issues. REST paths
 * fall through to `rest`, which is how the `readNode` repair path is stubbed.
 */
function subtreeTransport(
  pages: Record<string, unknown>,
  rest: Record<string, unknown> = {},
): { transport: GitHubApiTransport; keys: string[] } {
  const keys: string[] = [];
  const transport: GitHubApiTransport = async (request) => {
    if (request.path !== "graphql") {
      const key = `${request.method} ${request.path}`;
      keys.push(key);
      if (request.path.endsWith("/parent")) {
        throw new WorkGraphError("backend", `gh api GET ${request.path} failed (exit 1): HTTP 404: Not Found`);
      }
      if (!(key in rest)) throw new Error(`unstubbed rest request: ${key}`);
      return rest[key];
    }
    const variables = (request.body?.variables ?? {}) as { number?: number; after?: string | null };
    const key = variables.after == null ? String(variables.number) : `${variables.number}@${variables.after}`;
    keys.push(key);
    if (!(key in pages)) throw new Error(`unstubbed subtree request: ${key}`);
    return { data: { repository: { issue: pages[key] } } };
  };
  return { transport, keys };
}

test("the walk descends into closed nodes and reports the whole subtree depth-first", async () => {
  // #501 and #510 are closed and each carries open scaffold — the case a
  // one-level walk lost twice over, and the common one, not the exotic one.
  // Closed nodes are *reported* now, not filtered here: §2.4 is the contract
  // layer's predicate, and a store that pre-filters is deciding it instead.
  const { transport } = subtreeTransport({
    "495": gql(
      495,
      "OPEN",
      conn([
        gql(497, "OPEN"),
        gql(501, "CLOSED", conn([gql(556, "OPEN")])),
        gql(510, "CLOSED", conn([gql(560, "OPEN"), gql(561, "CLOSED")])),
      ]),
    ),
  });

  const subtree = await createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" });

  // Pre-order: each node is followed by its own scaffold, so provenance reads
  // off the listing itself.
  expect(ids(subtree)).toEqual(["497", "501", "556", "510", "560", "561"]);
});

test("every node arrives confirmed, with the parent the walk arrived on", async () => {
  // The whole of #576: no second read is needed because the walk already holds
  // status, assignees, blockers, author and the typed block. `parent` is free —
  // it is the edge we traversed.
  const { transport, keys } = subtreeTransport({
    "495": gql(
      495,
      "OPEN",
      conn([
        gql(501, "CLOSED", conn([
          gql(556, "OPEN", counted(0), {
            body: typedBody({ autonomy: "approve", kind: "grilling" }, "the question"),
            assignees: { totalCount: 1, nodes: [{ login: "ivy-agent" }] },
            blockedBy: { totalCount: 1, nodes: [{ number: 499, state: "CLOSED" }] },
          }),
        ])),
      ]),
    ),
  });

  const subtree = await createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" });
  const scaffold = subtree.find((state) => state.ref.id === "556");

  expect(scaffold?.parent).toEqual({ id: "501" });
  expect(scaffold?.assignees).toEqual(["ivy-agent"]);
  expect(scaffold?.blockedBy).toEqual([{ id: "499", status: "closed" }]);
  expect(scaffold?.author).toBe("jcfischer");
  expect(scaffold?.typed).toBe(true);
  expect(scaffold?.node.kind).toBe("grilling");
  expect(scaffold?.body).toBe("the question");
  // One query. That is the property, and counting calls is the only assertion
  // that actually holds it.
  expect(keys).toEqual(["495"]);
});

test("a short assignees or blockedBy page is repaired by a direct read, never trusted", async () => {
  // A short `assignees` page makes a claimed node look unclaimed and a short
  // `blockedBy` page makes a blocked node look takeable — false *positives*,
  // and with the second read gone nothing downstream would catch them.
  const { transport, keys } = subtreeTransport(
    {
      "495": gql(
        495,
        "OPEN",
        conn([gql(497, "OPEN", counted(0), { assignees: { totalCount: 40, nodes: [{ login: "a" }] } })]),
      ),
    },
    {
      [`GET repos/${REPO}/issues/497`]: issuePayload({ number: 497, assignees: [{ login: "a" }, { login: "b" }] }),
      [`GET repos/${REPO}/issues/497/dependencies/blocked_by`]: [],
    },
  );

  const subtree = await createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" });

  expect(subtree[0]?.assignees).toEqual(["a", "b"]);
  // The repair must not cost the membership edge: `readNode` resolves a parent
  // of its own (here the fake says none), and the walk's answer is the one the
  // seam promised.
  expect(subtree[0]?.parent).toEqual({ id: "495" });
  expect(keys).toEqual([
    "495",
    `GET repos/${REPO}/issues/497`,
    `GET repos/${REPO}/issues/497/parent`,
    `GET repos/${REPO}/issues/497/dependencies/blocked_by`,
  ]);
});

test("the root itself is never in its own subtree, however it is stated", async () => {
  const { transport } = subtreeTransport({ "495": gql(495, "OPEN", conn([gql(497, "OPEN")])) });

  expect(ids(await createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" }))).toEqual(["497"]);
});

test("a GraphQL rate limit falls back to a whole REST subtree in depth-first order", async () => {
  const calls: string[] = [];
  const transport: GitHubApiTransport = async (request) => {
    const key = `${request.method} ${request.path}`;
    calls.push(key);
    if (key === "POST graphql") {
      throw new WorkGraphError(
        "backend",
        "gh api POST graphql failed (exit 1): gh: API rate limit already exceeded for user ID 1.",
      );
    }
    const responses: Record<string, unknown> = {
      [`GET repos/${REPO}/issues/495/sub_issues?per_page=100`]: [
        issuePayload({ number: 501, id: 5_000_501, state: "closed", title: "node 501" }),
      ],
      [`GET repos/${REPO}/issues/501/dependencies/blocked_by`]: [],
      [`GET repos/${REPO}/issues/501/sub_issues?per_page=100`]: [
        issuePayload({ number: 556, id: 5_000_556, state: "open", title: "node 556" }),
      ],
      [`GET repos/${REPO}/issues/556/dependencies/blocked_by`]: [
        issuePayload({ number: 499, id: 5_000_499, state: "closed" }),
      ],
      [`GET repos/${REPO}/issues/556/sub_issues?per_page=100`]: [],
    };
    if (!(key in responses)) throw new Error(`unstubbed request: ${key}`);
    return responses[key];
  };

  const subtree = await createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" });

  expect(ids(subtree)).toEqual(["501", "556"]);
  expect(subtree.map((state) => state.parent?.id)).toEqual(["495", "501"]);
  expect(subtree[1]?.blockedBy).toEqual([{ id: "499", status: "closed" }]);
  expect(calls).toEqual([
    "POST graphql",
    `GET repos/${REPO}/issues/495/sub_issues?per_page=100`,
    `GET repos/${REPO}/issues/501/dependencies/blocked_by`,
    `GET repos/${REPO}/issues/501/sub_issues?per_page=100`,
    `GET repos/${REPO}/issues/556/dependencies/blocked_by`,
    `GET repos/${REPO}/issues/556/sub_issues?per_page=100`,
  ]);
});

test("REST subtree fallback deduplicates repeated and cyclic membership edges", async () => {
  const transport: GitHubApiTransport = async (request) => {
    const key = `${request.method} ${request.path}`;
    if (key === "POST graphql") throw new WorkGraphError("backend", "GraphQL: API rate limit exceeded");
    const responses: Record<string, unknown> = {
      [`GET repos/${REPO}/issues/495/sub_issues?per_page=100`]: [
        issuePayload({ number: 501, id: 5_000_501 }),
        issuePayload({ number: 501, id: 5_000_501 }),
      ],
      [`GET repos/${REPO}/issues/501/dependencies/blocked_by`]: [],
      [`GET repos/${REPO}/issues/501/sub_issues?per_page=100`]: [
        issuePayload({ number: 495, id: 5_000_495 }),
      ],
    };
    if (!(key in responses)) throw new Error(`unstubbed request: ${key}`);
    return responses[key];
  };

  expect(ids(await createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" }))).toEqual(["501"]);
});

test("a non-rate-limit GraphQL subtree error never falls back", async () => {
  const calls: string[] = [];
  const transport: GitHubApiTransport = async (request) => {
    calls.push(`${request.method} ${request.path}`);
    throw new WorkGraphError("backend", "GraphQL: field unavailable");
  };

  expect(createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" })).rejects.toThrow(
    /field unavailable/,
  );
  expect(calls).toEqual(["POST graphql"]);
});

test("a node deeper than the query reaches is re-rooted, not silently dropped", async () => {
  // #564 sits on the bottom row: the walk has its count but not its children.
  const { transport, keys } = subtreeTransport({
    "495": gql(495, "OPEN", conn([gql(557, "CLOSED", conn([gql(564, "CLOSED", counted(1))]))])),
    "564": gql(564, "CLOSED", conn([gql(999, "OPEN")])),
  });

  const subtree = await createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" });

  expect(ids(subtree)).toEqual(["557", "564", "999"]);
  expect(keys).toEqual(["495", "564"]);
});

test("a level that hit its page size is completed by re-rooting, where the children page", async () => {
  // Re-fetching in place would return the same truncated set — the completion
  // has to happen where the children are the *top* connection.
  const { transport, keys } = subtreeTransport({
    "495": gql(495, "OPEN", conn([gql(501, "CLOSED", conn([gql(556, "OPEN")], { totalCount: 2 }))])),
    "501": gql(501, "CLOSED", conn([gql(556, "OPEN"), gql(560, "OPEN")])),
  });

  const subtree = await createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" });

  expect(ids(subtree)).toEqual(["501", "556", "560"]);
  expect(keys).toEqual(["495", "501"]);
});

test("the root's children are cursor-paged to completion", async () => {
  const { transport, keys } = subtreeTransport({
    "495": gql(495, "OPEN", conn([gql(497, "OPEN")], { totalCount: 2, hasNextPage: true, endCursor: "Y3Vy" })),
    "495@Y3Vy": gql(495, "OPEN", conn([gql(511, "OPEN")], { totalCount: 2 })),
  });

  const subtree = await createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" });

  expect(ids(subtree)).toEqual(["497", "511"]);
  expect(keys).toEqual(["495", "495@Y3Vy"]);
});

test("more pages with no cursor to fetch them refuses, rather than reading short", async () => {
  const { transport } = subtreeTransport({
    "495": gql(495, "OPEN", conn([gql(497, "OPEN")], { totalCount: 2, hasNextPage: true })),
  });

  expect(createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" })).rejects.toThrow(
    /more children but no cursor/,
  );
});

test("an unreadable hasNextPage refuses instead of passing for a last page", async () => {
  // `!== true` would have read this as "that was the last page" and returned a
  // short list — the one direction §2.4 cannot recover.
  const { transport } = subtreeTransport({
    "495": gql(495, "OPEN", { totalCount: 1, pageInfo: {}, nodes: [gql(497, "OPEN")] }),
  });

  expect(createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" })).rejects.toThrow(
    /no usable hasNextPage/,
  );
});

test("a repeated pagination cursor refuses instead of looping forever", async () => {
  // Without the progress check this never terminates, so it never reaches the
  // totalCount check that would otherwise catch the bad page run.
  const { transport } = subtreeTransport({
    "495": gql(495, "OPEN", conn([gql(497, "OPEN")], { totalCount: 9, hasNextPage: true, endCursor: "same" })),
    "495@same": gql(495, "OPEN", conn([gql(511, "OPEN")], { totalCount: 9, hasNextPage: true, endCursor: "same" })),
  });

  expect(createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" })).rejects.toThrow(
    /repeated a pagination cursor/,
  );
});

test("a page run that does not add up to totalCount refuses", async () => {
  // Nothing is left to recover with at the top level: the count is the only
  // witness that the walk saw every child.
  const { transport } = subtreeTransport({
    "495": gql(495, "OPEN", conn([gql(497, "OPEN")], { totalCount: 2 })),
  });

  expect(createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" })).rejects.toThrow(
    /reported 2 children but paging returned 1/,
  );
});

test("a node reachable twice is reported once, and a cycle terminates", async () => {
  const { transport } = subtreeTransport({
    "495": gql(495, "OPEN", conn([gql(497, "OPEN", conn([gql(511, "OPEN")])), gql(511, "OPEN", conn([gql(497, "OPEN")]))])),
  });

  expect(ids(await createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "495" }))).toEqual([
    "497",
    "511",
  ]);
});

test("a non-numeric node ref is refused before any request goes out", async () => {
  const { transport, keys } = subtreeTransport({});

  expect(createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "root" })).rejects.toThrow(
    /not an issue number/,
  );
  expect(keys).toEqual([]);
});

test("the frontier is one backend call over the whole subtree", async () => {
  // The #530 target, stated as the only assertion that can hold it. Before
  // #576 this shape cost 1 + 3N spawns at ~600ms each; the count is the unit
  // that actually costs, and a wall-clock assertion would measure the network.
  const { transport, keys } = subtreeTransport({
    "495": gql(
      495,
      "OPEN",
      conn([
        gql(527, "OPEN"),
        gql(501, "CLOSED", conn([gql(556, "OPEN")])),
        gql(510, "CLOSED", conn([
          gql(560, "OPEN"),
          gql(561, "OPEN", counted(0), { assignees: { totalCount: 1, nodes: [{ login: "jcfischer" }] } }),
          gql(562, "OPEN", counted(0), { blockedBy: { totalCount: 1, nodes: [{ number: 560, state: "OPEN" }] } }),
        ])),
      ]),
    ),
  });

  const graph = new WorkGraph(createGitHubGraphStore({ repo: REPO, transport }));
  const frontier = await graph.frontier({ id: "495" });

  // 561 withheld as claimed, 562 as blocked, 501/510 as closed.
  expect(ids(frontier)).toEqual(["527", "556", "560"]);
  expect(keys).toEqual(["495"]);
});

// --- claim ------------------------------------------------------------------

test("an uncontested claim is held after the re-read", async () => {
  const { transport, calls } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload({ assignees: [{ login: "ivy-agent" }] }),
    [`POST repos/${REPO}/issues/497/assignees`]: {},
  });

  const result = await createGitHubGraphStore({ repo: REPO, transport }).claim({ id: "497" }, "ivy-agent");

  expect(result).toEqual({ held: true, identity: "ivy-agent", holder: "ivy-agent", assignees: ["ivy-agent"] });
  expect(calls.map((call) => call.key)).toEqual([
    `GET repos/${REPO}/issues/497`,
    `POST repos/${REPO}/issues/497/assignees`,
    `GET repos/${REPO}/issues/497`,
  ]);
});

test("a losing racer removes itself, so the assignee set converges on one holder", async () => {
  const { transport, calls } = fakeTransport({
    // Re-read shows the race: "Ada" sorts first by code point.
    [`GET repos/${REPO}/issues/497`]: issuePayload({ assignees: [{ login: "ivy-agent" }, { login: "Ada" }] }),
    [`POST repos/${REPO}/issues/497/assignees`]: {},
    [`DELETE repos/${REPO}/issues/497/assignees`]: {},
  });

  const result = await createGitHubGraphStore({ repo: REPO, transport }).claim({ id: "497" }, "ivy-agent");

  expect(result.held).toBe(false);
  expect(result.holder).toBe("Ada");
  expect(result.assignees).toEqual(["Ada"]);
  expect(calls.at(-1)?.key).toBe(`DELETE repos/${REPO}/issues/497/assignees`);
  expect(calls.at(-1)?.body).toEqual({ assignees: ["ivy-agent"] });
});

test("claiming a closed issue is refused by the backend too", async () => {
  const { transport, calls } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload({ state: "closed" }),
  });

  let thrown: unknown;
  try {
    await createGitHubGraphStore({ repo: REPO, transport }).claim({ id: "497" }, "ivy-agent");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WorkGraphError);
  expect((thrown as WorkGraphError).code).toBe("node-closed");
  expect(calls).toHaveLength(1);
});

// --- release ----------------------------------------------------------------

test("a self-release removes the acting identity from the assignee set", async () => {
  const { transport, calls } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload({ assignees: [{ login: "ivy-agent" }] }),
    [`DELETE repos/${REPO}/issues/497/assignees`]: {},
  });

  const result = await createGitHubGraphStore({ repo: REPO, transport }).release({ id: "497" }, "ivy-agent");

  expect(result).toEqual({ released: true, identity: "ivy-agent", assignees: [] });
  expect(calls.map((call) => call.key)).toEqual([
    `GET repos/${REPO}/issues/497`,
    `DELETE repos/${REPO}/issues/497/assignees`,
    `GET repos/${REPO}/issues/497`,
  ]);
  expect(calls[1]?.body).toEqual({ assignees: ["ivy-agent"] });
});

test("releasing a claim you do not hold is a no-op — it never unassigns another identity", async () => {
  const { transport, calls } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload({ assignees: [{ login: "Ada" }] }),
  });

  const result = await createGitHubGraphStore({ repo: REPO, transport }).release({ id: "497" }, "ivy-agent");

  expect(result).toEqual({ released: false, identity: "ivy-agent", assignees: ["Ada"] });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.key).toBe(`GET repos/${REPO}/issues/497`);
});

test("releasing a closed issue is refused by the backend too", async () => {
  const { transport, calls } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload({ state: "closed" }),
  });

  let thrown: unknown;
  try {
    await createGitHubGraphStore({ repo: REPO, transport }).release({ id: "497" }, "ivy-agent");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WorkGraphError);
  expect((thrown as WorkGraphError).code).toBe("node-closed");
  expect(calls).toHaveLength(1);
});

// --- comments, reactions, close --------------------------------------------

test("reaction authors come from the API author field, never from body text", async () => {
  const { transport } = fakeTransport({
    [`GET repos/${REPO}/issues/comments/42/reactions`]: [
      { id: 7, content: "+1", user: { login: "jcfischer" }, created_at: "2026-08-04T10:00:00Z" },
    ],
  });

  const reactions = await createGitHubGraphStore({ repo: REPO, transport }).readCommentReactions({
    id: "42",
    nodeId: "497",
  });

  expect(reactions).toEqual([
    { id: "7", content: "+1", author: "jcfischer", createdAt: "2026-08-04T10:00:00Z" },
  ]);
});

test("close posts the receipt before flipping the state", async () => {
  const { transport, calls } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload({ body: typedBody({ autonomy: "auto", checkpointId: "cp-497", probes: [PROBE] }) }),
    [`POST repos/${REPO}/issues/497/comments`]: { id: 42, user: { login: "ivy-agent" } },
    [`GET repos/${REPO}/issues/comments/42`]: { id: 42, user: { login: "ivy-agent" } },
    [`PATCH repos/${REPO}/issues/497`]: issuePayload({ state: "closed" }),
  });

  await createGitHubGraphStore({ repo: REPO, transport }).close(
    { id: "497" },
    {
      checkpointId: "cp-497",
      closedBy: "ivy-agent",
      at: "2026-08-04T10:00:00.000Z",
      evidence: [{ kind: "probed", summary: "bun test exit 0", pointer: "https://example.test/run/1" }],
      probeResults: [{ probe: PROBE, state: "probed", outcome: "pass", observed: "exit 0", at: "2026-08-04T09:59:00.000Z" }],
      attestation: "unverified",
    },
  );

  expect(calls.map((call) => call.key)).toEqual([
    `GET repos/${REPO}/issues/497`,
    `POST repos/${REPO}/issues/497/comments`,
    `GET repos/${REPO}/issues/comments/42`,
    `PATCH repos/${REPO}/issues/497`,
    `PATCH repos/${REPO}/issues/497`,
  ]);
  expect((calls[1]?.body as { body: string }).body).toContain("cp-497");
  expect((calls[3]?.body as { body: string }).body).toContain("receiptCommentId");
  expect((calls[4]?.body as { state: string }).state).toBe("closed");
});

// --- construction -----------------------------------------------------------

test("a graph is bound to one owner/name repo", () => {
  const { transport } = fakeTransport({});
  expect(() => createGitHubGraphStore({ repo: "soma", transport })).toThrow(WorkGraphError);
  expect(() => createGitHubGraphStore({ repo: REPO, transport })).not.toThrow();
});

test("readNode ignores a receipt from before reopen and current reclose", async () => {
  const receipt = "## Close receipt\n\n- **checkpoint:** `cp-497`\n- **closed by:** ivy\n- **autonomy:** `approve`\n- **at:** 2026-01-01T00:00:00.000Z\n- **attestation:** `unverified`\n\n### Evidence\n";
  const { transport } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload({ state: "closed", body: typedBody({ autonomy: "approve", checkpointId: "cp-497" }) }),
    [`GET repos/${REPO}/issues/497/dependencies/blocked_by`]: [],
    [`GET repos/${REPO}/issues/497/comments`]: [{ id: 1, body: receipt, created_at: "2026-01-01T00:00:00.000Z", user: { login: "ivy" } }],
    [`GET repos/${REPO}/issues/497/events`]: [
      { event: "closed", created_at: "2026-01-01T01:00:00.000Z" },
      { event: "reopened", created_at: "2026-01-02T00:00:00.000Z" },
      { event: "closed", created_at: "2026-01-03T00:00:00.000Z" },
    ],
  });
  const state = await createGitHubGraphStore({ repo: REPO, transport }).readNode({ id: "497" });
  expect(state.currentCloseReceipt).toBe(false);
});

type CompletionFixture = { receiptCommentId: string; checkpointId: string; autonomy: "approve"; closer: string; closedAt: string };

async function currentCloseReceipt(completion?: CompletionFixture): Promise<boolean | undefined> {
  const { transport } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload({ state: "closed", body: typedBody({ autonomy: "approve", checkpointId: "cp-497", ...(completion === undefined ? {} : { completion }) }) }),
    [`GET repos/${REPO}/issues/497/dependencies/blocked_by`]: [],
    [`GET repos/${REPO}/issues/comments/42`]: { id: 42, user: { login: "ivy" } },
    [`GET repos/${REPO}/issues/497/comments`]: [{ id: 42, body: "## Close receipt\n\n- **checkpoint:** `cp-497`\n- **closed by:** ivy\n- **autonomy:** `approve`\n- **at:** 2026-01-03T00:00:00.000Z\n- **attestation:** `unverified`\n\n### Evidence\n", created_at: "2026-01-03T00:00:00.000Z", user: { login: "ivy" } }],
    [`GET repos/${REPO}/issues/497/events`]: [{ event: "closed", created_at: "2026-01-03T00:00:00.000Z", actor: { login: "ivy" } }],
  });
  return (await createGitHubGraphStore({ repo: REPO, transport }).readNode({ id: "497" })).currentCloseReceipt;
}

const validCompletion: CompletionFixture = { receiptCommentId: "42", checkpointId: "cp-497", autonomy: "approve", closer: "ivy", closedAt: "2026-01-03T00:00:00.000Z" };

test("readNode rejects a missing completion binding", async () => { expect(await currentCloseReceipt()).toBe(false); });
test("readNode rejects a stale completion binding", async () => { expect(await currentCloseReceipt({ ...validCompletion, checkpointId: "cp-stale" })).toBe(false); });
test("readNode rejects a forged completion binding", async () => { expect(await currentCloseReceipt({ ...validCompletion, autonomy: "approve", closer: "mallory" })).toBe(false); });
test("readNode accepts a valid persisted completion binding", async () => { expect(await currentCloseReceipt(validCompletion)).toBe(true); });
