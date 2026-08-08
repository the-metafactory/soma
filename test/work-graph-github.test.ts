import { expect, test } from "bun:test";
import {
  WorkGraphError,
  createGitHubGraphStore,
  decodeNodeBlock,
  encodeNodeBlock,
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
      // `readNode` always asks GraphQL for the parent edge (REST omits it), so
      // default to "no parent" and let a test stub it only when that edge is
      // what it is testing.
      if (key === "POST graphql") return { data: { repository: { issue: { parent: null } } } };
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

test("the parent edge comes from GraphQL, because the REST issue payload has no parent key", async () => {
  const { transport, calls } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload(),
    [`GET repos/${REPO}/issues/497/dependencies/blocked_by`]: [],
    "POST graphql": { data: { repository: { issue: { parent: { number: 495 } } } } },
  });

  const state = await createGitHubGraphStore({ repo: REPO, transport }).readNode({ id: "497" });

  expect(state.parent).toEqual({ id: "495" });
  const graphql = calls.find((call) => call.key === "POST graphql");
  expect(graphql?.body?.variables).toEqual({ owner: "the-metafactory", name: "soma", number: 497 });
});

test("an unreadable parent is undefined, never an assumed root — §3.2 conjunct 4 downgrades on it", async () => {
  const { transport } = fakeTransport({
    [`GET repos/${REPO}/issues/497`]: issuePayload(),
    [`GET repos/${REPO}/issues/497/dependencies/blocked_by`]: [],
    "POST graphql": { errors: [{ message: "field unavailable" }] },
  });

  const state = await createGitHubGraphStore({ repo: REPO, transport }).readNode({ id: "497" });
  expect(state.parent).toBeUndefined();
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

// --- listCandidateFrontier: the membership subtree (#557) -------------------

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

function gql(number: number, state: "OPEN" | "CLOSED", subIssues: unknown = counted(0)) {
  return { number, state, subIssues };
}

/**
 * Serves the walk query by `variables.number` (and by cursor where a test pages),
 * so one fake can answer the re-rooted follow-ups the walk issues.
 */
function subtreeTransport(pages: Record<string, unknown>): { transport: GitHubApiTransport; keys: string[] } {
  const keys: string[] = [];
  const transport: GitHubApiTransport = async (request) => {
    const variables = (request.body?.variables ?? {}) as { number?: number; after?: string | null };
    const key = variables.after == null ? String(variables.number) : `${variables.number}@${variables.after}`;
    keys.push(key);
    if (!(key in pages)) throw new Error(`unstubbed subtree request: ${key}`);
    return { data: { repository: { issue: pages[key] } } };
  };
  return { transport, keys };
}

test("the walk descends into closed nodes, reports only the open ones, and orders them depth-first", async () => {
  // #501 and #510 are closed and each carries open scaffold — the case a
  // one-level walk lost twice over, and the common one, not the exotic one.
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

  const candidates = await createGitHubGraphStore({ repo: REPO, transport }).listCandidateFrontier({ id: "495" });

  // Pre-order: each node is followed by its own scaffold, so provenance reads
  // off the listing itself.
  expect(candidates).toEqual([{ id: "497" }, { id: "556" }, { id: "560" }]);
});

test("the root itself is never a candidate, however it is stated", async () => {
  const { transport } = subtreeTransport({ "495": gql(495, "OPEN", conn([gql(497, "OPEN")])) });

  expect(await createGitHubGraphStore({ repo: REPO, transport }).listCandidateFrontier({ id: "495" })).toEqual([
    { id: "497" },
  ]);
});

test("a node deeper than the query reaches is re-rooted, not silently dropped", async () => {
  // #564 sits on the bottom row: the walk has its count but not its children.
  const { transport, keys } = subtreeTransport({
    "495": gql(495, "OPEN", conn([gql(557, "CLOSED", conn([gql(564, "CLOSED", counted(1))]))])),
    "564": gql(564, "CLOSED", conn([gql(999, "OPEN")])),
  });

  const candidates = await createGitHubGraphStore({ repo: REPO, transport }).listCandidateFrontier({ id: "495" });

  expect(candidates).toEqual([{ id: "999" }]);
  expect(keys).toEqual(["495", "564"]);
});

test("a level that hit its page size is completed by re-rooting, where the children page", async () => {
  // Re-fetching in place would return the same truncated set — the completion
  // has to happen where the children are the *top* connection.
  const { transport, keys } = subtreeTransport({
    "495": gql(495, "OPEN", conn([gql(501, "CLOSED", conn([gql(556, "OPEN")], { totalCount: 2 }))])),
    "501": gql(501, "CLOSED", conn([gql(556, "OPEN"), gql(560, "OPEN")])),
  });

  const candidates = await createGitHubGraphStore({ repo: REPO, transport }).listCandidateFrontier({ id: "495" });

  expect(candidates).toEqual([{ id: "556" }, { id: "560" }]);
  expect(keys).toEqual(["495", "501"]);
});

test("the root's children are cursor-paged to completion", async () => {
  const { transport, keys } = subtreeTransport({
    "495": gql(495, "OPEN", conn([gql(497, "OPEN")], { totalCount: 2, hasNextPage: true, endCursor: "Y3Vy" })),
    "495@Y3Vy": gql(495, "OPEN", conn([gql(511, "OPEN")], { totalCount: 2 })),
  });

  const candidates = await createGitHubGraphStore({ repo: REPO, transport }).listCandidateFrontier({ id: "495" });

  expect(candidates).toEqual([{ id: "497" }, { id: "511" }]);
  expect(keys).toEqual(["495", "495@Y3Vy"]);
});

test("more pages with no cursor to fetch them refuses, rather than reading short", async () => {
  const { transport } = subtreeTransport({
    "495": gql(495, "OPEN", conn([gql(497, "OPEN")], { totalCount: 2, hasNextPage: true })),
  });

  expect(createGitHubGraphStore({ repo: REPO, transport }).listCandidateFrontier({ id: "495" })).rejects.toThrow(
    /more children but no cursor/,
  );
});

test("a node reachable twice is reported once, and a cycle terminates", async () => {
  const { transport } = subtreeTransport({
    "495": gql(495, "OPEN", conn([gql(497, "OPEN", conn([gql(511, "OPEN")])), gql(511, "OPEN", conn([gql(497, "OPEN")]))])),
  });

  expect(await createGitHubGraphStore({ repo: REPO, transport }).listCandidateFrontier({ id: "495" })).toEqual([
    { id: "497" },
    { id: "511" },
  ]);
});

test("a non-numeric node ref is refused before any request goes out", async () => {
  const { transport, keys } = subtreeTransport({});

  expect(createGitHubGraphStore({ repo: REPO, transport }).listCandidateFrontier({ id: "root" })).rejects.toThrow(
    /not an issue number/,
  );
  expect(keys).toEqual([]);
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
    [`POST repos/${REPO}/issues/497/comments`]: { id: 42, user: { login: "ivy-agent" } },
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
    `POST repos/${REPO}/issues/497/comments`,
    `PATCH repos/${REPO}/issues/497`,
  ]);
  expect((calls[0]?.body as { body: string }).body).toContain("cp-497");
  expect((calls[1]?.body as { state: string }).state).toBe("closed");
});

// --- construction -----------------------------------------------------------

test("a graph is bound to one owner/name repo", () => {
  const { transport } = fakeTransport({});
  expect(() => createGitHubGraphStore({ repo: "soma", transport })).toThrow(WorkGraphError);
  expect(() => createGitHubGraphStore({ repo: REPO, transport })).not.toThrow();
});
