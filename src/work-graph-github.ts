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

// --- the membership subtree (#557) ------------------------------------------

/**
 * One entry per nested `subIssues` level in the walk query; the value is that
 * level's page size. Depth and width are round-trip tuning only — a subtree
 * that outgrows them is *detected* (see {@link SubtreeNode.childrenTruncated})
 * and completed by a follow-up query, so no shape of graph can read short.
 *
 * GitHub costs a nested connection as the product of the `first` values along
 * its path and rejects a query scoring over 500,000. These multiply out to
 * 50 + 1 500 + 30 000 + 30 000 = 61 550, counting the bottom-row probe.
 *
 * **Recompute before adding a level.** The headroom is nothing like the
 * 61 550 : 500 000 ratio suggests, because each level multiplies everything
 * below it: a fourth 20-wide level would score 1 231 550, and the widest that
 * still fits is 7. Depth is far more expensive here than width, which is the
 * argument for leaving this shallow and letting re-rooting handle the tail.
 */
const SUBTREE_PAGE_SIZES = [50, 30, 20] as const;

/** A node in the walk: identity, status, and whether its children arrived whole. */
interface SubtreeNode {
  number: number;
  status: NodeStatus;
  children: SubtreeNode[];
  /**
   * The children in hand are not all of them — the level hit its page size, or
   * this node sits on the bottom row where only a count was fetched. Either way
   * the walk must ask again rather than report what it happens to hold.
   */
  childrenTruncated: boolean;
}

/**
 * The nested `subIssues` selection for one level and everything below it.
 *
 * The bottom row is a `totalCount`-only probe: it costs one node per parent and
 * answers the only question that matters there — *is there more?* Without it a
 * leaf and an unfetched subtree are indistinguishable, which is the silent
 * truncation this walk exists to avoid.
 */
function subtreeSelection(level: number): string {
  const size = SUBTREE_PAGE_SIZES[level];
  if (size === undefined) return "subIssues(first:1){totalCount}";
  return `subIssues(first:${size}){totalCount nodes{number state ${subtreeSelection(level + 1)}}}`;
}

/**
 * The walk query. Only the **top** connection takes a cursor, and that
 * asymmetry is what makes the walk terminate correctly.
 *
 * A node whose children did not all arrive is re-fetched *as the root of its
 * own query*, where its children become the top connection and are therefore
 * paged to completion. Re-fetching it in place would be useless — the same
 * query with the same page size returns the same truncated set — so completion
 * by re-rooting is not an optimisation, it is the mechanism. Every re-root
 * strictly descends, so the recursion is bounded by the depth of the tree.
 */
const SUBTREE_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){issue(number:$number){number state subIssues(first:${SUBTREE_PAGE_SIZES[0]},after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{number state ${subtreeSelection(1)}}}}}}`;

/**
 * GraphQL states are upper-case, and `state` also carries CLOSED-as-not-planned.
 * Anything that is not literally OPEN is closed to the walk — a policy worth
 * stating once, since the walk reads status at two levels and a drift between
 * them would silently change which nodes get reported.
 */
function readGraphQLStatus(record: Record<string, unknown>): NodeStatus {
  return record.state === "OPEN" ? "open" : "closed";
}

function readSubtreeNode(value: unknown): SubtreeNode {
  const context = "subtree walk";
  const record = asRecord(value, context);
  const connection = record.subIssues;

  // The bottom row selects `totalCount` without `nodes`, so "no nodes key" is a
  // depth limit rather than a childless node — and both must recurse when the
  // count says there is something down there.
  const counted = connection === undefined || connection === null ? undefined : asRecord(connection, context);
  const totalCount = counted === undefined ? 0 : readNumber(counted, "totalCount", context);
  const children = Array.isArray(counted?.nodes)
    ? (counted.nodes as unknown[]).map((entry) => readSubtreeNode(entry))
    : undefined;

  return {
    number: readNumber(record, "number", context),
    status: readGraphQLStatus(record),
    children: children ?? [],
    childrenTruncated: children === undefined ? totalCount > 0 : totalCount > children.length,
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
      await this.transport({
        method: "POST",
        path: `repos/${this.repo}/issues`,
        body: {
          title: spec.title,
          body,
          // Write-only: GitHub's own index over the issue list. Never read back
          // — `readNode` derives `kind` and `autonomy` from the typed block, so
          // a label edited on the tracker changes what a human sees and nothing
          // a verb decides.
          ...(spec.labels === undefined || spec.labels.length === 0 ? {} : { labels: [...spec.labels] }),
        },
      }),
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
   * tracker UI renders — walked **transitively** (#557).
   *
   * GraphQL rather than recursive REST, because the walk must descend into
   * *closed* nodes to reach the scaffold beneath them: a REST walk costs one
   * request per visited node and therefore scales with the map's closed
   * history, which only grows, so a map would get slower as it succeeded.
   * Nested `subIssues` returns {@link SUBTREE_PAGE_SIZES}`.length` levels per
   * round trip instead.
   *
   * `totalCount` at every level is what keeps that honest rather than merely
   * cheap, and the two levels answer a shortfall differently. **Below the top**
   * it is recoverable: the node is flagged truncated and completed by a
   * follow-up query. **At the top** there is nothing left to recover with, so a
   * page run that does not add up refuses outright. Either way a subtree wider
   * or deeper than one query fetched is never silently dropped.
   *
   * Closed nodes are traversed and omitted from the result; the contract layer
   * re-confirms every survivor by direct fetch.
   */
  async listCandidateFrontier(root: NodeRef): Promise<NodeRef[]> {
    const rootNumber = Number(root.id);
    if (!Number.isInteger(rootNumber)) {
      throw new WorkGraphError("backend", `listCandidateFrontier: ${root.id} is not an issue number`);
    }

    const open: NodeRef[] = [];
    // Guards the result against a node reachable by two paths, and the walk
    // against a cycle. Sub-issues are a tree today; the seam promises nothing.
    const seen = new Set<number>([rootNumber]);

    const visit = async (node: SubtreeNode): Promise<void> => {
      if (seen.has(node.number)) return;
      seen.add(node.number);
      // Traverse closed nodes, report only open ones: scaffold outlives the node
      // that spawned it, so below-a-closed-parent is the common case.
      if (node.status === "open") open.push({ id: String(node.number) });
      for (const child of await this.completeChildren(node)) await visit(child);
    };

    for (const child of await this.completeChildren(await this.fetchSubtree(rootNumber))) await visit(child);
    return open;
  }

  /**
   * A node's children, whole. If the enclosing query could not carry them all —
   * it hit a page size, or bottomed out at the depth probe — the node is
   * re-fetched as its own root, where {@link fetchSubtree} pages them.
   */
  private async completeChildren(node: SubtreeNode): Promise<SubtreeNode[]> {
    if (!node.childrenTruncated) return node.children;
    return (await this.fetchSubtree(node.number)).children;
  }

  /**
   * The subtree below `issueNumber`: children **complete** (cursor-paged),
   * deeper levels as far as {@link SUBTREE_QUERY} reaches and flagged where
   * they stop.
   *
   * Every exit from the paging loop is checked, because this is the one place
   * a short read cannot be caught later: deeper levels announce their own
   * shortfall through {@link SubtreeNode.childrenTruncated}, but a top level
   * that quietly ends is indistinguishable from a complete one.
   */
  private async fetchSubtree(issueNumber: number): Promise<SubtreeNode> {
    const context = "subtree walk";
    const [owner, name] = this.repo.split("/");
    const children: SubtreeNode[] = [];
    let status: NodeStatus = "closed";
    let after: string | null = null;
    let totalCount = 0;
    // A backend that keeps saying "there is more" while handing back a cursor
    // it already gave would spin here forever, accumulating children — and
    // never reach the count check below, which is what would otherwise catch a
    // bad page run. Progress has to be asserted, not assumed.
    const cursors = new Set<string>();

    for (;;) {
      const response = await this.transport({
        method: "POST",
        path: "graphql",
        body: { query: SUBTREE_QUERY, variables: { owner, name, number: issueNumber, after } },
      });
      const issue = (response as { data?: { repository?: { issue?: unknown } | null } } | null)?.data?.repository
        ?.issue;
      if (issue === undefined || issue === null) {
        throw new WorkGraphError("backend", `${context}: issue ${issueNumber} not found in ${this.repo}`);
      }

      const record = asRecord(issue, context);
      status = readGraphQLStatus(record);
      const connection = asRecord(record.subIssues, context);
      totalCount = readNumber(connection, "totalCount", context);
      for (const entry of asArray(connection.nodes, context)) children.push(readSubtreeNode(entry));

      const pageInfo = asRecord(connection.pageInfo, context);
      if (pageInfo.hasNextPage === false) break;
      // Anything other than a literal `false` is an answer we cannot read, and
      // treating it as "that was the last page" is precisely the silent
      // truncation §2.4 cannot recover. Refuse instead.
      if (pageInfo.hasNextPage !== true) {
        throw new WorkGraphError("backend", `${context}: issue ${issueNumber} reported no usable hasNextPage`);
      }
      if (typeof pageInfo.endCursor !== "string") {
        throw new WorkGraphError("backend", `${context}: issue ${issueNumber} has more children but no cursor`);
      }
      if (cursors.has(pageInfo.endCursor)) {
        throw new WorkGraphError("backend", `${context}: issue ${issueNumber} repeated a pagination cursor`);
      }
      cursors.add(pageInfo.endCursor);
      after = pageInfo.endCursor;
    }

    // The connection said how many children exist; paging must have produced
    // exactly that many. A mismatch means either a short page run or a
    // concurrent edit, and in both cases the honest answer is that this list
    // cannot be vouched for — the caller can retry.
    if (children.length !== totalCount) {
      throw new WorkGraphError(
        "backend",
        `${context}: issue ${issueNumber} reported ${totalCount} children but paging returned ${children.length}`,
      );
    }

    return { number: issueNumber, status, children, childrenTruncated: false };
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
