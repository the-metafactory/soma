/**
 * `soma graph list` (node #1155): a read-only, bounded page of nodes from one
 * permitted repository or one root's subtree.
 *
 * The CLI verb is exercised over recording transport fixtures, so "no writes"
 * and "nothing outside the permitted scope was read" are statements about the
 * requests the forge actually received, not about the code's intention.
 */
import { expect, test } from "bun:test";
import {
  createGitHubGraphStore,
  createGitLabGraphStore,
  parseRepoRef,
  type GitHubApiRequest,
  type GitLabApiRequest,
  type GraphReadScope,
  type GraphStore,
} from "../src/graph/index";
import { parseGraphArgs, runGraphCli } from "../src/cli/graph";

const typedBlock = (kind: string): string =>
  `<!-- soma:work-graph-node\n${JSON.stringify({ autonomy: "approve", kind, checkpointId: "list" })}\n-->`;

// --- GitHub ---------------------------------------------------------------

const GITHUB_REPO = "example/allowed";
const GITHUB_REF = parseRepoRef(`github:github.com/${GITHUB_REPO}`);
const GITHUB_SCOPE: GraphReadScope = { repositories: [GITHUB_REF], namespaces: [] };

/** Two open issues, a closed one, then one more open: a page boundary lands mid-status. */
const GITHUB_ISSUES = [
  { number: 1, state: "OPEN", kind: "task" },
  { number: 2, state: "OPEN", kind: "research" },
  { number: 3, state: "CLOSED", kind: "grilling" },
  { number: 4, state: "OPEN", kind: "task" },
] as const;

function githubIssueNode(issue: (typeof GITHUB_ISSUES)[number]) {
  return {
    number: issue.number,
    title: `Node ${issue.number}`,
    state: issue.state,
    body: typedBlock(issue.kind),
    updatedAt: "2026-11-09T00:00:00Z",
    url: `https://github.com/${GITHUB_REPO}/issues/${issue.number}`,
    repository: { nameWithOwner: GITHUB_REPO },
    parent: null,
  };
}

/** A GitHub GraphQL transport that honours `limit`/`after` and records every read. */
function githubListingFixture() {
  const calls: GitHubApiRequest[] = [];
  const store = createGitHubGraphStore({
    repo: GITHUB_REPO,
    readScope: GITHUB_SCOPE,
    transport: async (request) => {
      calls.push(request);
      expect(request.path).toBe("graphql");
      const query = String(request.body?.query);
      expect(query.startsWith("query")).toBe(true);
      const variables = request.body?.variables as { owner: string; name: string; limit: number; after: string | null };
      expect(`${variables.owner}/${variables.name}`).toBe(GITHUB_REPO);
      const states = /states:\[([A-Z,]+)\]/u.exec(query)?.[1]?.split(",") ?? [];
      const eligible = GITHUB_ISSUES.filter((issue) => states.includes(issue.state));
      const start = variables.after === null ? 0 : Number(variables.after.slice("cursor-".length));
      const page = eligible.slice(start, start + variables.limit);
      const consumed = start + page.length;
      return {
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: consumed < eligible.length, endCursor: `cursor-${consumed}` },
              nodes: page.map(githubIssueNode),
            },
          },
        },
      };
    },
  });
  return { store, calls };
}

/** The optional seam method, demanded: a store that cannot list is not a store this test accepts. */
function listNodesOf(store: GraphStore): NonNullable<GraphStore["listNodes"]> {
  const list = store.listNodes;
  if (list === undefined) throw new Error("the store cannot list nodes");
  return list.bind(store);
}

function githubOverrides(store: ReturnType<typeof githubListingFixture>["store"], opened: string[] = []) {
  return {
    resolveRepo: async () => GITHUB_REF,
    createStore: (repo: { path: string }) => {
      opened.push(repo.path);
      return store;
    },
  };
}

test("graph list parsing defaults to open and 50, and refuses an unbounded or out-of-vocabulary page", () => {
  const parsed = parseGraphArgs(["graph", "list", "--repo", `github:github.com/${GITHUB_REPO}`]);
  expect(parsed).toMatchObject({ action: "list", options: { state: "open", limit: 50 } });
  expect(parseGraphArgs(["graph", "list", "--state", "all", "--limit", "100", "--cursor", "abc"]).options).toMatchObject({
    state: "all",
    limit: 100,
    cursor: "abc",
  });
  expect(() => parseGraphArgs(["graph", "list", "--limit", "101"])).toThrow("100 or fewer");
  expect(() => parseGraphArgs(["graph", "list", "--limit", "0"])).toThrow("positive integer");
  expect(() => parseGraphArgs(["graph", "list", "--state", "merged"])).toThrow("one of open, closed, all");
  expect(() => parseGraphArgs(["graph", "list", "--cursor", "  "])).toThrow("must not be empty");
  expect(() => parseGraphArgs(["graph", "list", "--write"])).toThrow("Unknown option");
});

test("the CLI verb pages a repository without duplicates and stops at an empty next", async () => {
  const { store, calls } = githubListingFixture();
  const opened: string[] = [];
  const overrides = githubOverrides(store, opened);
  const args = (extra: string[]) => parseGraphArgs(["graph", "list", "--repo", `github:github.com/${GITHUB_REPO}`, ...extra, "--json"]);

  const first = JSON.parse(await runGraphCli(args(["--limit", "2"]), overrides)) as {
    nodes: unknown[];
    next: string | null;
  };
  expect(first.nodes).toEqual([
    { ref: { id: "1" }, title: "Node 1", status: "open", kind: "task", parent: null, url: `https://github.com/${GITHUB_REPO}/issues/1` },
    { ref: { id: "2" }, title: "Node 2", status: "open", kind: "research", parent: null, url: `https://github.com/${GITHUB_REPO}/issues/2` },
  ]);
  expect(first.next).toEqual(expect.any(String));

  const second = JSON.parse(
    await runGraphCli(args(["--limit", "2", "--cursor", String(first.next)]), overrides),
  ) as { nodes: { ref: { id: string } }[]; next: string | null };
  expect(second.nodes.map((row) => row.ref.id)).toEqual(["4"]);
  // The third open node is the last one, so the listing ends here rather than
  // returning another cursor that would produce an empty page.
  expect(second.next).toBeNull();

  const paged = [1, 2, 4];
  const seen = [...first.nodes, ...second.nodes].map((row) => (row as { ref: { id: string } }).ref.id);
  expect(seen).toEqual(paged.map(String));
  expect(new Set(seen).size).toBe(seen.length);
  // Every read the verb caused went through the permitted repository's own store,
  // and each one is a query: the verb has no write path at all.
  expect(opened).toEqual([GITHUB_REPO, GITHUB_REPO]);
  expect(calls).toHaveLength(2);
  expect(calls.every((call) => call.method === "POST" && call.path === "graphql")).toBe(true);
});

test("closed and all select the statuses the forge is asked for", async () => {
  const { store, calls } = githubListingFixture();
  const overrides = githubOverrides(store);
  const closed = JSON.parse(
    await runGraphCli(parseGraphArgs(["graph", "list", "--repo", `github:github.com/${GITHUB_REPO}`, "--state", "closed", "--json"]), overrides),
  ) as { nodes: { ref: { id: string }; status: string }[] };
  expect(closed.nodes).toEqual([
    expect.objectContaining({ ref: { id: "3" }, status: "closed" }),
  ]);
  expect(String(calls[0]?.body?.query)).toContain("states:[CLOSED]");

  const all = JSON.parse(
    await runGraphCli(parseGraphArgs(["graph", "list", "--repo", `github:github.com/${GITHUB_REPO}`, "--state", "all", "--limit", "100", "--json"]), overrides),
  ) as { nodes: unknown[]; next: string | null };
  expect(all.nodes).toHaveLength(4);
  expect(all.next).toBeNull();
});

test("a repository outside the read scope fails before any read and names nothing from it", async () => {
  const { store, calls } = githubListingFixture();
  const opened: string[] = [];
  const args = parseGraphArgs([
    "graph",
    "list",
    "--repo",
    "github:github.com/example/private",
    "--read-repo",
    `github:github.com/${GITHUB_REPO}`,
    "--json",
  ]);
  let thrown: unknown;
  try {
    await runGraphCli(args, {
      resolveRepo: async () => parseRepoRef("github:github.com/example/private"),
      createStore: (repo: { path: string }) => {
        opened.push(repo.path);
        return store;
      },
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe("Graph read unavailable in the permitted scope");
  expect((thrown as Error).message).not.toContain("private");
  // No store was opened and no request reached any forge.
  expect(opened).toEqual([]);
  expect(calls).toEqual([]);
});

test("a forge failure rejects instead of printing an empty page", async () => {
  const failing = (message: string) =>
    createGitHubGraphStore({
      repo: GITHUB_REPO,
      readScope: GITHUB_SCOPE,
      transport: async () => {
        throw new Error(message);
      },
    });
  const args = parseGraphArgs(["graph", "list", "--repo", `github:github.com/${GITHUB_REPO}`, "--json"]);
  for (const message of ["gh api graphql failed (exit 1): HTTP 502", "graphql returned nothing"]) {
    let thrown: unknown;
    try {
      await runGraphCli(args, { resolveRepo: async () => GITHUB_REF, createStore: () => failing(message) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(message);
  }
});

test("a GraphQL error payload rejects rather than reading as a short listing", async () => {
  const store = createGitHubGraphStore({
    repo: GITHUB_REPO,
    readScope: GITHUB_SCOPE,
    transport: async () => ({ errors: [{ message: "private details" }], data: {} }),
  });
  await expect(listNodesOf(store)({ repo: GITHUB_REF, state: "open", limit: 5 })).rejects.toThrow("GraphQL returned errors");
});

test("the GitHub store lists only its own repository and refuses a foreign cursor", async () => {
  const { store, calls } = githubListingFixture();
  const listNodes = listNodesOf(store);
  await expect(
    listNodes({ repo: parseRepoRef("github:github.com/example/other"), state: "open", limit: 5 }),
  ).rejects.toThrow("another repository");
  await expect(listNodes({ repo: GITHUB_REF, state: "open", limit: 5, cursor: "not-a-cursor" })).rejects.toThrow(
    "the cursor is not one this verb issued",
  );
  await expect(listNodes({ repo: GITHUB_REF, state: "open", limit: 5, cursor: Buffer.from('{"v":1}').toString("base64url") })).rejects.toThrow(
    "not one this store issued",
  );
  await expect(listNodes({ repo: GITHUB_REF, state: "open", limit: 101 })).rejects.toThrow("limit must be an integer from 1 to 100");
  expect(calls).toEqual([]);
});

// --- GitLab ---------------------------------------------------------------

const GITLAB_HOST = "gitlab.example.test";
const GITLAB_PROJECT = "example/allowed";
const GITLAB_REF = parseRepoRef(`gitlab:${GITLAB_HOST}/${GITLAB_PROJECT}`);
const GITLAB_SCOPE: GraphReadScope = { repositories: [GITLAB_REF], namespaces: [] };

interface FixtureWorkItem {
  iid: string;
  state: "OPEN" | "CLOSED";
  kind: string;
  children: readonly string[];
}

const WORK_ITEMS: readonly FixtureWorkItem[] = [
  { iid: "1", state: "OPEN", kind: "task", children: ["2", "3", "4"] },
  { iid: "2", state: "OPEN", kind: "research", children: [] },
  { iid: "3", state: "CLOSED", kind: "grilling", children: [] },
  { iid: "4", state: "OPEN", kind: "prototype", children: [] },
];

function gitlabWorkItem(iid: string, items: readonly FixtureWorkItem[]) {
  const entry = items.find((item) => item.iid === iid);
  if (entry === undefined) throw new Error(`unknown work item ${iid}`);
  return {
    id: `gid://gitlab/WorkItem/${iid}`,
    iid,
    title: `Node ${iid}`,
    state: entry.state,
    updatedAt: "2026-11-09T00:00:00Z",
    description: typedBlock(entry.kind),
    webUrl: `https://${GITLAB_HOST}/${GITLAB_PROJECT}/-/work_items/${iid}`,
    workItemType: { name: "Issue" },
    namespace: { fullPath: GITLAB_PROJECT },
    author: { username: "fixture" },
    widgets: [
      {
        type: "HIERARCHY",
        parent: iid === "1" ? null : { iid: "1", namespace: { fullPath: GITLAB_PROJECT }, workItemType: { name: "Issue" } },
        children: {
          nodes: entry.children.map((child) => ({ iid: child, namespace: { fullPath: GITLAB_PROJECT }, workItemType: { name: "Issue" } })),
          pageInfo: { hasNextPage: false },
        },
      },
    ],
  };
}

/**
 * A GitLab GraphQL transport answering the listing query and the subtree walk.
 *
 * `setItems` changes what the forge holds between two calls: the listing's
 * continuation has to survive a page that shifted underneath its cursor, which
 * a frozen fixture cannot show.
 */
function gitlabListingFixture(initial: readonly FixtureWorkItem[] = WORK_ITEMS) {
  const calls: GitLabApiRequest[] = [];
  let items = initial;
  const store = createGitLabGraphStore({
    host: GITLAB_HOST,
    readScope: GITLAB_SCOPE,
    transport: async (request) => {
      calls.push(request);
      expect(request.method).toBe("POST");
      expect(request.path).toBe("graphql");
      const query = String(request.body?.query);
      expect(query.startsWith("query")).toBe(true);
      const variables = request.body?.variables as Record<string, unknown>;
      if (query.includes("workItems(first:")) {
        expect(variables.fullPath).toBe(GITLAB_PROJECT);
        const after = typeof variables.after === "string" ? variables.after : null;
        const start = after === null ? 0 : Number(after.slice("page-".length));
        const page = items.slice(start, start + 20);
        const consumed = start + page.length;
        return {
          data: {
            namespace: {
              workItems: {
                pageInfo: { hasNextPage: consumed < items.length, endCursor: `page-${consumed}` },
                nodes: page.map((entry) => gitlabWorkItem(entry.iid, items)),
              },
            },
          },
        };
      }
      expect(variables.fullPath ?? variables.path0).toBe(GITLAB_PROJECT);
      if (typeof variables.iid === "string") return { data: { namespace: { workItem: gitlabWorkItem(variables.iid, items) } } };
      return {
        data: Object.fromEntries(
          Object.keys(variables)
            .filter((key) => key.startsWith("path"))
            .map((key) => {
              const suffix = key.slice(4);
              return [`item${suffix}`, { workItem: gitlabWorkItem(String(variables[`iid${suffix}`]), items) }];
            }),
        ),
      };
    },
  });
  return { store, calls, setItems: (next: readonly FixtureWorkItem[]) => { items = next; } };
}

test("the GitLab backend pages by a local status filter without duplicating or skipping rows", async () => {
  const { store, calls } = gitlabListingFixture();
  const overrides = { createStore: () => store };
  const args = (extra: string[]) =>
    parseGraphArgs(["graph", "list", "--repo", `gitlab:${GITLAB_HOST}/${GITLAB_PROJECT}`, ...extra, "--json"]);

  const first = JSON.parse(await runGraphCli(args(["--limit", "2"]), overrides)) as {
    nodes: { ref: { id: string }; title: string; status: string; kind: string | null; parent: unknown; url: string | null }[];
    next: string | null;
  };
  expect(first.nodes.map((row) => row.ref.id)).toEqual([`${GITLAB_PROJECT}#1`, `${GITLAB_PROJECT}#2`]);
  expect(first.nodes[0]).toEqual({
    ref: { id: `${GITLAB_PROJECT}#1` },
    title: "Node 1",
    status: "open",
    kind: "task",
    parent: null,
    url: `https://${GITLAB_HOST}/${GITLAB_PROJECT}/-/work_items/1`,
  });
  expect(first.nodes[1]).toMatchObject({ kind: "research", parent: { id: `${GITLAB_PROJECT}#1` } });
  expect(first.next).toEqual(expect.any(String));

  const second = JSON.parse(await runGraphCli(args(["--limit", "2", "--cursor", String(first.next)]), overrides)) as {
    nodes: { ref: { id: string } }[];
    next: string | null;
  };
  expect(second.nodes.map((row) => row.ref.id)).toEqual([`${GITLAB_PROJECT}#4`]);
  expect(second.next).toBeNull();
  // The closed item sat between two open ones and was never returned, and the
  // two pages together are exactly the open set.
  expect([...first.nodes, ...second.nodes].map((row) => row.ref.id)).toEqual(
    ["1", "2", "4"].map((iid) => `${GITLAB_PROJECT}#${iid}`),
  );
  expect(calls.every((call) => String(call.body?.query).startsWith("query"))).toBe(true);
});

test("a GitLab continuation skips by identity: a row that left the page drops none of the rows after it", async () => {
  const { store, setItems } = gitlabListingFixture([
    { iid: "1", state: "OPEN", kind: "task", children: [] },
    { iid: "2", state: "OPEN", kind: "research", children: [] },
    { iid: "3", state: "OPEN", kind: "grilling", children: [] },
    { iid: "4", state: "OPEN", kind: "prototype", children: [] },
  ]);
  const overrides = { createStore: () => store };
  const args = (extra: string[]) =>
    parseGraphArgs(["graph", "list", "--repo", `gitlab:${GITLAB_HOST}/${GITLAB_PROJECT}`, ...extra, "--json"]);

  const first = JSON.parse(await runGraphCli(args(["--limit", "2"]), overrides)) as {
    nodes: { ref: { id: string } }[];
    next: string | null;
  };
  expect(first.nodes.map((row) => row.ref.id)).toEqual([`${GITLAB_PROJECT}#1`, `${GITLAB_PROJECT}#2`]);

  // #1 and #2 were returned; #1 is then deleted from the forge, so the page
  // this cursor re-reads is one row shorter. A row offset would resume at #4
  // and silently drop #3; skipping the rows already returned returns it.
  setItems([
    { iid: "2", state: "OPEN", kind: "research", children: [] },
    { iid: "3", state: "OPEN", kind: "grilling", children: [] },
    { iid: "4", state: "OPEN", kind: "prototype", children: [] },
  ]);
  const second = JSON.parse(await runGraphCli(args(["--limit", "5", "--cursor", String(first.next)]), overrides)) as {
    nodes: { ref: { id: string } }[];
    next: string | null;
  };
  expect(second.nodes.map((row) => row.ref.id)).toEqual([`${GITLAB_PROJECT}#3`, `${GITLAB_PROJECT}#4`]);
  expect(second.next).toBeNull();
});

test("a GitLab continuation skips by identity: a row filed ahead of the cursor repeats none of the rows held", async () => {
  const { store, setItems } = gitlabListingFixture([
    { iid: "1", state: "OPEN", kind: "task", children: [] },
    { iid: "2", state: "OPEN", kind: "research", children: [] },
    { iid: "3", state: "OPEN", kind: "grilling", children: [] },
  ]);
  const overrides = { createStore: () => store };
  const args = (extra: string[]) =>
    parseGraphArgs(["graph", "list", "--repo", `gitlab:${GITLAB_HOST}/${GITLAB_PROJECT}`, ...extra, "--json"]);

  const first = JSON.parse(await runGraphCli(args(["--limit", "1"]), overrides)) as {
    nodes: { ref: { id: string } }[];
    next: string | null;
  };
  expect(first.nodes.map((row) => row.ref.id)).toEqual([`${GITLAB_PROJECT}#1`]);

  // A new work item is filed ahead of the cursor, shifting every row down one
  // place. A row offset would return #1 again; skipping by identity does not.
  setItems([
    { iid: "9", state: "OPEN", kind: "task", children: [] },
    { iid: "1", state: "OPEN", kind: "task", children: [] },
    { iid: "2", state: "OPEN", kind: "research", children: [] },
    { iid: "3", state: "OPEN", kind: "grilling", children: [] },
  ]);
  const second = JSON.parse(await runGraphCli(args(["--limit", "5", "--cursor", String(first.next)]), overrides)) as {
    nodes: { ref: { id: string } }[];
    next: string | null;
  };
  expect(second.nodes.map((row) => row.ref.id)).toEqual(
    ["9", "2", "3"].map((iid) => `${GITLAB_PROJECT}#${iid}`),
  );
  expect(second.next).toBeNull();
  const seen = [...first.nodes, ...second.nodes].map((row) => row.ref.id);
  expect(new Set(seen).size).toBe(seen.length);
});

test("one GitLab listing call reads a bounded number of forge pages and continues from what it scanned", async () => {
  const many: FixtureWorkItem[] = Array.from({ length: 130 }, (_, index) => ({
    iid: String(index + 1),
    state: "OPEN",
    kind: "task",
    children: [],
  }));
  const { store, calls } = gitlabListingFixture(many);
  const listNodes = listNodesOf(store);

  // A closed listing over a mostly-open project matches nothing here, yet one
  // call must not walk the whole project: it reads a fixed number of forge
  // pages and hands the rest back as `next`.
  const first = await listNodes({ repo: GITLAB_REF, state: "closed", limit: 5 });
  expect(first.nodes).toEqual([]);
  expect(first.next).toEqual(expect.any(String));
  expect(calls).toHaveLength(5);

  const second = await listNodes({ repo: GITLAB_REF, state: "closed", limit: 5, cursor: String(first.next) });
  expect(second.nodes).toEqual([]);
  expect(second.next).toBeNull();
  // Continuing is bounded too: the remaining two forge pages, not a second walk.
  expect(calls).toHaveLength(7);
});

test("a root-scoped page walks the subtree, pages it, and refuses a cursor from another root", async () => {
  const { store, calls } = gitlabListingFixture();
  const overrides = { createStore: () => store };
  const root = `gitlab:${GITLAB_HOST}/${GITLAB_PROJECT}#1`;
  const args = (extra: string[]) =>
    parseGraphArgs(["graph", "list", "--repo", `gitlab:${GITLAB_HOST}/${GITLAB_PROJECT}`, "--root", root, ...extra, "--json"]);

  const first = JSON.parse(await runGraphCli(args(["--limit", "1"]), overrides)) as {
    nodes: { ref: { id: string } }[];
    next: string | null;
  };
  // The root itself is not a row; its open descendants are, in traversal order.
  expect(first.nodes.map((row) => row.ref.id)).toEqual([`${GITLAB_PROJECT}#2`]);
  expect(first.next).toEqual(expect.any(String));

  const second = JSON.parse(await runGraphCli(args(["--limit", "1", "--cursor", String(first.next)]), overrides)) as {
    nodes: { ref: { id: string } }[];
    next: string | null;
  };
  expect(second.nodes.map((row) => row.ref.id)).toEqual([`${GITLAB_PROJECT}#4`]);
  expect(second.next).toBeNull();

  const other = parseGraphArgs([
    "graph",
    "list",
    "--repo",
    `gitlab:${GITLAB_HOST}/${GITLAB_PROJECT}`,
    "--root",
    `gitlab:${GITLAB_HOST}/${GITLAB_PROJECT}#2`,
    "--cursor",
    String(first.next),
    "--json",
  ]);
  await expect(runGraphCli(other, overrides)).rejects.toThrow("another subtree");
  expect(calls.length).toBeGreaterThan(0);
});

test("a root-scoped continuation survives a row closing before its boundary, and refuses one that left", async () => {
  const root = `gitlab:${GITLAB_HOST}/${GITLAB_PROJECT}#1`;
  const args = (extra: string[]) =>
    parseGraphArgs(["graph", "list", "--repo", `gitlab:${GITLAB_HOST}/${GITLAB_PROJECT}`, "--root", root, ...extra, "--json"]);
  const children = [
    { iid: "1", state: "OPEN" as const, kind: "task", children: ["2", "3", "4"] },
    { iid: "2", state: "OPEN" as const, kind: "research", children: [] },
    { iid: "3", state: "OPEN" as const, kind: "grilling", children: [] },
    { iid: "4", state: "OPEN" as const, kind: "prototype", children: [] },
  ];

  // A row before the boundary leaves the subtree: the boundary is found by
  // identity, so the rest of the page is still returned. A row offset would
  // have resumed past the end and reported an empty page.
  const shifted = gitlabListingFixture(children);
  const shiftedOverrides = { createStore: () => shifted.store };
  const first = JSON.parse(await runGraphCli(args(["--limit", "2"]), shiftedOverrides)) as {
    nodes: { ref: { id: string } }[];
    next: string | null;
  };
  expect(first.nodes.map((row) => row.ref.id)).toEqual([`${GITLAB_PROJECT}#2`, `${GITLAB_PROJECT}#3`]);
  shifted.setItems([
    { iid: "1", state: "OPEN", kind: "task", children: ["3", "4"] },
    { iid: "3", state: "OPEN", kind: "grilling", children: [] },
    { iid: "4", state: "OPEN", kind: "prototype", children: [] },
  ]);
  const second = JSON.parse(await runGraphCli(args(["--limit", "2", "--cursor", String(first.next)]), shiftedOverrides)) as {
    nodes: { ref: { id: string } }[];
    next: string | null;
  };
  expect(second.nodes.map((row) => row.ref.id)).toEqual([`${GITLAB_PROJECT}#4`]);
  expect(second.next).toBeNull();

  // A row that *is* the boundary leaves: it cannot tell where to resume, so it
  // refuses instead of guessing.
  const vanished = gitlabListingFixture(children);
  const vanishedOverrides = { createStore: () => vanished.store };
  const head = JSON.parse(await runGraphCli(args(["--limit", "1"]), vanishedOverrides)) as {
    nodes: { ref: { id: string } }[];
    next: string | null;
  };
  expect(head.nodes.map((row) => row.ref.id)).toEqual([`${GITLAB_PROJECT}#2`]);
  vanished.setItems([
    { iid: "1", state: "OPEN", kind: "task", children: ["3", "4"] },
    { iid: "3", state: "OPEN", kind: "grilling", children: [] },
    { iid: "4", state: "OPEN", kind: "prototype", children: [] },
  ]);
  await expect(runGraphCli(args(["--limit", "1", "--cursor", String(head.next)]), vanishedOverrides)).rejects.toThrow(
    "is no longer in the subtree",
  );
});

test("the GitLab store refuses a project on another host or outside the scope before any read", async () => {
  const { store, calls } = gitlabListingFixture();
  const listNodes = listNodesOf(store);
  await expect(
    listNodes({ repo: parseRepoRef("gitlab:gitlab.example.test/example/private"), state: "open", limit: 5 }),
  ).rejects.toThrow("Graph read unavailable in the permitted scope");
  await expect(
    listNodes({ repo: parseRepoRef("gitlab:other.example.test/example/allowed"), state: "open", limit: 5 }),
  ).rejects.toThrow("projects on gitlab.example.test");
  expect(calls).toEqual([]);
});
