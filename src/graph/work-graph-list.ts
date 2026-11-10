/**
 * Node listing (node #1155): the bounded page behind `soma graph list`.
 *
 * The seam is {@link GraphStore.listNodes}; this module holds what both backends
 * must answer identically — the request bounds, the projection from a node
 * state to a listing row, the cursor, and the page taken from a subtree already
 * read whole. Forge pagination itself stays in each backend, because GitHub and
 * GitLab paginate differently and neither difference is a contract.
 *
 * The cursor is deliberately **opaque**: a versioned base64url JSON object. The
 * caller may only hand `next` back, which is what lets each backend carry its
 * own continuation (a forge page cursor on GitHub, a page cursor plus a local
 * skip on GitLab, an offset inside a subtree) without the CLI knowing which.
 */

import {
  NODE_LIST_MAX_LIMIT,
  NODE_LIST_STATES,
  WorkGraphError,
  type NodeListPage,
  type NodeListRequest,
  type NodeListing,
  type NodeRef,
  type NodeState,
} from "./work-graph";
import { validateRepoRef } from "./work-graph-ref";

/**
 * Refuse a request outside the seam's bounds **before** the store reads
 * anything. The CLI checks the same bounds for a usage error; this is the
 * library caller's barrier, and the one both backends run first.
 */
export function assertNodeListRequest(request: NodeListRequest): void {
  const repo = validateRepoRef(request.repo);
  if (!(NODE_LIST_STATES as readonly string[]).includes(request.state)) {
    throw new WorkGraphError(
      "invalid-node",
      `node list state must be one of ${NODE_LIST_STATES.join(", ")}, not ${JSON.stringify(request.state)}`,
    );
  }
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > NODE_LIST_MAX_LIMIT) {
    throw new WorkGraphError(
      "invalid-node",
      `node list limit must be an integer from 1 to ${NODE_LIST_MAX_LIMIT}, not ${String(request.limit)}`,
    );
  }
  if (request.cursor?.length === 0) {
    throw new WorkGraphError("invalid-node", `node list of ${repo.path}: the cursor must not be empty`);
  }
}

/**
 * The one projection from a full node state to a listing row.
 *
 * `permitted` drops a parent the read scope denies to `unavailable: true`, the
 * way `scopeNodeState` does for every other scoped read: the membership edge is
 * reported as present, its foreign identity is not content we may read.
 */
export function toNodeListing(state: NodeState, permitted: (ref: NodeRef) => boolean = () => true): NodeListing {
  const parent = state.parent === undefined || permitted(state.parent) ? state.parent : { id: state.parent.id, unavailable: true as const };
  return {
    ref: state.ref,
    title: state.node.title,
    status: state.status,
    ...(state.node.kind === undefined ? {} : { kind: state.node.kind }),
    ...(parent === undefined ? {} : { parent }),
    ...(state.url === undefined ? {} : { url: state.url }),
  };
}

/**
 * Page a subtree that was read whole.
 *
 * A root-scoped listing reads the root's membership (the same read `frontier`
 * and `decisions` make) and then pages over it in traversal order. The cursor
 * records the root it belongs to and how many rows were already returned, so a
 * cursor from another root — or one whose subtree shrank underneath it —
 * refuses instead of silently skipping or repeating rows.
 */
export function pageNodeListings(
  root: string,
  states: readonly NodeState[],
  request: NodeListRequest,
  permitted?: (ref: NodeRef) => boolean,
): NodeListPage {
  const rows = states
    .map((state) => toNodeListing(state, permitted))
    .filter((row) => request.state === "all" || row.status === request.state);
  const start = request.cursor === undefined ? 0 : readSubtreeOffset(request.cursor, root);
  if (start > rows.length) {
    throw new WorkGraphError(
      "backend",
      `node listing of ${root}: the cursor is past the end of the subtree it was issued for; start again without a cursor`,
    );
  }
  const page = rows.slice(start, start + request.limit);
  const next = start + page.length < rows.length ? encodeNodeListCursor({ root, at: start + page.length }) : null;
  return { nodes: page, next };
}

/** The opaque listing cursor: a versioned base64url JSON object, never interpreted by a caller. */
export function encodeNodeListCursor(payload: Readonly<Record<string, string | number>>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...payload }), "utf8").toString("base64url");
}

/** Decode a cursor this module issued, or refuse. Each backend validates its own fields after this. */
export function decodeNodeListCursor(cursor: string, context: string): Record<string, unknown> {
  const unreadable = new WorkGraphError(
    "invalid-node",
    `${context}: the cursor is not one this verb issued; pass the previous page's next verbatim`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch (error) {
    // Only the unparseable cursor is the caller's mistake this can explain; a
    // decode failure of any other kind is a bug and must not read as bad input.
    if (error instanceof SyntaxError) throw unreadable;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw unreadable;
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) throw unreadable;
  return record;
}

/** The row offset a subtree cursor records, refused when it was issued for another root. */
function readSubtreeOffset(cursor: string, root: string): number {
  const decoded = decodeNodeListCursor(cursor, `node listing of ${root}`);
  const at = decoded.at;
  if (decoded.root !== root || typeof at !== "number" || !Number.isInteger(at) || at < 0) {
    throw new WorkGraphError(
      "invalid-node",
      `node listing of ${root}: the cursor was issued for another subtree; pass the previous page's next verbatim`,
    );
  }
  return at;
}
