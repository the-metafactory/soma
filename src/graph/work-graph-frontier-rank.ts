/** Frontier order: what a node unblocks, then how shallow it sits, then how old it is, then its id. */
import type { NodeRef, NodeState } from "./work-graph";

export interface FrontierRank {
  /** Distinct open subtree nodes this node blocks, transitively. */
  unblocks: number;
  /** 1 for the root's direct children. */
  depth: number;
}

function nodeNumber(id: string): number {
  const digits = /(\d+)$/u.exec(id)?.[1];
  return digits === undefined ? Number.POSITIVE_INFINITY : Number(digits);
}

/** Rank every node of one subtree read; only open nodes count as unblocked, and only edges inside the subtree count. */
export function rankSubtree(root: NodeRef, subtree: readonly NodeState[]): Map<string, FrontierRank> {
  const depth = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const state of subtree) {
    const parent = state.parent?.id;
    if (!depth.has(state.ref.id)) depth.set(state.ref.id, parent === undefined || parent === root.id ? 1 : (depth.get(parent) ?? 0) + 1);
    if (state.status !== "open") continue;
    for (const blocker of state.blockedBy) {
      const list = dependents.get(blocker.id) ?? [];
      if (!list.includes(state.ref.id)) list.push(state.ref.id);
      dependents.set(blocker.id, list);
    }
  }
  const ranks = new Map<string, FrontierRank>();
  for (const id of depth.keys()) {
    const reached = new Set<string>();
    const queue = [id];
    for (const current of queue) {
      for (const next of dependents.get(current) ?? []) {
        if (next === id || reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    ranks.set(id, { unblocks: reached.size, depth: depth.get(id) ?? 1 });
  }
  return ranks;
}

export function compareFrontier(ranks: ReadonlyMap<string, FrontierRank>): (a: NodeState, b: NodeState) => number {
  return (a, b) => {
    const ra = ranks.get(a.ref.id) ?? { unblocks: 0, depth: Number.POSITIVE_INFINITY };
    const rb = ranks.get(b.ref.id) ?? { unblocks: 0, depth: Number.POSITIVE_INFINITY };
    if (ra.unblocks !== rb.unblocks) return rb.unblocks - ra.unblocks;
    if (ra.depth !== rb.depth) return ra.depth < rb.depth ? -1 : 1;
    const na = nodeNumber(a.ref.id);
    const nb = nodeNumber(b.ref.id);
    if (na !== nb) return na < nb ? -1 : 1;
    return a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0;
  };
}
