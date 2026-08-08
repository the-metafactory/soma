/**
 * `soma graph` — the CLI verb layer over the GraphStore seam
 * (`docs/work-graph.md` §2.6, #498).
 *
 * Five verbs, exactly the spec's list:
 *
 * ```
 * soma graph frontier <root>   open, unassigned, unblocked — confirmed by direct fetch
 * soma graph node <id>         read one node — also the planSteps bridge's read path (§2.7)
 * soma graph claim <node>      assign, re-read, tie-break on race
 * soma graph add <root> …      create node (+ edges) — additive, structurally validated
 * soma graph close <node>      runs declared probes; refuses a hollow close
 * ```
 *
 * The rules live in {@link WorkGraph} and {@link assertClosable}; this module
 * only gathers inputs, calls them, and renders. Two things it *does* own,
 * because they are close-time derivations rather than contract logic:
 *
 * - **Probe execution** — declared probes run here (§2.2) and their results go
 *   into the receipt.
 * - **Attestation derivation** — the four conjuncts of §3.2, never a config flag.
 *
 * Evidence is derived from the two mechanisms the spec names — passed probes
 * (`probed`, §3.1) and a ratified proposal (`approved`, §3.2) — rather than
 * hand-written by the closing session, which would be the self-declared
 * verification the whole design exists to refuse. `--evidence` adds entries; it
 * cannot substitute for either.
 */

import {
  WorkGraph,
  WorkGraphError,
  agentExternalEvidenceKinds,
  assertClosable,
  renderCloseReceipt,
  type CloseEvidence,
  type CloseReceipt,
  type CommentRef,
  type GraphStore,
  type NodeRef,
  type NodeState,
  type Probe,
  type ProbeResult,
  type Ratification,
  type Reaction,
  type WorkGraphEvidenceKind,
} from "../work-graph";
import {
  checkConfinement as defaultCheckConfinement,
  deriveAttestation,
  findGraphRoot,
  type ConfinementResult,
} from "../work-graph-attestation";
import { createGitHubGraphStore } from "../work-graph-github";
import {
  isProbeRefusal,
  loadProbeRegistry as defaultLoadProbeRegistry,
  type ProbeRegistry,
} from "../work-graph-probe-registry";
import { allProbesPassed, runCommand, runProbes as defaultRunProbes } from "../work-graph-probes";
// Repo resolution and the bridge's node read live in `../work-graph-bridge` (core),
// not here: a seam only `src/cli/` can import forces a library/MCP/daemon consumer
// to re-implement it, becoming the second reader §2.7 forbids. No re-export — the
// other importers point at core directly, so there is one path to each symbol.
import { resolveGraphRepo } from "../work-graph-bridge";
import { SomaCliError } from "./errors";
import { readOption } from "./parse-utils";

const GRAPH_ACTIONS = ["frontier", "node", "claim", "add", "close"] as const;
type GraphAction = (typeof GRAPH_ACTIONS)[number];

const EVIDENCE_KINDS: readonly WorkGraphEvidenceKind[] = ["specified", "probed", "tested", "judged", "approved"];

export const GRAPH_COMMAND_HELP: { usage: string; subcommands: Record<GraphAction, string> } = {
  usage: "Usage: soma graph <frontier|node|claim|add|close> ...",
  subcommands: {
    frontier: "Usage: soma graph frontier <root> [--repo <owner/name>] [--json]",
    node: "Usage: soma graph node <id> [--repo <owner/name>] [--json]",
    claim: "Usage: soma graph claim <id> [--identity <login>] [--repo <owner/name>] [--json]",
    add: "Usage: soma graph add <root> --title <text> --autonomy <auto|propose|approve> [--kind <k>] [--label <name>]... [--body <text>|--body-file <path>] [--checkpoint <id>] [--probe <json>]... [--blocked-by <id>]... [--budget-tokens <n>] [--budget-invocations <n>] [--budget-minutes <n>] [--repo <owner/name>] [--json]",
    close:
      "Usage: soma graph close <id> [--propose --body <text>|--body-file <path>] [--proposal-comment <id>] [--checkpoint <id>] [--evidence <json>]... [--identity <login>] [--dry-run] [--repo <owner/name>]",
  },
};

interface GraphSharedOptions {
  repo?: string;
  json?: boolean;
}

export interface ParsedGraphFrontierArgs {
  command: "graph";
  action: "frontier";
  target: string;
  options: GraphSharedOptions;
}

export interface ParsedGraphNodeArgs {
  command: "graph";
  action: "node";
  target: string;
  options: GraphSharedOptions;
}

export interface ParsedGraphClaimArgs {
  command: "graph";
  action: "claim";
  target: string;
  options: GraphSharedOptions & { identity?: string };
}

export interface ParsedGraphAddArgs {
  command: "graph";
  action: "add";
  target: string;
  options: GraphSharedOptions & {
    /** Untyped on purpose — {@link WorkGraph.createNode} is the one validation barrier (§2.1). */
    spec: Record<string, unknown>;
    blockedBy: string[];
  };
}

export interface ParsedGraphCloseArgs {
  command: "graph";
  action: "close";
  target: string;
  options: GraphSharedOptions & {
    propose?: boolean;
    body?: string;
    bodyFile?: string;
    proposalComment?: string;
    checkpointId?: string;
    identity?: string;
    dryRun?: boolean;
    evidence: CloseEvidence[];
  };
}

export type ParsedGraphArgs =
  | ParsedGraphFrontierArgs
  | ParsedGraphNodeArgs
  | ParsedGraphClaimArgs
  | ParsedGraphAddArgs
  | ParsedGraphCloseArgs;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isGraphAction(value: string | undefined): value is GraphAction {
  return value !== undefined && (GRAPH_ACTIONS as readonly string[]).includes(value);
}

function readShared(options: GraphSharedOptions, args: string[], index: number, arg: string): number | undefined {
  switch (arg) {
    case "--repo":
      options.repo = readOption(args, index, arg);
      return index + 1;
    case "--json":
      options.json = true;
      return index;
    default:
      return undefined;
  }
}

function readPositiveInteger(args: string[], index: number, arg: string): number {
  const raw = readOption(args, index, arg);
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${arg} must be a positive integer.`);
  }
  return Number(raw);
}

function parseJsonOption(raw: string, arg: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${arg} must be valid JSON.`);
  }
}

function parseEvidenceOption(raw: string): CloseEvidence {
  const value = parseJsonOption(raw, "--evidence");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`--evidence must be a JSON object: {"kind":"tested","summary":"…","pointer":"…"}`);
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`--evidence "kind" must be one of: ${EVIDENCE_KINDS.join(", ")}.`);
  }
  const summary = record.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    throw new Error(`--evidence "summary" must be a non-empty string.`);
  }
  const pointer = record.pointer;
  if (pointer !== undefined && typeof pointer !== "string") {
    throw new Error(`--evidence "pointer" must be a string when present.`);
  }
  return {
    kind: kind as WorkGraphEvidenceKind,
    summary,
    ...(pointer === undefined ? {} : { pointer }),
  };
}

function requireTarget(action: GraphAction, target: string | undefined): string {
  if (target === undefined || target.startsWith("--") || target.trim().length === 0) {
    throw new Error(GRAPH_COMMAND_HELP.subcommands[action]);
  }
  return target.trim();
}

function parseAddArgs(target: string, rest: string[]): ParsedGraphAddArgs {
  const options: ParsedGraphAddArgs["options"] = { spec: {}, blockedBy: [] };
  const probes: unknown[] = [];
  const labels: string[] = [];
  const budget: Record<string, number> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const shared = readShared(options, rest, index, arg);
    if (shared !== undefined) {
      index = shared;
      continue;
    }

    switch (arg) {
      case "--title":
        options.spec.title = readOption(rest, index, arg);
        index += 1;
        break;
      case "--autonomy":
        options.spec.autonomy = readOption(rest, index, arg);
        index += 1;
        break;
      case "--kind":
        options.spec.kind = readOption(rest, index, arg);
        index += 1;
        break;
      case "--body":
        options.spec.body = readOption(rest, index, arg);
        index += 1;
        break;
      case "--body-file":
        options.spec.bodyFile = readOption(rest, index, arg);
        index += 1;
        break;
      case "--checkpoint":
        options.spec.checkpointId = readOption(rest, index, arg);
        index += 1;
        break;
      case "--probe":
        probes.push(parseJsonOption(readOption(rest, index, arg), arg));
        index += 1;
        break;
      case "--blocked-by":
        options.blockedBy.push(readOption(rest, index, arg));
        index += 1;
        break;
      case "--label":
        labels.push(readOption(rest, index, arg));
        index += 1;
        break;
      case "--budget-tokens":
        budget.tokens = readPositiveInteger(rest, index, arg);
        index += 1;
        break;
      case "--budget-invocations":
        budget.agentInvocations = readPositiveInteger(rest, index, arg);
        index += 1;
        break;
      case "--budget-minutes":
        budget.wallClockMin = readPositiveInteger(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (probes.length > 0) options.spec.probes = probes;
  if (labels.length > 0) options.spec.labels = labels;
  if (Object.keys(budget).length > 0) options.spec.budget = budget;
  if (options.spec.title === undefined) {
    throw new Error("soma graph add is missing required option: --title.");
  }
  if (options.spec.autonomy === undefined) {
    throw new Error("soma graph add is missing required option: --autonomy.");
  }

  return { command: "graph", action: "add", target, options };
}

function parseCloseArgs(target: string, rest: string[]): ParsedGraphCloseArgs {
  const options: ParsedGraphCloseArgs["options"] = { evidence: [] };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const shared = readShared(options, rest, index, arg);
    if (shared !== undefined) {
      index = shared;
      continue;
    }

    switch (arg) {
      case "--propose":
        options.propose = true;
        break;
      case "--body":
        options.body = readOption(rest, index, arg);
        index += 1;
        break;
      case "--body-file":
        options.bodyFile = readOption(rest, index, arg);
        index += 1;
        break;
      case "--proposal-comment":
        options.proposalComment = readOption(rest, index, arg);
        index += 1;
        break;
      case "--checkpoint":
        options.checkpointId = readOption(rest, index, arg);
        index += 1;
        break;
      case "--identity":
        options.identity = readOption(rest, index, arg);
        index += 1;
        break;
      case "--evidence":
        options.evidence.push(parseEvidenceOption(readOption(rest, index, arg)));
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.propose === true && options.body === undefined && options.bodyFile === undefined) {
    throw new Error("soma graph close --propose needs --body or --body-file.");
  }
  // `--propose` posts a public comment and returns before the dry-run branch is
  // ever reached, so the two together would write exactly what `--dry-run`
  // promises not to. Refuse the combination rather than silently honouring one.
  if (options.propose === true && options.dryRun === true) {
    throw new Error(
      "soma graph close --propose cannot be combined with --dry-run: proposing posts a comment, which is a write.",
    );
  }

  return { command: "graph", action: "close", target, options };
}

export function parseGraphArgs(args: string[]): ParsedGraphArgs {
  const [command, action, target, ...rest] = args;

  if (command !== "graph" || !isGraphAction(action)) {
    throw new Error(GRAPH_COMMAND_HELP.usage);
  }

  const resolvedTarget = requireTarget(action, target);

  if (action === "add") return parseAddArgs(resolvedTarget, rest);
  if (action === "close") return parseCloseArgs(resolvedTarget, rest);

  const options: GraphSharedOptions & { identity?: string } = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const shared = readShared(options, rest, index, arg);
    if (shared !== undefined) {
      index = shared;
      continue;
    }
    if (arg === "--identity" && action === "claim") {
      options.identity = readOption(rest, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (action === "claim") return { command, action, target: resolvedTarget, options };
  return { command, action, target: resolvedTarget, options };
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface GraphCliDeps {
  createStore: (repo: string) => GraphStore;
  resolveRepo: () => Promise<string>;
  resolveIdentity: () => Promise<string>;
  /**
   * The registry is loaded per close and handed to the runner rather than read
   * inside it: one place decides which repo's declarations apply, and the
   * refusal messages can name the document the adopter has to edit.
   *
   * Takes the repo and **nothing else**. There is deliberately no caller-supplied
   * path: the registry's location is the one thing the closing session may not
   * choose, or it authorises itself by pointing at a file it just wrote. An
   * adopter whose soma home is not `~/.soma` configures that for the environment,
   * never per invocation.
   */
  loadProbeRegistry: (repo: string) => Promise<ProbeRegistry>;
  runProbes: (probes: readonly Probe[], registry: ProbeRegistry) => Promise<ProbeResult[]>;
  checkConfinement: () => Promise<ConfinementResult>;
  /**
   * An anchor for probe evidence — the commit the probes ran against.
   *
   * "Externally checkable" is the bar `assertClosable` states, and this clears it
   * only partly: the default reads `git rev-parse HEAD` in the CLI's own cwd, so
   * it names a commit that may be unpushed, and that is the *runner's* tree
   * rather than any tree a probe chose via `repo`. A reader can re-derive what it
   * points at; they cannot always fetch it. Recorded rather than papered over —
   * making it strictly external (refuse an unpushed sha) is a change to what
   * closes an `auto` node, which is a decision, not a default.
   */
  evidencePointer: () => Promise<string | undefined>;
  readTextFile: (path: string) => Promise<string>;
  now: () => Date;
  warn: (message: string) => void;
  /** True when the running CLI is the dev tree rather than the installed binary (§1 clause 5). */
  fromDevTree: boolean;
}

async function gh(args: string[]): Promise<string> {
  const outcome = await runCommand({ argv: ["gh", ...args], timeoutSec: 60 });
  if (outcome.exitCode !== 0) {
    throw new SomaCliError(`gh ${args.join(" ")} failed (exit ${outcome.exitCode}): ${outcome.stderr.trim()}`, 1);
  }
  return outcome.stdout.trim();
}

async function defaultEvidencePointer(): Promise<string | undefined> {
  const head = await runCommand({ argv: ["git", "rev-parse", "HEAD"], timeoutSec: 30 });
  if (head.exitCode !== 0) return undefined;
  const sha = head.stdout.trim();
  return sha.length === 0 ? undefined : `HEAD ${sha}`;
}

function defaultDeps(): GraphCliDeps {
  return {
    createStore: (repo) => createGitHubGraphStore({ repo }),
    resolveRepo: resolveGraphRepo,
    resolveIdentity: async () => await gh(["api", "user", "--jq", ".login"]),
    loadProbeRegistry: async (repo) => await defaultLoadProbeRegistry({ repo }),
    runProbes: async (probes, registry) => await defaultRunProbes(probes, { registry }),
    checkConfinement: async () =>
      await defaultCheckConfinement({
        runCommand,
        env: process.env,
        platform: process.platform,
        now: () => new Date(),
      }),
    evidencePointer: defaultEvidencePointer,
    readTextFile: async (path) => await Bun.file(path).text(),
    now: () => new Date(),
    warn: (message) => process.stderr.write(`${message}\n`),
    // The dev tree ships `src/`; an installed soma does not run from one.
    fromDevTree: import.meta.url.includes("/src/cli/"),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function describeProbes(probes: readonly Probe[] | undefined): string[] {
  if (probes === undefined || probes.length === 0) return ["probes: none declared"];
  return ["probes:", ...probes.map((probe) => `  - ${JSON.stringify(probe)}`)];
}

function renderNodeState(state: NodeState): string {
  const node = state.node;
  return [
    `node: ${state.ref.id}`,
    `title: ${node.title}`,
    `status: ${state.status}`,
    `autonomy: ${node.autonomy}`,
    `kind: ${node.kind ?? "—"}`,
    `checkpoint: ${node.checkpointId ?? "—"}`,
    `author: ${state.author.length > 0 ? state.author : "—"}`,
    `assignees: ${state.assignees.length > 0 ? state.assignees.join(", ") : "—"}`,
    `parent: ${state.parent?.id ?? "—"}`,
    `blocked by: ${
      state.blockedBy.length > 0
        ? state.blockedBy.map((blocker) => `${blocker.id} (${blocker.status})`).join(", ")
        : "—"
    }`,
    `typed: ${state.typed}${state.typed ? "" : " (no readable node block — reported fail-safe as approve with no probes)"}`,
    ...(state.parseError === undefined ? [] : [`parse error: ${state.parseError}`]),
    ...describeProbes(node.probes),
    ...(state.url === undefined ? [] : [`url: ${state.url}`]),
  ].join("\n");
}

function nodeSummary(state: NodeState): string {
  const node = state.node;
  const tags = [node.autonomy, node.kind ?? "no kind", state.typed ? "typed" : "untyped"].join(", ");
  return `- ${state.ref.id} ${node.title} [${tags}]`;
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

async function runFrontier(parsed: ParsedGraphFrontierArgs, graph: WorkGraph, repo: string): Promise<string> {
  const confirmed = await graph.frontier({ id: parsed.target });

  if (parsed.options.json === true) {
    return JSON.stringify({ repo, root: parsed.target, frontier: confirmed }, null, 2);
  }

  return [
    `Work graph frontier — root ${parsed.target} (${repo})`,
    "",
    ...(confirmed.length > 0 ? confirmed.map((state) => nodeSummary(state)) : ["- none"]),
    "",
    `${confirmed.length} node(s) open, unassigned, and unblocked.`,
    "Advisory (§2.4): the frontier can read short when membership edges are missing or the tracker index lags.",
  ].join("\n");
}

async function runNode(parsed: ParsedGraphNodeArgs, graph: WorkGraph, repo: string): Promise<string> {
  const state = await graph.readNode({ id: parsed.target });
  if (parsed.options.json === true) {
    return JSON.stringify({ repo, ...state }, null, 2);
  }
  return [`Work graph node ${parsed.target} (${repo})`, "", renderNodeState(state)].join("\n");
}

async function runClaim(
  parsed: ParsedGraphClaimArgs,
  graph: WorkGraph,
  repo: string,
  deps: GraphCliDeps,
): Promise<string> {
  const identity = parsed.options.identity ?? (await deps.resolveIdentity());
  const result = await graph.claim({ id: parsed.target }, identity);

  if (parsed.options.json === true) {
    const rendered = JSON.stringify({ repo, node: parsed.target, ...result }, null, 2);
    if (!result.held) throw new SomaCliError(rendered, 1);
    return rendered;
  }

  if (!result.held) {
    throw new SomaCliError(
      [
        `Node ${parsed.target} is held by ${result.holder ?? "another session"} — code-point tie-break (§2.4).`,
        `${identity} withdrew its assignment; assignees now: ${result.assignees.join(", ") || "—"}`,
      ].join("\n"),
      1,
    );
  }

  return [
    `Claimed node ${parsed.target} as ${identity} (${repo}).`,
    `assignees: ${result.assignees.join(", ")}`,
  ].join("\n");
}

async function resolveBody(
  deps: GraphCliDeps,
  body: string | undefined,
  bodyFile: string | undefined,
): Promise<string | undefined> {
  if (bodyFile !== undefined) return await deps.readTextFile(bodyFile);
  return body;
}

async function runAdd(
  parsed: ParsedGraphAddArgs,
  graph: WorkGraph,
  repo: string,
  deps: GraphCliDeps,
): Promise<string> {
  const { bodyFile, ...rest } = parsed.options.spec;
  const body = await resolveBody(deps, typeof rest.body === "string" ? rest.body : undefined, typeof bodyFile === "string" ? bodyFile : undefined);

  const created = await graph.createNode({
    ...rest,
    ...(body === undefined ? {} : { body }),
    parent: { id: parsed.target },
  });

  // The node exists from here on. An edge that fails leaves it created but
  // under-blocked, so the failure has to name what did land — silently
  // surfacing a node on the frontier that should have been blocked is worse
  // than an error that says so.
  // One call rather than one per edge, so the cycle check reads each ancestor
  // once for the whole batch instead of once per blocker (#530 finding 4).
  // Written edges are reported as they land, which is what lets the failure
  // message stay exactly as specific as it was when this was a loop.
  const written: string[] = [];
  try {
    await graph.addBlockingEdges(
      parsed.options.blockedBy.map((id) => ({ id })),
      created,
      (blocker) => written.push(blocker.id),
    );
  } catch (error) {
    // Blockers are attempted in order, so the one that failed is the first not
    // yet written — an index, not a string match against the message.
    const blockerId = parsed.options.blockedBy[written.length] ?? "unknown";
    const edges = written.map((id) => `${created.id} blocked by ${id}`);
    throw new SomaCliError(
      [
        `Created node ${created.id} under ${parsed.target}, then failed to add "blocked by ${blockerId}":`,
        error instanceof Error ? error.message : String(error),
        edges.length > 0 ? `Edges already written: ${edges.join("; ")}` : "No blocking edges were written.",
        `Node ${created.id} is on the frontier until its remaining blockers are wired.`,
      ].join("\n"),
      1,
    );
  }
  const edges = written.map((id) => `${created.id} blocked by ${id}`);

  if (parsed.options.json === true) {
    return JSON.stringify({ repo, node: created.id, parent: parsed.target, blockedBy: parsed.options.blockedBy }, null, 2);
  }

  return [
    `Created node ${created.id} under ${parsed.target} (${repo}).`,
    ...(edges.length > 0 ? ["", "Blocking edges:", ...edges.map((edge) => `- ${edge}`)] : []),
  ].join("\n");
}

/**
 * Pick the ratifying reaction (§3.2). A 👎 from the graph root's author is an
 * explicit refusal, so no ratification is taken from that comment at all —
 * otherwise a third party's 👍 could carry a close over the one person whose
 * approval conjunct 4 actually asks for.
 */
export function selectRatification(
  reactions: readonly Reaction[],
  proposalAuthor: string,
  rootAuthor: string | undefined,
): Ratification | undefined {
  if (
    rootAuthor !== undefined &&
    reactions.some((reaction) => reaction.content === "-1" && reaction.author === rootAuthor)
  ) {
    return undefined;
  }

  const approvals = reactions
    .filter((reaction) => reaction.content === "+1" && reaction.author !== proposalAuthor)
    .sort((left, right) => (left.author < right.author ? -1 : left.author > right.author ? 1 : 0));

  if (approvals.length === 0) return undefined;
  const preferred = approvals.find((reaction) => reaction.author === rootAuthor) ?? approvals[0];
  return { kind: "reaction", id: preferred.id, author: preferred.author };
}

async function runClose(
  parsed: ParsedGraphCloseArgs,
  graph: WorkGraph,
  store: GraphStore,
  repo: string,
  deps: GraphCliDeps,
): Promise<string> {
  const ref: NodeRef = { id: parsed.target };
  const state = await graph.readNode(ref);

  if (parsed.options.propose === true) {
    const body = await resolveBody(deps, parsed.options.body, parsed.options.bodyFile);
    if (body === undefined || body.trim().length === 0) {
      throw new SomaCliError("soma graph close --propose needs a non-empty --body or --body-file.", 1);
    }
    // Posting is a write, and phase one must not publish a proposal that phase
    // two will refuse: a node with no attached checkpoint cannot close at all,
    // and no verb attaches one afterwards, so the 👍 it collects would be
    // permanently unusable. Check what is checkable now — the probes have not
    // run yet, so this is the checkpoint and nothing more.
    if (state.node.checkpointId === undefined || state.node.checkpointId.length === 0) {
      throw new SomaCliError(
        [
          `Node ${ref.id} has no attached checkpoint, so it cannot close — proposing would publish a comment nobody can act on.`,
          `Attach one to the node block first; there is no verb that adds it after creation.`,
        ].join("\n"),
        1,
      );
    }
    const comment = await graph.postComment(ref, body);
    return [
      `Posted proposal comment ${comment.id} on node ${ref.id} (${repo}).`,
      comment.url === undefined ? undefined : `url: ${comment.url}`,
      "",
      "The receipt is a 👍 on THIS comment from the graph root's author (§3.2). Once it is there:",
      `  soma graph close ${ref.id} --proposal-comment ${comment.id}`,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }

  if (deps.fromDevTree) {
    deps.warn(
      "Warning: `soma graph close` is running from the dev tree. §1 clause 5 puts enforcement in the installed binary — a close gated by the tree it guards is not gated.",
    );
  }

  // `assertClosable` counts any admissible-kind entry carrying a pointer, and it
  // cannot tell one the runtime derived from one the caller typed — a receipt is
  // just a receipt by the time it gets there. So the distinction has to be
  // enforced where it still exists: here, at the boundary where caller-supplied
  // and derived evidence are still separate values. Without this, `--evidence
  // '{"kind":"approved",…}'` closes an approve-class node with no proposal and no
  // human, which is §3.2 defeated by a flag.
  const reserved = agentExternalEvidenceKinds(state.node.autonomy);
  const usurping = parsed.options.evidence.filter((entry) => reserved.includes(entry.kind));
  if (usurping.length > 0) {
    throw new SomaCliError(
      [
        `--evidence cannot carry ${reserved.map((kind) => `\`${kind}\``).join(" or ")} on a ${state.node.autonomy}-class node.`,
        `Those kinds are what closes it, so the runtime derives them — ${
          state.node.autonomy === "auto"
            ? "from probes that ran and passed (§3.1)"
            : "from a ratified proposal comment (§3.2)"
        } — and a hand-written one would be exactly the self-declared verification the gate exists to refuse.`,
        `Refused: ${usurping.map((entry) => `${entry.kind} — ${entry.summary}`).join("; ")}`,
        `Use --evidence for informational kinds (${EVIDENCE_KINDS.filter((kind) => !reserved.includes(kind)).join(", ")}).`,
      ].join("\n"),
      1,
    );
  }

  const identity = parsed.options.identity ?? (await deps.resolveIdentity());
  const probes = state.node.probes ?? [];
  const registry = await deps.loadProbeRegistry(repo);
  const probeResults = await deps.runProbes(probes, registry);
  const refusals = probeResults.filter((result) => isProbeRefusal(result));

  // A refused probe reaches `assertClosable` as "ran and failed", which is true
  // but useless to act on. Surface it here instead, where the reason — and the
  // exact entry to declare — is still in hand. A dry run keeps going: showing
  // the whole receipt is the point of asking for one.
  if (refusals.length > 0 && parsed.options.dryRun !== true) {
    throw new SomaCliError(
      [
        `Close refused: ${refusals.length} of ${probeResults.length} declared probe(s) are not authorised on this machine.`,
        "",
        ...refusals.map((refusal) => (refusal.state === "probed" ? refusal.observed : "")),
        "",
        "Nothing was written. The registry is yours to edit — soma has no verb that widens it (§4: loosening is identity-bound).",
      ].join("\n"),
      1,
    );
  }

  const evidence: CloseEvidence[] = [...parsed.options.evidence];
  if (probes.length > 0 && allProbesPassed(probeResults)) {
    const pointer = await deps.evidencePointer();
    if (pointer !== undefined) {
      evidence.push({
        kind: "probed",
        summary: `${probeResults.length}/${probeResults.length} declared probes ran and passed`,
        pointer,
      });
    }
  }

  const root = await findGraphRoot(ref, async (nodeRef) => await graph.readNode(nodeRef), state);

  let proposal: { commentId: string; author: string } | undefined;
  let ratification: Ratification | undefined;

  // A proposal comment is optional now: a HITL node closes on the session's
  // say-so (§3.2). When one IS supplied, its reactions still carry weight —
  // a ratification as admissible evidence, and a root-author 👎 as a refusal.
  //
  // Keyed on the comment id alone, deliberately. `assertClosable` no longer
  // distinguishes `propose` from `approve` from anything else non-`auto`, so a
  // CLI-side autonomy test would be the only place in the system still drawing a
  // line the core does not — a distinction living in one consumer is worse than
  // no distinction at all. Supplying a proposal on an `auto` node is unusual
  // rather than wrong: its reactions are read on the same terms.
  const commentId = parsed.options.proposalComment;
  if (commentId !== undefined) {
    const proposalRef: CommentRef = await graph.readComment({ id: commentId, nodeId: ref.id });
    proposal = { commentId: proposalRef.id, author: proposalRef.author ?? "" };
    const reactions = await graph.readCommentReactions(proposalRef);

    // Ratification is no longer required; an explicit refusal is still surfaced.
    //
    // Deliberately a speed bump, not a control, and it lives here in the CLI
    // rather than in `assertClosable` because it is not a contract rule. It
    // catches the honest case — you were told no and closed anyway by reflex —
    // and it stops nobody who means to proceed: a fresh `--propose` mints a new
    // comment with no reactions, and passing that id closes cleanly. Binding
    // proposals to superseded ones, or threading reactions through the receipt
    // so the core could enforce it, is machinery this primitive does not want.
    const vetoed = reactions.some(
      (reaction) => reaction.content === "-1" && root?.author !== undefined && reaction.author === root.author,
    );
    if (vetoed) {
      throw new SomaCliError(
        [
          `Node ${ref.id} was refused: ${root?.author ?? "the graph root's author"} left a 👎 on proposal comment ${proposal.commentId}.`,
          `Nothing here can stop you closing anyway — this is a reminder, not a gate.`,
        ].join("\n"),
        1,
      );
    }

    ratification = selectRatification(reactions, proposal.author, root?.author);
    if (ratification !== undefined) {
      evidence.push({
        kind: "approved",
        summary: `ratified by ${ratification.author} via ${ratification.kind} on proposal comment ${proposal.commentId}`,
        pointer: proposalRef.url ?? `comment:${proposal.commentId}`,
      });
    }
  }

  const confinement = await deps.checkConfinement();
  const { attestation, facts } = deriveAttestation({
    backendCapability: store.attestation,
    actingIdentity: identity,
    confinement,
    ...(proposal === undefined ? {} : { proposal }),
    ...(ratification === undefined ? {} : { ratification }),
    ...(root === undefined ? {} : { root }),
  });

  const receipt: CloseReceipt = {
    checkpointId: parsed.options.checkpointId ?? state.node.checkpointId ?? "",
    closedBy: identity,
    at: deps.now().toISOString(),
    evidence,
    probeResults,
    attestation,
    attestationFacts: facts,
  };

  if (parsed.options.dryRun === true) {
    let verdict = "would be ACCEPTED";
    try {
      assertClosable(state.node, receipt);
    } catch (error) {
      verdict = `would be REFUSED — ${error instanceof WorkGraphError ? error.message : String(error)}`;
    }
    return [
      `Dry run for node ${ref.id} (${repo}) — nothing written.`,
      `close ${verdict}`,
      ...(refusals.length > 0
        ? ["", `Probe registry: ${refusals.length} of ${probeResults.length} probe(s) refused (${registry.path}).`]
        : []),
      "",
      renderCloseReceipt(receipt),
    ].join("\n");
  }

  await graph.close(ref, receipt);

  return [
    `Closed node ${ref.id} (${repo}) — attestation: ${attestation}.`,
    ...(attestation === "unverified" && facts.reasons !== undefined
      ? ["", "Unverified because:", ...facts.reasons.map((reason) => `- ${reason}`)]
      : []),
    "",
    "Receipt posted to the tracker.",
  ].join("\n");
}

export async function runGraphCli(parsed: ParsedGraphArgs, overrides: Partial<GraphCliDeps> = {}): Promise<string> {
  const deps: GraphCliDeps = { ...defaultDeps(), ...overrides };
  const repo = parsed.options.repo ?? (await deps.resolveRepo());
  const store = deps.createStore(repo);
  const graph = new WorkGraph(store);

  switch (parsed.action) {
    case "frontier":
      return await runFrontier(parsed, graph, repo);
    case "node":
      return await runNode(parsed, graph, repo);
    case "claim":
      return await runClaim(parsed, graph, repo, deps);
    case "add":
      return await runAdd(parsed, graph, repo, deps);
    case "close":
      return await runClose(parsed, graph, store, repo, deps);
  }
}
