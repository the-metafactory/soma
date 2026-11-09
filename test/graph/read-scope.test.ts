import { expect, test } from "bun:test";
import { createGitHubGraphStore, createGitLabGraphStore, permitsGraphRead, parseRepoRef, renderCloseReceipt, WorkGraph, type GraphReadScope, type GitHubApiRequest, type GitLabApiRequest } from "../../src/graph/index";
import { parseGraphArgs, runGraphCli } from "../../src/cli/graph";

const github = parseRepoRef("github:github.com/example/allowed");
const gitlab = parseRepoRef("gitlab:gitlab.example.test/example/allowed");
const githubScope: GraphReadScope = { repositories: [github], namespaces: [] };
const gitlabScope: GraphReadScope = { repositories: [gitlab], namespaces: [] };
const receipt = renderCloseReceipt({ checkpointId: "scope", closedBy: "fixture", closedWith: "fixture", at: "2026-11-09T00:00:00Z", gist: "Synthetic decision", evidence: [{ kind: "tested", summary: "Synthetic probe passed" }], probeResults: [], attestation: "unverified" });
const block = '<!-- soma:work-graph-node\n{"autonomy":"approve","checkpointId":"scope"}\n-->';
const edge = (path: string, iid: string) => ({ iid, namespace: { fullPath: path }, workItemType: { name: "Issue" } });

function gitlabItem(iid: string, children: unknown[] = [], links: unknown[] = []) {
  return { id: `gid://gitlab/WorkItem/${iid}`, iid, workItemType: "Issue", namespace: { fullPath: gitlab.path }, title: "Synthetic node", description: block, state: iid === "3" ? "CLOSED" : "OPEN", updatedAt: "2026-11-09T00:00:00Z", author: { username: "fixture" }, widgets: [
    { type: "ASSIGNEES", assignees: { nodes: [] } },
    { type: "HIERARCHY", children: { nodes: children, pageInfo: { hasNextPage: false } } },
    { type: "LINKED_ITEMS", linkedItems: { nodes: links, pageInfo: { hasNextPage: false } } },
  ] };
}

function gitlabFixture() {
  const calls: GitLabApiRequest[] = [];
  const store = createGitLabGraphStore({ host: gitlab.host, readScope: gitlabScope, transport: async (request) => {
    calls.push(request);
    expect(request.method).toBe("POST");
    const query = String(request.body?.query);
    expect(query.startsWith("query")).toBe(true);
    expect(query).not.toContain("fullPath} state workItemType");
    const variables = request.body?.variables as Record<string, string>;
    if (query.includes("WorkItemWidgetNotes")) return { data: { namespace: { workItem: { widgets: [{ type: "NOTES", notes: { nodes: [{ id: "gid://gitlab/Note/99", body: receipt, author: { username: "fixture" } }], pageInfo: { hasNextPage: false } } }] } } } };
    const itemFor = (path: string, iid: string) => {
      expect(path).toBe(gitlab.path);
      return iid === "1" ? gitlabItem("1", [edge(gitlab.path, "2"), edge(gitlab.path, "3"), edge("example/private", "9")]) : gitlabItem(iid, [], iid === "2" ? [
        { linkType: "IS_BLOCKED_BY", workItem: edge("example/private", "9") },
        { linkType: "IS_BLOCKED_BY", workItem: edge(gitlab.path, "3") },
      ] : []);
    };
    if (variables.fullPath !== undefined) return { data: { namespace: { workItem: itemFor(variables.fullPath, variables.iid) } } };
    const data = Object.fromEntries(Object.keys(variables).filter((key) => key.startsWith("path")).map((key) => {
      const suffix = key.slice(4);
      return [`item${suffix}`, { workItem: itemFor(variables[key], variables[`iid${suffix}`]) }];
    }));
    return { data };

  } });
  return { store, calls };
}

test("scope identity includes forge and host; namespaces use segment boundaries", () => {
  expect(permitsGraphRead(gitlabScope, { ...gitlab, host: "other.example.test" })).toBe(false);
  expect(permitsGraphRead(gitlabScope, { ...gitlab, forge: "github" })).toBe(false);
  expect(permitsGraphRead({ repositories: [] }, gitlab)).toBe(false);
  const scope = { repositories: [], namespaces: [parseRepoRef("gitlab:gitlab.example.test/example/team")] };
  expect(permitsGraphRead(scope, { ...gitlab, path: "example/team/project" })).toBe(true);
  expect(permitsGraphRead(scope, { ...gitlab, path: "example/team-private/project" })).toBe(false);
});

test("GitLab scope blocks foreign membership and blockers before target queries", async () => {
  const { store, calls } = gitlabFixture();
  const root = { id: `${gitlab.path}#1` };
  const nodes = await store.readSubtree(root);
  expect(nodes.map((node) => node.ref.id)).toEqual([`${gitlab.path}#2`, `${gitlab.path}#3`]);
  expect(nodes[0].blockedBy).toEqual([{ id: "example/private#9", status: "unavailable" }, { id: `${gitlab.path}#3`, status: "closed" }]);
  expect((await store.readNode(root)).unavailableChildren).toEqual([{ id: "example/private#9", unavailable: true }]);
  expect(await new WorkGraph(store).frontier(root)).toEqual([]);
  expect(calls.length).toBeGreaterThan(0);
  const before = calls.length;
  const denied = { id: "example/private#9" };
  for (const read of [() => store.readNode(denied), () => store.readSubtree(denied), () => store.listComments(denied), () => store.readRawBody(denied), () => store.readComment({ id: "1", nodeId: denied.id }), () => store.readCommentReactions({ id: "1", nodeId: denied.id })]) await expect(read()).rejects.toThrow("unavailable");
  expect(calls).toHaveLength(before);
});

function githubFixture() {
  const calls: GitHubApiRequest[] = [];
  const store = createGitHubGraphStore({ repo: github.path, readScope: githubScope, transport: async (request) => {
    calls.push(request);
    if (request.path === "graphql") {
      const query = String(request.body?.query);
      expect(query).not.toContain("body");
      expect(query).not.toContain("state");
      const variables = request.body?.variables as { owner: string; name: string; number: number };
      expect(`${variables.owner}/${variables.name}`).toBe(github.path);
      const relation = query.includes("subIssues(") ? "subIssues" : query.includes("blockedBy(") ? "blockedBy" : "parent";
      const identity = (repo: string, number: number) => ({ number, repository: { nameWithOwner: repo } });
      const nodes = variables.number === 1 && relation === "subIssues" ? [identity(github.path, 2), identity("example/private", 9)] : variables.number === 2 && relation === "blockedBy" ? [identity("example/private", 9)] : [];
      return { data: { repository: { issue: { [relation]: relation === "parent" ? null : { nodes, pageInfo: { hasNextPage: false } } } } } };
    }
    expect(request.path).toMatch(/^repos\/example\/allowed\/issues\/\d+$/u);
    const number = Number(request.path.split("/").at(-1));
    return { id: number + 100, number, title: "Synthetic node", body: block, state: "open", updated_at: "2026-11-09T00:00:00Z", user: { login: "fixture" }, assignees: [], html_url: `https://github.com/${github.path}/issues/${number}` };
  } });
  return { store, calls };
}

test("GitHub scoped reads use identity-only edges and never fetch foreign issue content", async () => {
  const { store, calls } = githubFixture();
  expect((await store.readSubtree({ id: "1" }))[0].blockedBy).toEqual([{ id: "example/private#9", status: "unavailable" }]);
  expect((await store.readNode({ id: "1" })).unavailableChildren).toEqual([{ id: "example/private#9", unavailable: true }]);
  expect(await new WorkGraph(store).frontier({ id: "1" })).toEqual([]);
  const before = calls.length;
  const denied = { id: "example/private#9" };
  for (const read of [() => store.readNode(denied), () => store.readSubtree(denied), () => store.listComments(denied), () => store.readRawBody(denied)]) await expect(read()).rejects.toThrow("unavailable");
  await expect(store.listCommentsBatch!([...Array.from({ length: 21 }, () => ({ id: "1" })), denied])).rejects.toThrow("unavailable");
  expect(calls).toHaveLength(before);
});

test("scoped GitHub errors cannot enter the full-content REST traversal fallback", async () => {
  const calls: string[] = [];
  const store = createGitHubGraphStore({ repo: github.path, readScope: githubScope, transport: async (request) => { calls.push(request.path); throw new Error("GraphQL: API rate limit exceeded"); } });
  await expect(store.readSubtree({ id: "1" })).rejects.toThrow("rate limit");
  expect(calls).toEqual(["graphql"]);
});

test("CLI scopes read verbs, refuses writes and requires explicit map scope", () => {
  for (const verb of ["node", "frontier", "audit", "decisions"]) expect(parseGraphArgs(["graph", verb, "1", "--read-repo", "github:github.com/example/allowed"]).options).toMatchObject({ readScope: githubScope });
  expect(() => parseGraphArgs(["graph", "decisions", "1", "--read-repo", "github:github.com/example/allowed", "--write"])).toThrow("cannot write");
  expect(() => parseGraphArgs(["graph", "claim", "1", "--read-repo", "github:github.com/example/allowed"])).toThrow("Unknown option");
  expect(() => parseGraphArgs(["graph", "maps", "--root", "github:github.com/example/allowed#1"])).toThrow("Usage:");
  expect(() => parseGraphArgs(["graph", "node", "1", "--read-repo", "example/allowed"])).toThrow("no forge");
  expect(() => parseGraphArgs(["graph", "node", "1", "--read-namespace", "github:github.com/example/allowed"])).toThrow("require GitLab");
});

test("CLI discovers configured permitted roots and returns neutral denied roots without opening their stores", async () => {
  const { store } = githubFixture();
  const created: string[] = [];
  const result = JSON.parse(await runGraphCli(parseGraphArgs(["graph", "maps", "--root", "github:github.com/example/allowed#1", "--root", "gitlab:private.example.test/team&3", "--read-repo", "github:github.com/example/allowed", "--json"]), { createStore: (repo, scope) => { created.push(repo.path); expect(scope).toEqual(githubScope); return store; } }));
  expect(created).toEqual([github.path]);
  expect(result.maps[0]).toMatchObject({ ref: "github:github.com/example/allowed#1", state: { typed: true } });
  expect(result.maps[1]).toEqual({ ref: "gitlab:private.example.test/team&3", unavailable: true });
});

test("all scoped CLI reads delegate scope and preserve root omissions", async () => {
  for (const verb of ["node", "frontier", "audit", "decisions"]) {
    const { store } = gitlabFixture();
    const output = JSON.parse(await runGraphCli(parseGraphArgs(["graph", verb, "gitlab:gitlab.example.test/example/allowed#1", "--read-repo", "gitlab:gitlab.example.test/example/allowed", "--json"]), { createStore: (_repo, scope) => { expect(scope).toEqual(gitlabScope); return store; }, listProbeRegistryEntries: async () => { throw new Error("Scoped audit must not read local registry"); } }));
    expect(output.repo).toBe("gitlab:gitlab.example.test/example/allowed");
    if (verb === "decisions") expect(output.decisions).toMatchObject([{ id: `${gitlab.path}#3`, hasReceipt: true, gist: "Synthetic decision" }]);
    if (verb === "audit") expect(output.closedWithoutReceipt).toEqual([]);
    if (verb !== "audit") expect(output.unavailableChildren).toEqual([{ id: "example/private#9", unavailable: true }]);
  }
});

for (const response of [{}, { data: { repository: { issue: { subIssues: { nodes: [], pageInfo: {} } } } } }, { errors: [{ message: "private details" }], data: {} }]) {
  test("malformed scoped links fail closed without a REST retry", async () => {
    const paths: string[] = [];
    const store = createGitHubGraphStore({ repo: github.path, readScope: githubScope, transport: async (request) => { paths.push(request.path); return response; } });
    await expect(store.readSubtree({ id: "1" })).rejects.toThrow();
    expect(paths).toEqual(["graphql"]);
  });
}

test("scoped link pagination follows cursors and refuses repeated cursors", async () => {
  const cursors: unknown[] = [];
  const store = createGitHubGraphStore({ repo: github.path, readScope: githubScope, transport: async (request) => {
    cursors.push((request.body?.variables as { after: unknown }).after);
    return { data: { repository: { issue: { subIssues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } } } } } };
  } });
  await expect(store.readSubtree({ id: "1" })).rejects.toThrow("pagination");
  expect(cursors).toEqual([null, "same"]);
});


test("scoped GitLab node refuses truncated membership metadata", async () => {
  const item = gitlabItem("1");
  const widgets = item.widgets as { type: string; children?: { pageInfo: { hasNextPage: boolean } } }[];
  const children = widgets.find((widget) => widget.type === "HIERARCHY")?.children;
  if (children === undefined) throw new Error("Missing hierarchy fixture");
  children.pageInfo.hasNextPage = true;
  const store = createGitLabGraphStore({ host: gitlab.host, readScope: gitlabScope, transport: async () => ({ data: { namespace: { workItem: item } } }) });
  await expect(store.readNode({ id: `${gitlab.path}#1` })).rejects.toThrow("paginated");
});

test("frontier and decisions retain unavailable grandchildren beneath closed nodes in JSON and text", async () => {
  const store = createGitLabGraphStore({ host: gitlab.host, readScope: gitlabScope, transport: async (request) => {
    const query = String(request.body?.query);
    const variables = request.body?.variables as { iid: string; fullPath: string };
    expect(variables.fullPath).toBe(gitlab.path);
    if (query.includes("WorkItemWidgetNotes")) return { data: { namespace: { workItem: { widgets: [] } } } };
    return { data: { namespace: { workItem: gitlabItem(variables.iid, variables.iid === "1" ? [edge(gitlab.path, "3")] : [edge("example/private", "9")]) } } };
  } });
  for (const verb of ["frontier", "decisions", "audit"]) {
    const args = ["graph", verb, "gitlab:gitlab.example.test/example/allowed#1", "--read-repo", "gitlab:gitlab.example.test/example/allowed"];
    const overrides = { createStore: () => store, listProbeRegistryEntries: async () => { throw new Error("Private registry read"); } };
    const output = JSON.parse(await runGraphCli(parseGraphArgs([...args, "--json"]), overrides));
    expect(output.unavailableMembership).toContainEqual({ source: { id: `${gitlab.path}#3` }, target: { id: "example/private#9", unavailable: true } });
    expect(await runGraphCli(parseGraphArgs(args), overrides)).toContain(`Unavailable membership: ${gitlab.path}#3 -> example/private#9`);
  }
});


test("scoped comment reads reject traversal IDs before any transport", async () => {
  const { store, calls } = githubFixture();
  const ref = { nodeId: "1", id: "../../../../private/issues/9" };
  await expect(store.readComment(ref)).rejects.toThrow("positive decimal");
  await expect(store.readCommentReactions(ref)).rejects.toThrow("positive decimal");
  expect(calls).toEqual([]);
});


test("scoped GitHub audit retains forge-qualified repository identity", async () => {
  const { store } = githubFixture();
  const result = JSON.parse(await runGraphCli(parseGraphArgs(["graph", "audit", "github:github.com/example/allowed#1", "--read-repo", "github:github.com/example/allowed", "--json"]), { createStore: () => store }));
  expect(result.repo).toBe("github:github.com/example/allowed");
});
