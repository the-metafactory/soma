/** Spawn budget: the caps `soma graph add` enforces and the growth `soma graph audit` reports. */
import { WorkGraphError, type GraphReadOptions, type NodeRef, type NodeState, type SpawnBudget, type SpawnCap } from "./work-graph";

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
  caps: SpawnBudget;
  /** Set when the root's typed block does not parse, so its caps are unknown; nothing else is read. */
  budgetError?: string;
  children?: number;
  open?: number;
  exceeded: SpawnExcess[];
}

export interface SpawnReport {
  open: number;
  closed: number;
  /** Mean direct children per closed non-root node, two decimals; null with no closed node. */
  spawnRate: number | null;
  caps: SpawnBudget;
  /** Set when the root's typed block does not parse, so its caps are unknown. */
  budgetError?: string;
  /** Present only when the root declares a children cap. */
  overChildrenCap?: { id: string; title: string; children: number }[];
  /** Present only when the root declares an open cap. */
  openOverCap?: boolean;
}

interface SpawnReader {
  readNode(ref: NodeRef, options?: GraphReadOptions): Promise<NodeState>;
  readSubtree(root: NodeRef, options?: GraphReadOptions): Promise<NodeState[]>;
}

const NO_RECEIPTS: GraphReadOptions = { includeCurrentCloseReceipt: false };

export function spawnCaps(root: NodeState): SpawnBudget {
  const declared = root.typed ? root.node.spawnBudget : undefined;
  return {
    ...(declared?.childrenPerNode === undefined ? {} : { childrenPerNode: declared.childrenPerNode }),
    ...(declared?.openNodes === undefined ? {} : { openNodes: declared.openNodes }),
  };
}

/**
 * Read what an add under `parent` would cost against the caps its map root
 * declares. Reads the parent and each ancestor up to the root; then, only when
 * a cap is declared, one subtree: the root's for an open cap, else the parent's.
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
  const base = { parent: parentState.ref.id, root: root.ref.id, caps };
  if (root.parseError !== undefined) return { ...base, budgetError: root.parseError, exceeded: [] };
  if (caps.childrenPerNode === undefined && caps.openNodes === undefined) return { ...base, exceeded: [] };
  const subtree = await graph.readSubtree(caps.openNodes === undefined ? parentState.ref : root.ref, NO_RECEIPTS);
  const children = subtree.filter((state) => state.parent?.id === parentState.ref.id).length;
  const open = subtree.filter((state) => state.status === "open").length;
  const exceeded: SpawnExcess[] = [];
  if (caps.childrenPerNode !== undefined && children >= caps.childrenPerNode) exceeded.push({ cap: "childrenPerNode", node: parentState.ref.id, count: children, limit: caps.childrenPerNode });
  if (caps.openNodes !== undefined && open >= caps.openNodes) exceeded.push({ cap: "openNodes", node: root.ref.id, count: open, limit: caps.openNodes });
  return { ...base, children, ...(caps.openNodes === undefined ? {} : { open }), exceeded };
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
  const { childrenPerNode, openNodes } = caps;
  const overChildrenCap = childrenPerNode === undefined ? undefined : [root, ...descendants]
    .map((state) => ({ id: state.ref.id, title: state.node.title, children: childCount.get(state.ref.id) ?? 0 }))
    .filter((entry) => entry.children > childrenPerNode);
  return {
    open,
    closed: closed.length,
    spawnRate,
    caps,
    ...(root.parseError === undefined ? {} : { budgetError: root.parseError }),
    ...(overChildrenCap === undefined ? {} : { overChildrenCap }),
    ...(openNodes === undefined ? {} : { openOverCap: open > openNodes }),
  };
}
