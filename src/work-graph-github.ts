/**
 * GitHub backend for the work graph (`docs/work-graph.md` §2.5, #497).
 *
 * Day-one store: tracker issues *are* the graph surface (§5). Topology rides on
 * GitHub's native relationships — sub-issues for membership, issue dependencies
 * for blocking — so the frontier renders in the tracker's own UI and a human can
 * read the graph without soma installed.
 *
 * The typed part of a node (autonomy, probes, checkpoint, budget) rides in an
 * HTML-comment block in the issue body: invisible when rendered, readable in
 * raw markdown, and the tracker never becomes a typed database (§5). An issue
 * with no block is a hand-authored ticket — reported fail-safe as `approve`
 * with no probes, never `auto`.
 *
 * I/O only. Every rule (validation, cycle rejection, frontier confirmation,
 * close gating) lives in {@link WorkGraph}.
 */

import {
  WorkGraphError,
  parseNodeSpec,
  renderCloseReceipt,
  resolveClaimRace,
  toNode,
  type AttestationCapability,
  type ClaimResult,
  type CloseReceipt,
  type CommentRef,
  type CreateNodeSpec,
  type GraphStore,
  type NodeRef,
  type NodeState,
  type NodeStatus,
  type Reaction,
  type WorkGraphNode,
} from "./work-graph";

const NODE_BLOCK_OPEN = "<!-- soma:work-graph-node";
const NODE_BLOCK_CLOSE = "-->";

export interface GitHubApiRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** API path without a leading slash, e.g. `repos/owner/name/issues/1`. */
  path: string;
  body?: Record<string, unknown>;
  paginate?: boolean;
}

/** The one seam the backend needs — makes the store testable without a network or a tracker. */
export type GitHubApiTransport = (request: GitHubApiRequest) => Promise<unknown>;

export interface GhCliTransportOptions {
  binary?: string;
  cwd?: string;
}

/**
 * Default transport: shell out to `gh api`.
 *
 * `gh` owns credential resolution, which is the point — the identity a session
 * acts as is a deployment fact (§5), not something soma re-implements. Sessions
 * run with `GH_TOKEN` set to the agent PAT; what else a session can *reach* is
 * the confinement question (#511), decided outside this module.
 */
export function createGhCliTransport(options: GhCliTransportOptions = {}): GitHubApiTransport {
  const binary = options.binary ?? "gh";
  return async (request: GitHubApiRequest): Promise<unknown> => {
    const args = ["api", "--method", request.method, request.path];
    if (request.paginate === true) args.push("--paginate");
    if (request.body !== undefined) args.push("--input", "-");

    const proc = Bun.spawn([binary, ...args], {
      stdin: request.body === undefined ? "ignore" : new TextEncoder().encode(JSON.stringify(request.body)),
      stdout: "pipe",
      stderr: "pipe",
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new WorkGraphError(
        "backend",
        `gh api ${request.method} ${request.path} failed (exit ${exitCode}): ${stderr.trim()}`,
      );
    }
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return null;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      throw new WorkGraphError("backend", `gh api ${request.method} ${request.path} returned unparseable JSON`);
    }
  };
}

export interface GitHubGraphStoreOptions {
  /** `owner/name`. A graph records its backend at creation and lives there forever (§2.5). */
  repo: string;
  transport?: GitHubApiTransport;
}

interface GitHubIssue {
  number: number;
  /** Database id — what the sub-issue and dependency endpoints take, never the issue number. */
  id: number;
  title: string;
  body: string;
  status: NodeStatus;
  author: string;
  assignees: string[];
  url?: string;
  parentNumber?: number;
}

interface GitHubComment {
  id: number;
  author: string;
  url?: string;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkGraphError("backend", `${context}: expected an object from the GitHub API`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new WorkGraphError("backend", `${context}: expected an array from the GitHub API`);
  }
  return value;
}

function readNumber(record: Record<string, unknown>, key: string, context: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new WorkGraphError("backend", `${context}: "${key}" missing from the GitHub response`);
  }
  return value;
}

function readLogin(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const login = (value as Record<string, unknown>).login;
  return typeof login === "string" ? login : "";
}

function readIssue(value: unknown, context: string): GitHubIssue {
  const record = asRecord(value, context);
  const assignees = Array.isArray(record.assignees)
    ? record.assignees.map((entry) => readLogin(entry)).filter((login) => login.length > 0)
    : [];
  const parent = record.parent;
  const parentNumber =
    typeof parent === "object" && parent !== null && typeof (parent as Record<string, unknown>).number === "number"
      ? ((parent as Record<string, unknown>).number as number)
      : undefined;
  return {
    number: readNumber(record, "number", context),
    id: readNumber(record, "id", context),
    title: typeof record.title === "string" ? record.title : "",
    body: typeof record.body === "string" ? record.body : "",
    status: record.state === "closed" ? "closed" : "open",
    author: readLogin(record.user),
    assignees,
    ...(typeof record.html_url === "string" ? { url: record.html_url } : {}),
    ...(parentNumber === undefined ? {} : { parentNumber }),
  };
}

function readComment(value: unknown, context: string): GitHubComment {
  const record = asRecord(value, context);
  return {
    id: readNumber(record, "id", context),
    author: readLogin(record.user),
    ...(typeof record.html_url === "string" ? { url: record.html_url } : {}),
  };
}

/** The typed half of a node, as stored in the issue body. Title lives in the issue title; parent is a native edge. */
export function encodeNodeBlock(spec: CreateNodeSpec): string {
  const payload: Record<string, unknown> = { autonomy: spec.autonomy };
  if (spec.kind !== undefined) payload.kind = spec.kind;
  if (spec.checkpointId !== undefined) payload.checkpointId = spec.checkpointId;
  if (spec.budget !== undefined) payload.budget = spec.budget;
  if (spec.probes !== undefined && spec.probes.length > 0) payload.probes = spec.probes;
  return `${NODE_BLOCK_OPEN}\n${JSON.stringify(payload, null, 2)}\n${NODE_BLOCK_CLOSE}`;
}

export interface DecodedBody {
  /** Issue body with the node block removed — the human-readable question. */
  text: string;
  /** Raw JSON found in the block, still untrusted; undefined when the issue carries no block. */
  raw?: string;
}

export function decodeNodeBlock(body: string): DecodedBody {
  const open = body.lastIndexOf(NODE_BLOCK_OPEN);
  if (open === -1) return { text: body.trim() };
  const close = body.indexOf(NODE_BLOCK_CLOSE, open + NODE_BLOCK_OPEN.length);
  if (close === -1) return { text: body.trim() };
  return {
    text: `${body.slice(0, open)}${body.slice(close + NODE_BLOCK_CLOSE.length)}`.trim(),
    raw: body.slice(open + NODE_BLOCK_OPEN.length, close).trim(),
  };
}

/**
 * An issue with no readable node block still has to answer `readNode` — the
 * dogfooding walk runs over hand-authored tickets. It reports as the most-gated
 * class with no probes: nothing declared how to check it by machine, so nothing
 * may close it by machine.
 */
function untypedNode(issue: GitHubIssue): WorkGraphNode {
  return { id: String(issue.number), title: issue.title, autonomy: "approve" };
}

function nodeFromIssue(issue: GitHubIssue): { node: WorkGraphNode; typed: boolean; parseError?: string; text: string } {
  const decoded = decodeNodeBlock(issue.body);
  if (decoded.raw === undefined) {
    return { node: untypedNode(issue), typed: false, text: decoded.text };
  }
  try {
    const block = asRecord(JSON.parse(decoded.raw) as unknown, "node block");
    const spec = parseNodeSpec({ ...block, title: issue.title });
    return { node: toNode(String(issue.number), spec), typed: true, text: decoded.text };
  } catch (error) {
    // Visible state, never a silent downgrade: the node falls back to the
    // most-gated class AND says why.
    return {
      node: untypedNode(issue),
      typed: false,
      parseError: error instanceof Error ? error.message : String(error),
      text: decoded.text,
    };
  }
}

class GitHubGraphStore implements GraphStore {
  /** GitHub can attest comment and reaction authorship via its API (§2.5). Capability, not verdict. */
  readonly attestation: AttestationCapability = "verifiable";

  private readonly repo: string;
  private readonly transport: GitHubApiTransport;

  constructor(options: GitHubGraphStoreOptions) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(options.repo)) {
      throw new WorkGraphError("backend", `repo must be "owner/name", got ${JSON.stringify(options.repo)}`);
    }
    this.repo = options.repo;
    this.transport = options.transport ?? createGhCliTransport();
  }

  async createNode(spec: CreateNodeSpec): Promise<NodeRef> {
    const body = [spec.body ?? "", encodeNodeBlock(spec)].filter((part) => part.length > 0).join("\n\n");
    const created = readIssue(
      await this.transport({ method: "POST", path: `repos/${this.repo}/issues`, body: { title: spec.title, body } }),
      "createNode",
    );
    if (spec.parent !== undefined) {
      await this.transport({
        method: "POST",
        path: `repos/${this.repo}/issues/${spec.parent.id}/sub_issues`,
        body: { sub_issue_id: created.id },
      });
    }
    return { id: String(created.number) };
  }

  async addBlockingEdge(blocker: NodeRef, blocked: NodeRef): Promise<void> {
    const blockerIssue = await this.fetchIssue(blocker);
    await this.transport({
      method: "POST",
      path: `repos/${this.repo}/issues/${blocked.id}/dependencies/blocked_by`,
      // The dependency endpoint keys on the database id, not the issue number.
      body: { issue_id: blockerIssue.id },
    });
  }

  async readNode(ref: NodeRef): Promise<NodeState> {
    const issue = await this.fetchIssue(ref);
    const parentNumber = issue.parentNumber ?? (await this.fetchParentNumber(issue.number));
    const blockers = asArray(
      await this.transport({
        method: "GET",
        path: `repos/${this.repo}/issues/${ref.id}/dependencies/blocked_by`,
        paginate: true,
      }),
      "readNode blocked_by",
    ).map((entry) => readIssue(entry, "readNode blocked_by"));
    const { node, typed, parseError, text } = nodeFromIssue(issue);
    return {
      ref: { id: String(issue.number) },
      node,
      status: issue.status,
      assignees: issue.assignees,
      blockedBy: blockers.map((blocker) => ({ id: String(blocker.number), status: blocker.status })),
      author: issue.author,
      ...(parentNumber === undefined ? {} : { parent: { id: String(parentNumber) } }),
      ...(text.length === 0 ? {} : { body: text }),
      ...(issue.url === undefined ? {} : { url: issue.url }),
      typed,
      ...(parseError === undefined ? {} : { parseError }),
    };
  }

  /**
   * Membership comes from native sub-issue edges — the same relationship the
   * tracker UI renders. Closed children are dropped here as a cheap pre-filter;
   * the contract layer re-confirms every survivor by direct fetch.
   */
  async listCandidateFrontier(root: NodeRef): Promise<NodeRef[]> {
    const children = asArray(
      await this.transport({ method: "GET", path: `repos/${this.repo}/issues/${root.id}/sub_issues`, paginate: true }),
      "listCandidateFrontier",
    ).map((entry) => readIssue(entry, "listCandidateFrontier"));
    return children.filter((child) => child.status === "open").map((child) => ({ id: String(child.number) }));
  }

  /**
   * GitHub offers no compare-and-swap, so: assign, re-read, and let the
   * deterministic tie-break decide. A loser removes itself, so the assignee set
   * converges to the single holder without coordination (§2.4).
   */
  async claim(ref: NodeRef, identity: string): Promise<ClaimResult> {
    const before = await this.fetchIssue(ref);
    if (before.status === "closed") {
      throw new WorkGraphError("node-closed", `node ${ref.id} is closed — nothing to claim`);
    }
    await this.transport({
      method: "POST",
      path: `repos/${this.repo}/issues/${ref.id}/assignees`,
      body: { assignees: [identity] },
    });

    const after = await this.fetchIssue(ref);
    const { held, holder } = resolveClaimRace(identity, after.assignees);
    if (!held && after.assignees.includes(identity)) {
      await this.transport({
        method: "DELETE",
        path: `repos/${this.repo}/issues/${ref.id}/assignees`,
        body: { assignees: [identity] },
      });
      return { held, identity, holder, assignees: after.assignees.filter((login) => login !== identity) };
    }
    return { held, identity, holder, assignees: after.assignees };
  }

  async postComment(ref: NodeRef, body: string): Promise<CommentRef> {
    const comment = readComment(
      await this.transport({ method: "POST", path: `repos/${this.repo}/issues/${ref.id}/comments`, body: { body } }),
      "postComment",
    );
    return {
      id: String(comment.id),
      nodeId: ref.id,
      author: comment.author,
      ...(comment.url === undefined ? {} : { url: comment.url }),
    };
  }

  /** Re-read a comment for its API author field — the proposal half of §3.2 conjunct 3. */
  async readComment(ref: CommentRef): Promise<CommentRef> {
    const comment = readComment(
      await this.transport({ method: "GET", path: `repos/${this.repo}/issues/comments/${ref.id}` }),
      "readComment",
    );
    return {
      id: String(comment.id),
      nodeId: ref.nodeId,
      author: comment.author,
      ...(comment.url === undefined ? {} : { url: comment.url }),
    };
  }

  /** Authors come from the API author field — the whole point of reading reactions here (§3.2 conjunct 3). */
  async readCommentReactions(ref: CommentRef): Promise<Reaction[]> {
    const reactions = asArray(
      await this.transport({
        method: "GET",
        path: `repos/${this.repo}/issues/comments/${ref.id}/reactions`,
        paginate: true,
      }),
      "readCommentReactions",
    );
    return reactions.map((entry) => {
      const record = asRecord(entry, "readCommentReactions");
      const createdAt = record.created_at;
      return {
        id: String(readNumber(record, "id", "readCommentReactions")),
        content: typeof record.content === "string" ? record.content : "",
        author: readLogin(record.user),
        ...(typeof createdAt === "string" ? { createdAt } : {}),
      };
    });
  }

  /** Receipt first, then the state change: a close that fails halfway leaves the evidence, not a bare closed issue. */
  async close(ref: NodeRef, receipt: CloseReceipt): Promise<void> {
    await this.postComment(ref, renderCloseReceipt(receipt));
    await this.transport({
      method: "PATCH",
      path: `repos/${this.repo}/issues/${ref.id}`,
      body: { state: "closed", state_reason: "completed" },
    });
  }

  /**
   * The sub-issue *parent* edge, which the REST issue payload does not carry —
   * `GET repos/{repo}/issues/{n}` has no `parent` key at all, while the child
   * direction (`/sub_issues`) does. Only GraphQL exposes it.
   *
   * This matters well beyond display: §3.2 conjunct 4 derives the authorized
   * ratifier by walking parent edges to the graph root. With no parent, every
   * node resolves to itself as root, and "the root's author may ratify" quietly
   * degrades into "a ticket's own author may ratify its close" — an
   * authorization bypass, not a cosmetic gap.
   *
   * A missing or unreadable parent returns undefined, which the caller reads as
   * "root unreachable" and downgrades on. Never an assumed root.
   */
  private async fetchParentNumber(issueNumber: number): Promise<number | undefined> {
    const [owner, name] = this.repo.split("/");
    const response = await this.transport({
      method: "POST",
      path: "graphql",
      body: {
        query:
          "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){parent{number}}}}",
        variables: { owner, name, number: issueNumber },
      },
    });

    const data = (response as { data?: { repository?: { issue?: { parent?: { number?: unknown } | null } | null } | null } } | null)
      ?.data;
    const parent = data?.repository?.issue?.parent;
    const number = parent?.number;
    return typeof number === "number" ? number : undefined;
  }

  private async fetchIssue(ref: NodeRef): Promise<GitHubIssue> {
    return readIssue(
      await this.transport({ method: "GET", path: `repos/${this.repo}/issues/${ref.id}` }),
      `issue ${ref.id}`,
    );
  }
}

export function createGitHubGraphStore(options: GitHubGraphStoreOptions): GraphStore {
  return new GitHubGraphStore(options);
}
