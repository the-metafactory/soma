import { expect, test } from "bun:test";
import {
  WorkGraphError,
  WorkGraph,
  checkGitLabConfinement,
  createGitLabGraphStore,
  type GitLabApiRequest,
} from "../src/index";
import { glabApiArgs, parseGitLabCreateData, parseGlabApiOutput } from "../src/work-graph-gitlab";
import { parseNodeSpec } from "../src/work-graph";

const REF = { id: "saca/secacademy#12" };
const REPO = "saca/secacademy";

test("glab transport pins the host and flattens paginated output", () => {
  const request: GitLabApiRequest = { method: "GET", path: "projects/x/issues/1/notes", paginate: true };
  expect(glabApiArgs(request, "gitlab-int.switch.ch")).toEqual(["api", request.path, "--hostname", "gitlab-int.switch.ch", "--method", "GET", "--paginate", "--slurp"]);
  expect(parseGlabApiOutput("[[{\"id\":1}],[{\"id\":2}]]", request)).toEqual([{ id: 1 }, { id: 2 }]);
});

test("GitLab system notes are excluded and thumb tones normalize at the store boundary", async () => {
  const transport = async (request: GitLabApiRequest): Promise<unknown> => {
    if (request.path === "graphql") return { data: { namespace: { workItem: { widgets: [{ type: "NOTES", notes: { nodes: [
      { id: "gid://gitlab/Note/1", databaseId: 1, system: true, body: "mentioned in commit", author: { username: "ivy" } },
      { id: "gid://gitlab/Note/2", databaseId: 2, system: false, body: "human", author: { username: "jc" } },
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
  expect((calls.find((call) => String(call.body?.query).includes("workItemCreate"))?.body?.variables as { input: Record<string, unknown> }).input).toMatchObject({ linkedItemsWidget: { linkType: "RELATES_TO", workItemsIds: [task.id] } });
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
  await expect(store.createNode(parseNodeSpec({ title: "map", autonomy: "approve", checkpointId: "cp", storeData: { homeProject: "saca/" } }, parseGitLabCreateData))).rejects.toThrow(/both a group and project/u);
});

test("GitLab root creation cannot route outside the selected repository", async () => {
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch",  transport: async () => { throw new Error("must not call GitLab"); } });
  await expect(store.createNode(parseNodeSpec({ title: "map", autonomy: "approve", checkpointId: "cp", storeData: { homeProject: "other/project", scopeProject: REPO } }, parseGitLabCreateData))).rejects.toThrow(/must match the selected repository/u);
});

test("GitLab preserves an Epic blocker id", async () => {
  const item = { id: "gid://gitlab/WorkItem/12", iid: "12", workItemType: "Issue", namespace: { fullPath: "saca/secacademy" }, title: "task", description: "", state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [{ linkType: "IS_BLOCKED_BY", workItem: { iid: "1", namespace: { fullPath: "saca" }, state: "OPEN", workItemType: { name: "Epic" } } }] } }] };
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
