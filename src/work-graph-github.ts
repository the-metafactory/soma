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
  isStructurallyValidCloseReceipt,
  resolveClaimRace,
  toNode,
  type AttestationCapability,
  type BlockingRef,
  type ClaimResult,
  type CloseReceipt,
  type CommentRef,
  type CreateNodeSpec,
  type GraphStore,
  type NodeComment,
  type NodeRef,
  type NodeState,
  type NodeStatus,
  type Reaction,
  type ReleaseResult,
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

/** Build the `gh api` argv once so pagination semantics are unit-testable. */
export function ghApiArgs(request: GitHubApiRequest): string[] {
  const args = ["api", "--method", request.method, request.path];
  if (request.paginate === true) args.push("--paginate", "--slurp");
  if (request.body !== undefined) args.push("--input", "-");
  return args;
}

/** Decode one `gh api` response, flattening the page arrays emitted by `--slurp`. */
export function parseGhApiOutput(stdout: string, request: GitHubApiRequest): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (request.paginate === true && Array.isArray(parsed) && parsed.every((page) => Array.isArray(page))) {
      return parsed.flat();
    }
    return parsed;
  } catch {
    throw new WorkGraphError("backend", `gh api ${request.method} ${request.path} returned unparseable JSON`);
  }
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
    const args = ghApiArgs(request);

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
    return parseGhApiOutput(stdout, request);
  };
}

function isGraphQLRateLimitError(error: unknown): boolean {
  return (
    error instanceof WorkGraphError &&
    error.code === "backend" &&
    /(?:API\s+)?rate limit (?:already )?exceeded/i.test(error.message)
  );
}

function isMissingRestResource(error: unknown): boolean {
  return (
    error instanceof WorkGraphError &&
    error.code === "backend" &&
    /(?:HTTP\s+)?(?:404|410)\b|\bNot Found\b|\bGone\b/i.test(error.message)
  );
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
 * ## Two independent budgets
 *
 * GitHub rejects a query whose worst-case node count exceeds **500 000**, and
 * separately charges its primary GraphQL quota from the connection expansion.
 * A query can pass the former while rapidly exhausting the latter: the old
 * `50/25/10` shape was valid at 440 330 nodes but predicted 414 primary points,
 * allowing only twelve successful subtree calls in a 5 000-point hour.
 *
 * A node costs `1 + ASSIGNEE_PAGE + BLOCKER_PAGE` = **31** — its own slot plus
 * its two connections — while the primary point estimate counts three
 * connections per visited position: `subIssues`, `assignees`, and `blockedBy`.
 * With the shipped `20/3/3` shape:
 *
 * ```
 *   node limit = 20×31 + 60×31 + 180×31 + 180 + 30 = 8 270
 *   primary connection requests = 3×(1 + 20 + 60 + 180) = 783
 *   predicted primary points = round(783 / 100) = 8
 * ```
 *
 * Width and depth remain round-trip tuning, not correctness limits: short
 * levels are detected and re-rooted below. Any new connection in NODE_FIELDS
 * must update `NODE_CONNECTION_COUNT` and re-open both calculations.
 */
const SUBTREE_PAGE_SIZES = [20, 3, 3] as const;
const NODE_CONNECTION_COUNT = 2;
const SUBTREE_PRIMARY_RATE_POINT_BUDGET = 10;

/** GitHub's documented primary-cost estimate: unique connection requests / 100, rounded. */
export function estimateSubtreeQueryPrimaryRatePoints(pageSizes: readonly number[]): number {
  let positions = 1;
  let connectionRequests = NODE_CONNECTION_COUNT + 1;
  for (const size of pageSizes) {
    if (!Number.isInteger(size) || size < 1) throw new TypeError("subtree page sizes must be positive integers");
    positions *= size;
    connectionRequests += positions * (NODE_CONNECTION_COUNT + 1);
  }
  return Math.max(1, Math.round(connectionRequests / 100));
}

export const SUBTREE_QUERY_PRIMARY_RATE_POINTS = estimateSubtreeQueryPrimaryRatePoints(SUBTREE_PAGE_SIZES);
if (SUBTREE_QUERY_PRIMARY_RATE_POINTS > SUBTREE_PRIMARY_RATE_POINT_BUDGET) {
  throw new Error(
    `subtree GraphQL query predicts ${SUBTREE_QUERY_PRIMARY_RATE_POINTS} primary points, budget is ${SUBTREE_PRIMARY_RATE_POINT_BUDGET}`,
  );
}

/** Per-node connection widths. Short reads on either are detected — see {@link SubtreeNode.stateTruncated}. */
const ASSIGNEE_PAGE = 10;
const BLOCKER_PAGE = 20;

/**
 * Everything {@link NodeState} carries, for one node (#576).
 *
 * The frontier used to re-read each candidate through `readNode` — three `gh`
 * spawns apiece at ~600ms each, which was the entire cost of the read path.
 * Selecting the same fields inside the walk collapses that to nothing: the
 * subtree arrives already confirmed. `parent` is deliberately absent, because
 * the walk *knows* it — a node's parent is whoever it was reached from, so
 * asking the API would be paying for an answer already in hand.
 *
 * **Every connection here carries `totalCount`.** A short `assignees` page
 * would make a claimed node look unclaimed and a short `blockedBy` page would
 * make a blocked node look takeable — both are false *positives* on the
 * frontier, which is the direction §2.4 says a reader cannot detect for itself.
 *
 * **The trade, stated:** this hydrates every node traversed, including the
 * closed history the frontier will discard, and `body` dominates the payload —
 * 57KB for map #495's 21-node subtree.
 *
 * The alternative is a narrow traversal plus a second call hydrating only the
 * survivors: one round trip when the frontier is empty, two whenever it is not,
 * against one either way here. The narrow pass cannot be very narrow, since the
 * predicate needs `state`, `assignees` and `blockedBy` — what one pass
 * over-fetches is `title`, `url` and `body` for discarded nodes.
 *
 * Measured on map #495, one pass costs 929ms where the old shape cost 9 606ms.
 * That is one map, and the honest limit of the claim: this scales with *closed*
 * history, which only grows, so a much larger map pays more payload for the same
 * few frontier nodes. Nothing here establishes where that crosses over — revisit
 * when payload rather than round trips is what a real map is paying.
 */
const NODE_FIELDS = `number title state body url databaseId author{login} assignees(first:${ASSIGNEE_PAGE}){totalCount nodes{login}} blockedBy(first:${BLOCKER_PAGE}){totalCount nodes{number state}}`;

/** A node in the walk: its confirmed state, its children, and what arrived short. */
interface SubtreeNode {
  state: NodeState;
  children: SubtreeNode[];
  /**
   * The children in hand are not all of them — the level hit its page size, or
   * this node sits on the bottom row where only a count was fetched. Either way
   * the walk must ask again rather than report what it happens to hold.
   */
  childrenTruncated: boolean;
  /**
   * `assignees` or `blockedBy` came back short, so this node's *state* is not
   * trustworthy even though its identity is. Repaired by a direct `readNode`,
   * whose REST paths paginate — the one place the old two-phase read is still
   * the right tool.
   */
  stateTruncated: boolean;
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
  const size = SUBTREE_PAGE_SIZES.at(level);
  if (size === undefined) return "subIssues(first:1){totalCount}";
  return `subIssues(first:${size}){totalCount nodes{${NODE_FIELDS} ${subtreeSelection(level + 1)}}}`;
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
const SUBTREE_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){issue(number:$number){${NODE_FIELDS} subIssues(first:${SUBTREE_PAGE_SIZES[0]},after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{${NODE_FIELDS} ${subtreeSelection(1)}}}}}}`;

/**
 * GraphQL states are upper-case, and `state` also carries CLOSED-as-not-planned.
 * Anything that is not literally OPEN is closed to the walk — a policy worth
 * stating once, since the walk reads status at two levels and a drift between
 * them would silently change which nodes get reported.
 */
function readGraphQLStatus(record: Record<string, unknown>): NodeStatus {
  return record.state === "OPEN" ? "open" : "closed";
}

/** A connection read as `{totalCount, nodes}`, with the shortfall reported rather than swallowed. */
function readCountedNodes(
  value: unknown,
  context: string,
): { entries: unknown[]; truncated: boolean } {
  const record = asRecord(value, context);
  const totalCount = readNumber(record, "totalCount", context);
  const entries = asArray(record.nodes, context);
  return { entries, truncated: totalCount > entries.length };
}

/**
 * The one place a {@link NodeState} is assembled.
 *
 * Both read paths land here — `readNode` over REST and the subtree walk over
 * GraphQL — so a field added to `NodeState` has a single production site. Each
 * caller's job is only to decode its own wire shape into a {@link GitHubIssue}
 * plus blockers; the same argument as reusing `nodeFromIssue` for the typed
 * block, one level up: two assemblers would be two answers.
 */
function toNodeState(
  issue: GitHubIssue,
  blockedBy: readonly BlockingRef[],
  parent?: NodeRef,
): NodeState {
  const { node, typed, parseError, text } = nodeFromIssue(issue);
  return {
    ref: { id: String(issue.number) },
    node,
    status: issue.status,
    assignees: issue.assignees,
    blockedBy,
    author: issue.author,
    ...(parent === undefined ? {} : { parent }),
    ...(text.length === 0 ? {} : { body: text }),
    ...(issue.url === undefined ? {} : { url: issue.url }),
    typed,
    ...(parseError === undefined ? {} : { parseError }),
  };
}

/**
 * A walk node's own state — everything `readNode` would have returned except
 * `parent`, which the walk supplies from the edge it arrived on.
 */
function readSubtreeState(record: Record<string, unknown>): { state: NodeState; truncated: boolean } {
  const context = "subtree walk";
  const number = readNumber(record, "number", context);
  const assignees = readCountedNodes(record.assignees, context);
  const blockers = readCountedNodes(record.blockedBy, context);

  const issue: GitHubIssue = {
    number,
    id: typeof record.databaseId === "number" ? record.databaseId : 0,
    title: typeof record.title === "string" ? record.title : "",
    body: typeof record.body === "string" ? record.body : "",
    status: readGraphQLStatus(record),
    author: readLogin(record.author),
    assignees: assignees.entries.map((entry) => readLogin(entry)).filter((login) => login.length > 0),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
  };

  return {
    truncated: assignees.truncated || blockers.truncated,
    state: toNodeState(
      issue,
      blockers.entries.map((entry) => {
        const blocker = asRecord(entry, context);
        return { id: String(readNumber(blocker, "number", context)), status: readGraphQLStatus(blocker) };
      }),
    ),
  };
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
  const { state, truncated } = readSubtreeState(record);

  return {
    state,
    children: children ?? [],
    childrenTruncated: children === undefined ? totalCount > 0 : totalCount > children.length,
    stateTruncated: truncated,
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
export function encodeNodeBlock(spec: CreateNodeSpec & { completion?: WorkGraphNode["completion"] }): string {
  const payload: Record<string, unknown> = { autonomy: spec.autonomy };
  if (spec.kind !== undefined) payload.kind = spec.kind;
  if (spec.checkpointId !== undefined) payload.checkpointId = spec.checkpointId;
  if (spec.budget !== undefined) payload.budget = spec.budget;
  if (spec.probes !== undefined && spec.probes.length > 0) payload.probes = spec.probes;
  if (spec.completion !== undefined) payload.completion = spec.completion;
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
    const rawCompletion = block.completion;
    delete block.completion;
    const spec = parseNodeSpec({ ...block, title: issue.title });
    const node = toNode(String(issue.number), spec);
    if (rawCompletion === undefined) return { node, typed: true, text: decoded.text };
    const completion = asRecord(rawCompletion, "node completion");
    const fields = ["receiptCommentId", "checkpointId", "closer", "closedAt"] as const;
    if (fields.some((field) => typeof completion[field] !== "string")
      || !["auto", "propose", "approve"].includes(String(completion.autonomy))) {
      throw new WorkGraphError("invalid-node", "invalid persisted completion binding");
    }
    const autoProbeKeys = completion.autoProbeKeys;
    if (autoProbeKeys !== undefined && (!Array.isArray(autoProbeKeys) || autoProbeKeys.some((key) => typeof key !== "string"))) {
      throw new WorkGraphError("invalid-node", "invalid persisted completion probe keys");
    }
    return { node: { ...node, completion: { receiptCommentId: completion.receiptCommentId as string, checkpointId: completion.checkpointId as string, autonomy: completion.autonomy as WorkGraphNode["autonomy"], closer: completion.closer as string, closedAt: completion.closedAt as string, ...(autoProbeKeys === undefined ? {} : { autoProbeKeys: autoProbeKeys as string[] }) } }, typed: true, text: decoded.text };
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
    const state = toNodeState(issue, await this.fetchBlockers(ref), parentNumber === undefined ? undefined : { id: String(parentNumber) });
    if (issue.status !== "closed") return state;
    if (state.node.completion === undefined) return { ...state, currentCloseReceipt: false };
    return { ...state, currentCloseReceipt: await this.hasCurrentCloseReceipt(ref, issue, state.node.completion) };
  }

  /**
   * Membership comes from native sub-issue edges — the same relationship the
   * tracker UI renders — walked **transitively** (#557).
   *
   * GraphQL on the normal path rather than recursive REST, because the walk must descend into
   * *closed* nodes to reach the scaffold beneath them: a REST walk costs one
   * request per visited node and therefore scales with the map's closed
   * history, which only grows, so a map would get slower as it succeeded.
   * Nested `subIssues` returns {@link SUBTREE_PAGE_SIZES}`.length` levels per
   * round trip instead. If GitHub's separate GraphQL quota is exhausted, the
   * same contract is reconstructed through the paginated REST sub-issues
   * endpoint; slower is preferable to making every graph verb unavailable.
   *
   * `totalCount` at every level is what keeps that honest rather than merely
   * cheap, and the two levels answer a shortfall differently. **Below the top**
   * it is recoverable: the node is flagged truncated and completed by a
   * follow-up query. **At the top** there is nothing left to recover with, so a
   * page run that does not add up refuses outright. Either way a subtree wider
   * or deeper than one query fetched is never silently dropped.
   *
   * Each node arrives **confirmed** — {@link NODE_FIELDS} selects everything
   * `readNode` would have returned, so the contract layer filters in memory
   * instead of re-reading (#576). The one exception is a node whose `assignees`
   * or `blockedBy` page came back short: its state is repaired by a direct
   * `readNode`, whose REST paths paginate.
   */
  async readSubtree(root: NodeRef): Promise<NodeState[]> {
    const rootNumber = Number(root.id);
    if (!Number.isInteger(rootNumber)) {
      throw new WorkGraphError("backend", `readSubtree: ${root.id} is not an issue number`);
    }

    const states: NodeState[] = [];
    // Guards the result against a node reachable by two paths, and the walk
    // against a cycle. Sub-issues are a tree today; the seam promises nothing.
    const seen = new Set<number>([rootNumber]);

    const visit = async (node: SubtreeNode, parent: NodeRef): Promise<void> => {
      const number = Number(node.state.ref.id);
      if (seen.has(number)) return;
      seen.add(number);
      // The walk knows the parent — it is whoever we arrived from — so the
      // membership edge costs nothing to report. Traverse closed nodes and
      // report them too: `readSubtree` states what the subtree holds, and §2.4
      // filtering is the contract layer's job, not the store's.
      // `parent` is the walk's answer either way. On the repair path `readNode`
      // resolves a parent of its own, and letting that win would make the two
      // able to disagree about the edge we are standing on — the seam promises
      // the edge it arrived by, not whatever a second lookup reports.
      states.push(
        node.stateTruncated ? { ...(await this.readNode(node.state.ref)), parent } : { ...node.state, parent },
      );
      for (const child of await this.completeChildren(node)) await visit(child, node.state.ref);
    };

    try {
      const rootNode = await this.fetchSubtree(rootNumber);
      for (const child of await this.completeChildren(rootNode)) await visit(child, root);
      return states;
    } catch (error) {
      if (!isGraphQLRateLimitError(error)) throw error;
      // Start over rather than mixing observations if a re-rooted or paged
      // GraphQL walk failed after contributing some states.
      return this.readSubtreeRest(root);
    }
  }

  /**
   * Quota-exhaustion path for the membership walk.
   *
   * REST exposes only one level of sub-issues at a time, so this costs one
   * child-list request per visited node plus one blocker request per returned
   * node. That is deliberately a fallback, not the normal path. Pagination is
   * still whole through the transport, closed nodes are traversed, and the
   * result preserves the same depth-first pre-order and parent-edge contract
   * as the nested GraphQL walk.
   */
  private async readSubtreeRest(root: NodeRef): Promise<NodeState[]> {
    const states: NodeState[] = [];
    const seen = new Set<string>([root.id]);

    const visitChildren = async (parent: NodeRef): Promise<void> => {
      const children = asArray(
        await this.transport({
          method: "GET",
          path: `repos/${this.repo}/issues/${parent.id}/sub_issues?per_page=100`,
          paginate: true,
        }),
        `REST subtree children of ${parent.id}`,
      );

      for (const entry of children) {
        const issue = readIssue(entry, `REST subtree child of ${parent.id}`);
        const ref = { id: String(issue.number) };
        if (seen.has(ref.id)) continue;
        seen.add(ref.id);
        states.push(toNodeState(issue, await this.fetchBlockers(ref), parent));
        await visitChildren(ref);
      }
    };

    await visitChildren(root);
    return states;
  }

  /**
   * A node's children, whole. If the enclosing query could not carry them all —
   * it hit a page size, or bottomed out at the depth probe — the node is
   * re-fetched as its own root, where {@link fetchSubtree} pages them.
   */
  private async completeChildren(node: SubtreeNode): Promise<SubtreeNode[]> {
    if (!node.childrenTruncated) return node.children;
    return (await this.fetchSubtree(Number(node.state.ref.id))).children;
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
    let self: { state: NodeState; truncated: boolean };
    let after: string | null = null;
    let totalCount: number;
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
      self = readSubtreeState(record);
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

    return { state: self.state, children, childrenTruncated: false, stateTruncated: self.truncated };
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

  /**
   * Identity-bound self-release. The same DELETE the claim-race loser
   * performs, promoted to a verb so a walker can abandon its own claim
   * without a raw tracker write. It only ever unassigns the acting identity
   * — a claim you do not hold is a no-op, never a release of someone else's.
   */
  async release(ref: NodeRef, identity: string): Promise<ReleaseResult> {
    const before = await this.fetchIssue(ref);
    if (before.status === "closed") {
      throw new WorkGraphError("node-closed", `node ${ref.id} is closed — nothing to release`);
    }
    if (!before.assignees.includes(identity)) {
      return { released: false, identity, assignees: before.assignees };
    }
    await this.transport({
      method: "DELETE",
      path: `repos/${this.repo}/issues/${ref.id}/assignees`,
      body: { assignees: [identity] },
    });
    const after = await this.fetchIssue(ref);
    // Filter the re-read defensively, matching the claim-race loser's branch:
    // the DELETE just happened, so the identity is gone even if the re-read
    // reflects a slightly earlier snapshot.
    return { released: true, identity, assignees: after.assignees.filter((login) => login !== identity) };
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

  /** Completion is authority only when its persisted binding matches this closure. */
  private async hasCurrentCloseReceipt(ref: NodeRef, issue: GitHubIssue, completion: NonNullable<WorkGraphNode["completion"]>): Promise<boolean> {
    const node = nodeFromIssue(issue).node;
    if (completion.checkpointId !== node.checkpointId || completion.autonomy !== node.autonomy) return false;
    if (node.autonomy === "auto" && JSON.stringify(completion.autoProbeKeys ?? []) !== JSON.stringify((node.probes ?? []).map((probe) => JSON.stringify(probe)).sort())) return false;
    const [comments, events] = await Promise.all([
      this.listComments(ref),
      this.transport({ method: "GET", path: `repos/${this.repo}/issues/${ref.id}/events`, paginate: true }),
    ]);
    const comment = comments.find((entry) => entry.id === completion.receiptCommentId);
    if (comment === undefined || comment.author !== completion.closer || !isStructurallyValidCloseReceipt(comment.body)) return false;
    const timeline = asArray(events, "issue events").flatMap((entry) => {
      const record = asRecord(entry, "issue event");
      const at = typeof record.created_at === "string" ? Date.parse(record.created_at) : NaN;
      const event = record.event;
      const actor = event === "closed" ? readLogin(record.actor) : undefined;
      return Number.isFinite(at) && (event === "closed" || event === "reopened") ? [{ event, at, actor }] : [];
    }).sort((left, right) => left.at - right.at);
    const close = [...timeline].reverse().find((entry) => entry.event === "closed");
    if (close === undefined || close.actor === undefined) return false;
    const reopened = [...timeline].reverse().find((entry) => entry.event === "reopened" && entry.at < close.at);
    const commentAt = comment.createdAt === undefined ? NaN : Date.parse(comment.createdAt);
    const boundAt = Date.parse(completion.closedAt);
    const checkpoint = /^- \*\*checkpoint:\*\* `([^`\n]+)`$/mu.exec(comment.body)?.[1];
    const autonomy = /^- \*\*autonomy:\*\* `([^`\n]+)`$/mu.exec(comment.body)?.[1];
    return close.actor === completion.closer
      && Number.isFinite(commentAt) && Number.isFinite(boundAt)
      && commentAt === boundAt && commentAt <= close.at && (reopened === undefined || commentAt > reopened.at)
      && checkpoint === completion.checkpointId && autonomy === completion.autonomy;
  }

  /** Bodies included — the read half of {@link postComment}. Paginated: receipts are often the last comment. */
  async listComments(ref: NodeRef): Promise<NodeComment[]> {
    const comments = asArray(
      await this.transport({
        method: "GET",
        path: `repos/${this.repo}/issues/${ref.id}/comments`,
        paginate: true,
      }),
      "listComments",
    );
    return comments.map((entry) => {
      const record = asRecord(entry, "listComments");
      return {
        id: String(readNumber(record, "id", "listComments")),
        author: readLogin(record.user),
        body: typeof record.body === "string" ? record.body : "",
        ...(typeof record.created_at === "string" ? { createdAt: record.created_at } : {}),
        ...(typeof record.html_url === "string" ? { url: record.html_url } : {}),
      };
    });
  }

  async readRawBody(ref: NodeRef): Promise<string> {
    return (await this.fetchIssue(ref)).body;
  }

  async writeRawBody(ref: NodeRef, body: string): Promise<void> {
    await this.transport({
      method: "PATCH",
      path: `repos/${this.repo}/issues/${ref.id}`,
      body: { body },
    });
  }

  /** Receipt first, then the state change: a close that fails halfway leaves the evidence, not a bare closed issue. */
  async close(ref: NodeRef, receipt: CloseReceipt): Promise<void> {
    const issue = await this.fetchIssue(ref);
    const decoded = nodeFromIssue(issue);
    const posted = await this.postComment(ref, renderCloseReceipt(receipt));
    const comment = await this.readComment(posted);
    if (comment.author === undefined || comment.author.length === 0) {
      throw new WorkGraphError("backend", "posted close receipt has no authenticated author");
    }
    const node = decoded.node;
    const completion = {
      receiptCommentId: comment.id,
      checkpointId: receipt.checkpointId,
      autonomy: receipt.autonomy ?? node.autonomy,
      closer: comment.author,
      closedAt: receipt.at,
      ...(node.autonomy === "auto" ? { autoProbeKeys: (node.probes ?? []).map((probe) => JSON.stringify(probe)).sort() } : {}),
    };
    const body = [decoded.text, encodeNodeBlock({ ...node, title: issue.title, completion })]
      .filter((part) => part.length > 0).join("\n\n");
    await this.writeRawBody(ref, body);
    await this.transport({
      method: "PATCH",
      path: `repos/${this.repo}/issues/${ref.id}`,
      body: { state: "closed", state_reason: "completed" },
    });
  }

  /**
   * The sub-issue *parent* edge, which the ordinary REST issue payload does not
   * carry. GitHub's dedicated REST `/parent` endpoint keeps this one-edge read
   * out of the separate GraphQL quota entirely.
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
    try {
      const parent = readIssue(
        await this.transport({ method: "GET", path: `repos/${this.repo}/issues/${issueNumber}/parent` }),
        `parent of issue ${issueNumber}`,
      );
      return parent.number;
    } catch (error) {
      if (isMissingRestResource(error)) return undefined;
      throw error;
    }
  }

  private async fetchIssue(ref: NodeRef): Promise<GitHubIssue> {
    return readIssue(
      await this.transport({ method: "GET", path: `repos/${this.repo}/issues/${ref.id}` }),
      `issue ${ref.id}`,
    );
  }

  private async fetchBlockers(ref: NodeRef): Promise<BlockingRef[]> {
    return asArray(
      await this.transport({
        method: "GET",
        path: `repos/${this.repo}/issues/${ref.id}/dependencies/blocked_by`,
        paginate: true,
      }),
      `node ${ref.id} blocked_by`,
    ).map((entry) => {
      const blocker = readIssue(entry, `node ${ref.id} blocked_by`);
      return { id: String(blocker.number), status: blocker.status };
    });
  }
}

export function createGitHubGraphStore(options: GitHubGraphStoreOptions): GraphStore {
  return new GitHubGraphStore(options);
}
