/**
 * Measure the `soma graph` read path against a live tracker (#530, #576).
 *
 * Counts and times **every backend call** each verb makes, because that is what
 * the read path actually costs: on the reference GitHub backend, 100% of
 * frontier wall-clock is `gh` subprocess and network, and the per-invocation
 * floor is ~600ms. Spawn *count* is therefore the honest unit — wall-clock
 * numbers from this script describe the network you ran it on.
 *
 * This is a measuring tool, not a gate. #530 decided against a latency target
 * ("do no obviously-wasted work" is the standing rule instead), so nothing here
 * asserts; the one-round-trip property is pinned in `test/work-graph-github.test.ts`
 * by counting transport calls against a fake, which is deterministic.
 *
 *   bun run measure-graph-read-path -- --root 495 [--repo owner/name] [--node 530]
 *
 * Needs a `gh` authenticated for the repo, and makes only read calls.
 */
import { WorkGraph, createGhCliTransport, createGitHubGraphStore, type GitHubApiRequest } from "../src/index";

interface Call {
  label: string;
  ms: number;
}

function parseArgs(argv: readonly string[]): { repo?: string; root: string; node?: string } {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg?.startsWith("--") !== true) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    options.set(arg.slice(2), value);
    index += 1;
  }
  const root = options.get("root");
  if (root === undefined) throw new Error("usage: --root <node-id> [--repo owner/name] [--node <node-id>]");
  return { root, ...(options.has("repo") ? { repo: options.get("repo") as string } : {}), ...(options.has("node") ? { node: options.get("node") as string } : {}) };
}

/** Wraps the real transport so every call is attributed and timed. */
function instrument(): { transport: ReturnType<typeof createGhCliTransport>; calls: Call[] } {
  const inner = createGhCliTransport();
  const calls: Call[] = [];
  const transport = async (request: GitHubApiRequest): Promise<unknown> => {
    const label =
      request.path === "graphql"
        ? String((request.body?.query as string) ?? "").includes("subIssues")
          ? "graphql subtree walk"
          : "graphql parent lookup"
        : // Collapse issue numbers so repeated calls group.
          `${request.method} ${request.path.replace(/\d+/g, "N")}`;
    const started = performance.now();
    try {
      return await inner(request);
    } finally {
      calls.push({ label, ms: performance.now() - started });
    }
  };
  return { transport, calls };
}

function report(name: string, calls: readonly Call[], wallMs: number): void {
  const grouped = new Map<string, { n: number; ms: number }>();
  for (const call of calls) {
    const entry = grouped.get(call.label) ?? { n: 0, ms: 0 };
    entry.n += 1;
    entry.ms += call.ms;
    grouped.set(call.label, entry);
  }
  const inBackend = calls.reduce((total, call) => total + call.ms, 0);
  const share = wallMs === 0 ? 0 : Math.round((inBackend / wallMs) * 100);
  console.log(`\n=== ${name} ===`);
  console.log(`wall ${wallMs.toFixed(0)}ms · ${calls.length} spawn(s) · ${inBackend.toFixed(0)}ms in gh (${share}% of wall)`);
  for (const [label, entry] of [...grouped].sort((a, b) => b[1].ms - a[1].ms)) {
    console.log(`  ${String(entry.n).padStart(3)}× ${entry.ms.toFixed(0).padStart(6)}ms  avg ${(entry.ms / entry.n).toFixed(0).padStart(4)}ms  ${label}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const repo = args.repo ?? "the-metafactory/soma";

  {
    const { transport, calls } = instrument();
    const graph = new WorkGraph(createGitHubGraphStore({ repo, transport }));
    const started = performance.now();
    const frontier = await graph.frontier({ id: args.root });
    report(`frontier ${args.root} → ${frontier.length} node(s)`, calls, performance.now() - started);
  }

  if (args.node !== undefined) {
    const { transport, calls } = instrument();
    const graph = new WorkGraph(createGitHubGraphStore({ repo, transport }));
    const started = performance.now();
    await graph.readNode({ id: args.node });
    report(`node ${args.node}`, calls, performance.now() - started);
  }
}

await main();
