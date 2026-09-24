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
  type ReleaseResult,
} from "./work-graph";
import { envWithoutTokens, type ConfinementDeps } from "./work-graph-attestation";
import { decodeNodeBlock, encodeNodeBlock } from "./work-graph-node-block";
import { runCommand } from "./work-graph-probes";
import { parseLocatedNodeId, validateRepoRef } from "./work-graph-ref";

const TOKEN_KEYS = ["GITLAB_TOKEN", "GLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "CI_JOB_TOKEN"] as const;

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
  if (request.body !== undefined) args.push("--input", "-");
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
export function createGlabCliTransport(options: GlabCliTransportOptions): GitLabApiTransport {
  const binary = options.binary ?? "glab";
  return async (request) => {
    const proc = Bun.spawn([binary, ...glabApiArgs(request, options.hostname)], {
      stdin: request.body === undefined ? "ignore" : new TextEncoder().encode(JSON.stringify(request.body)),
      stdout: "pipe", stderr: "pipe", ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      // The ref supplies the host. Keep glab's configured credential lookup,
      // but never forward a process-wide token to an arbitrary GitLab host.
      env: envWithoutTokens(process.env, TOKEN_KEYS),
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) throw new WorkGraphError("backend", `glab api ${request.method} ${request.path} failed (exit ${exitCode}): ${stderr.trim()}`);
    return parseGlabApiOutput(stdout, request);
  };
}

export interface GitLabGraphStoreOptions { host: string; transport?: GitLabApiTransport; confinement?: ConfinementDeps; }
interface Parts { path: string; iid: number; sigil: "#" | "&"; }
interface Item { id: string; iid: number; path: string; type: string; title: string; description: string; status: NodeStatus; author: string; assignees: string[]; parent?: NodeRef; blockers: BlockingRef[]; children: NodeRef[]; childrenTruncated: boolean; linksTruncated: boolean; }
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
function gqlValue(value: unknown, field: string): unknown { const root = rec(value, "GraphQL response"); const data = rec(root.data, "GraphQL response data"); const result = data[field]; if (result === undefined || result === null) throw new WorkGraphError("backend", `GraphQL response has no ${field}`); return result; }
function nodeId(path: string, iid: number, sigil: "#" | "&" = "#"): NodeRef { return { id: `${path}${sigil}${iid}` }; }
function itemRef(item: Item): NodeRef { return nodeId(item.path, item.iid, item.type === "Epic" ? "&" : "#"); }
function limitConcurrency(limit: number): <T>(fn: () => Promise<T>) => Promise<T> { let active = 0; const waiting: (() => void)[] = []; return async <T>(fn: () => Promise<T>): Promise<T> => { if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve)); active += 1; try { return await fn(); } finally { active -= 1; waiting.shift()?.(); } }; }
function mutation(response: unknown, field: string): Record<string, unknown> {
  const result = rec(gqlValue(response, field), field);
  const errors = result.errors;
  if (Array.isArray(errors) && errors.some((error) => typeof error === "string" && error.length > 0)) throw new WorkGraphError("backend", `${field}: ${errors.join("; ")}`);
  return result;
}

function itemFrom(value: unknown, context: string, fallbackPath: string): Item {
  const item = rec(value, context);
  const rawIid = item.iid; const iid = typeof rawIid === "number" ? rawIid : typeof rawIid === "string" && /^\d+$/u.test(rawIid) ? Number(rawIid) : num(item, "iid", context); const title = typeof item.title === "string" ? item.title : "";
  const description = typeof item.description === "string" ? item.description : "";
  const namespace = item.namespace && typeof item.namespace === "object" ? item.namespace as Record<string, unknown> : {};
  const path = typeof namespace.fullPath === "string" ? namespace.fullPath : fallbackPath;
  const widgets = Array.isArray(item.widgets) ? item.widgets.map((widget) => rec(widget, `${context} widget`)) : [];
  const widget = (type: string): Record<string, unknown> => widgets.find((entry) => entry.type === type) ?? {};
  const assigneeWidget = widget("ASSIGNEES");
  const assignees = assigneeWidget.assignees && typeof assigneeWidget.assignees === "object" && Array.isArray((assigneeWidget.assignees as Record<string, unknown>).nodes)
    ? (assigneeWidget.assignees as { nodes: unknown[] }).nodes.map(username).filter(Boolean) : [];
  const hierarchy = widget("HIERARCHY");
  const parentRaw = hierarchy.parent;
  const parentRecord = parentRaw && typeof parentRaw === "object" ? parentRaw as Record<string, unknown> : undefined;
  const parentNamespace = parentRecord?.namespace && typeof parentRecord.namespace === "object" ? parentRecord.namespace as Record<string, unknown> : undefined;
  const parentIid = parentRecord?.iid;
  const parent = parentRecord !== undefined && typeof parentNamespace?.fullPath === "string" && (typeof parentIid === "number" || typeof parentIid === "string" && /^\d+$/u.test(parentIid))
    ? nodeId(parentNamespace.fullPath, Number(parentIid), parentRecord.workItemType === "Epic" ? "&" : "#") : undefined;
  const childrenRecord = hierarchy.children && typeof hierarchy.children === "object" ? hierarchy.children as Record<string, unknown> : undefined;
  const childNodes = Array.isArray(childrenRecord?.nodes)
    ? (hierarchy.children as { nodes: unknown[] }).nodes.flatMap((child) => { const r = rec(child, `${context} child`); const childNamespace = r.namespace && typeof r.namespace === "object" ? r.namespace as Record<string, unknown> : {}; return typeof r.iid === "string" && typeof childNamespace.fullPath === "string" ? [nodeId(childNamespace.fullPath, Number(r.iid), r.workItemType === "Epic" ? "&" : "#")] : []; }) : [];
  const links = widget("LINKED_ITEMS");
  const blocked = links.linkedItems && typeof links.linkedItems === "object" && Array.isArray((links.linkedItems as Record<string, unknown>).nodes)
    ? (links.linkedItems as { nodes: unknown[] }).nodes.flatMap((entry) => { const r = rec(entry, `${context} link`); const linked = r.workItem && typeof r.workItem === "object" ? r.workItem as Record<string, unknown> : {}; const linkedNamespace = linked.namespace && typeof linked.namespace === "object" ? linked.namespace as Record<string, unknown> : {}; return r.linkType === "IS_BLOCKED_BY" && typeof linked.iid === "string" && typeof linkedNamespace.fullPath === "string" ? [{ id: nodeId(linkedNamespace.fullPath, Number(linked.iid)).id, status: linked.state === "CLOSED" ? "closed" as const : "open" as const }] : []; }) : [];
  const type = typeof item.workItemType === "string" ? item.workItemType : "";
  const childrenTruncated = childrenRecord?.pageInfo !== undefined && rec(childrenRecord.pageInfo, `${context} child page`).hasNextPage === true;
  const linkedRecord = links.linkedItems && typeof links.linkedItems === "object" ? links.linkedItems as Record<string, unknown> : undefined;
  const linksTruncated = linkedRecord?.pageInfo !== undefined && rec(linkedRecord.pageInfo, `${context} linked page`).hasNextPage === true;
  return { id: str(item, "id", context), iid, path, type, title, description, status: item.state === "CLOSED" ? "closed" : "open", author: username(item.author), assignees, ...(parent === undefined ? {} : { parent }), blockers: blocked, children: childNodes, childrenTruncated, linksTruncated };
}
function stateFrom(item: Item): NodeState {
  const decoded = decodeNodeBlock(item.description);
  const ref = nodeId(item.path, item.iid, item.type === "Epic" ? "&" : "#");
  try { const raw = decoded.raw === undefined ? undefined : rec(JSON.parse(decoded.raw) as unknown, "node block"); const node = raw === undefined ? { id: ref.id, title: item.title, autonomy: "approve" as const } : toNode(ref.id, parseNodeSpec({ ...raw, title: item.title })); return { ref, node, typed: raw !== undefined, status: item.status, author: item.author, assignees: item.assignees, body: decoded.text, blockedBy: item.blockers, trackerType: item.type, ...(item.parent === undefined ? {} : { parent: item.parent }) }; }
  catch (error) { return { ref, node: { id: ref.id, title: item.title, autonomy: "approve" }, typed: false, parseError: error instanceof Error ? error.message : String(error), status: item.status, author: item.author, assignees: item.assignees, body: decoded.text, blockedBy: item.blockers, trackerType: item.type, ...(item.parent === undefined ? {} : { parent: item.parent }) }; }
}

const ITEM_QUERY = `query($fullPath:ID!,$iid:String!){namespace(fullPath:$fullPath){workItem(iid:$iid){id iid title description state workItemType namespace{fullPath} author{username} widgets{type ... on WorkItemWidgetAssignees{assignees{nodes{username}}} ... on WorkItemWidgetHierarchy{parent{iid namespace{fullPath} workItemType} children(first:100){nodes{iid namespace{fullPath} workItemType} pageInfo{hasNextPage}}} ... on WorkItemWidgetLinkedItems{linkedItems(first:100){nodes{linkType workItem{iid namespace{fullPath} state}} pageInfo{hasNextPage}}}}}}}`;
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

class GitLabGraphStore implements GraphStore {
  readonly attestation: AttestationCapability = "verifiable";
  /** GitLab Tasks can only be parented by Issues; WorkGraph applies re-home. */
  readonly allowedParentTypes = ["Issue"] as const;
  private readonly host: string; private readonly transport: GitLabApiTransport; private readonly confinement: ConfinementDeps;
  constructor(options: GitLabGraphStoreOptions) { this.host = validateRepoRef({ forge: "gitlab", host: options.host, path: "group" }).host; this.transport = options.transport ?? createGlabCliTransport({ hostname: this.host }); this.confinement = options.confinement ?? defaultConfinement(); }
  async actingIdentity(): Promise<string> { const user = rec(await this.transport({ method: "GET", path: "user" }), "GitLab user"); return str(user, "username", "GitLab user"); }
  async checkConfinement(): Promise<ConfinementResult> { return await checkGitLabConfinement(this.confinement, this.host); }
  private async item(ref: NodeRef): Promise<Item> { const p = parts(ref); const response = await this.transport({ method: "POST", path: "graphql", body: { query: ITEM_QUERY, variables: { fullPath: p.path, iid: String(p.iid) } } }); const namespace = rec(gqlValue(response, "namespace"), "work item namespace"); const item = itemFrom(namespace.workItem, `work item ${ref.id}`, p.path); if (item.linksTruncated) throw new WorkGraphError("backend", `GitLab blockers for ${ref.id} are paginated; refusing incomplete graph state`); return item; }
  async readNode(ref: NodeRef): Promise<NodeState> { return stateFrom(await this.item(ref)); }
  async createNode(spec: CreateNodeSpec): Promise<NodeRef> {
    const parent = spec.parent === undefined ? undefined : await this.item(spec.parent);
    const description = [spec.body ?? "", encodeNodeBlock(spec)].filter(Boolean).join("\n\n");
    let input: Record<string, unknown>;
    if (parent === undefined) {
      if (spec.home === undefined) throw new WorkGraphError("invalid-node", "GitLab map roots require home: <group/project>");
      const group = spec.home.slice(0, spec.home.lastIndexOf("/"));
      if (group.length === 0) throw new WorkGraphError("invalid-node", "GitLab home must be a project path under the Epic group");
      input = { namespacePath: group, workItemTypeId: "gid://gitlab/WorkItems::Type/8", title: spec.title, description };
    } else {
      const type = parent.type === "Epic" ? "Issue" : parent.type === "Issue" ? "Task" : undefined;
      if (type === undefined) throw new WorkGraphError("invalid-node", `GitLab cannot create a child below ${parent.type || "this"} work item`);
      const home = parent.type === "Epic" ? stateFrom(parent).node.home : parent.path;
      if (!home?.startsWith(`${parent.path}/`)) throw new WorkGraphError("invalid-node", `GitLab Epic ${spec.parent?.id} has no valid home project under ${parent.path}`);
      input = { projectPath: home, workItemTypeId: type === "Issue" ? "gid://gitlab/WorkItems::Type/1" : "gid://gitlab/WorkItems::Type/5", title: spec.title, description, hierarchyWidget: { parentId: parent.id } };
    }
    const created = mutation(await this.transport({ method: "POST", path: "graphql", body: { query: `mutation($input:WorkItemCreateInput!){workItemCreate(input:$input){workItem{id iid namespace{fullPath} workItemType} errors}}`, variables: { input } } }), "workItemCreate");
    const item = rec(created.workItem, "created work item"); const namespace = rec(item.namespace, "created work item namespace"); const iid = item.iid;
    return nodeId(str(namespace, "fullPath", "created work item namespace"), typeof iid === "string" ? Number(iid) : num(item, "iid", "created work item"), item.workItemType === "Epic" ? "&" : "#");
  }
  async createNodeWithPlacement(spec: CreateNodeSpec): Promise<NodeRef & { rehomedFrom?: NodeRef; rehomedTo?: NodeRef }> {
    if (spec.parent === undefined) return await this.createNode(spec);
    const requested = await this.item(spec.parent);
    if (requested.type !== "Task") return await this.createNode(spec);
    let ancestor = requested.parent;
    while (ancestor !== undefined) {
      const candidate = await this.item(ancestor);
      if (candidate.type === "Issue") {
        const parent = itemRef(candidate);
        const created = await this.createNode({ ...spec, parent });
        await this.addRelatedEdge(itemRef(requested), created);
        return { ...created, rehomedFrom: itemRef(requested), rehomedTo: parent };
      }
      ancestor = candidate.parent;
    }
    throw new WorkGraphError("invalid-node", `cannot re-home Task parent ${spec.parent.id}: no Issue ancestor`);
  }
  private async addLinkedEdge(source: NodeRef, related: NodeRef, linkType: "BLOCKS" | "RELATES_TO"): Promise<void> { const left = await this.item(source); const right = await this.item(related); mutation(await this.transport({ method: "POST", path: "graphql", body: { query: `mutation($source:WorkItemID!,$target:WorkItemID!,$linkType:WorkItemLinkType!){workItemAddLinkedItems(input:{workItemId:$source,workItemIds:[$target],linkType:$linkType}){errors}}`, variables: { source: left.id, target: right.id, linkType } } }), "workItemAddLinkedItems"); }
  async addBlockingEdge(blocker: NodeRef, blocked: NodeRef): Promise<void> { await this.addLinkedEdge(blocker, blocked, "BLOCKS"); }
  private async addRelatedEdge(source: NodeRef, related: NodeRef): Promise<void> { await this.addLinkedEdge(source, related, "RELATES_TO"); }
  async readSubtree(root: NodeRef): Promise<NodeState[]> { const seen = new Set<string>([root.id]); const bounded = limitConcurrency(8); const visit = async (ref: NodeRef, parent: NodeRef): Promise<NodeState[]> => { if (seen.has(ref.id)) return []; seen.add(ref.id); const item = await bounded(async () => await this.item(ref)); if (item.childrenTruncated) throw new WorkGraphError("backend", `GitLab subtree ${ref.id} is paginated; refusing a partial membership walk`); const descendants = await Promise.all(item.children.map((child) => visit(child, ref))); return [{ ...stateFrom(item), parent }, ...descendants.flat()]; }; const rootItem = await bounded(async () => await this.item(root)); if (rootItem.childrenTruncated) throw new WorkGraphError("backend", `GitLab subtree ${root.id} is paginated; refusing a partial membership walk`); return (await Promise.all(rootItem.children.map((child) => visit(child, root)))).flat(); }
  async claim(ref: NodeRef, identity: string): Promise<ClaimResult> { const before = await this.item(ref); if (before.status === "closed") throw new WorkGraphError("node-closed", `node ${ref.id} is closed — nothing to claim`); await this.updateAssignees(parts(ref), "APPEND", identity); const after = await this.item(ref); const { held, holder } = resolveClaimRace(identity, after.assignees); if (!held && after.assignees.includes(identity)) await this.updateAssignees(parts(ref), "REMOVE", identity); return { held, identity, holder, assignees: held ? after.assignees : after.assignees.filter((name) => name !== identity) }; }
  async release(ref: NodeRef, identity: string): Promise<ReleaseResult> { const before = await this.item(ref); if (before.status === "closed") throw new WorkGraphError("node-closed", `node ${ref.id} is closed — nothing to release`); if (!before.assignees.includes(identity)) return { released: false, identity, assignees: before.assignees }; await this.updateAssignees(parts(ref), "REMOVE", identity); const after = await this.item(ref); return { released: true, identity, assignees: after.assignees.filter((name) => name !== identity) }; }
  private async updateAssignees(ref: Parts, operation: "APPEND" | "REMOVE", user: string): Promise<void> { if (ref.sigil !== "#") throw new WorkGraphError("backend", "GitLab epic cannot be claimed"); mutation(await this.transport({ method: "POST", path: "graphql", body: { query: `mutation($projectPath:ID!,$iid:String!,$user:String!,$operation:MutationOperationMode!){issueSetAssignees(input:{projectPath:$projectPath,iid:$iid,assigneeUsernames:[$user],operationMode:$operation}){errors}}`, variables: { projectPath: ref.path, iid: String(ref.iid), user, operation } } }), "issueSetAssignees"); }
  private async updateEpic(ref: NodeRef, description: string, close = false): Promise<void> { const item = await this.item(ref); mutation(await this.transport({ method: "POST", path: "graphql", body: { query: `mutation($input:WorkItemUpdateInput!){workItemUpdate(input:$input){errors}}`, variables: { input: { id: item.id, descriptionWidget: { description }, ...(close ? { stateEvent: "CLOSE" } : {}) } } } }), "workItemUpdate"); }
  async postComment(ref: NodeRef, body: string): Promise<CommentRef> { const p = parts(ref); if (p.sigil === "&") { const item = await this.item(ref); const result = mutation(await this.transport({ method: "POST", path: "graphql", body: { query: `mutation($noteableId:NoteableID!,$body:String!){createNote(input:{noteableId:$noteableId,body:$body}){note{id author{username} url} errors}}`, variables: { noteableId: item.id, body } } }), "createNote"); const note = rec(result.note, "GitLab note"); return { id: str(note, "id", "GitLab note"), nodeId: ref.id, author: username(note.author), ...(typeof note.url === "string" ? { url: note.url } : {}) }; } const note = rec(await this.transport({ method: "POST", path: `${restIssue(p)}/notes`, body: { body } }), "GitLab note"); return { id: String(num(note, "id", "GitLab note")), nodeId: ref.id, author: username(note.author), ...(typeof note.web_url === "string" ? { url: note.web_url } : {}) }; }
  async readComment(ref: CommentRef): Promise<CommentRef> { const p = parts({ id: ref.nodeId }); if (p.sigil === "&") { const note = rec(gqlValue(await this.transport({ method: "POST", path: "graphql", body: { query: `query($id:NoteID!){note(id:$id){id author{username} url}}`, variables: { id: ref.id } } }), "note"), "GitLab note"); return { id: str(note, "id", "GitLab note"), nodeId: ref.nodeId, author: username(note.author), ...(typeof note.url === "string" ? { url: note.url } : {}) }; } const note = rec(await this.transport({ method: "GET", path: `${restIssue(p)}/notes/${ref.id}` }), "GitLab note"); return { id: String(num(note, "id", "GitLab note")), nodeId: ref.nodeId, author: username(note.author), ...(typeof note.web_url === "string" ? { url: note.web_url } : {}) }; }
  private reactions(awards: unknown[]): Reaction[] { return awards.flatMap((award) => { const value = rec(award, "GitLab award"); const name = typeof value.name === "string" ? value.name : ""; const content = THUMBS_UP.test(name) ? "+1" : THUMBS_DOWN.test(name) ? "-1" : name; const id = typeof value.id === "string" ? value.id : String(num(value, "id", "GitLab award")); return [{ id, content, author: username(value.user), ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : typeof value.created_at === "string" ? { createdAt: value.created_at } : {}) }]; }); }
  async readCommentReactions(ref: CommentRef): Promise<Reaction[]> { const p = parts({ id: ref.nodeId }); if (p.sigil === "&") { const note = rec(gqlValue(await this.transport({ method: "POST", path: "graphql", body: { query: `query($id:NoteID!){note(id:$id){awardEmoji{nodes{id name user{username} createdAt}}}}`, variables: { id: ref.id } } }), "note"), "GitLab note"); const awards = note.awardEmoji && typeof note.awardEmoji === "object" && Array.isArray((note.awardEmoji as Record<string, unknown>).nodes) ? (note.awardEmoji as { nodes: unknown[] }).nodes : []; return this.reactions(awards); } const awards = arr(await this.transport({ method: "GET", path: `${restIssue(p)}/notes/${ref.id}/award_emoji`, paginate: true }), "GitLab awards"); return this.reactions(awards); }
  async listComments(ref: NodeRef): Promise<NodeComment[]> { const p = parts(ref); if (p.sigil === "&") { const response = await this.transport({ method: "POST", path: "graphql", body: { query: `query($fullPath:ID!,$iid:String!){namespace(fullPath:$fullPath){workItem(iid:$iid){widgets{type ... on WorkItemWidgetNotes{notes(first:100){nodes{id body author{username} createdAt url system} pageInfo{hasNextPage}}}}}}}`, variables: { fullPath: p.path, iid: String(p.iid) } } }); const namespace = rec(gqlValue(response, "namespace"), "Epic namespace"); const item = rec(namespace.workItem, "Epic work item"); const widgets = arr(item.widgets, "Epic widgets").map((value) => rec(value, "Epic widget")); const notes = widgets.find((widget) => widget.type === "NOTES")?.notes; const notePage = notes === undefined ? { nodes: [] } : rec(notes, "Epic notes"); if (notePage.pageInfo !== undefined && rec(notePage.pageInfo, "Epic note page").hasNextPage === true) throw new WorkGraphError("backend", `GitLab Epic comments for ${ref.id} are paginated; refusing partial receipt history`); return arr(notePage.nodes, "Epic notes").filter((note) => rec(note, "GitLab note").system !== true).map((note) => { const value = rec(note, "GitLab note"); return { id: str(value, "id", "GitLab note"), author: username(value.author), body: typeof value.body === "string" ? value.body : "", ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}), ...(typeof value.url === "string" ? { url: value.url } : {}) }; }); } const notes = arr(await this.transport({ method: "GET", path: `${restIssue(p)}/notes?sort=asc&per_page=100`, paginate: true }), "GitLab notes"); return notes.filter((note) => rec(note, "GitLab note").system !== true).map((note) => { const value = rec(note, "GitLab note"); return { id: String(num(value, "id", "GitLab note")), author: username(value.author), body: typeof value.body === "string" ? value.body : "", ...(typeof value.created_at === "string" ? { createdAt: value.created_at } : {}), ...(typeof value.web_url === "string" ? { url: value.web_url } : {}) }; }); }
  async readRawBody(ref: NodeRef): Promise<string> { const p = parts(ref); if (p.sigil === "&") return (await this.item(ref)).description; const issue = rec(await this.transport({ method: "GET", path: restIssue(p) }), "GitLab issue"); return typeof issue.description === "string" ? issue.description : ""; }
  async writeRawBody(ref: NodeRef, body: string): Promise<void> { const p = parts(ref); if (p.sigil === "&") { await this.updateEpic(ref, body); return; } await this.transport({ method: "PUT", path: restIssue(p), body: { description: body } }); }
  async close(ref: NodeRef, receipt: CloseReceipt, expectedGatedNodeHash?: string): Promise<void> { const state = await this.readNode(ref); const hash = hashGatedNodeFields(state.node); if (expectedGatedNodeHash !== undefined && hash !== expectedGatedNodeHash) throw new WorkGraphError("invalid-node", `node ${ref.id} changed after close validation`); await this.postComment(ref, renderCloseReceipt({ ...receipt, autonomy: state.node.autonomy, gatedNodeHash: hash })); const raw = await this.readRawBody(ref); const text = decodeNodeBlock(raw).text; const body = `${text}${text === "" ? "" : "\n\n"}${encodeNodeBlock({ ...state.node, title: state.node.title })}`; const p = parts(ref); if (p.sigil === "&") { await this.updateEpic(ref, body, true); return; } await this.transport({ method: "PUT", path: restIssue(p), body: { description: body, state_event: "close" } }); }
}
export function createGitLabGraphStore(options: GitLabGraphStoreOptions): GraphStore { return new GitLabGraphStore(options); }
