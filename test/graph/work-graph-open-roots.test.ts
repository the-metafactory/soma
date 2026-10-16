import { expect, test } from "bun:test";
import {
  type GraphStore,
  WorkGraphError,
  createGitHubGraphStore,
  type GitHubApiRequest,
  type GitHubApiTransport,
  createGitLabGraphStore,
} from "../../src/graph/index";

const REPO = "the-metafactory/soma";
const API_TIME = "2026-10-14T10:00:00Z";
const BODY_TIME = "2099-01-01T00:00:00Z";
const block = (serves = "G5") => `<!-- soma:work-graph-node\n${JSON.stringify({ autonomy: "approve", serves, updatedAt: BODY_TIME })}\n-->`;
const candidate = (number: number, body = block()) => ({ number, title: `node ${number}`, body });
const issue = (number: number, overrides: Record<string, unknown> = {}) => ({
  ...candidate(number), id: number + 1000, state: "open", updated_at: API_TIME,
  user: { login: "ivy-agent" }, assignees: [], ...overrides,
});
const page = (nodes: unknown[], totalCount = nodes.length, hasNextPage = false, endCursor: string | null = null) => ({
  data: { repository: { issues: { nodes, totalCount, pageInfo: { hasNextPage, endCursor } } } },
});

function discoveryFixture(
  pages: Record<string, unknown>,
  current: Record<string, Record<string, unknown>> = {},
  failure?: (request: GitHubApiRequest) => void,
) {
  const calls: GitHubApiRequest[] = [];
  const transport: GitHubApiTransport = async (request) => {
    calls.push(request);
    failure?.(request);
    if (request.path === "graphql") {
      expect(request.body?.query).toContain("issues(first:100,states:[OPEN]");
      expect(request.body?.query).not.toContain("search(");
      expect(request.body?.variables).toMatchObject({ owner: "the-metafactory", name: "soma" });
      const variables = request.body?.variables as { after: string | null };
      const result = pages[variables.after ?? "first"];
      if (result === undefined) throw new Error("unexpected page");
      return result;
    }
    const match = new RegExp(`^repos/${REPO}/issues/(\\d+)(.*)$`, "u").exec(request.path);
    if (match === null) throw new Error(`unexpected path ${request.path}`);
    const payload = current[match[1]];
    if (payload === undefined) throw new Error(`unreadable issue ${match[1]}`);
    if (match[2] === "") return payload;
    if (match[2] === "/parent") throw new WorkGraphError("backend", "HTTP 404: Not Found");
    if (match[2] === "/dependencies/blocked_by") return [];
    throw new Error(`unexpected path ${request.path}`);
  };
  return { store: createGitHubGraphStore({ repo: REPO, transport }), calls };
}

// Narrow the optional capability exactly as a goal-sweep caller must.
async function roots(store: GraphStore, serves = "G5") {
  if (store.listOpenRoots === undefined) throw new Error("root discovery unsupported");
  return await store.listOpenRoots(serves);
}

test("only open membership roots with the matching typed serves are returned", async () => {
  const { store } = discoveryFixture({ first: page([
    candidate(1), candidate(2), candidate(3, block("G6")), candidate(4),
    candidate(5, "serves: G5"), candidate(6, "<!-- soma:work-graph-node\nnot JSON\n-->"),
    candidate(7, block("G50")),
  ]) }, {
    1: issue(1), 2: issue(2, { state: "closed" }),
    4: issue(4, { parent: { number: 1 } }),
  });
  const result = await roots(store);
  expect(result.map((state) => state.ref.id)).toEqual(["1"]);
  expect(result[0]?.updatedAt).toBe(API_TIME);
  expect(result[0]?.node.serves).toBe("G5");
  expect(await roots(discoveryFixture({ first: page([]) }).store)).toEqual([]);
});

test.each([
  ["closed", { state: "closed" }],
  ["serves changed", { body: block("G6") }],
  ["serves removed", { body: "<!-- soma:work-graph-node\n{\"autonomy\":\"approve\"}\n-->" }],
  ["typed block removed", { body: "serves: G5" }],
  ["attached to a parent", { parent: { number: 99 } }],
])("a candidate %s after discovery is dropped on confirmation", async (_name, changes) => {
  const { store, calls } = discoveryFixture({ first: page([candidate(1)]) }, { 1: issue(1, changes) });
  expect(await roots(store)).toEqual([]);
  expect(calls.some((request) => request.path === `repos/${REPO}/issues/1`)).toBe(true);
});

test("every matching root across multiple pages is returned with its confirmed time", async () => {
  const nodes = Array.from({ length: 205 }, (_, index) => candidate(index + 1));
  const current = Object.fromEntries(nodes.map(({ number }) => [String(number), issue(number)]));
  const { store, calls } = discoveryFixture({
    first: page(nodes.slice(0, 100), 205, true, "page-2"),
    "page-2": page(nodes.slice(100, 200), 205, true, "page-3"),
    "page-3": page(nodes.slice(200), 205),
  }, current);
  const result = await roots(store);
  expect(result.map((state) => state.ref.id)).toEqual(nodes.map(({ number }) => String(number)));
  expect(result.every((state) => state.updatedAt === API_TIME)).toBe(true);
  expect(calls.filter((request) => request.path === "graphql")).toHaveLength(3);
});

test("a page with no goal matches still advances to later matching roots", async () => {
  const { store } = discoveryFixture({
    first: page([candidate(1, block("G6"))], 2, true, "next"),
    next: page([candidate(2)], 2),
  }, { 2: issue(2) });
  expect((await roots(store)).map((state) => state.ref.id)).toEqual(["2"]);
});

test.each([
  ["short final page", { first: page([], 1) }],
  ["missing cursor", { first: page([], 1, true) }],
  ["empty cursor", { first: page([], 1, true, "") }],
  ["repeating cursor", { first: page([], 1, true, "same"), same: page([], 1, true, "same") }],
  ["duplicate issue", { first: page([candidate(1), candidate(1)], 2) }],
  ["changing count", { first: page([], 1, true, "next"), next: page([], 0) }],
  ["unknown page status", { first: { data: { repository: { issues: { nodes: [], totalCount: 0, pageInfo: {} } } } } }],
  ["partial GraphQL errors", { first: { ...page([]), errors: [{ message: "unreadable" }] } }],
  ["missing repository", { first: { data: { repository: null } } }],
  ["missing issue body", { first: page([{ number: 1, title: "missing body" }]) }],
])("%s rejects with the repo instead of returning a short or empty list", async (_name, pages) => {
  await expect(roots(discoveryFixture(pages).store)).rejects.toThrow(REPO);
});

test.each(["graphql", `/issues/2`, `/issues/2/parent`, `/issues/2/dependencies/blocked_by`])(
  "a failed %s read rejects the entire discovery with the repo",
  async (path) => {
    const { store } = discoveryFixture({ first: page([candidate(1), candidate(2)]) }, { 1: issue(1), 2: issue(2) }, (request) => {
      if (request.path.endsWith(path)) throw new Error("forge unreachable");
    });
    await expect(roots(store)).rejects.toThrow(`${REPO}: forge unreachable`);
  },
);

test("failure on a later page rejects rather than publishing the first page", async () => {
  const { store } = discoveryFixture({ first: page([candidate(1)], 2, true, "next") }, { 1: issue(1) });
  await expect(roots(store)).rejects.toThrow(REPO);
});

test("invalid goal IDs refuse before calling the forge", async () => {
  const { store, calls } = discoveryFixture({});
  await expect(roots(store, "G5 extra query")).rejects.toThrow(REPO);
  expect(calls).toEqual([]);
});

test("GitLab leaves unsupported root discovery absent", () => {
  const store = createGitLabGraphStore({ host: "gitlab.example", transport: async () => { throw new Error("should not read"); } });
  expect(store.listOpenRoots).toBeUndefined();
  expect("listOpenRoots" in store).toBe(false);
});

const connection = (nodes: unknown[], totalCount = nodes.length) => ({
  nodes, totalCount, pageInfo: { hasNextPage: false, endCursor: null },
});
const subtreeNode = (number: number, updatedAt: unknown, subIssues = connection([]), overrides: Record<string, unknown> = {}) => ({
  ...candidate(number), state: "OPEN", databaseId: number + 1000, updatedAt,
  author: { login: "ivy-agent" }, assignees: connection([]), blockedBy: connection([]), subIssues, ...overrides,
});

test("REST readNode takes its update time from the API, never the typed block", async () => {
  const { store } = discoveryFixture({}, { 1: issue(1) });
  expect((await store.readNode({ id: "1" })).updatedAt).toBe(API_TIME);
});

test.each([undefined, null, "invalid", "2026-10-14", BODY_TIME + " garbage"])(
  "a missing or invalid REST API time (%s) cannot be rescued by body text",
  async (updated_at) => {
    const { store } = discoveryFixture({}, { 1: issue(1, { updated_at }) });
    await expect(store.readNode({ id: "1" })).rejects.toThrow("API update time");
    await expect(roots(discoveryFixture({ first: page([candidate(1)]) }, { 1: issue(1, { updated_at }) }).store)).rejects.toThrow(REPO);
  },
);

test("all subtree nodes carry GraphQL times, including closed descendants and re-rooted reads", async () => {
  const times = [API_TIME, "2026-10-13T09:00:00Z", "2026-10-14T11:00:00Z"];
  const store = createGitHubGraphStore({ repo: REPO, transport: async (request) => {
    expect(request.body?.query).toContain("body updatedAt");
    const { number } = request.body?.variables as { number: number };
    const root = number === 1
      ? subtreeNode(1, API_TIME, connection([
        subtreeNode(2, times[0], connection([subtreeNode(3, times[1], connection([], 1), { state: "CLOSED" })])),
      ]))
      : subtreeNode(3, times[1], connection([subtreeNode(4, times[2])]));
    return { data: { repository: { issue: root } } };
  } });
  const subtree = await store.readSubtree({ id: "1" });
  expect(subtree.map((state) => state.ref.id)).toEqual(["2", "3", "4"]);
  expect(subtree.map((state) => state.updatedAt)).toEqual(times);
  expect(subtree[1]?.status).toBe("closed");
  expect(Math.max(...subtree.map((state) => Date.parse(state.updatedAt)))).toBe(Date.parse(times[2]));
});

test("a truncated subtree state uses the confirmed REST update time", async () => {
  const fixture = discoveryFixture({}, { 2: issue(2, { updated_at: "2026-10-14T11:00:00Z" }) });
  const transport: GitHubApiTransport = async (request) => {
    if (request.path === "graphql") return { data: { repository: { issue: subtreeNode(1, API_TIME, connection([
      subtreeNode(2, API_TIME, connection([]), { assignees: connection([], 1) }),
    ])) } } };
    // Reuse the same canned issue response and REST paths for the repair.
    if (request.path.endsWith("/parent")) throw new WorkGraphError("backend", "HTTP 404: Not Found");
    if (request.path.endsWith("/blocked_by")) return [];
    return issue(2, { updated_at: "2026-10-14T11:00:00Z" });
  };
  const subtree = await createGitHubGraphStore({ repo: REPO, transport }).readSubtree({ id: "1" });
  expect(subtree[0]?.updatedAt).toBe((await fixture.store.readNode({ id: "2" })).updatedAt);
});

test("REST subtree fallback retains forge times on every descendant", async () => {
  const store = createGitHubGraphStore({ repo: REPO, transport: async (request) => {
    if (request.path === "graphql") throw new WorkGraphError("backend", "API rate limit exceeded");
    if (request.path.includes("/sub_issues?")) {
      expect(request.paginate).toBe(true);
      return request.path.includes("/issues/1/") ? [issue(2)] : [];
    }
    if (request.path.endsWith("/blocked_by")) return [];
    throw new Error(`unexpected path ${request.path}`);
  } });
  expect((await store.readSubtree({ id: "1" })).map((state) => state.updatedAt)).toEqual([API_TIME]);
});

test("GraphQL subtree rejects missing API times instead of reading body times", async () => {
  const store = createGitHubGraphStore({ repo: REPO, transport: async () => ({
    data: { repository: { issue: subtreeNode(1, API_TIME, connection([subtreeNode(2, undefined)])) } },
  }) });
  await expect(store.readSubtree({ id: "1" })).rejects.toThrow("API update time");
});
