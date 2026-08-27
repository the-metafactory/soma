/**
 * The work graph's **read seam for non-graph consumers** — today the planSteps
 * bridge (`docs/work-graph.md` §2.7), which needs to read a node without owning
 * a `GraphStore` or knowing how a repo is resolved.
 *
 * It lives in core rather than in `src/cli/`, where it started: the bridge's own
 * argument is that a second reader means a second answer to "which node backs
 * this step", and a seam only the CLI can import forces a library, MCP or daemon
 * consumer — every one of which can already reach the *write* half through
 * `src/index.ts` — to re-implement repo resolution and become exactly that second
 * reader.
 */
import { WorkGraph } from "./work-graph";
import type { BridgedNodeReport, GraphStore } from "./work-graph";
import { createGitHubGraphStore } from "./work-graph-github";
import { runCommand } from "./work-graph-probes";

/** `owner/name` out of any of the URL shapes a GitHub remote takes. */
export function parseRepoFromRemote(remote: string): string | undefined {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u.exec(remote.trim());
  if (match === null) return undefined;
  return `${match[1]}/${match[2]}`;
}

/**
 * Which repository backs this graph. One implementation on purpose: the probe
 * registry is scoped by repo identity, so `soma policy probes` has to resolve it
 * the same way `soma graph` does — two answers to "which repo" would mean an
 * adopter declaring commands under a key the close path never looks at.
 */
export async function resolveGraphRepo(): Promise<string> {
  const configured = process.env.SOMA_GRAPH_REPO;
  if (configured !== undefined && configured.trim().length > 0) return configured.trim();

  const remote = await runCommand({ argv: ["git", "remote", "get-url", "origin"], timeoutSec: 30 });
  if (remote.exitCode === 0) {
    const parsed = parseRepoFromRemote(remote.stdout);
    if (parsed !== undefined) return parsed;
  }

  throw new Error("Cannot tell which repository backs this graph. Pass --repo <owner/name> or set SOMA_GRAPH_REPO.");
}

export interface ReadNodeForBridgeOptions {
  /** Explicit `owner/name`; falls back to {@link resolveGraphRepo}. */
  repo?: string;
  /** Injectable so a consumer can supply its own backend or a test double. */
  createStore?: (repo: string) => GraphStore;
  resolveRepo?: () => Promise<string>;
}

/**
 * Read one node for a bridge consumer — the same `WorkGraph.readNode` the
 * `soma graph node` verb calls, over the same repo resolution.
 */
export async function readNodeForBridge(nodeId: string, options: ReadNodeForBridgeOptions = {}): Promise<BridgedNodeReport> {
  const createStore = options.createStore ?? ((repo: string) => createGitHubGraphStore({ repo }));
  const repo = options.repo ?? (await (options.resolveRepo ?? resolveGraphRepo)());
  const store = createStore(repo);
  const state = await new WorkGraph(store).readNode({ id: nodeId });
  // The production GraphStore binds this to the current tracker close; bridge
  // consumers never inspect comments and therefore cannot bless stale receipts.
  return { ref: state.ref, status: state.status, blockedBy: state.blockedBy, hasCloseReceipt: state.currentCloseReceipt === true };
}
