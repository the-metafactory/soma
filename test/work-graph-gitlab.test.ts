import { expect, test } from "bun:test";
import {
  WorkGraphError,
  checkGitLabConfinement,
  createGitLabGraphStore,
  glabApiArgs,
  parseGlabApiOutput,
  type GitLabApiRequest,
} from "../src/index";
import { parseNodeSpec } from "../src/work-graph";

const REF = { id: "saca/secacademy#12" };

test("glab transport pins the host and flattens paginated output", () => {
  const request: GitLabApiRequest = { method: "GET", path: "projects/x/issues/1/notes", paginate: true };
  expect(glabApiArgs(request, "gitlab-int.switch.ch")).toEqual(["api", request.path, "--hostname", "gitlab-int.switch.ch", "--method", "GET", "--paginate", "--slurp"]);
  expect(parseGlabApiOutput("[[{\"id\":1}],[{\"id\":2}]]", request)).toEqual([{ id: 1 }, { id: 2 }]);
});

test("GitLab system notes are excluded and thumb tones normalize at the store boundary", async () => {
  const transport = async (request: GitLabApiRequest): Promise<unknown> => {
    if (request.path.endsWith("/notes?sort=asc&per_page=100")) return [
      { id: 1, system: true, body: "mentioned in commit", author: { username: "ivy" } },
      { id: 2, system: false, body: "human", author: { username: "jc" } },
    ];
    if (request.path.endsWith("/notes/2/award_emoji")) return [{ id: 3, name: "thumbsup_tone3", user: { username: "jc" } }, { id: 4, name: "thumbsdown", user: { username: "ada" } }];
    throw new Error(`unexpected ${request.method} ${request.path}`);
  };
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport });
  expect(await store.listComments(REF)).toEqual([{ id: "2", author: "jc", body: "human" }]);
  expect((await store.readCommentReactions({ id: "2", nodeId: REF.id, author: "jc" })).map((reaction) => reaction.content)).toEqual(["+1", "-1"]);
});

test("GitLab exposes Issue as its only Task-parent capability", () => {
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async () => ({}) });
  expect(store.allowedParentTypes).toEqual(["Issue"]);
});

test("GitLab creates an Issue in an Epic root's declared home project", async () => {
  const calls: GitLabApiRequest[] = [];
  const epic = { id: "gid://gitlab/WorkItem/1", iid: "1", workItemType: "Epic", namespace: { fullPath: "saca" }, title: "map", description: `<!-- soma:work-graph-node\n{"autonomy":"approve","home":"saca/secacademy"}\n-->`, state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const transport = async (request: GitLabApiRequest): Promise<unknown> => {
    calls.push(request);
    if (calls.length === 1) return { data: { namespace: { workItem: epic } } };
    return { data: { workItemCreate: { workItem: { iid: "2", workItemType: "Issue", namespace: { fullPath: "saca/secacademy" } }, errors: [] } } };
  };
  const ref = await createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport }).createNode(parseNodeSpec({ title: "route", autonomy: "approve", checkpointId: "cp", parent: { id: "saca&1" } }));
  expect(ref).toEqual({ id: "saca/secacademy#2" });
  const input = (calls[1]?.body?.variables as { input: Record<string, unknown> }).input;
  expect(input).toMatchObject({ projectPath: "saca/secacademy", workItemTypeId: "gid://gitlab/WorkItems::Type/1", hierarchyWidget: { parentId: "gid://gitlab/WorkItem/1" } });
});

test("close writes the receipt note before one description-and-state PUT", async () => {
  const calls: string[] = [];
  const item = { id: "gid://gitlab/WorkItem/12", iid: "12", namespace: { fullPath: "saca/secacademy" }, title: "task", description: "body", state: "OPEN", author: { username: "jc" }, widgets: [{ type: "ASSIGNEES", assignees: { nodes: [] } }, { type: "HIERARCHY", children: { nodes: [] } }, { type: "LINKED_ITEMS", linkedItems: { nodes: [] } }] };
  const transport = async (request: GitLabApiRequest): Promise<unknown> => {
    calls.push(`${request.method} ${request.path}`);
    if (request.path === "graphql") return { data: { namespace: { workItem: item } } };
    if (request.method === "POST") return { id: 9, author: { username: "ivy" } };
    if (request.method === "GET") return { description: "body" };
    if (request.method === "PUT") return {};
    throw new Error("unexpected request");
  };
  await createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport }).close(REF, { checkpointId: "cp", autonomy: "propose", closedBy: "ivy", at: "2026-09-23T00:00:00.000Z", evidence: [], probeResults: [], attestation: "unverified" });
  expect(calls.slice(-3)).toEqual(["POST projects/saca%2Fsecacademy/issues/12/notes", "GET projects/saca%2Fsecacademy/issues/12", "PUT projects/saca%2Fsecacademy/issues/12"]);
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
  await createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport }).close({ id: "saca&1" }, { checkpointId: "cp", autonomy: "approve", closedBy: "ivy", at: "2026-09-24T00:00:00.000Z", evidence: [], probeResults: [], attestation: "unverified" });
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

test("malformed GitLab node ids refuse before transport", async () => {
  const store = createGitLabGraphStore({ host: "gitlab-int.switch.ch", transport: async () => { throw new Error("must not run"); } });
  expect(store.readNode({ id: "12" })).rejects.toThrow(WorkGraphError);
});
