/** GitLab implementation of the work-graph I/O seam (#693). */
import {
  WorkGraphError,
  hashGatedNodeFields,
  parseNodeSpec,
  renderCloseReceipt,
  resolveClaimRace,
  toNode,
  type AttestationCapability,
  type BlockingRef,
  type ClaimResult,
  type CloseReceipt,
  type CommentRef,
  type ConfinementProbeRecord,
  type ConfinementResult,
  type CreateNodeSpec,
  type GraphStore,
  type NodeComment,
  type NodeRef,
  type NodeState,
  type NodeStatus,
  type Reaction,
  type RehomeSelection,
  type ReleaseResult,
  type StoreCreationData,
  type WorkGraphNode,
} from "./work-graph";
import { envWithoutTokens, type ConfinementDeps } from "./work-graph-attestation";
import { decodeNodeBlock, encodeNodeBlock } from "./work-graph-node-block";
import { runCommand } from "./work-graph-probes";
import { parseLocatedNodeId, validateRepoRef } from "./work-graph-ref";

// A ref-provided host must be the only route that glab can use. Strip both
// process-wide credentials and host overrides that could route to another host.
const TOKEN_KEYS = ["GITLAB_TOKEN", "GLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "CI_JOB_TOKEN", "GITLAB_API_HOST", "GLAB_HOST", "GITLAB_HOST", "GITLAB_URI"] as const;
const GLAB_ENV_KEYS = new Set(["PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "GLAB_CONFIG_DIR"]);

export interface GitLabApiRequest {
  method: "GET" | "POST" | "PUT";
  /** `graphql` or a GitLab v4 path without `/api/v4/`. */
  path: string;
  body?: Record<string, unknown>;
  paginate?: boolean;
}
export type GitLabApiTransport = (request: GitLabApiRequest) => Promise<unknown>;
export interface GlabCliTransportOptions { binary?: string; cwd?: string; hostname: string; }

export function glabApiArgs(request: GitLabApiRequest, hostname: string): string[] {
  const args = ["api", request.path, "--hostname", hostname, "--method", request.method];
  if (request.paginate) args.push("--paginate", "--slurp");
  // glab sends a piped body without a JSON content type, which GitLab GraphQL reads as an empty document.
  if (request.body !== undefined) args.push("--input", "-", "--header", "Content-Type: application/json");
  return args;
}
export function parseGlabApiOutput(stdout: string, request: GitLabApiRequest): unknown {
  const text = stdout.trim();
  if (text === "") return null;
  try {
    const value: unknown = JSON.parse(text);
    return request.paginate && Array.isArray(value) && value.every(Array.isArray) ? value.flat() : value;
  } catch { throw new WorkGraphError("backend", `glab api ${request.method} ${request.path} returned unparseable JSON`); }
}
/** The transport forwards only glab's non-secret runtime and config locations. */
export function gitLabCliEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> { return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && GLAB_ENV_KEYS.has(key))) as Record<string, string>; }
export function createGlabCliTransport(options: GlabCliTransportOptions): GitLabApiTransport {
  const binary = options.binary ?? "glab";
  return async (request) => {
    const proc = Bun.spawn([binary, ...glabApiArgs(request, options.hostname)], {
      stdin: request.body === undefined ? "ignore" : new TextEncoder().encode(JSON.stringify(request.body)),
      stdout: "pipe", stderr: "pipe", ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      // The ref supplies the host. Keep glab's configured credential lookup,
      // but never forward a process-wide token to an arbitrary GitLab host.
      env: gitLabCliEnvironment(process.env),
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) throw new WorkGraphError("backend", `glab api ${request.method} ${request.path} failed (exit ${exitCode}): ${stderr.trim()}`);
    return parseGlabApiOutput(stdout, request);
  };
}

export interface GitLabGraphStoreOptions { host: string; transport?: GitLabApiTransport; confinement?: ConfinementDeps; }
export interface GitLabCreateData extends StoreCreationData { readonly capability: "gitlab"; readonly homeProject?: string; readonly scopeProject?: string; }
interface Parts { path: string; iid: number; sigil: "#" | "&"; }
interface Item { id: string; iid: number; path: string; type: string; title: string; rawDescription: string; nodeBlock: ReturnType<typeof decodeNodeBlock>; nodeBlockData?: Record<string, unknown>; nodeBlockError?: string; status: NodeStatus; author: string; assignees: string[]; homeProject?: string; parent?: NodeRef; blockers: BlockingRef[]; children: NodeRef[]; childrenTruncated: boolean; linksTruncated: boolean; }
const GITLAB_ITEM = Symbol("gitlab-item");
const GITLAB_REHOME = Symbol("gitlab-rehome");
type HydratedNodeState = NodeState & { [GITLAB_ITEM]?: Item };
interface GitLabRehomeContext { readonly [GITLAB_REHOME]: true; readonly parent: Item; readonly related: Item; }
// GitLab 19.4 has no Note.databaseId; the REST note id is the numeric tail of the global id.
function noteDatabaseId(globalId: string): string { const match = /^gid:\/\/gitlab\/(?:Discussion)?Note\/([1-9]\d*)$/u.exec(globalId); if (match === null) throw new WorkGraphError("backend", `GitLab note id ${JSON.stringify(globalId)} is not a note global id`); return match[1]!; }
const THUMBS_UP = /^thumbsup(?:_tone[1-5])?$/u;
const THUMBS_DOWN = /^thumbsdown(?:_tone[1-5])?$/u;

function rec(value: unknown, context: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorkGraphError("backend", `${context}: expected object`); return value as Record<string, unknown>; }
function arr(value: unknown, context: string): unknown[] { if (!Array.isArray(value)) throw new WorkGraphError("backend", `${context}: expected array`); return value; }
function str(record: Record<string, unknown>, key: string, context: string): string { const value = record[key]; if (typeof value !== "string" || value.length === 0) throw new WorkGraphError("backend", `${context}: missing ${key}`); return value; }
function num(record: Record<string, unknown>, key: string, context: string): number { const value = record[key]; if (typeof value !== "number" || !Number.isInteger(value)) throw new WorkGraphError("backend", `${context}: missing ${key}`); return value; }
function username(value: unknown): string { return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).username === "string" ? (value as Record<string, unknown>).username as string : ""; }
function parts(ref: NodeRef): Parts { const parsed = parseLocatedNodeId(ref.id); if (parsed === undefined || parsed.path === "") throw new WorkGraphError("backend", `GitLab node id ${JSON.stringify(ref.id)} must be <path>#<iid> or <group>&<iid>`); return parsed; }
function projectPath(path: string): string { return encodeURIComponent(path); }
function restIssue(parts: Parts): string { if (parts.sigil !== "#") throw new WorkGraphError("backend", "GitLab epic has no project issue REST endpoint"); return `projects/${projectPath(parts.path)}/issues/${parts.iid}`; }
function issueCommentId(ref: CommentRef): string { if (!/^[1-9]\d*$/u.test(ref.id)) throw new WorkGraphError("invalid-node", `GitLab issue comment id ${JSON.stringify(ref.id)} must be a positive decimal integer`); return ref.id; }
function gqlValue(value: unknown, field: string): unknown { const root = rec(value, "GraphQL response"); const data = rec(root.data, "GraphQL response data"); const result = data[field]; if (result === undefined || result === null) throw new WorkGraphError("backend", `GraphQL response has no ${field}`); return result; }
function nodeId(path: string, iid: number, sigil: "#" | "&" = "#"): NodeRef { return { id: `${path}${sigil}${iid}` }; }
function typeName(value: unknown): string { return typeof value === "string" ? value : value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).name === "string" ? (value as Record<string, unknown>).name as string : ""; }
function typeEnum(name: "Epic" | "Issue" | "Task"): "EPIC" | "ISSUE" | "TASK" { return name.toUpperCase() as "EPIC" | "ISSUE" | "TASK"; }
const GITLAB_ROUTE_OPEN = "<!-- soma:gitlab-work-graph-route\n";
function decodeGitLabRoute(description: string): { text: string; homeProject?: string } { const start = description.lastIndexOf(GITLAB_ROUTE_OPEN); if (start === -1) return { text: description }; const end = description.indexOf("-->", start); if (end === -1) return { text: description }; try { const value = rec(JSON.parse(description.slice(start + GITLAB_ROUTE_OPEN.length, end).trim()) as unknown, "GitLab route metadata"); const homeProject = typeof value.homeProject === "string" && value.homeProject.length > 0 ? value.homeProject : undefined; return { text: `${description.slice(0, start)}${description.slice(end + 3)}`.trim(), ...(homeProject === undefined ? {} : { homeProject }) }; } catch { return { text: description }; } }
function encodeGitLabRoute(homeProject: string): string { return `${GITLAB_ROUTE_OPEN}${JSON.stringify({ homeProject })}\n-->`; }
export function parseGitLabCreateData(value: unknown): GitLabCreateData {
  const data = rec(value, "node spec: GitLab creation data");
  if (data.homeProject !== undefined && (typeof data.homeProject !== "string" || data.homeProject.trim().length === 0)) throw new WorkGraphError("invalid-node", "node spec: GitLab homeProject must be a non-empty string");
  if (data.scopeProject !== undefined && (typeof data.scopeProject !== "string" || data.scopeProject.trim().length === 0)) throw new WorkGraphError("invalid-node", "node spec: GitLab scopeProject must be a non-empty string");
  return { capability: "gitlab", ...(typeof data.homeProject === "string" ? { homeProject: data.homeProject.trim() } : {}), ...(typeof data.scopeProject === "string" ? { scopeProject: data.scopeProject.trim() } : {}) };
}
function createHomeProject(spec: CreateNodeSpec<GitLabCreateData>): string | undefined { return spec.storeData?.homeProject; }
function validHomeProject(host: string, path: string, epicGroup?: string): string {
  let home: string;
  try { home = validateRepoRef({ forge: "gitlab", host, path }).path; }
  catch { throw new WorkGraphError("invalid-node", `GitLab home project ${JSON.stringify(path)} has an invalid path`); }
  const segments = home.split("/");
  if (segments.length < 2) throw new WorkGraphError("invalid-node", "GitLab homeProject must name both a group and project");
  if (epicGroup !== undefined) {
    const group = epicGroup.split("/");
    if (segments.length <= group.length || group.some((segment, index) => segments[index] !== segment)) throw new WorkGraphError("invalid-node", `GitLab home ${home} is outside Epic group ${epicGroup}`);
  }
  return home;
}
function limitConcurrency(limit: number): <T>(fn: () => Promise<T>) => Promise<T> { let active = 0; const waiting: (() => void)[] = []; return async <T>(fn: () => Promise<T>): Promise<T> => { if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve)); active += 1; try { return await fn(); } finally { active -= 1; waiting.shift()?.(); } }; }
function mutation(response: unknown, field: string): Record<string, unknown> {
  const result = rec(gqlValue(response, field), field);
  const errors = result.errors;
  if (Array.isArray(errors) && errors.some((error) => typeof error === "string" && error.length > 0)) throw new WorkGraphError("backend", `${field}: ${errors.join("; ")}`);
  return result;
}

function widget(widgets: readonly Record<string, unknown>[], type: string): Record<string, unknown> { return widgets.find((entry) => entry.type === type) ?? {}; }
function parseAssignees(widgets: readonly Record<string, unknown>[]): string[] {
  const assignees = widget(widgets, "ASSIGNEES").assignees;
  return assignees && typeof assignees === "object" && Array.isArray((assignees as Record<string, unknown>).nodes)
    ? (assignees as { nodes: unknown[] }).nodes.map(username).filter(Boolean) : [];
}
function parseHierarchy(widgets: readonly Record<string, unknown>[], context: string): Pick<Item, "parent" | "children" | "childrenTruncated"> {
  const hierarchy = widget(widgets, "HIERARCHY");
  const parentRecord = hierarchy.parent && typeof hierarchy.parent === "object" ? hierarchy.parent as Record<string, unknown> : undefined;
  const parentNamespace = parentRecord?.namespace && typeof parentRecord.namespace === "object" ? parentRecord.namespace as Record<string, unknown> : undefined;
  const parentIid = parentRecord?.iid;
  const parent = parentRecord !== undefined && typeof parentNamespace?.fullPath === "string" && (typeof parentIid === "number" || typeof parentIid === "string" && /^\d+$/u.test(parentIid))
    ? nodeId(parentNamespace.fullPath, Number(parentIid), typeName(parentRecord.workItemType) === "Epic" ? "&" : "#") : undefined;
  const children = hierarchy.children && typeof hierarchy.children === "object" ? hierarchy.children as Record<string, unknown> : undefined;
  const childNodes = Array.isArray(children?.nodes)
    ? (children as { nodes: unknown[] }).nodes.flatMap((child) => { const record = rec(child, `${context} child`); const namespace = record.namespace && typeof record.namespace === "object" ? record.namespace as Record<string, unknown> : {}; return typeof record.iid === "string" && typeof namespace.fullPath === "string" ? [nodeId(namespace.fullPath, Number(record.iid), typeName(record.workItemType) === "Epic" ? "&" : "#")] : []; }) : [];
  const childrenTruncated = children?.pageInfo !== undefined && rec(children.pageInfo, `${context} child page`).hasNextPage === true;
  return { ...(parent === undefined ? {} : { parent }), children: childNodes, childrenTruncated };
}
function parseLinkedItems(widgets: readonly Record<string, unknown>[], context: string): Pick<Item, "blockers" | "linksTruncated"> {
  const linkedItems = widget(widgets, "LINKED_ITEMS").linkedItems;
  const links = linkedItems && typeof linkedItems === "object" ? linkedItems as Record<string, unknown> : undefined;
  const blockers = Array.isArray(links?.nodes)
    ? (links as { nodes: unknown[] }).nodes.flatMap((entry) => { const record = rec(entry, `${context} link`); const linked = record.workItem && typeof record.workItem === "object" ? record.workItem as Record<string, unknown> : {}; const namespace = linked.namespace && typeof linked.namespace === "object" ? linked.namespace as Record<string, unknown> : {}; return typeof record.linkType === "string" && record.linkType.toUpperCase() === "IS_BLOCKED_BY" && typeof linked.iid === "string" && typeof namespace.fullPath === "string" ? [{ id: nodeId(namespace.fullPath, Number(linked.iid), typeName(linked.workItemType) === "Epic" ? "&" : "#").id, status: linked.state === "CLOSED" ? "closed" as const : "open" as const }] : []; }) : [];
  const linksTruncated = links?.pageInfo !== undefined && rec(links.pageInfo, `${context} linked page`).hasNextPage === true;
  return { blockers, linksTruncated };
}

function itemFrom(value: unknown, context: string, fallbackPath: string): Item {
  const item = rec(value, context);
  const rawIid = item.iid; const iid = typeof rawIid === "number" ? rawIid : typeof rawIid === "string" && /^\d+$/u.test(rawIid) ? Number(rawIid) : num(item, "iid", context); const title = typeof item.title === "string" ? item.title : "";
  const rawDescription = typeof item.description === "string" ? item.description : ""; const route = decodeGitLabRoute(rawDescription); const description = route.text;
  const block = decodeNodeBlock(description);
  let boundHome: string | undefined;
  let nodeBlockData: Record<string, unknown> | undefined;
  let nodeBlockError: string | undefined;
  if (block.raw !== undefined) {
    try {
      nodeBlockData = rec(JSON.parse(block.raw) as unknown, "node block");
      if ("home" in nodeBlockData) {
        if (typeof nodeBlockData.home !== "string" || nodeBlockData.home.trim().length === 0) throw new WorkGraphError("invalid-node", "node block: home must be a non-empty string");
        boundHome = nodeBlockData.home;
      }
    } catch (error) { nodeBlockError = error instanceof Error ? error.message : String(error); }
  }
  const namespace = item.namespace && typeof item.namespace === "object" ? item.namespace as Record<string, unknown> : {};
  const path = typeof namespace.fullPath === "string" ? namespace.fullPath : fallbackPath;
  const widgets = Array.isArray(item.widgets) ? item.widgets.map((entry) => rec(entry, `${context} widget`)) : [];
  const hierarchy = parseHierarchy(widgets, context);
  const linkedItems = parseLinkedItems(widgets, context);
  if (boundHome !== undefined && route.homeProject !== undefined && boundHome !== route.homeProject) throw new WorkGraphError("invalid-node", `GitLab Epic ${path}&${iid} has conflicting typed and route home bindings`);
  return { id: str(item, "id", context), iid, path, type: typeName(item.workItemType), title, rawDescription, nodeBlock: block, ...(nodeBlockData === undefined ? {} : { nodeBlockData }), ...(nodeBlockError === undefined ? {} : { nodeBlockError }), status: item.state === "CLOSED" ? "closed" : "open", author: username(item.author), assignees: parseAssignees(widgets), ...((boundHome ?? route.homeProject) === undefined ? {} : { homeProject: boundHome ?? route.homeProject }), ...hierarchy, ...linkedItems };
}
function withPersistedCompletion(node: WorkGraphNode, value: unknown): WorkGraphNode {
  const completion = rec(value, "node completion"); const fields = ["receiptCommentId", "checkpointId", "closer", "closedAt", "gatedNodeHash"] as const;
  if (fields.some((field) => typeof completion[field] !== "string") || !["auto", "propose", "approve"].includes(String(completion.autonomy))) throw new WorkGraphError("invalid-node", "invalid persisted completion binding");
  const autoProbeKeys = completion.autoProbeKeys; if (autoProbeKeys !== undefined && (!Array.isArray(autoProbeKeys) || autoProbeKeys.some((key) => typeof key !== "string"))) throw new WorkGraphError("invalid-node", "invalid persisted completion probe keys");
  const ciCheckRunId = completion.ciCheckRunId; const ciHeadSha = completion.ciHeadSha; if ((ciCheckRunId === undefined) !== (ciHeadSha === undefined) || (ciCheckRunId !== undefined && typeof ciCheckRunId !== "string") || (ciHeadSha !== undefined && typeof ciHeadSha !== "string")) throw new WorkGraphError("invalid-node", "invalid persisted completion CI binding");
  return { ...node, completion: { receiptCommentId: completion.receiptCommentId as string, checkpointId: completion.checkpointId as string, autonomy: completion.autonomy as WorkGraphNode["autonomy"], closer: completion.closer as string, closedAt: completion.closedAt as string, gatedNodeHash: completion.gatedNodeHash as string, ...(autoProbeKeys === undefined ? {} : { autoProbeKeys: autoProbeKeys as string[] }), ...(ciCheckRunId === undefined ? {} : { ciCheckRunId: ciCheckRunId as string, ciHeadSha: ciHeadSha as string }) } };
}

function typedNodeFrom(item: Item, ref: NodeRef): { node: WorkGraphNode; typed: boolean } {
  if (item.nodeBlockError !== undefined) throw new WorkGraphError("invalid-node", item.nodeBlockError);
  const raw = item.nodeBlockData;
  if (raw === undefined) return { node: { id: ref.id, title: item.title, autonomy: "approve" }, typed: false };
  const fields = { ...raw };
  const completion = fields.completion;
  delete fields.completion;
  delete fields.home;
  const parsed = toNode(ref.id, parseNodeSpec({ ...fields, title: item.title }));
  return { node: completion === undefined ? parsed : withPersistedCompletion(parsed, completion), typed: true };
}

function stateFrom(item: Item): NodeState {
  const decoded = item.nodeBlock;
  const ref = nodeId(item.path, item.iid, item.type === "Epic" ? "&" : "#");
  try {
    const { node, typed } = typedNodeFrom(item, ref);
    return { ref, node, ...(item.type === "Epic" && item.homeProject !== undefined ? { storeFields: { home: item.homeProject } } : {}), typed, status: item.status, author: item.author, assignees: item.assignees, body: decoded.text, blockedBy: item.blockers, trackerType: item.type, ...(item.parent === undefined ? {} : { parent: item.parent }) };
  } catch (error) {
    return { ref, node: { id: ref.id, title: item.title, autonomy: "approve" }, typed: false, parseError: error instanceof Error ? error.message : String(error), status: item.status, author: item.author, assignees: item.assignees, body: decoded.text, blockedBy: item.blockers, trackerType: item.type, ...(item.parent === undefined ? {} : { parent: item.parent }) };
  }
}

const ITEM_FIELDS = `id iid title description state workItemType{name} namespace{fullPath} author{username} widgets{type ... on WorkItemWidgetAssignees{assignees{nodes{username}}} ... on WorkItemWidgetHierarchy{parent{iid namespace{fullPath} workItemType{name}}} ... on WorkItemWidgetLinkedItems{linkedItems(first:100){nodes{linkType workItem{iid namespace{fullPath} state workItemType{name}}} pageInfo{hasNextPage}}}}`;
const SUBTREE_ITEM_FIELDS = `id iid title description state workItemType{name} namespace{fullPath} author{username} widgets{type ... on WorkItemWidgetAssignees{assignees{nodes{username}}} ... on WorkItemWidgetHierarchy{parent{iid namespace{fullPath} workItemType{name}} children(first:100){nodes{iid namespace{fullPath} workItemType{name}} pageInfo{hasNextPage}}} ... on WorkItemWidgetLinkedItems{linkedItems(first:100){nodes{linkType workItem{iid namespace{fullPath} state workItemType{name}}} pageInfo{hasNextPage}}}}`;
const ITEM_QUERY = `query($fullPath:ID!,$iid:String!){namespace(fullPath:$fullPath){workItem(iid:$iid){${ITEM_FIELDS}}}}`;
const SUBTREE_ITEM_QUERY = `query($fullPath:ID!,$iid:String!){namespace(fullPath:$fullPath){workItem(iid:$iid){${SUBTREE_ITEM_FIELDS}}}}`;
function defaultConfinement(): ConfinementDeps { return { runCommand, env: process.env, platform: process.platform, now: () => new Date() }; }

export async function checkGitLabConfinement(deps: ConfinementDeps, host: string): Promise<ConfinementResult> {
  const env = envWithoutTokens(deps.env, TOKEN_KEYS); const at = deps.now().toISOString(); const probes: ConfinementProbeRecord[] = []; const reachable = new Set<string>();
  const config = deps.platform === "darwin" ? `${env.HOME}/Library/Application Support/glab-cli/config.yml` : `${env.XDG_CONFIG_HOME || `${env.HOME}/.config`}/glab-cli/config.yml`;
  const [status, token, readable, user, tokenInfo] = await Promise.all([
    deps.runCommand({ argv: ["glab", "auth", "status", "--hostname", host], timeoutSec: 30, env }),
    deps.runCommand({ argv: ["glab", "config", "get", "token", "--host", host], timeoutSec: 30, env }),
    deps.runCommand({ argv: ["test", "-r", config], timeoutSec: 30, env }),
    deps.runCommand({ argv: ["glab", "api", "user", "--hostname", host], timeoutSec: 30, env }),
    deps.runCommand({ argv: ["glab", "api", "personal_access_tokens/self", "--hostname", host], timeoutSec: 30, env }),
  ]);
  const statusOutput = `${status.stdout}\n${status.stderr}`; const logins = [...statusOutput.matchAll(/\bas\s+([A-Za-z0-9][A-Za-z0-9._-]*)/gu)].map((match) => match[1]); logins.forEach((login) => reachable.add(login)); probes.push({ name: `glab auth status --hostname ${host} (token env stripped)`, observed: `exit ${status.exitCode}; identities: ${logins.join(", ") || "none"}` });
  if (token.exitCode === 0 && token.stdout.trim() !== "" && logins.length === 0) reachable.add("unidentified-credential"); probes.push({ name: `glab config get token --host ${host} (token env stripped)`, observed: token.exitCode === 0 && token.stdout.trim() !== "" ? "printed a credential" : `refused (exit ${token.exitCode})` });
  if (readable.exitCode === 0) reachable.add("file:glab-cli/config.yml"); probes.push({ name: "glab-cli config.yml readable", observed: readable.exitCode === 0 ? "readable" : `refused (exit ${readable.exitCode})` });
  let impersonation = false; try { const admin = (JSON.parse(user.stdout) as { is_admin?: unknown }).is_admin === true; const scopes = (JSON.parse(tokenInfo.stdout) as { scopes?: unknown }).scopes; impersonation = admin && Array.isArray(scopes) && scopes.includes("sudo"); } catch { reachable.add("impersonation:unknown"); }
  if (impersonation) reachable.add("impersonation:any"); probes.push({ name: "GitLab admin + sudo impersonation probe", observed: impersonation ? "admin token has sudo" : user.exitCode === 0 && tokenInfo.exitCode === 0 ? "not admin+sudo" : "unreadable — downgraded" });
  return { checked: true, reachableIdentities: [...reachable].sort(), at, probes };
}

class GitLabGraphStore implements GraphStore<GitLabCreateData> {
  readonly attestation: AttestationCapability = "verifiable";
  readonly parseCreateData = parseGitLabCreateData;
  private readonly host: string; private readonly transport: GitLabApiTransport; private readonly confinement: ConfinementDeps; private readonly workItemTypeIds = new Map<string, Promise<string>>();
  constructor(options: GitLabGraphStoreOptions) { this.host = validateRepoRef({ forge: "gitlab", host: options.host, path: "group" }).host; this.transport = options.transport ?? createGlabCliTransport({ hostname: this.host }); this.confinement = options.confinement ?? defaultConfinement(); }
  async actingIdentity(): Promise<string> { const user = rec(await this.transport({ method: "GET", path: "user" }), "GitLab user"); return str(user, "username", "GitLab user"); }
  async checkConfinement(): Promise<ConfinementResult> { return await checkGitLabConfinement(this.confinement, this.host); }
  private async workItemTypeId(namespacePath: string, name: "Epic" | "Issue" | "Task"): Promise<string> { const key = `${namespacePath}\u0000${name}`; let cached = this.workItemTypeIds.get(key); if (cached === undefined) { cached = (async () => { const response = await this.transport({ method: "POST", path: "graphql", body: { query: `query($fullPath:ID!){namespace(fullPath:$fullPath){workItemTypes(name:${typeEnum(name)}){nodes{id name}}}}`, variables: { fullPath: namespacePath } } }); const namespace = rec(gqlValue(response, "namespace"), "work item type namespace"); const types = rec(namespace.workItemTypes, "work item types"); const found = arr(types.nodes, "work item types").map((value) => rec(value, "work item type")).find((type) => typeName(type) === name); if (found === undefined) throw new WorkGraphError("backend", `GitLab namespace ${namespacePath} has no ${name} work-item type`); return str(found, "id", `${name} work item type`); })(); this.workItemTypeIds.set(key, cached); } return await cached; }
  private async items(refs: readonly NodeRef[], includeChildren = false): Promise<Item[]> { if (refs.length === 0) return []; const parsed = refs.map(parts); const fields = includeChildren ? SUBTREE_ITEM_FIELDS : ITEM_FIELDS; if (refs.length === 1) { const p = parsed[0]!; const response = await this.transport({ method: "POST", path: "graphql", body: { query: includeChildren ? SUBTREE_ITEM_QUERY : ITEM_QUERY, variables: { fullPath: p.path, iid: String(p.iid) } } }); const namespace = rec(gqlValue(response, "namespace"), "work item namespace"); const item = itemFrom(namespace.workItem, `work item ${refs[0]!.id}`, p.path); if (item.linksTruncated) throw new WorkGraphError("backend", `GitLab blockers for ${refs[0]!.id} are paginated; refusing incomplete graph state`); return [item]; }
    const variables: Record<string, string> = {}; const definitions: string[] = []; const selections: string[] = [];
    for (const [index, p] of parsed.entries()) { variables[`path${index}`] = p.path; variables[`iid${index}`] = String(p.iid); definitions.push(`$path${index}:ID!,$iid${index}:String!`); selections.push(`item${index}:namespace(fullPath:$path${index}){workItem(iid:$iid${index}){${fields}}}`); }
    const response = await this.transport({ method: "POST", path: "graphql", body: { query: `query(${definitions.join(",")}){${selections.join("")}}`, variables } });
    return refs.map((ref, index) => { const namespace = rec(gqlValue(response, `item${index}`), "work item namespace"); const item = itemFrom(namespace.workItem, `work item ${ref.id}`, parsed[index]!.path); if (item.linksTruncated) throw new WorkGraphError("backend", `GitLab blockers for ${ref.id} are paginated; refusing incomplete graph state`); return item; }); }
  private async item(ref: NodeRef): Promise<Item> { return (await this.items([ref]))[0]!; }
  async readNode(ref: NodeRef): Promise<NodeState> { const item = await this.item(ref); const state = stateFrom(item) as HydratedNodeState; Object.defineProperty(state, GITLAB_ITEM, { value: item }); return state; }
  async createNode(spec: CreateNodeSpec<GitLabCreateData>, rehome?: RehomeSelection): Promise<NodeRef> {
    if (spec.labels !== undefined && spec.labels.length > 0) throw new WorkGraphError("invalid-node", "GitLab GraphStore does not support labels; use the Epic or node ref");
    if (spec.parent !== undefined && spec.storeData?.homeProject !== undefined) throw new WorkGraphError("invalid-node", "GitLab home belongs on the map root, not a child node");
    const context = rehome?.context;
    const hydrated = rehome !== undefined && typeof context === "object" && context !== null && (context as Partial<GitLabRehomeContext>)[GITLAB_REHOME] === true && rehome.parent.id === spec.parent?.id ? context as GitLabRehomeContext : undefined;
    const parent = spec.parent === undefined ? undefined : hydrated?.parent ?? await this.item(spec.parent);
    const related = hydrated?.related;
    const homeProject = createHomeProject(spec);
    const description = [spec.body ?? "", encodeNodeBlock(spec, spec.parent === undefined && homeProject !== undefined ? { home: homeProject } : {}), ...(spec.parent === undefined && homeProject !== undefined ? [encodeGitLabRoute(homeProject)] : [])].filter(Boolean).join("\n\n");
    let input: Record<string, unknown>;
    if (parent === undefined) {
      if (homeProject === undefined) throw new WorkGraphError("invalid-node", "GitLab graph roots require --home-project <group/project>");
      validHomeProject(this.host, homeProject);
      const separator = homeProject.lastIndexOf("/"); const group = homeProject.slice(0, separator);
      if (spec.storeData?.scopeProject !== undefined && homeProject !== spec.storeData.scopeProject) throw new WorkGraphError("invalid-node", `GitLab homeProject ${homeProject} must match the selected repository ${spec.storeData.scopeProject}`);
      input = { namespacePath: group, workItemTypeId: await this.workItemTypeId(group, "Epic"), title: spec.title, descriptionWidget: { description } };
    } else {
      const type = parent.type === "Epic" ? "Issue" : parent.type === "Issue" ? "Task" : undefined;
      if (type === undefined) throw new WorkGraphError("invalid-node", `GitLab cannot create a child below ${parent.type || "this"} work item`);
      if (parent.type === "Epic" && parent.nodeBlockError !== undefined) throw new WorkGraphError("invalid-node", `GitLab Epic ${spec.parent?.id} has an invalid typed node block: ${parent.nodeBlockError}`);
      const parentHomeProject = parent.type === "Epic" ? parent.homeProject : parent.path;
      if (parentHomeProject === undefined || spec.storeData?.scopeProject !== undefined && parentHomeProject !== spec.storeData.scopeProject) throw new WorkGraphError("invalid-node", `GitLab Epic ${spec.parent?.id} has no valid home project under the selected repository`);
      validHomeProject(this.host, parentHomeProject, parent.type === "Epic" ? parent.path : undefined);
      input = { projectPath: parentHomeProject, workItemTypeId: await this.workItemTypeId(parentHomeProject, type), title: spec.title, descriptionWidget: { description }, hierarchyWidget: { parentId: parent.id }, ...(related === undefined ? {} : { linkedItemsWidget: { linkType: "RELATED", workItemsIds: [related.id] } }) };
    }
    const created = mutation(await this.transport({ method: "POST", path: "graphql", body: { query: `mutation($input:WorkItemCreateInput!){workItemCreate(input:$input){workItem{id iid namespace{fullPath} workItemType{name}} errors}}`, variables: { input } } }), "workItemCreate");
    const item = rec(created.workItem, "created work item"); const namespace = rec(item.namespace, "created work item namespace"); const iid = item.iid;
    return nodeId(str(namespace, "fullPath", "created work item namespace"), typeof iid === "string" ? Number(iid) : num(item, "iid", "created work item"), typeName(item.workItemType) === "Epic" ? "&" : "#");
  }
  private async addLinkedEdge(source: NodeRef, related: NodeRef, linkType: "BLOCKS" | "RELATED"): Promise<void> { const [left, right] = await Promise.all([this.item(source), this.item(related)]); mutation(await this.transport({ method: "POST", path: "graphql", body: { query: `mutation($source:WorkItemID!,$target:WorkItemID!,$linkType:WorkItemRelatedLinkType!){workItemAddLinkedItems(input:{id:$source,workItemsIds:[$target],linkType:$linkType}){errors}}`, variables: { source: left.id, target: right.id, linkType } } }), "workItemAddLinkedItems"); }
  async addBlockingEdge(blocker: NodeRef, blocked: NodeRef): Promise<void> { await this.addLinkedEdge(blocker, blocked, "BLOCKS"); }
  async selectRehomeParent(requested: NodeState): Promise<RehomeSelection | undefined> { if (requested.trackerType !== "Task") return undefined; const related = (requested as HydratedNodeState)[GITLAB_ITEM] ?? await this.item(requested.ref); let parent = requested.parent; while (parent !== undefined) { const candidate = await this.readNode(parent) as HydratedNodeState; if (candidate.trackerType === "Issue") { const parentItem = candidate[GITLAB_ITEM]; if (parentItem === undefined) throw new WorkGraphError("backend", `GitLab re-home parent ${candidate.ref.id} was not hydrated`); return { parent: candidate.ref, context: { [GITLAB_REHOME]: true, parent: parentItem, related } satisfies GitLabRehomeContext }; } parent = candidate.parent; } throw new WorkGraphError("invalid-node", `cannot re-home parent ${requested.ref.id}: no allowed ancestor`); }
  async readSubtree(root: NodeRef): Promise<NodeState[]> { const seen = new Set<string>([root.id]); const records = new Map<string, { item: Item; parent?: NodeRef }>(); const bounded = limitConcurrency(8); let frontier: { ref: NodeRef; parent?: NodeRef }[] = [{ ref: root }]; while (frontier.length > 0) { const current = frontier; frontier = []; const batches = Array.from({ length: Math.ceil(current.length / 50) }, (_, index) => current.slice(index * 50, (index + 1) * 50)); const items = (await Promise.all(batches.map((batch) => bounded(async () => await this.items(batch.map((entry) => entry.ref), true))))).flat(); for (const [index, item] of items.entries()) { const entry = current[index]!; if (item.childrenTruncated) throw new WorkGraphError("backend", `GitLab subtree ${entry.ref.id} is paginated; refusing a partial membership walk`); records.set(entry.ref.id, { item, ...(entry.parent === undefined ? {} : { parent: entry.parent }) }); for (const child of item.children) if (!seen.has(child.id)) { seen.add(child.id); frontier.push({ ref: child, parent: entry.ref }); } } }
    const result: NodeState[] = []; const visit = (ref: NodeRef): void => { const record = records.get(ref.id); if (record === undefined) return; for (const child of record.item.children) { const childRecord = records.get(child.id); if (childRecord?.parent?.id !== ref.id) continue; result.push({ ...stateFrom(childRecord.item), parent: ref }); visit(child); } }; visit(root); return result; }
  private async requireActingIdentity(identity: string): Promise<void> {
    const actingIdentity = await this.actingIdentity();
    if (identity !== actingIdentity) throw new WorkGraphError("invalid-node", `GitLab claim identity ${identity} does not match the authenticated GitLab identity ${actingIdentity}`);
  }
  async claim(ref: NodeRef, identity: string): Promise<ClaimResult> { await this.requireActingIdentity(identity); const before = await this.item(ref); if (before.status === "closed") throw new WorkGraphError("node-closed", `node ${ref.id} is closed — nothing to claim`); await this.updateAssignees(parts(ref), "APPEND", identity); const after = await this.item(ref); const { held, holder } = resolveClaimRace(identity, after.assignees); if (!held && after.assignees.includes(identity)) await this.updateAssignees(parts(ref), "REMOVE", identity); return { held, identity, holder, assignees: held ? after.assignees : after.assignees.filter((name) => name !== identity) }; }
  async release(ref: NodeRef, identity: string): Promise<ReleaseResult> { await this.requireActingIdentity(identity); const before = await this.item(ref); if (before.status === "closed") throw new WorkGraphError("node-closed", `node ${ref.id} is closed — nothing to release`); if (!before.assignees.includes(identity)) return { released: false, identity, assignees: before.assignees }; await this.updateAssignees(parts(ref), "REMOVE", identity); const after = await this.item(ref); return { released: !after.assignees.includes(identity), identity, assignees: after.assignees }; }
  private async updateAssignees(ref: Parts, operation: "APPEND" | "REMOVE", user: string): Promise<void> { if (ref.sigil !== "#") throw new WorkGraphError("backend", "GitLab epic cannot be claimed"); mutation(await this.transport({ method: "POST", path: "graphql", body: { query: `mutation($projectPath:ID!,$iid:String!,$user:String!,$operation:MutationOperationMode!){issueSetAssignees(input:{projectPath:$projectPath,iid:$iid,assigneeUsernames:[$user],operationMode:$operation}){errors}}`, variables: { projectPath: ref.path, iid: String(ref.iid), user, operation } } }), "issueSetAssignees"); }
  private async updateEpic(ref: NodeRef, description: string, close = false, item?: Item): Promise<void> { const target = item ?? await this.item(ref); mutation(await this.transport({ method: "POST", path: "graphql", body: { query: `mutation($input:WorkItemUpdateInput!){workItemUpdate(input:$input){errors}}`, variables: { input: { id: target.id, descriptionWidget: { description }, ...(close ? { stateEvent: "CLOSE" } : {}) } } } }), "workItemUpdate"); }
  async postComment(ref: NodeRef, body: string, item?: Item): Promise<CommentRef> { const p = parts(ref); if (p.sigil === "&") { const target = item ?? await this.item(ref); const result = mutation(await this.transport({ method: "POST", path: "graphql", body: { query: `mutation($noteableId:NoteableID!,$body:String!){createNote(input:{noteableId:$noteableId,body:$body}){note{id author{username} url} errors}}`, variables: { noteableId: target.id, body } } }), "createNote"); const note = rec(result.note, "GitLab note"); return { id: str(note, "id", "GitLab note"), nodeId: ref.id, author: username(note.author), ...(typeof note.url === "string" ? { url: note.url } : {}) }; } const note = rec(await this.transport({ method: "POST", path: `${restIssue(p)}/notes`, body: { body } }), "GitLab note"); return { id: String(num(note, "id", "GitLab note")), nodeId: ref.id, author: username(note.author), ...(typeof note.web_url === "string" ? { url: note.web_url } : {}) }; }
  private async epicNote(ref: CommentRef): Promise<Record<string, unknown>> {
    const p = parts({ id: ref.nodeId });
    const response = await this.transport({ method: "POST", path: "graphql", body: { query: `query($fullPath:ID!,$iid:String!){namespace(fullPath:$fullPath){workItem(iid:$iid){widgets{type ... on WorkItemWidgetNotes{notes(first:100){nodes{id author{username} url awardEmoji{nodes{id name user{username} createdAt}}} pageInfo{hasNextPage}}}}}}}`, variables: { fullPath: p.path, iid: String(p.iid) } } });
    const namespace = rec(gqlValue(response, "namespace"), "GitLab Epic namespace"); const item = rec(namespace.workItem, "GitLab Epic work item"); const widgets = arr(item.widgets, "GitLab Epic widgets").map((value) => rec(value, "GitLab Epic widget")); const notes = widgets.find((widget) => widget.type === "NOTES")?.notes; const page = notes === undefined ? { nodes: [] } : rec(notes, "GitLab Epic notes");
    if (page.pageInfo !== undefined && rec(page.pageInfo, "GitLab Epic note page").hasNextPage === true) throw new WorkGraphError("backend", `GitLab Epic comments for ${ref.nodeId} exceed the bounded receipt-history read`);
    const note = arr(page.nodes, "GitLab Epic notes").map((value) => rec(value, "GitLab Epic note")).find((value) => value.id === ref.id);
    if (note === undefined) throw new WorkGraphError("backend", `GitLab Epic receipt ${ref.id} is not attached to ${ref.nodeId}`);
    return note;
  }
  async readComment(ref: CommentRef): Promise<CommentRef> { const p = parts({ id: ref.nodeId }); if (p.sigil === "&") { const note = await this.epicNote(ref); return { id: str(note, "id", "GitLab note"), nodeId: ref.nodeId, author: username(note.author), ...(typeof note.url === "string" ? { url: note.url } : {}) }; } const note = rec(await this.transport({ method: "GET", path: `${restIssue(p)}/notes/${issueCommentId(ref)}` }), "GitLab note"); return { id: String(num(note, "id", "GitLab note")), nodeId: ref.nodeId, author: username(note.author), ...(typeof note.web_url === "string" ? { url: note.web_url } : {}) }; }
  private reactions(awards: unknown[]): Reaction[] { return awards.flatMap((award) => { const value = rec(award, "GitLab award"); const name = typeof value.name === "string" ? value.name : ""; const content = THUMBS_UP.test(name) ? "+1" : THUMBS_DOWN.test(name) ? "-1" : name; const id = typeof value.id === "string" ? value.id : String(num(value, "id", "GitLab award")); return [{ id, content, author: username(value.user), ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : typeof value.created_at === "string" ? { createdAt: value.created_at } : {}) }]; }); }
  async readCommentReactions(ref: CommentRef): Promise<Reaction[]> { const p = parts({ id: ref.nodeId }); if (p.sigil === "&") { const note = await this.epicNote(ref); const awards = note.awardEmoji && typeof note.awardEmoji === "object" && Array.isArray((note.awardEmoji as Record<string, unknown>).nodes) ? (note.awardEmoji as { nodes: unknown[] }).nodes : []; return this.reactions(awards); } const awards = arr(await this.transport({ method: "GET", path: `${restIssue(p)}/notes/${issueCommentId(ref)}/award_emoji`, paginate: true }), "GitLab awards"); return this.reactions(awards); }
  async listComments(ref: NodeRef): Promise<NodeComment[]> {
    const p = parts(ref);
    const response = await this.transport({ method: "POST", path: "graphql", body: { query: `query($fullPath:ID!,$iid:String!){namespace(fullPath:$fullPath){workItem(iid:$iid){widgets{type ... on WorkItemWidgetNotes{notes(first:100){nodes{id body author{username} createdAt url system} pageInfo{hasNextPage}}}}}}}`, variables: { fullPath: p.path, iid: String(p.iid) } } });
    const namespace = rec(gqlValue(response, "namespace"), "GitLab namespace");
    const item = rec(namespace.workItem, "GitLab work item");
    const widgets = arr(item.widgets, "GitLab widgets").map((value) => rec(value, "GitLab widget"));
    const notes = widgets.find((widget) => widget.type === "NOTES")?.notes;
    const notePage = notes === undefined ? { nodes: [] } : rec(notes, "GitLab notes");
    if (notePage.pageInfo !== undefined && rec(notePage.pageInfo, "GitLab note page").hasNextPage === true) {
      throw new WorkGraphError("backend", `GitLab comments for ${ref.id} exceed the bounded receipt-history read`);
    }
    return arr(notePage.nodes, "GitLab notes").filter((note) => rec(note, "GitLab note").system !== true).map((note) => {
      const value = rec(note, "GitLab note");
      return { id: p.sigil === "#" ? noteDatabaseId(str(value, "id", "GitLab issue note")) : str(value, "id", "GitLab note"), author: username(value.author), body: typeof value.body === "string" ? value.body : "", ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}), ...(typeof value.url === "string" ? { url: value.url } : {}) };
    });
  }
  async readRawBody(ref: NodeRef): Promise<string> { const p = parts(ref); if (p.sigil === "&") return (await this.item(ref)).rawDescription; const issue = rec(await this.transport({ method: "GET", path: restIssue(p) }), "GitLab issue"); return typeof issue.description === "string" ? issue.description : ""; }
  async writeRawBody(ref: NodeRef, body: string): Promise<void> { const p = parts(ref); if (p.sigil === "&") { await this.updateEpic(ref, body); return; } await this.transport({ method: "PUT", path: restIssue(p), body: { description: body } }); }
  async close(ref: NodeRef, receipt: CloseReceipt, expectedGatedNodeHash?: string): Promise<void> { const item = await this.item(ref); const state = stateFrom(item); const hash = hashGatedNodeFields(state.node, state.storeFields); if (expectedGatedNodeHash !== undefined && hash !== expectedGatedNodeHash) throw new WorkGraphError("invalid-node", `node ${ref.id} changed after close validation`); const boundReceipt = { ...receipt, autonomy: state.node.autonomy, gatedNodeHash: hash }; const posted = await this.postComment(ref, renderCloseReceipt(boundReceipt), item); if (posted.author === undefined || posted.author.length === 0) throw new WorkGraphError("backend", "posted close receipt has no authenticated author"); const completion = { receiptCommentId: posted.id, checkpointId: receipt.checkpointId, autonomy: state.node.autonomy, closer: posted.author, closedAt: boundReceipt.at, gatedNodeHash: hash, ...(state.node.autonomy === "auto" ? { autoProbeKeys: (state.node.probes ?? []).map((probe) => JSON.stringify(probe)).sort() } : {}), ...(receipt.ci === undefined ? {} : { ciCheckRunId: receipt.ci.checkRunId, ciHeadSha: receipt.ci.headSha }) }; const body = [state.body, encodeNodeBlock({ ...state.node, title: state.node.title, completion }, state.storeFields), ...(item.type === "Epic" && item.homeProject !== undefined ? [encodeGitLabRoute(item.homeProject)] : [])].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n\n"); const p = parts(ref); if (p.sigil === "&") { await this.updateEpic(ref, body, true, item); return; } await this.transport({ method: "PUT", path: restIssue(p), body: { description: body, state_event: "close" } }); }
}
export function createGitLabGraphStore(options: GitLabGraphStoreOptions): GraphStore<GitLabCreateData> { return new GitLabGraphStore(options); }
