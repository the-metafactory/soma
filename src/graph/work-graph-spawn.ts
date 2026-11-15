/** Spawn budget: the caps `soma graph add` enforces and the growth `soma graph audit` reports. */
import { DEFAULT_CHILDREN_PER_NODE, WorkGraphError, type GraphReadOptions, type NodeRef, type NodeState } from "./work-graph";

export const SPAWN_CAPS = ["childrenPerNode", "openNodes"] as const;
export type SpawnCap = (typeof SPAWN_CAPS)[number];

export interface SpawnCaps {
  childrenPerNode: number;
  /** False when the default applies because the root declares none. */
  childrenPerNodeDeclared: boolean;
  openNodes?: number;
}

export interface SpawnExcess {
  cap: SpawnCap;
  /** The parent for `childrenPerNode`, the map root for `openNodes`. */
  node: string;
  count: number;
  limit: number;
}

export interface SpawnCheck {
  parent: string;
  root: string;
  caps: SpawnCaps;
  children: number;
  open?: number;
  exceeded: SpawnExcess[];
}

export interface SpawnReport {
  open: number;
  closed: number;
  /** Mean direct children per closed non-root node, two decimals; null with no closed node. */
  spawnRate: number | null;
  caps: SpawnCaps;
  overChildrenCap: { id: string; title: string; children: number }[];
  openOverCap: boolean;
}

interface SpawnReader {
  readNode(ref: NodeRef, options?: GraphReadOptions): Promise<NodeState>;
  readSubtree(root: NodeRef, options?: GraphReadOptions): Promise<NodeState[]>;
}

const NO_RECEIPTS: GraphReadOptions = { includeCurrentCloseReceipt: false };

export function spawnCaps(root: NodeState): SpawnCaps {
  const declared = root.typed ? root.node.spawnBudget : undefined;
  return {
    childrenPerNode: declared?.childrenPerNode ?? DEFAULT_CHILDREN_PER_NODE,
    childrenPerNodeDeclared: declared?.childrenPerNode !== undefined,
    ...(declared?.openNodes === undefined ? {} : { openNodes: declared.openNodes }),
  };
}

/**
 * Read what an add under `parent` would cost: the parent's direct children and,
 * when the map root declares an open cap, the root's open descendants. Reads
 * the parent, each ancestor up to the root, and one subtree (the root's when an
 * open cap is declared, otherwise the parent's).
 */
export async function checkSpawnBudget(graph: SpawnReader, parent: NodeRef): Promise<SpawnCheck> {
  const parentState = await graph.readNode(parent, NO_RECEIPTS);
  const seen = new Set<string>([parentState.ref.id]);
  let root = parentState;
  while (root.parent !== undefined) {
    if (seen.has(root.parent.id)) throw new WorkGraphError("cycle", `the parent chain above ${parentState.ref.id} loops through ${root.parent.id}`);
    seen.add(root.parent.id);
    root = await graph.readNode(root.parent, NO_RECEIPTS);
  }
  const caps = spawnCaps(root);
  const subtree = await graph.readSubtree(caps.openNodes === undefined ? parentState.ref : root.ref, NO_RECEIPTS);
  const children = subtree.filter((state) => state.parent?.id === parentState.ref.id).length;
  const open = caps.openNodes === undefined ? undefined : subtree.filter((state) => state.status === "open").length;
  const exceeded: SpawnExcess[] = [];
  if (children >= caps.childrenPerNode) exceeded.push({ cap: "childrenPerNode", node: parentState.ref.id, count: children, limit: caps.childrenPerNode });
  if (open !== undefined && caps.openNodes !== undefined && open >= caps.openNodes) exceeded.push({ cap: "openNodes", node: root.ref.id, count: open, limit: caps.openNodes });
  return { parent: parentState.ref.id, root: root.ref.id, caps, children, ...(open === undefined ? {} : { open }), exceeded };
}

/** Growth over one map: `root` and its descendants as `readSubtree` returns them. */
export function spawnReport(root: NodeState, descendants: readonly NodeState[]): SpawnReport {
  const caps = spawnCaps(root);
  const childCount = new Map<string, number>();
  for (const state of descendants) {
    if (state.parent !== undefined) childCount.set(state.parent.id, (childCount.get(state.parent.id) ?? 0) + 1);
  }
  const closed = descendants.filter((state) => state.status === "closed");
  const open = descendants.length - closed.length;
  const spawned = closed.reduce((sum, state) => sum + (childCount.get(state.ref.id) ?? 0), 0);
  const spawnRate = closed.length === 0 ? null : Math.round((spawned / closed.length) * 100) / 100;
  const overChildrenCap = [root, ...descendants]
    .map((state) => ({ id: state.ref.id, title: state.node.title, children: childCount.get(state.ref.id) ?? 0 }))
    .filter((entry) => entry.children > caps.childrenPerNode);
  return { open, closed: closed.length, spawnRate, caps, overChildrenCap, openOverCap: caps.openNodes !== undefined && open > caps.openNodes };
}
