import { expect, test } from "bun:test";
import {
  WorkGraphError,
  WorkGraph,
  checkGitLabConfinement,
  createGitLabGraphStore,
  type GitLabApiRequest,
} from "../src/index";
import { gitLabCliEnvironment, glabApiArgs, parseGitLabCreateData, parseGlabApiOutput } from "../src/work-graph-gitlab";
import { parseNodeSpec } from "../src/work-graph";

const REF = { id: "saca/secacademy#12" };
const REPO = "saca/secacademy";
function gitLabEpic(description: string) {
  return { id: "gid://gitlab/WorkItem/1", iid: "1", workItemType: "Epic", namespace: { fullPath: "saca" }, title: "map", description, state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
}

test("glab transport pins the host and flattens paginated output", () => {
  const request: GitLabApiRequest = { method: "GET", path: "projects/x/issues/1/notes", paginate: true };
  expect(glabApiArgs(request, "gitlab-int.switch.ch")).toEqual(["api", request.path, "--hostname", "gitlab-int.switch.ch", "--method", "GET", "--paginate", "--slurp"]);
  expect(parseGlabApiOutput("[[{\"id\":1}],[{\"id\":2}]]", request)).toEqual([{ id: 1 }, { id: 2 }]);
});

test("GitLab CLI transport allow-lists only its runtime and config environment", () => {
  expect(gitLabCliEnvironment({ PATH: "/bin", HOME: "/home/jc", GLAB_CONFIG_DIR: "/home/jc/.config/glab-cli", OPENAI_API_KEY: "secret", GLAB_TOKEN: "secret", GITLAB_TOKEN: "secret", GITLAB_ACCESS_TOKEN: "secret", OAUTH_TOKEN: "secret", CI_JOB_TOKEN: "secret", GITLAB_API_HOST: "evil.example", GLAB_HOST: "evil.example", GITLAB_HOST: "evil.example", GITLAB_URI: "https://evil.example" })).toEqual({ PATH: "/bin", HOME: "/home/jc", GLAB_CONFIG_DIR: "/home/jc/.config/glab-cli" });
});

test("GitLab system notes are excluded and thumb tones normalize at the store boundary", async () => {
  const transport = async (request: GitLabApiRequest): Promise<unknown> => {
    if (request.path === "graphql") return { data: { namespace: { workItem: { widgets: [{ type: "NOTES", notes: { nodes: [
      { id: "gid://gitlab/Note/1", system: true, body: "mentioned in commit", author: { username: "ivy" } },
      { id: "gid://gitlab/Note/2", system: false, body: "human", author: { username: "jc" } },
    ], pageInfo: { hasNextPage: false } } }] } } } };
    if (request.path.endsWith("/notes/2/award_emoji")) return [{ id: 3, name: "thumbsup_tone3", user: { username: "jc" } }, { id: 4, name: "thumbsdown", user: { username: "ada" } }];
    throw new Error(`unexpected ${request.method} ${request.path}`);
  };
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport });
  expect(await store.listComments(REF)).toEqual([{ id: "2", author: "jc", body: "human" }]);
  expect((await store.readCommentReactions({ id: "2", nodeId: REF.id, author: "jc" })).map((reaction) => reaction.content)).toEqual(["+1", "-1"]);
});

test("GitLab refuses a paginated comment history rather than auditing a partial receipt set", async () => {
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport: async () => ({ data: { namespace: { workItem: { widgets: [{ type: "NOTES", notes: { nodes: [], pageInfo: { hasNextPage: true } } }] } } } }) });
  await expect(store.listComments(REF)).rejects.toThrow(/bounded receipt-history read/u);
});

test("GitLab exposes Issue as its only Task-parent capability", () => {
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport: async () => ({}) });
  expect(store.selectRehomeParent).toBeTypeOf("function");
});

test("GitLab re-home reuses the Task and Issue reads for creation", async () => {
  const calls: GitLabApiRequest[] = [];
  const issue = { id: "gid://gitlab/WorkItem/2", iid: "2", workItemType: "Issue", namespace: { fullPath: REPO }, title: "issue", description: "", state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const task = { id: "gid://gitlab/WorkItem/3", iid: "3", workItemType: "Task", namespace: { fullPath: REPO }, title: "task", description: "", state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", parent: { iid: "2", namespace: { fullPath: REPO }, workItemType: { name: "Issue" } }, children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async (request) => {
    calls.push(request);
    const query = String(request.body?.query);
    if (query.includes("workItemTypes")) return { data: { namespace: { workItemTypes: { nodes: [{ id: "gid://gitlab/WorkItems::Type/instance-task", name: "Task" }] } } } };
    if (query.includes("workItemCreate")) return { data: { workItemCreate: { workItem: { iid: "4", workItemType: { name: "Task" }, namespace: { fullPath: REPO } }, errors: [] } } };
    return { data: { namespace: { workItem: calls.filter((call) => String(call.body?.query).includes("workItem(iid")).length === 1 ? task : issue } } };
  } });
  const created = await new WorkGraph(store).createNode({ title: "scaffold", autonomy: "approve", checkpointId: "cp", parent: { id: `${REPO}#3` } });
  expect(created).toMatchObject({ id: `${REPO}#4`, rehomedFrom: { id: `${REPO}#3` }, rehomedTo: { id: `${REPO}#2` } });
  expect(calls.filter((call) => String(call.body?.query).includes("workItem(iid"))).toHaveLength(2);
  expect((calls.find((call) => String(call.body?.query).includes("workItemCreate"))?.body?.variables as { input: Record<string, unknown> }).input).toMatchObject({ linkedItemsWidget: { linkType: "RELATED", workItemsIds: [task.id] } });
});

test("GitLab writes blocking edges through the linked-item mutation contract", async () => {
  const calls: GitLabApiRequest[] = [];
  const item = { id: "gid://gitlab/WorkItem/12", iid: "12", workItemType: "Issue", namespace: { fullPath: REPO }, title: "task", description: "", state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async (request) => { calls.push(request); if (String(request.body?.query).includes("workItemAddLinkedItems")) return { data: { workItemAddLinkedItems: { errors: [] } } }; return { data: { namespace: { workItem: item } } }; } });
  await store.addBlockingEdge({ id: `${REPO}#1` }, { id: `${REPO}#2` });
  const request = calls.find((call) => String(call.body?.query).includes("workItemAddLinkedItems"));
  expect(String(request?.body?.query)).toContain("$linkType:WorkItemRelatedLinkType!");
  expect(String(request?.body?.query)).toContain("input:{id:$source,workItemsIds:[$target],linkType:$linkType}");
  expect(request?.body?.variables).toMatchObject({ source: item.id, target: item.id, linkType: "BLOCKS" });
});

test("GitLab refuses non-decimal Issue receipt ids before REST reads", async () => {
  const calls: GitLabApiRequest[] = [];
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async (request) => { calls.push(request); return {}; } });
  const ref = { id: "../../../issues/99/notes/1", nodeId: REF.id, author: "ivy" };
  await expect(store.readComment(ref)).rejects.toThrow(/positive decimal integer/u);
  await expect(store.readCommentReactions(ref)).rejects.toThrow(/positive decimal integer/u);
  expect(calls).toEqual([]);
});

test("GitLab claim and release refuse an identity other than the authenticated account", async () => {
  const calls: GitLabApiRequest[] = [];
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport: async (request) => { calls.push(request); return { username: "jc" }; } });
  await expect(store.claim(REF, "ivy")).rejects.toThrow(/does not match the authenticated GitLab identity/u);
  await expect(store.release(REF, "ivy")).rejects.toThrow(/does not match the authenticated GitLab identity/u);
  expect(calls).toEqual([{ method: "GET", path: "user" }, { method: "GET", path: "user" }]);
});

test("GitLab release reports the assignees GitLab actually returned", async () => {
  const issue = { id: "gid://gitlab/WorkItem/12", iid: "12", workItemType: "Issue", namespace: { fullPath: REPO }, title: "task", description: "", state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [{ username: "jc" }] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async (request) => {
    if (request.path === "user") return { username: "jc" };
    if (String(request.body?.query).includes("issueSetAssignees")) return { data: { issueSetAssignees: { errors: [] } } };
    if (request.path === "graphql") return { data: { namespace: { workItem: issue } } };
    return {};
  } });
  await expect(store.release(REF, "jc")).resolves.toEqual({ released: false, identity: "jc", assignees: ["jc"] });
});

test("GitLab creates an Issue in an Epic root's declared home project", async () => {
  const calls: GitLabApiRequest[] = [];
  const epic = { id: "gid://gitlab/WorkItem/1", iid: "1", workItemType: "Epic", namespace: { fullPath: "saca" }, title: "map", description: `<!-- soma:work-graph-node\n{"autonomy":"approve"}\n-->\n\n<!-- soma:gitlab-work-graph-route\n{"homeProject":"saca/secacademy"}\n-->`, state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const transport = async (request: GitLabApiRequest): Promise<unknown> => {
    calls.push(request);
    if (calls.length === 1) return { data: { namespace: { workItem: epic } } };
    if (String(request.body?.query).includes("workItemTypes")) return { data: { namespace: { workItemTypes: { nodes: [{ id: "gid://gitlab/WorkItems::Type/instance-issue", name: "Issue" }] } } } };
    return { data: { workItemCreate: { workItem: { iid: "2", workItemType: { name: "Issue" }, namespace: { fullPath: "saca/secacademy" } }, errors: [] } } };
  };
  const ref = await createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport }).createNode(parseNodeSpec({ title: "route", autonomy: "approve", checkpointId: "cp", parent: { id: "saca&1" } }));
  expect(ref).toEqual({ id: "saca/secacademy#2" });
  const input = (calls[2]?.body?.variables as { input: Record<string, unknown> }).input;
  expect(input).toMatchObject({ projectPath: "saca/secacademy", workItemTypeId: "gid://gitlab/WorkItems::Type/instance-issue", descriptionWidget: { description: expect.any(String) }, hierarchyWidget: { parentId: "gid://gitlab/WorkItem/1" } });
  expect(String(calls[2]?.body?.query)).toContain("workItemType{name}");
  expect(String(calls[1]?.body?.query)).toContain("workItemTypes(name:ISSUE)");
});

test("GitLab resolves the Epic type in the target group before creating a graph root", async () => {
  const calls: GitLabApiRequest[] = [];
  const transport = async (request: GitLabApiRequest): Promise<unknown> => { calls.push(request); return String(request.body?.query).includes("workItemTypes") ? { data: { namespace: { workItemTypes: { nodes: [{ id: "gid://gitlab/WorkItems::Type/instance-epic", name: "Epic" }] } } } } : { data: { workItemCreate: { workItem: { iid: "1", workItemType: { name: "Epic" }, namespace: { fullPath: "saca" } }, errors: [] } } }; };
  const ref = await createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport }).createNode(parseNodeSpec({ title: "map", autonomy: "approve", checkpointId: "cp", storeData: { homeProject: "saca/secacademy" } }, parseGitLabCreateData));
  expect(ref).toEqual({ id: "saca&1" });
  expect(String(calls[0]?.body?.query)).toContain("workItemTypes(name:EPIC)");
  expect((calls[1]?.body?.variables as { input: Record<string, unknown> }).input).toMatchObject({ namespacePath: "saca", workItemTypeId: "gid://gitlab/WorkItems::Type/instance-epic" });
  const description = ((calls[1]?.body?.variables as { input: { descriptionWidget: { description: string } } }).input).descriptionWidget.description;
  expect(description).toContain('"home": "saca/secacademy"');
  expect(description).toContain("soma:gitlab-work-graph-route");
});

test("GitLab rejects an Epic without home before a transport call", async () => {
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async () => { throw new Error("transport must not run"); } });
  await expect(store.createNode(parseNodeSpec({ title: "map", autonomy: "approve", checkpointId: "cp" }))).rejects.toThrow(/require --home-project/u);
});

test("GitLab refuses labels instead of silently discarding map discovery metadata", async () => {
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async () => { throw new Error("transport must not run"); } });
  await expect(store.createNode(parseNodeSpec({ title: "map", autonomy: "approve", checkpointId: "cp", labels: ["orienteer:map"], storeData: { homeProject: "saca/secacademy" } }, parseGitLabCreateData))).rejects.toThrow(/does not support labels/u);
});

test("GitLab refuses an Epic home outside its group before creating a child", async () => {
  const epic = gitLabEpic('<!-- soma:work-graph-node\n{"autonomy":"approve","home":"elsewhere/project"}\n-->');
  let calls = 0;
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async () => { calls += 1; return { data: { namespace: { workItem: epic } } }; } });
  await expect(store.createNode(parseNodeSpec({ title: "route", autonomy: "approve", checkpointId: "cp", parent: { id: "saca&1" } }))).rejects.toThrow(/outside Epic group/u);
  expect(calls).toBe(1);
});

test("GitLab rejects traversal in a typed Epic home before child creation", async () => {
  const epic = gitLabEpic('<!-- soma:work-graph-node\n{"autonomy":"approve","home":"saca/../../other"}\n-->');
  let calls = 0;
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async () => { calls += 1; return { data: { namespace: { workItem: epic } } }; } });
  await expect(store.createNode(parseNodeSpec({ title: "route", autonomy: "approve", checkpointId: "cp", parent: { id: "saca&1" } }))).rejects.toThrow(/invalid path/u);
  expect(calls).toBe(1);
});

test("GitLab refuses conflicting typed and legacy home bindings", async () => {
  const epic = gitLabEpic('<!-- soma:work-graph-node\n{"autonomy":"approve","home":"saca/one"}\n-->\n<!-- soma:gitlab-work-graph-route\n{"homeProject":"saca/two"}\n-->');
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async () => ({ data: { namespace: { workItem: epic } } }) });
  await expect(store.readNode({ id: "saca&1" })).rejects.toThrow(/conflicting typed and route home/u);
});

test("GitLab refuses malformed typed homes even when a legacy route is valid", async () => {
  for (const block of ['{"autonomy":"approve","home":42}', '{broken json']) {
    const epic = gitLabEpic(`<!-- soma:work-graph-node\n${block}\n-->\n<!-- soma:gitlab-work-graph-route\n{"homeProject":"saca/secacademy"}\n-->`);
    let calls = 0;
    const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async () => { calls += 1; return { data: { namespace: { workItem: epic } } }; } });
    const state = await store.readNode({ id: "saca&1" });
    expect(state.typed).toBe(false);
    expect(state.parseError).toBeDefined();
    await expect(store.createNode(parseNodeSpec({ title: "route", autonomy: "approve", checkpointId: "cp", parent: { id: "saca&1" } }))).rejects.toThrow(/invalid typed node block/u);
    expect(calls).toBe(2);
  }
});

test("GitLab creates a Task in its Issue parent's project", async () => {
  const calls: GitLabApiRequest[] = [];
  const issue = { id: "gid://gitlab/WorkItem/2", iid: "2", workItemType: "Issue", namespace: { fullPath: "saca/secacademy" }, title: "route", description: "", state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const transport = async (request: GitLabApiRequest): Promise<unknown> => { calls.push(request); if (calls.length === 1) return { data: { namespace: { workItem: issue } } }; if (String(request.body?.query).includes("workItemTypes")) return { data: { namespace: { workItemTypes: { nodes: [{ id: "gid://gitlab/WorkItems::Type/instance-task", name: "Task" }] } } } }; return { data: { workItemCreate: { workItem: { iid: "3", workItemType: { name: "Task" }, namespace: { fullPath: "saca/secacademy" } }, errors: [] } } }; };
  const ref = await createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport }).createNode(parseNodeSpec({ title: "scaffold", autonomy: "approve", checkpointId: "cp", parent: { id: "saca/secacademy#2" } }));
  expect(ref).toEqual({ id: "saca/secacademy#3" });
  expect((calls[2]?.body?.variables as { input: Record<string, unknown> }).input).toMatchObject({ projectPath: "saca/secacademy", hierarchyWidget: { parentId: "gid://gitlab/WorkItem/2" } });
});

test("GitLab refuses a homeProject without a project segment", async () => {
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport: async () => { throw new Error("must not call GitLab"); } });
  await expect(store.createNode(parseNodeSpec({ title: "map", autonomy: "approve", checkpointId: "cp", storeData: { homeProject: "saca/" } }, parseGitLabCreateData))).rejects.toThrow(/invalid path/u);
});

test("GitLab root creation cannot route outside the selected repository", async () => {
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport: async () => { throw new Error("must not call GitLab"); } });
  await expect(store.createNode(parseNodeSpec({ title: "map", autonomy: "approve", checkpointId: "cp", storeData: { homeProject: "other/project", scopeProject: REPO } }, parseGitLabCreateData))).rejects.toThrow(/must match the selected repository/u);
});

test("GitLab preserves an Epic blocker id, reading link types as GitLab returns them (lowercase)", async () => {
  const item = { id: "gid://gitlab/WorkItem/12", iid: "12", workItemType: "Issue", namespace: { fullPath: "saca/secacademy" }, title: "task", description: "", state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [{ linkType: "is_blocked_by", workItem: { iid: "1", namespace: { fullPath: "saca" }, state: "OPEN", workItemType: { name: "Epic" } } }] } }] };
  const calls: GitLabApiRequest[] = [];
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport: async (request) => { calls.push(request); return { data: { namespace: { workItem: item } } }; } });
  expect((await store.readNode(REF)).blockedBy).toEqual([{ id: "saca&1", status: "open" }]);
  expect(String(calls[0]?.body?.query)).not.toContain("children(first:100)");
});

test("GitLab batches every subtree hierarchy level", async () => {
  const root = { id: "gid://gitlab/WorkItem/1", iid: "1", workItemType: "Epic", namespace: { fullPath: "saca" }, title: "root", description: "", state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [{ iid: "2", namespace: { fullPath: "saca/p" }, workItemType: { name: "Issue" } }, { iid: "3", namespace: { fullPath: "saca/p" }, workItemType: { name: "Issue" } }] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const child = (iid: string) => ({ id: `gid://gitlab/WorkItem/${iid}`, iid, workItemType: "Issue", namespace: { fullPath: "saca/p" }, title: `child ${iid}`, description: "", state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] });
  const calls: GitLabApiRequest[] = [];
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport: async (request) => { calls.push(request); return calls.length === 1 ? { data: { namespace: { workItem: root } } } : { data: { item0: { workItem: child("2") }, item1: { workItem: child("3") } } }; } });
  expect((await store.readSubtree({ id: "saca&1" })).map((state) => state.ref.id)).toEqual(["saca/p#2", "saca/p#3"]);
  expect(calls).toHaveLength(2);
  expect(String(calls[1]?.body?.query)).toContain("item0:namespace");
  expect(String(calls[1]?.body?.query)).toContain("item1:namespace");
});

test("close writes the receipt note before one description-and-state PUT", async () => {
  const calls: string[] = [];
  let closeBody: Record<string, unknown> | undefined;
  const item = { id: "gid://gitlab/WorkItem/12", iid: "12", namespace: { fullPath: "saca/secacademy" }, title: "task", description: "body\n\n<!-- soma:work-graph-node\n{\"autonomy\":\"approve\"}\n-->", state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const transport = async (request: GitLabApiRequest): Promise<unknown> => {
    calls.push(`${request.method} ${request.path}`);
    if (request.path === "graphql") return { data: { namespace: { workItem: item } } };
    if (request.method === "POST") return { id: 9, author: { username: "ivy" } };
    if (request.method === "GET") return { description: "body" };
    if (request.method === "PUT") { closeBody = request.body; return {}; }
    throw new Error("unexpected request");
  };
  await createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport }).close(REF, { checkpointId: "cp", autonomy: "propose", closedBy: "ivy", at: "2026-09-23T00:00:00.000Z", evidence: [], probeResults: [], attestation: "unverified" });
  expect(calls.slice(-3)).toEqual(["POST graphql", "POST projects/saca%2Fsecacademy/issues/12/notes", "PUT projects/saca%2Fsecacademy/issues/12"]);
  expect(String(closeBody?.description)).toContain('"receiptCommentId": "9"');
  expect(String(closeBody?.description)).toContain('"closer": "ivy"');
  expect(String(closeBody?.description)).toContain('"autonomy": "approve"');
});

test("GitLab route metadata never appears in a node body", async () => {
  const item = { id: "gid://gitlab/WorkItem/1", iid: "1", workItemType: "Epic", namespace: { fullPath: "saca" }, title: "map", description: `Human text\n\n<!-- soma:work-graph-node\n{"autonomy":"approve"}\n-->\n\n<!-- soma:gitlab-work-graph-route\n{"homeProject":"saca/secacademy"}\n-->`, state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport: async () => ({ data: { namespace: { workItem: item } } }) });
  expect((await store.readNode({ id: "saca&1" })).body).toBe("Human text");
  expect((await store.readNode({ id: "saca&1" })).storeFields?.home).toBe("saca/secacademy");
});

test("GitLab Epic close preserves a legacy route and restores it on typed-only roots", async () => {
  const homes = [
    { description: '<!-- soma:work-graph-node\n{"autonomy":"approve"}\n-->\n\n<!-- soma:gitlab-work-graph-route\n{"homeProject":"saca/secacademy"}\n-->' },
    { description: '<!-- soma:work-graph-node\n{"autonomy":"approve","home":"saca/secacademy"}\n-->' },
  ];
  for (const fixture of homes) {
    const epic = gitLabEpic(fixture.description);
    let written = "";
    const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async (request) => {
      const query = String(request.body?.query);
      if (query.includes("createNote")) return { data: { createNote: { note: { id: "gid://gitlab/Note/1", author: { username: "ivy" } }, errors: [] } } };
      if (query.includes("workItemUpdate")) { written = ((request.body?.variables as { input: { descriptionWidget: { description: string } } }).input).descriptionWidget.description; return { data: { workItemUpdate: { errors: [] } } }; }
      return { data: { namespace: { workItem: epic } } };
    } });
    await store.close({ id: "saca&1" }, { checkpointId: "cp", autonomy: "approve", closedBy: "ivy", at: "2026-09-24T00:00:00.000Z", evidence: [], probeResults: [], attestation: "unverified" });
    expect(written).toContain("soma:gitlab-work-graph-route");
    expect(written.match(/"home": "saca\/secacademy"/gu)).toHaveLength(1);
  }
});

test("GitLab rejects child-owned home instead of persisting an ignored binding", async () => {
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async () => { throw new Error("transport must not run"); } });
  await expect(store.createNode(parseNodeSpec({ title: "child", autonomy: "approve", storeData: { homeProject: "saca/other" }, parent: { id: "saca&1" } }, parseGitLabCreateData))).rejects.toThrow(/home belongs on the map root/u);
});

test("GitLab reads a new Epic's home from the typed node block", async () => {
  const item = gitLabEpic('<!-- soma:work-graph-node\n{"autonomy":"approve","home":"saca/secacademy"}\n-->');
  const calls: GitLabApiRequest[] = [];
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async (request) => {
    calls.push(request);
    if (calls.length <= 2) return { data: { namespace: { workItem: item } } };
    if (String(request.body?.query).includes("workItemTypes")) return { data: { namespace: { workItemTypes: { nodes: [{ id: "gid://gitlab/WorkItems::Type/instance-issue", name: "Issue" }] } } } };
    return { data: { workItemCreate: { workItem: { iid: "2", workItemType: { name: "Issue" }, namespace: { fullPath: "saca/secacademy" } }, errors: [] } } };
  } });
  expect((await store.readNode({ id: "saca&1" })).storeFields?.home).toBe("saca/secacademy");
  await store.createNode(parseNodeSpec({ title: "route", autonomy: "approve", checkpointId: "cp", parent: { id: "saca&1" } }));
  expect((calls[3]?.body?.variables as { input: { projectPath: string } }).input.projectPath).toBe("saca/secacademy");
});

test("GitLab raw Epic bodies retain route metadata for later writes", async () => {
  const description = `Human text\n\n<!-- soma:gitlab-work-graph-route\n{"homeProject":"saca/secacademy"}\n-->`;
  const item = { id: "gid://gitlab/WorkItem/1", iid: "1", workItemType: "Epic", namespace: { fullPath: "saca" }, title: "map", description, state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async () => ({ data: { namespace: { workItem: item } } }) });
  await expect(store.readRawBody({ id: "saca&1" })).resolves.toBe(description);
});

test("closed GitLab nodes retain their typed completion binding", async () => {
  const item = { id: "gid://gitlab/WorkItem/12", iid: "12", workItemType: "Issue", namespace: { fullPath: REPO }, title: "task", description: `<!-- soma:work-graph-node\n{"autonomy":"approve","completion":{"receiptCommentId":"9","checkpointId":"cp","autonomy":"approve","closer":"ivy","closedAt":"2026-09-24T00:00:00.000Z","gatedNodeHash":"hash"}}\n-->`, state: "CLOSED", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const state = await createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport: async () => ({ data: { namespace: { workItem: item } } }) }).readNode(REF);
  expect(state.typed).toBe(true);
  expect(state.node.completion?.receiptCommentId).toBe("9");
});

test("GitLab rejects a partial persisted completion CI binding", async () => {
  const item = { id: "gid://gitlab/WorkItem/12", iid: "12", workItemType: "Issue", namespace: { fullPath: REPO }, title: "task", description: `<!-- soma:work-graph-node\n{"autonomy":"approve","completion":{"receiptCommentId":"9","checkpointId":"cp","autonomy":"approve","closer":"ivy","closedAt":"2026-09-24T00:00:00.000Z","gatedNodeHash":"hash","ciCheckRunId":"42"}}\n-->`, state: "CLOSED", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const state = await createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async () => ({ data: { namespace: { workItem: item } } }) }).readNode(REF);
  expect(state.typed).toBe(false);
  expect(state.parseError).toMatch(/invalid persisted completion CI binding/u);
});

test("Epic receipt reads refuse a note that is not attached to that Epic", async () => {
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport: async (request) => {
    expect(String(request.body?.query)).not.toContain("note(id:$id)");
    return { data: { namespace: { workItem: { widgets: [{ type: "NOTES", notes: { nodes: [{ id: "gid://gitlab/Note/elsewhere", author: { username: "ivy" } }], pageInfo: { hasNextPage: false } } }] } } } };
  } });
  await expect(store.readComment({ id: "gid://gitlab/Note/receipt", nodeId: "saca&1", author: "ivy" })).rejects.toThrow(/is not attached to saca&1/u);
});

test("an Epic root closes through work-item mutations, never an issue REST path", async () => {
  const calls: GitLabApiRequest[] = [];
  const epic = { id: "gid://gitlab/WorkItem/1", iid: "1", workItemType: "Epic", namespace: { fullPath: "saca" }, title: "map", description: "body", state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const transport = async (request: GitLabApiRequest): Promise<unknown> => {
    calls.push(request);
    if (request.path !== "graphql") throw new Error(`Epic used REST: ${request.path}`);
    const query = String(request.body?.query);
    if (query.includes("createNote")) return { data: { createNote: { note: { id: "gid://gitlab/Note/1", author: { username: "ivy" } }, errors: [] } } };
    if (query.includes("workItemUpdate")) return { data: { workItemUpdate: { errors: [] } } };
    return { data: { namespace: { workItem: epic } } };
  };
  await createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport }).close({ id: "saca&1" }, { checkpointId: "cp", autonomy: "approve", closedBy: "ivy", at: "2026-09-24T00:00:00.000Z", evidence: [], probeResults: [], attestation: "unverified" });
  expect(calls).toHaveLength(3);
  expect(calls.map((call) => String(call.body?.query)).some((query) => query.includes("createNote"))).toBe(true);
  expect(calls.map((call) => String(call.body?.query)).some((query) => query.includes("workItemUpdate"))).toBe(true);
});

test("unparseable GitLab sudo probe downgrades confinement", async () => {
  const result = await checkGitLabConfinement({
    env: { PATH: "/usr/bin", HOME: "/tmp" }, platform: "darwin", now: () => new Date("2026-09-23T00:00:00.000Z"),
    runCommand: async (request) => request.argv?.join(" ").includes("personal_access_tokens") ? { exitCode: 0, stdout: "not-json", stderr: "", timedOut: false } : { exitCode: 1, stdout: "", stderr: "", timedOut: false },
  }, "gitlab-int.switch.ch");
  expect(result.reachableIdentities).toContain("impersonation:unknown");
});

test("GitLab confinement probes strip ambient host overrides", async () => {
  const environments: Record<string, string | undefined>[] = [];
  await checkGitLabConfinement({
    env: { PATH: "/usr/bin", HOME: "/tmp", GITLAB_API_HOST: "evil.invalid", GLAB_HOST: "evil.invalid", GITLAB_HOST: "evil.invalid", GITLAB_URI: "evil.invalid" }, platform: "darwin", now: () => new Date("2026-09-23T00:00:00.000Z"),
    runCommand: async (request) => { environments.push(request.env ?? {}); return { exitCode: 1, stdout: "", stderr: "", timedOut: false }; },
  }, "gitlab-int.switch.ch");
  for (const env of environments) expect(env).not.toHaveProperty("GITLAB_API_HOST");
  for (const env of environments) expect(env).not.toHaveProperty("GLAB_HOST");
  for (const env of environments) expect(env).not.toHaveProperty("GITLAB_HOST");
  for (const env of environments) expect(env).not.toHaveProperty("GITLAB_URI");
});

test("malformed GitLab node ids refuse before transport", async () => {
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport: async () => { throw new Error("must not run"); } });
  expect(store.readNode({ id: "12" })).rejects.toThrow(WorkGraphError);
});

test("glab transport marks a piped body as JSON", () => {
  // Without the header GitLab GraphQL reads the piped body as an empty document (live glab 1.80.4).
  const request: GitLabApiRequest = { method: "POST", path: "graphql", body: { query: "query{currentUser{username}}" } };
  expect(glabApiArgs(request, "gitlab-int.switch.ch")).toEqual(["api", "graphql", "--hostname", "gitlab-int.switch.ch", "--method", "POST", "--input", "-", "--header", "Content-Type: application/json"]);
});

function expectBalancedGraphQL(name: string, text: string): void {
  let braces = 0; let parens = 0;
  for (const char of text) {
    braces += char === "{" ? 1 : char === "}" ? -1 : 0;
    parens += char === "(" ? 1 : char === ")" ? -1 : 0;
    expect({ name, braces: Math.min(braces, 0), parens: Math.min(parens, 0) }).toEqual({ name, braces: 0, parens: 0 });
  }
  expect({ name, braces, parens }).toEqual({ name, braces: 0, parens: 0 });
}

test("the GitLab store's GraphQL literals and field selections are balanced in source", async () => {
  // Fake transports never parse a query, so an unbalanced document only fails against a live server.
  const source = await Bun.file(new URL("../src/work-graph-gitlab.ts", import.meta.url)).text();
  const documents = [
    ...[...source.matchAll(/const (\w+_FIELDS) = `([^`]*)`/gu)].map((match) => ({ name: match[1]!, text: match[2]! })),
    ...[...source.matchAll(/`((?:query|mutation)[({][^`]*)`/gu)].map((match) => ({ name: match[1]!.slice(0, 40), text: match[1]! })),
  ];
  expect(documents.length).toBeGreaterThan(5);
  for (const { name, text } of documents) expectBalancedGraphQL(name, text);
});

test("GitLab splits a wide subtree read into batches under the query complexity cap", async () => {
  // Live GitLab refuses one document aliasing a whole map level ("Query has complexity of 296, which exceeds max complexity of 250" at 8 items).
  const iids = Array.from({ length: 13 }, (_, index) => String(index + 2));
  const empty = [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }];
  const root = { id: "gid://gitlab/WorkItem/1", iid: "1", workItemType: "Epic", namespace: { fullPath: "saca" }, title: "root", description: "", state: "OPEN", author: { username: "jc" }, widgets: [...empty, { type: "HIERARCHY", children: { nodes: iids.map((iid) => ({ iid, namespace: { fullPath: "saca/p" }, workItemType: { name: "Issue" } })) } }] };
  const child = (iid: string) => ({ id: `gid://gitlab/WorkItem/${iid}`, iid, workItemType: "Issue", namespace: { fullPath: "saca/p" }, title: `child ${iid}`, description: "", state: "OPEN", author: { username: "jc" }, widgets: [...empty, { type: "HIERARCHY", children: { nodes: [] } }] });
  const calls: GitLabApiRequest[] = [];
  let inFlight = 0; let peak = 0;
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async (request) => {
    calls.push(request);
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    if (calls.length === 1) return { data: { namespace: { workItem: root } } };
    const variables = request.body?.variables as Record<string, string>;
    if ("iid" in variables) return { data: { namespace: { workItem: child(variables.iid!) } } };
    return { data: Object.fromEntries(Object.keys(variables).filter((key) => key.startsWith("iid")).map((key) => [`item${key.slice(3)}`, { workItem: child(variables[key]!) }])) };
  } });
  expect((await store.readSubtree({ id: "saca&1" })).map((state) => state.ref.id)).toEqual(iids.map((iid) => `saca/p#${iid}`));
  const batches = calls.slice(1).map((call) => Object.keys(call.body?.variables as object).filter((key) => key.startsWith("iid")).length);
  expect(batches).toEqual([6, 6, 1]);
  // The level's batches share the concurrency bound rather than queueing one after another.
  expect(peak).toBe(3);
  // The source scan cannot see the aliased selections assembled at runtime; check what was actually sent.
  for (const [index, call] of calls.entries()) expectBalancedGraphQL(`request ${index}`, String(call.body?.query));
});

test("GitLab refuses an issue note whose global id carries no REST note id", async () => {
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async () => ({ data: { namespace: { workItem: { widgets: [{ type: "NOTES", notes: { nodes: [{ id: "gid://gitlab/WorkItem/2", system: false, body: "human", author: { username: "jc" } }], pageInfo: { hasNextPage: false } } }] } } } }) });
  await expect(store.listComments(REF)).rejects.toThrow(/is not a note global id/u);
});
