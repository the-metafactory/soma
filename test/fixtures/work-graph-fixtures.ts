import type { NodeRef, NodeState } from "../../src/index";

/**
 * The reference `GraphStore.readSubtree` walk, for test fakes.
 *
 * Two fakes had grown their own copy, which is how the seam's semantics start
 * drifting from each other and from the real backend — the same "two answers"
 * problem the production code avoids by assembling `NodeState` in one place.
 * A fake supplies only what makes it a fake: how to find children, and how to
 * read one node.
 *
 * Matches the contract in {@link GraphStore.readSubtree}: depth-first pre-order,
 * closed nodes reported and descended through, the root excluded, `parent` set
 * to the edge the walk arrived on, and a `seen` guard so a node reachable twice
 * appears once.
 */
export async function walkFakeSubtree(
  root: NodeRef,
  childrenOf: (id: string) => readonly string[],
  readNode: (ref: NodeRef) => Promise<NodeState>,
): Promise<NodeState[]> {
  const states: NodeState[] = [];
  const seen = new Set<string>([root.id]);

  const walk = async (parent: NodeRef): Promise<void> => {
    for (const id of childrenOf(parent.id)) {
      if (seen.has(id)) continue;
      seen.add(id);
      states.push({ ...(await readNode({ id })), parent });
      await walk({ id });
    }
  };

  await walk(root);
  return states;
}
