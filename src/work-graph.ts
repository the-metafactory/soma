/**
 * Work graph — typed contracts (`docs/work-graph.md` §2, DD-16, map #495 / #497).
 *
 * The work graph is Soma's typed primitive for cross-session effort topology:
 * nodes of work joined by blocking edges, walked by agent sessions, closed only
 * through checkpoint gates.
 *
 * Layering, per spec §2.5:
 *
 * - {@link GraphStore} is the **I/O port** — one implementation per backend
 *   (day-one: GitHub, in `./work-graph-github`).
 * - {@link WorkGraph} is the **contract layer** over any store: creation
 *   validation, DAG/cycle rejection, frontier confirmation, claim semantics,
 *   close gating. A second backend inherits every rule for free.
 *
 * Everything crossing the store boundary is parsed, never cast: §2.1 makes
 * `createNode` validation the authoritative barrier ("JSON/store-returned data
 * is never trusted by cast"), because the TS tuple type only guards literal
 * construction sites.
 */

import type { EvidenceKind } from "./types";

/**
 * The only classification the runtime enforces (#485). The work-kind vocabulary
 * (research / prototype / grilling / task) is doctrine owned by consumers such
 * as the orienteer skill, and rides on {@link WorkGraphNodeBase.kind}.
 */
export type WorkGraphAutonomy = "auto" | "propose" | "approve";

/** Deterministic circuit breaker (§3.3) — a cap read at claim/execution time, not a scheduler. */
export interface NodeBudget {
  tokens?: number;
  agentInvocations?: number;
  wallClockMin?: number;
}

/**
 * A machine-checkable expectation (§2.2). Prose probes are `judged` evidence in
 * disguise (#492 correction 1), so there is no free-text variant. `type` alone
 * is the runner's dispatch key — one switch, no nested discriminants.
 */
export type Probe =
  | { type: "command"; run: string; cwd?: string; timeoutSec: number; expectExit: number }
  | { type: "url"; target: string; expectStatus: number }
  | { type: "git-ref-exists"; ref: string; repo?: string }
  | { type: "git-merged-into"; ref: string; into: string; repo?: string }
  | { type: "artifact-exists"; path: string; atRef?: string; repo?: string };

export type ProbeType = Probe["type"];

/**
 * Evidence typed by whether it was *specified up front* and then *actually
 * probed* — the algorithm-runner P1 lesson (self-declared verification is
 * hollow). `state` never flips to `probed` without recorded output.
 */
export type ProbeResult =
  | { probe: Probe; state: "specified" }
  | {
      probe: Probe;
      state: "probed";
      /** ran-and-passed vs ran-and-failed — close requires every probe probed AND passed. */
      outcome: "pass" | "fail";
      /** command: exit code + bounded output tail; url: status; git/artifact: resolved sha / path presence. */
      observed: string;
      /** ISO timestamp of execution. */
      at: string;
      /**
       * The resolved absolute directory this probe was dispatched to (#580) —
       * where it ran, or where it *would* have: the value is fixed before the
       * registry gate, so a refused probe reports the directory it was refused
       * for. That is the directory the adopter has to declare, which is what a
       * reader of a refusal needs.
       *
       * Per result, not per close, because a probe may name its own `cwd`/`repo`
       * and land in a different tree than the close's base — an absolute `cwd`
       * escapes it entirely. Without this, a probe that ran elsewhere would be
       * reported under a tree it never touched: the #579 mislabel one level down.
       *
       * Absent for `url`, which runs against a host and no tree.
       */
      cwd?: string;
    };

export interface WorkGraphNodeBase {
  /** Backend-native identity (GitHub: issue number), assigned by the store — never caller-supplied. */
  id: string;
  title: string;
  /**
   * Free-form doctrine tag (e.g. research, grilling). The runtime never
   * interprets its MEANING but normalizes its FORM at the store boundary:
   * absent is accepted; present is stored trimmed + lowercased, and rejected
   * if it trims to empty.
   */
  kind?: string;
  /**
   * The checkpoint whose completion gate closes this node. May attach after
   * creation, but close REFUSES while it is absent — the required-by-close
   * invariant, enforced in {@link assertClosable}.
   */
  checkpointId?: string;
  budget?: NodeBudget;
}

/**
 * The tuple type on `auto` guards TS literal-construction sites only; the
 * authoritative barrier is {@link parseNodeSpec} at the store boundary. Zero
 * probes on an `auto` node would mean zero machine-checkable evidence at close
 * (§1 clause 1).
 */
export type WorkGraphNode =
  | (WorkGraphNodeBase & { autonomy: "auto"; probes: [Probe, ...Probe[]] })
  | (WorkGraphNodeBase & { autonomy: "propose" | "approve"; probes?: Probe[] });

/** `Omit` over a union collapses it; this preserves the `auto` ⇒ non-empty-probes discrimination. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Opaque handle to a node — backend-native id, the shape callers pass around. */
export interface NodeRef {
  id: string;
}

/**
 * What `createNode` accepts: the node minus its store-assigned id, plus the two
 * fields a *creation* needs that a node does not carry (spec §2.5 leaves the
 * store-facing types open; see the addendum note on #497):
 *
 * - `body` — the human-readable statement of the node. Doctrine puts the
 *   question in the ticket body; without it a created node is a bare title.
 * - `parent` — where the node attaches. `soma graph add <root>` (§2.6) and the
 *   orienteer rule "scaffold nodes attach below their spawning ticket" (#492)
 *   both need it, and `readSubtree(root)` needs the membership edge
 *   it writes.
 * - `labels` — **write-only decoration.** Caller-supplied, so a list view is
 *   readable without opening every issue. Nothing derives them from the node:
 *   they are a second, independent input that happens to describe the same
 *   thing, and keeping them in step is the caller's discipline.
 *
 *   What the runtime *does* guarantee is the half that matters: they are never
 *   read back. `readNode` takes `kind` and `autonomy` from the typed block
 *   alone, so a mistyped or stale label can mislead a human and can never change
 *   what a verb decides. That is what keeps a second input from becoming a
 *   second authority. A backend with no index concept ignores them.
 */
export type CreateNodeSpec = DistributiveOmit<WorkGraphNode, "id"> & {
  body?: string;
  parent?: NodeRef;
  labels?: readonly string[];
};

/** A blocker as seen from the blocked node — status included so the frontier needs no second fetch. */
export interface BlockingRef extends NodeRef {
  status: NodeStatus;
}

export type NodeStatus = "open" | "closed";

/** A node as the store currently reports it. */
export interface NodeState {
  ref: NodeRef;
  node: WorkGraphNode;
  status: NodeStatus;
  assignees: readonly string[];
  blockedBy: readonly BlockingRef[];
  /** Read from the backend's API author field, never from body text (§3.2 conjunct 3). */
  author: string;
  parent?: NodeRef;
  body?: string;
  url?: string;
  /**
   * False when the backing issue carries no typed node block — a hand-authored
   * ticket. Such a node is reported fail-safe as `approve` with no probes: the
   * most-gated class, never `auto`, since nothing declared its probes.
   */
  typed: boolean;
  /** Set when a typed block was present but unreadable. Visible state, never a silent downgrade. */
  parseError?: string;
  /** True only when the production store proved a receipt belongs to this current closure. */
  currentCloseReceipt?: boolean;
}

/**
 * The narrow slice of {@link NodeState} a **status derivation** needs — what the
 * graph publishes to the planSteps bridge (§2.7).
 *
 * It lives here, with the graph, because the graph owns the shape it publishes:
 * declaring it in `src/algorithm.ts` would point the run module at the graph
 * module and invert §2.7's dependency direction, in which a plan step *references*
 * a node and the two scopes never merge.
 *
 * `Pick`ed rather than re-declared: written by hand it was a claim the compiler
 * did not check, and its `blockedBy?` was optional where `NodeState`'s is
 * required — so a report missing the field type-checked and derived `open` on a
 * `blocked` node.
 */
export type BridgedNodeReport = Pick<NodeState, "ref" | "status" | "blockedBy"> & {
  /** Only a receipt-backed close is Soma-complete; tracker state alone is not a gate result. */
  hasCloseReceipt: boolean;
};

/**
 * Outcome of a claim attempt after the store's post-write re-read (§2.4).
 * `held` is the question every caller actually asks; `holder` names the winner
 * when it is someone else.
 */
export interface ClaimResult {
  held: boolean;
  identity: string;
  holder: string | null;
  assignees: readonly string[];
}

/**
 * Outcome of an identity-bound self-release (§2.4). `released` is whether the
 * acting identity actually held the claim and was removed — a release of a
 * claim you never held is a no-op, never an error, and can never remove a
 * different identity (the verb only ever unassigns itself).
 */
export interface ReleaseResult {
  released: boolean;
  identity: string;
  assignees: readonly string[];
}

export interface CommentRef {
  id: string;
  nodeId: string;
  author?: string;
  url?: string;
}

/**
 * A comment as the store reports it — with its body, unlike {@link CommentRef}.
 *
 * Exists for the read paths that must inspect what was actually posted: `audit`
 * asks "does a close receipt exist on this closed node?" and `decisions` reads
 * the gist out of it. Both questions are about tracker *content*, so a
 * ref-shaped answer cannot serve them.
 */
export interface NodeComment {
  id: string;
  author: string;
  body: string;
  /** Tracker-authored creation timestamp, used to bind a receipt to one closure interval. */
  createdAt?: string;
  url?: string;
}

export interface Reaction {
  id: string;
  content: string;
  /** API author field (§2.5) — never parsed out of body text. */
  author: string;
  createdAt?: string;
}

/**
 * Close evidence vocabulary. Extends the repo's {@link EvidenceKind} with the
 * two the graph spec names: `judged` (a model's opinion — informs, never
 * decides, §1 clause 4) and `approved` (an attestation from a credential the
 * agent does not hold, §3.2).
 */
export type WorkGraphEvidenceKind = EvidenceKind | "judged" | "approved";

export interface CloseEvidence {
  kind: WorkGraphEvidenceKind;
  summary: string;
  /** Externally checkable pointer: commit sha, CI run URL, comment id, probe output location. */
  pointer?: string;
}

export type AttestationState = "verified" | "unverified";

/** Backend capability (§2.5): CAN receipts be independently attested here? Necessary, never sufficient. */
export type AttestationCapability = "verifiable" | "unverified";

/**
 * The facts a receipt records, not just the verdict (§3.2). Every input except
 * the confinement result is re-derivable from the tracker indefinitely; the
 * session's credential topology is not, so an unrecorded check leaves a future
 * reader unable to tell *why* a receipt was unverified.
 *
 * Populated by the verb layer, which owns the derivation rule (#498, gated on
 * #502). The contract layer stores and renders it.
 */
/** One line of the confinement check's probe set (§3.2: probe set, result, and timestamp — not just a verdict). */
export interface ConfinementProbeRecord {
  name: string;
  observed: string;
}

/**
 * A ratification recorded on a close receipt.
 *
 * `kind` is deliberately a one-variant discriminant rather than an omitted
 * field. A receipt is a published artifact re-read years later, and *how* this
 * was ratified is part of what it records; a bare `{id, author}` would leave a
 * future reader to infer the mechanism from an id shape. Nothing branches on it
 * today, and nothing should need to.
 *
 * Named rather than spelled inline at each use: dropping the withdrawn
 * `"comment"` member (#525) took a three-file edit, and the next shape change
 * would have taken another.
 */
export interface Ratification {
  /** A reaction, and only ever a reaction — the HITL receipts section of `docs/work-graph.md` has why (#525, #549). */
  kind: "reaction";
  id: string;
  author: string;
}

export interface AttestationFacts {
  backendCapability: AttestationCapability;
  confinement?: {
    checked: boolean;
    reachableIdentities: readonly string[];
    at: string;
    probes?: readonly ConfinementProbeRecord[];
  };
  proposal?: { commentId: string; author: string };
  ratification?: Ratification;
  root?: { nodeId: string; author: string };
  /**
   * Why the verdict came out as it did, one line per failed conjunct — empty on
   * `verified`. The facts above are what a re-audit re-judges; these say which
   * remediation the reader needs, since a wrong ratifier and a reachable keyring
   * look identical in the verdict and are fixed differently.
   */
  reasons?: readonly string[];
}

/**
 * The tree the probes actually ran in (#579, #580).
 *
 * A probe result is only evidence about the thing being closed if it was
 * produced in the thing being closed. That directory used to be ambient — the
 * CLI's process cwd, which the installer's symlink could make some entirely
 * unrelated checkout — and nothing in the receipt said which one it was, so a
 * `bun test` that passed against an ancestor commit read exactly like one that
 * passed against the work. Recording the resolved directory, its HEAD, and
 * whether it was dirty makes a wrong tree *visible* rather than silent.
 *
 * Recorded, never gated: a dirty tree is a fact about the evidence, and #579
 * decided explicitly that it does not refuse the close.
 */
export interface ProbeTree {
  /**
   * Resolved absolute directory. One of these is recorded per directory the
   * declared probes **actually resolve to** — never the base a probe might have
   * ignored by naming its own absolute `cwd`/`repo`, since a receipt describing
   * a tree nothing ran in is the #579 mislabel wearing a new hat.
   */
  dir: string;
  /** HEAD of that directory **as of before the probes ran**, when it is a git tree with a commit. */
  head?: string;
  /** `git status` non-empty there, again before the run — probes may write. Absent when it is not a readable git tree. */
  dirty?: boolean;
}

export interface CloseReceipt {
  /** Must match the node's attached checkpoint — one work item, one completion gate. */
  checkpointId: string;
  closedBy: string;
  /** The node autonomy at the authoritative close write. */
  autonomy?: WorkGraphAutonomy;
  /** ISO timestamp. */
  at: string;
  /**
   * The **human-readable half** of the close: why this node resolved the way it
   * did, in prose (#556).
   *
   * Carried on the receipt rather than posted as a comment of its own so that
   * both halves land in **one write**. Posted separately, the two orderings each
   * lose something: before the probes leaves an orphan resolution on a node whose
   * close then refuses, after them leaves a receipt whose prose failed to post.
   * Folded, neither state is reachable — which is what "two halves of one close"
   * has to mean if it means anything.
   *
   * Optional on the *type*, required by {@link assertClosable} unless the receipt
   * records a proposal, whose body already carries the prose. Optional here
   * because the exemption exists; a required field would make the exempt case
   * unrepresentable.
   */
  resolution?: string;
  /**
   * One line for the map's decision index — the compressed form of
   * {@link CloseReceipt.resolution}, written by the closer at close time.
   *
   * Stored on the receipt because the receipt is the only durable record a
   * close leaves: `soma graph decisions` derives the map's index from receipts,
   * and a gist living anywhere else would make the index a second authoritative
   * home. Optional — a receipt without one still indexes, it just points at the
   * node instead of summarising it.
   */
  gist?: string;
  /**
   * What closed this node — tool version and whether it ran from the dev tree
   * or an install, plus the tool tree's commit when resolvable.
   *
   * Exists because "merged" and "enforced" are different dates (§1 clause 5
   * puts enforcement in the installed binary): a gate shipped at noon binds
   * nothing until the install refreshes, and before this stamp the only way to
   * see which rules a receipt was produced under was to grep the installed
   * tree. Descriptive, never gated on — a stale tool writing an honest stamp
   * beats a stale tool refusing to say so.
   */
  closedWith?: string;
  evidence: readonly CloseEvidence[];
  probeResults: readonly ProbeResult[];
  /**
   * Every distinct tree the declared probes ran in, described as of *before*
   * the run. Empty or absent when nothing directory-bound ran — no probes at
   * all, or `url` probes only, which test a host and no checkout.
   */
  probeTrees?: readonly ProbeTree[];
  attestation: AttestationState;
  attestationFacts?: AttestationFacts;
}

/**
 * Does a probe line need to name its own directory?
 *
 * Only when the trees above it leave it ambiguous: with exactly one recorded
 * tree that the probe ran in, the heading already said it. More than one tree,
 * or a probe that ran in none of them, and the line has to be explicit.
 *
 * One predicate, two readers — the close path and {@link renderCloseReceipt} —
 * because two spellings of "elsewhere" would drift into a receipt that
 * contradicts itself.
 */
export function probeRanOutsideTree(result: ProbeResult, trees: readonly ProbeTree[] | undefined): boolean {
  if (result.state !== "probed" || result.cwd === undefined) return false;
  const recorded = trees ?? [];
  return recorded.length !== 1 || recorded[0].dir !== result.cwd;
}

/**
 * How a probe tree reads in a receipt — one string, used both as the `probed`
 * evidence pointer and in the rendered probe section, so the pointer and the
 * prose can never disagree about which tree was tested.
 */
export function describeProbeTree(tree: ProbeTree, home: string | undefined = process.env.HOME): string {
  const head = tree.head === undefined ? "no HEAD" : `HEAD ${tree.head}`;
  const state = tree.dirty === undefined ? "not a git tree" : tree.dirty ? "dirty" : "clean";
  return `${head} in ${collapseHome(tree.dir, home)} (${state})`;
}

/**
 * `/Users/someone/work/x` → `~/work/x` for anything that gets **published**.
 *
 * A receipt is posted to a tracker whose visibility soma cannot know (§2.2 says
 * the same of probe declarations), and the point of naming the tree is to make
 * a reader able to tell one checkout from another — which the path below `~`
 * already does. The home prefix adds only the local account name, so it is the
 * part to drop. `ProbeTree.dir` itself stays absolute: it is what the runner
 * compares against, and a display convention must not become a comparison one.
 *
 * `home` is a parameter with an ambient default rather than a bare env read, so
 * the rendering stays a function of its inputs when a caller says so.
 */
export function collapseHome(dir: string, home: string | undefined = process.env.HOME): string {
  if (home === undefined || home.length === 0) return dir;
  // Separator-agnostic: the runner has a `win32` branch, so a probe directory
  // can arrive backslash-separated, and a boundary check that only knows `/`
  // would silently publish the full path on the platform it was meant to
  // protect. Compared on a normalised copy; the returned string keeps the
  // caller's own separators.
  const slash = (path: string): string => path.replace(/\\/gu, "/");
  const root = slash(home).replace(/\/+$/u, "");
  const candidate = slash(dir);
  if (candidate === root) return "~";
  return candidate.startsWith(`${root}/`) ? `~${dir.slice(root.length)}` : dir;
}

/**
 * The store seam (§2.5): pure I/O, no contract logic. The tracker is the *sole*
 * authoritative store for topology, claims, and status; soma-home holds at most
 * a disposable derived cache and `nodeId` references, and no sync contract
 * exists (#491).
 *
 * A graph records its backend at creation and lives there forever; moving is a
 * one-way export into a fresh graph.
 */
export interface GraphStore {
  /** Backend capability, not a per-receipt verdict — see {@link AttestationCapability}. */
  readonly attestation: AttestationCapability;
  /** Store assigns the id. Callers reach this through {@link WorkGraph.createNode}, which validates first. */
  createNode(spec: CreateNodeSpec): Promise<NodeRef>;
  addBlockingEdge(blocker: NodeRef, blocked: NodeRef): Promise<void>;
  readNode(ref: NodeRef): Promise<NodeState>;
  /**
   * Every node in the root's membership **subtree**, at any depth, in
   * depth-first pre-order, each reported at its **current** state.
   *
   * **The subtree, not the direct children** (#557). Depth records where a node
   * came from; it never decides whether the frontier reports it. Doctrine puts
   * scaffold below its spawning node, and a one-level walk turned that into
   * invisibility — worse, into invisibility that arrives exactly when the parent
   * closes and the scaffold becomes takeable. Gating is what a blocking edge
   * means and past-the-destination is what a close means; neither is a depth.
   *
   * **This read confirms** (#576). §2.4 once required {@link WorkGraph.frontier}
   * to re-fetch every candidate, a rule written when discovery was assumed to be
   * a lagging search index. Where discovery is already a live read of the
   * authoritative store, the second read buys nothing and costs coherence: N
   * sequential fetches report a state smeared across however long they take,
   * where one traversal is a single observation. A backend that *does* discover
   * through a stale index still owes the second read — internally, before
   * returning — because the obligation attaches to the staleness, not to the
   * ceremony.
   *
   * Three obligations on an implementation:
   *
   * - **Report closed nodes too, and descend through them.** Filtering is the
   *   contract layer's job. Pruning a closed *node* and pruning its *subtree*
   *   are different acts, and scaffold below a closed parent is the common case.
   * - **Never truncate in silence.** A subtree larger than one request returns
   *   must be detected and completed. A false negative is the direction §2.4
   *   cannot recover, so a short list that reads complete is the one failure
   *   this seam must not produce.
   * - **Every returned state must be whole.** A short `assignees` or `blockedBy`
   *   read would make a claimed node look unclaimed or a blocked node look
   *   takeable — now false *positives*, since nothing re-checks downstream.
   *
   * `parent` is expected on every node but the root's own children, where it is
   * the root: a walk knows the edge it arrived on, so reporting it costs nothing.
   *
   * A backend whose membership relation is only ever one level deep still
   * implements this honestly — its subtree of `root` *is* `root`'s members, and
   * pre-order over a single level is their order. What no backend may do is
   * return everything it holds: the result is scoped to the root's membership,
   * so a store that cannot express membership at all cannot implement this
   * seam, and a flat dump is a wrong answer rather than a degenerate one.
   */
  readSubtree(root: NodeRef): Promise<NodeState[]>;
  /** Assigns, then re-reads (no compare-and-swap exists on GitHub) and applies {@link resolveClaimRace}. */
  claim(ref: NodeRef, identity: string): Promise<ClaimResult>;
  /**
   * Identity-bound self-release: removes the acting identity from the node's
   * assignee set (the same DELETE the claim-race loser performs), so a walker
   * can abandon its own claim without a raw tracker write. Never removes a
   * different identity; releasing a claim you do not hold is a no-op.
   */
  release(ref: NodeRef, identity: string): Promise<ReleaseResult>;
  postComment(ref: NodeRef, body: string): Promise<CommentRef>;
  /**
   * Re-read a comment for its API author field. The HITL close path needs the
   * *proposal's* author to evaluate §3.2 conjunct 3, and the two-phase close
   * spans two process invocations — so the author has to come back from the
   * backend rather than be carried on the command line, where it would be
   * caller-authored and therefore exactly the evidence class the conjunct
   * rejects. (Seam addendum, same class as `CreateNodeSpec.body`/`parent` on #497.)
   */
  readComment(ref: CommentRef): Promise<CommentRef>;
  readCommentReactions(ref: CommentRef): Promise<Reaction[]>;
  /**
   * Every comment on a node, in posting order, bodies included. The read half of
   * what {@link postComment} writes — `audit` needs it to tell a gated close
   * from a tracker-side one (#588's auto-close), and `decisions` reads the gist
   * out of the receipt it finds.
   */
  listComments(ref: NodeRef): Promise<NodeComment[]>;
  /**
   * The node's raw body, exactly as stored — node block included, nothing
   * stripped. The write path's counterpart below splices a marked section, and a
   * splice over a *decoded* body would re-write the node block from parsed
   * state, silently normalising what it did not mean to touch.
   */
  readRawBody(ref: NodeRef): Promise<string>;
  /** Replace the node's raw body wholesale. Callers splice; the store writes. */
  writeRawBody(ref: NodeRef, body: string): Promise<void>;
  close(ref: NodeRef, receipt: CloseReceipt): Promise<void>;
}

export type WorkGraphErrorCode =
  | "invalid-node"
  | "invalid-probe"
  | "invalid-edge"
  | "cycle"
  | "node-closed"
  | "close-refused"
  /** The backend failed or answered in a shape the store cannot read. */
  | "backend";

export class WorkGraphError extends Error {
  readonly code: WorkGraphErrorCode;

  constructor(code: WorkGraphErrorCode, message: string) {
    super(message);
    this.name = "WorkGraphError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Parsing — the authoritative barrier at the store boundary (§2.1)
// ---------------------------------------------------------------------------

function asRecord(value: unknown, code: WorkGraphErrorCode, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkGraphError(code, `${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, code: WorkGraphErrorCode, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkGraphError(code, `${context}: "${key}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string, code: WorkGraphErrorCode, context: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkGraphError(code, `${context}: "${key}" must be a non-empty string when present`);
  }
  return value.trim();
}

function requireInteger(record: Record<string, unknown>, key: string, code: WorkGraphErrorCode, context: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new WorkGraphError(code, `${context}: "${key}" must be an integer`);
  }
  return value;
}

function requirePositiveNumber(record: Record<string, unknown>, key: string, code: WorkGraphErrorCode, context: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new WorkGraphError(code, `${context}: "${key}" must be a positive finite number`);
  }
  return value;
}

/**
 * Normalize a work-kind: absent stays absent, present is trimmed + lowercased,
 * empty-after-trim is rejected (§2.1). Form only — the runtime never reads the
 * meaning.
 */
export function normalizeKind(kind: unknown): string | undefined {
  if (kind === undefined || kind === null) return undefined;
  if (typeof kind !== "string") {
    throw new WorkGraphError("invalid-node", `"kind" must be a string when present`);
  }
  const normalized = kind.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new WorkGraphError("invalid-node", `"kind" must not be empty after trimming`);
  }
  return normalized;
}

/** Parse one probe from untrusted input. One switch on `type`, no nested discriminants. */
export function parseProbe(input: unknown): Probe {
  const record = asRecord(input, "invalid-probe", "probe");
  const type = record.type;
  switch (type) {
    case "command": {
      const cwd = optionalString(record, "cwd", "invalid-probe", "command probe");
      return {
        type,
        run: requireString(record, "run", "invalid-probe", "command probe"),
        ...(cwd === undefined ? {} : { cwd }),
        timeoutSec: requirePositiveNumber(record, "timeoutSec", "invalid-probe", "command probe"),
        expectExit: requireInteger(record, "expectExit", "invalid-probe", "command probe"),
      };
    }
    case "url": {
      const expectStatus = requireInteger(record, "expectStatus", "invalid-probe", "url probe");
      if (expectStatus < 100 || expectStatus > 599) {
        throw new WorkGraphError("invalid-probe", `url probe: "expectStatus" must be a valid HTTP status`);
      }
      return { type, target: requireString(record, "target", "invalid-probe", "url probe"), expectStatus };
    }
    case "git-ref-exists": {
      const repo = optionalString(record, "repo", "invalid-probe", "git-ref-exists probe");
      return {
        type,
        ref: requireString(record, "ref", "invalid-probe", "git-ref-exists probe"),
        ...(repo === undefined ? {} : { repo }),
      };
    }
    case "git-merged-into": {
      const repo = optionalString(record, "repo", "invalid-probe", "git-merged-into probe");
      return {
        type,
        ref: requireString(record, "ref", "invalid-probe", "git-merged-into probe"),
        into: requireString(record, "into", "invalid-probe", "git-merged-into probe"),
        ...(repo === undefined ? {} : { repo }),
      };
    }
    case "artifact-exists": {
      const atRef = optionalString(record, "atRef", "invalid-probe", "artifact-exists probe");
      const repo = optionalString(record, "repo", "invalid-probe", "artifact-exists probe");
      return {
        type,
        path: requireString(record, "path", "invalid-probe", "artifact-exists probe"),
        ...(atRef === undefined ? {} : { atRef }),
        ...(repo === undefined ? {} : { repo }),
      };
    }
    default:
      throw new WorkGraphError("invalid-probe", `unknown probe type: ${JSON.stringify(type)}`);
  }
}

function parseBudget(input: unknown): NodeBudget {
  const record = asRecord(input, "invalid-node", "budget");
  const budget: NodeBudget = {};
  for (const key of ["tokens", "agentInvocations", "wallClockMin"] as const) {
    if (record[key] === undefined || record[key] === null) continue;
    budget[key] = requirePositiveNumber(record, key, "invalid-node", "budget");
  }
  if (Object.keys(budget).length === 0) {
    throw new WorkGraphError("invalid-node", `budget must declare at least one cap`);
  }
  return budget;
}

function parseAutonomy(value: unknown): WorkGraphAutonomy {
  if (value === "auto" || value === "propose" || value === "approve") return value;
  throw new WorkGraphError("invalid-node", `"autonomy" must be one of auto | propose | approve`);
}

function parseProbes(value: unknown): Probe[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new WorkGraphError("invalid-probe", `"probes" must be an array when present`);
  }
  return value.map((entry) => parseProbe(entry));
}

/**
 * Labels are presentation, so validation only checks form — non-empty strings,
 * deduplicated, order preserved. There is no vocabulary here on purpose: the
 * runtime never interprets a label, exactly as it never interprets `kind`.
 */
function parseLabels(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new WorkGraphError("invalid-node", `"labels" must be an array of strings`);
  }
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new WorkGraphError("invalid-node", `"labels" entries must be non-empty strings`);
    }
    const label = entry.trim();
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

/**
 * Validate an untrusted node spec at the store boundary. This — not the TS
 * tuple type — is what makes an `auto` node without probes impossible (§2.1).
 */
export function parseNodeSpec(input: unknown): CreateNodeSpec {
  const record = asRecord(input, "invalid-node", "node spec");
  if ("id" in record && record.id !== undefined) {
    throw new WorkGraphError("invalid-node", `"id" is assigned by the store — never caller-supplied`);
  }

  const title = requireString(record, "title", "invalid-node", "node spec");
  const autonomy = parseAutonomy(record.autonomy);
  const kind = normalizeKind(record.kind);
  const checkpointId = optionalString(record, "checkpointId", "invalid-node", "node spec");
  const budget = record.budget === undefined || record.budget === null ? undefined : parseBudget(record.budget);
  const body = optionalString(record, "body", "invalid-node", "node spec");
  const parentId = record.parent === undefined || record.parent === null
    ? undefined
    : requireString(asRecord(record.parent, "invalid-node", "node spec: parent"), "id", "invalid-node", "node spec: parent");
  const probes = parseProbes(record.probes);
  const labels = parseLabels(record.labels);

  const base = {
    title,
    ...(kind === undefined ? {} : { kind }),
    ...(checkpointId === undefined ? {} : { checkpointId }),
    ...(budget === undefined ? {} : { budget }),
    ...(body === undefined ? {} : { body }),
    ...(parentId === undefined ? {} : { parent: { id: parentId } }),
    ...(labels.length === 0 ? {} : { labels }),
  };

  if (autonomy === "auto") {
    if (probes.length === 0) {
      throw new WorkGraphError(
        "invalid-node",
        `an "auto" node needs at least one probe — zero probes means zero machine-checkable evidence at close`,
      );
    }
    return { ...base, autonomy, probes: probes as [Probe, ...Probe[]] };
  }

  return { ...base, autonomy, ...(probes.length === 0 ? {} : { probes }) };
}

/**
 * Attach a store-assigned id to a validated spec, yielding the node proper.
 *
 * `body`, `parent` and `labels` are creation inputs, not node state: the body
 * lives on the issue, the parent is an edge, and a label is a caller-supplied
 * index entry the runtime never reads back. A node carrying them would be a
 * second home for facts that already have one.
 */
export function toNode(id: string, spec: CreateNodeSpec): WorkGraphNode {
  const { body: _body, parent: _parent, labels: _labels, ...rest } = spec;
  return { ...rest, id };
}

// ---------------------------------------------------------------------------
// Claim semantics (§2.4)
// ---------------------------------------------------------------------------

/**
 * The deterministic tie-break every racer computes over the same eventual
 * assignee set (#492 correction 2): the login sorting first by code point holds
 * the claim; every other claimant removes itself. The race converges to one
 * holder without coordination.
 *
 * Code-point comparison, not `localeCompare` — a locale-dependent order would
 * let two machines disagree about the winner, which is exactly the coordination
 * the rule exists to avoid.
 */
export function resolveClaimRace(identity: string, assignees: readonly string[]): { held: boolean; holder: string | null } {
  if (assignees.length === 0) return { held: false, holder: null };
  let winner = assignees[0];
  for (const candidate of assignees) {
    if (candidate < winner) winner = candidate;
  }
  return { held: winner === identity, holder: winner };
}

// ---------------------------------------------------------------------------
// Close gating (§2.1 required-by-close, §3.1/§3.2 admissible evidence)
// ---------------------------------------------------------------------------

/**
 * Evidence the agent cannot author by itself, per autonomy class:
 * `auto` closes on machine-checkable observation, HITL closes on an attestation
 * from a credential the agent does not hold (§3.2). `judged` and `specified`
 * never qualify — a model's opinion informs, never decides (§1 clause 4).
 */
export function agentExternalEvidenceKinds(autonomy: WorkGraphAutonomy): readonly WorkGraphEvidenceKind[] {
  return autonomy === "auto" ? ["probed", "tested"] : ["approved"];
}

/** Canonical identity of a probe, used to pair declared probes with their results. */
function probeKey(probe: Probe): string {
  switch (probe.type) {
    case "command":
      return `command:${probe.run}|${probe.cwd ?? ""}|${probe.timeoutSec}|${probe.expectExit}`;
    case "url":
      return `url:${probe.target}|${probe.expectStatus}`;
    case "git-ref-exists":
      return `git-ref-exists:${probe.ref}|${probe.repo ?? ""}`;
    case "git-merged-into":
      return `git-merged-into:${probe.ref}|${probe.into}|${probe.repo ?? ""}`;
    case "artifact-exists":
      return `artifact-exists:${probe.path}|${probe.atRef ?? ""}|${probe.repo ?? ""}`;
  }
}

/**
 * The hollow-close refusal. Throws unless:
 *
 * 1. the node has an attached checkpoint and the receipt names it — a node
 *    closes only through its checkpoint's completion gate (§2.1, §2.6);
 * 2. every declared probe was actually run and passed — `specified` is a
 *    declaration, `probed` is a fact (§2.2);
 * 3. at least one agent-external evidence entry carries a pointer someone else
 *    can check (§3.1) — what makes the receipt re-auditable by the phase-2
 *    auditor rather than a self-report;
 * 4. the receipt carries a **resolution** — prose saying why the node resolved
 *    as it did — unless it records a proposal, whose body already is that prose
 *    (#556).
 *
 * Conjunct 4 is a different animal from 1–3, and the difference is worth stating
 * rather than blurring: 1–3 check facts a session could not fake — a checkpoint
 * is attached or it is not, a probe ran or it did not, a pointer resolves or it
 * does not. Conjunct 4 checks only that *something was written*, and no machine
 * can check that what was written says anything. It is a **forcing function, not
 * evidence**. Adopted knowingly (#556), on the grounds that the human-readable
 * half is the half a later reader actually reads, and leaving it to discipline
 * left it absent. Read it as such — a conjunct described as verification when it
 * is a prompt to write something would be exactly the self-declared verification
 * DD-16 exists to refuse.
 *
 * `attestation` is deliberately **not** gated on: refusing on `unverified`
 * would deadlock the bootstrap, since the nodes that establish credential
 * separation are themselves `approve`-class (§3.2).
 */
export function assertClosable(node: WorkGraphNode, receipt: CloseReceipt): void {
  const checkpointId = node.checkpointId;
  if (checkpointId === undefined || checkpointId.length === 0) {
    throw new WorkGraphError(
      "close-refused",
      `node ${node.id} has no attached checkpoint — a node closes only through its checkpoint's completion gate`,
    );
  }
  if (receipt.checkpointId !== checkpointId) {
    throw new WorkGraphError(
      "close-refused",
      `receipt names checkpoint ${receipt.checkpointId}, node ${node.id} is gated by ${checkpointId}`,
    );
  }

  const results = new Map(receipt.probeResults.map((result) => [probeKey(result.probe), result]));
  for (const probe of node.probes ?? []) {
    const result = results.get(probeKey(probe));
    if (result === undefined || result.state === "specified") {
      throw new WorkGraphError(
        "close-refused",
        `probe ${probeKey(probe)} on node ${node.id} was specified but never probed`,
      );
    }
    if (result.outcome !== "pass") {
      throw new WorkGraphError("close-refused", `probe ${probeKey(probe)} on node ${node.id} ran and failed`);
    }
  }

  // Prose is required of **every** class, unlike the evidence rule below.
  //
  // The exemption is the two-phase HITL path and only it: `--propose` posted a
  // body, that body *is* the resolution, and requiring a second one would post
  // the same thing twice. A **bare** HITL close has no proposal — it is the
  // normal single-operator route (§3.2) — so it needs prose like any other. The
  // alternative, exempting HITL wholesale, would have let a `grilling` node whose
  // entire output is a decision close with no human-readable half while an `auto`
  // node that merely ran `bun test` was refused for the same omission.
  if (resolutionText(receipt).length === 0 && receipt.attestationFacts?.proposal === undefined) {
    throw new WorkGraphError(
      "close-refused",
      `node ${node.id} closes without a resolution — the receipt carries no prose, and no proposal comment whose body would be it`,
    );
  }

  // Evidence is required of `auto` nodes only, and there it costs nothing: the
  // `probed` entry is derived from probes that already ran and passed.
  //
  // HITL nodes close on the session's say-so, unconditionally — not scoped to
  // single-operator deployments. The receipt still distinguishes the two cases:
  // a bare close records the absence of a proposal and ratification in
  // `attestationFacts.reasons`, so an unratified close is visible rather than
  // prevented. See §3.2.
  if (node.autonomy !== "auto") return;

  const admissible = agentExternalEvidenceKinds(node.autonomy);
  const external = receipt.evidence.filter(
    (entry) => admissible.includes(entry.kind) && entry.summary.trim().length > 0 && (entry.pointer ?? "").trim().length > 0,
  );
  if (external.length === 0) {
    throw new WorkGraphError(
      "close-refused",
      `node ${node.id} (${node.autonomy}) needs at least one ${admissible.join(" or ")} evidence entry with an externally checkable pointer`,
    );
  }
}

/**
 * What a tracker comment can hold. GitHub's hard cap is 65 536 characters; this
 * is the budget a close is allowed to plan for, leaving room for the parts of a
 * receipt that vary (#527).
 *
 * A backend property living at the contract layer, knowingly: `GraphStore` has
 * no way to express "my comments cap at N", and inventing that capability for
 * one number would be a seam change ahead of a second backend that disagrees.
 * When #533's GitLab backend lands with a different limit, this is the constant
 * that moves onto the store.
 */
export const RECEIPT_COMMENT_LIMIT = 65_536;
export const RECEIPT_COMMENT_BUDGET = 60_000;

/** Worst case for one probe line: the failing-case tail plus its markdown furniture. */
const RECEIPT_PROBE_WORST_CASE = 1_500;

/** Header, evidence entries, probe-tree lines and the attestation-facts JSON. */
const RECEIPT_FIXED_OVERHEAD = 3_000;

/**
 * Worst-case size of the receipt a close is about to produce, computable
 * **before any probe runs** (#527).
 *
 * The receipt POST happens after every probe has run, so an oversized receipt
 * used to fail at the most expensive possible moment — which was the real answer
 * to #527's "what stops a chatty probe from filling a tracker comment": nothing
 * did. This is the estimate that moves the refusal to the cheap end.
 *
 * **Worst case means every probe failing**, since that is the receipt that has to
 * fit — a close cannot know its outcomes before it runs, and planning for the
 * passing case would refuse nothing until the day something breaks.
 *
 * The prose counts. #588 put an unbounded, human-written `resolution` on the
 * receipt, riding the same comment; a long resolution and fifty probe lines
 * overrun together, and neither half is at fault alone.
 */
export function estimateReceiptChars(input: { resolution?: string; probeCount: number }): number {
  return (input.resolution ?? "").length + input.probeCount * RECEIPT_PROBE_WORST_CASE + RECEIPT_FIXED_OVERHEAD;
}

/** The marker a receipt comment always carries — what `audit` and `decisions` key on. */
export const CLOSE_RECEIPT_MARKER = "## Close receipt";

/** The gist line inside a rendered receipt. One renderer, one parser — pinned against each other in tests. */
const RECEIPT_GIST_LINE = /^- \*\*gist:\*\* (.+)$/mu;

export interface ReceiptScan {
  /** Did any comment carry a close receipt? `false` on a closed node is the #588 auto-close signature. */
  hasReceipt: boolean;
  /** The gist from the LAST receipt found — a re-close supersedes, so the last word wins. */
  gist?: string;
}

/**
 * Look through a node's comments for its close receipt, and the gist inside it.
 *
 * Parsing rendered markdown is deliberate, not regrettable: the tracker is the
 * sole authoritative store (#491), so the receipt comment IS the durable record
 * — there is no side table to consult. The parse is pinned to
 * {@link renderCloseReceipt}'s exact output in tests, so the pair drifts loudly.
 */
export function isStructurallyValidCloseReceipt(body: string): boolean {
  const autonomy = /^- \*\*autonomy:\*\* `(auto|propose|approve)`$/mu.exec(body)?.[1];
  const hasEvidence = /^- `[^`\n]+` — \S.+$/mu.test(body);
  return body.includes(CLOSE_RECEIPT_MARKER)
    && /^- \*\*checkpoint:\*\* `[^`\n]+`$/mu.test(body)
    && /^- \*\*closed by:\*\* \S.+$/mu.test(body)
    && /^- \*\*at:\*\* \d{4}-\d{2}-\d{2}T[^\n]+$/mu.test(body)
    && /^- \*\*attestation:\*\* `(?:verified|unverified)`$/mu.test(body)
    && /^### Evidence$/mu.test(body)
    && autonomy !== undefined
    && (autonomy !== "auto" || hasEvidence);
}

export function scanCommentsForReceipt(bodies: readonly string[]): ReceiptScan {
  let found: string | undefined;
  for (const body of bodies) {
    if (isStructurallyValidCloseReceipt(body)) found = body;
  }
  if (found === undefined) return { hasReceipt: false };
  const gist = RECEIPT_GIST_LINE.exec(found)?.[1]?.trim();
  return { hasReceipt: true, ...(gist === undefined || gist.length === 0 ? {} : { gist }) };
}

/** Markers bounding the derived decisions section in a map body. */
export const DECISIONS_BEGIN = "<!-- soma:decisions:begin -->";
export const DECISIONS_END = "<!-- soma:decisions:end -->";

/**
 * Replace the marked section of a body, keeping the markers. `undefined` when
 * the markers are absent or malformed — the caller refuses rather than guessing
 * where a decisions list belongs in prose it does not own.
 */
export function spliceSection(body: string, content: string): string | undefined {
  const begin = body.indexOf(DECISIONS_BEGIN);
  if (begin === -1) return undefined;
  const end = body.indexOf(DECISIONS_END, begin + DECISIONS_BEGIN.length);
  if (end === -1) return undefined;
  return `${body.slice(0, begin + DECISIONS_BEGIN.length)}\n${content}\n${body.slice(end)}`;
}

/**
 * The resolution prose, trimmed — `""` when there is none.
 *
 * One expression, two readers: the gate that requires it and the renderer that
 * prints it. Two spellings of "is there prose here" would agree today and drift
 * later into a receipt rendering a paragraph the gate did not count, or a gate
 * counting whitespace the receipt renders as an empty heading (#582's lesson,
 * one type along).
 */
function resolutionText(receipt: CloseReceipt): string {
  return receipt.resolution?.trim() ?? "";
}

/** Render the receipt as the close comment body (§5: checkpoint id + evidence pointers on the tracker). */
export function renderCloseReceipt(receipt: CloseReceipt): string {
  const resolution = resolutionText(receipt);
  const lines: string[] = [
    // The human half first — a later reader reads prose, not a probe table, and
    // burying it under the receipt would make the comment's first screen the half
    // written for machines.
    ...(resolution.length === 0 ? [] : [`## Resolution`, ``, resolution, ``]),
    `## Close receipt`,
    ``,
    `- **checkpoint:** \`${receipt.checkpointId}\``,
    ...((receipt.gist ?? "").trim().length === 0 ? [] : [`- **gist:** ${(receipt.gist ?? "").trim()}`]),
    `- **closed by:** ${receipt.closedBy}`,
    `- **autonomy:** \`${receipt.autonomy ?? "approve"}\``,
    ...((receipt.closedWith ?? "").length === 0 ? [] : [`- **closed with:** ${receipt.closedWith}`]),
    `- **at:** ${receipt.at}`,
    `- **attestation:** \`${receipt.attestation}\``,
    ``,
    `### Evidence`,
    ``,
  ];
  for (const entry of receipt.evidence) {
    lines.push(`- \`${entry.kind}\` — ${entry.summary}${entry.pointer === undefined ? "" : ` (${entry.pointer})`}`);
  }
  if (receipt.probeResults.length > 0) {
    lines.push(``, `### Probes`, ``);
    // Named before the results, not after: a reader who does not know which
    // tree produced them cannot judge a single line below (#579).
    const trees = receipt.probeTrees ?? [];
    if (trees.length === 1) {
      lines.push(`Ran in ${describeProbeTree(trees[0])}.`, ``);
    } else if (trees.length > 1) {
      lines.push(`Ran across ${trees.length} trees:`, ``, ...trees.map((tree) => `- ${describeProbeTree(tree)}`), ``);
    }
    for (const result of receipt.probeResults) {
      // A probe carrying its own `cwd`/`repo` — an absolute one especially —
      // lands in a tree of its own. Reporting it under a single heading is the
      // #579 mislabel one level down, so the line says where it actually ran
      // whenever the heading does not settle it.
      const elsewhere =
        probeRanOutsideTree(result, receipt.probeTrees) && result.state === "probed"
          ? ` [in ${collapseHome(result.cwd ?? "", process.env.HOME)}]`
          : "";
      lines.push(
        result.state === "probed"
          ? `- \`${probeKey(result.probe)}\`${elsewhere} — **${result.outcome}** at ${result.at}: ${result.observed}`
          : `- \`${probeKey(result.probe)}\` — specified, not run`,
      );
    }
  }
  if (receipt.attestationFacts !== undefined) {
    lines.push(``, `### Attestation facts`, ``, "```json", JSON.stringify(receipt.attestationFacts, null, 2), "```");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Contract layer
// ---------------------------------------------------------------------------

/**
 * The rules, over any {@link GraphStore}. Verbs (`soma graph …`, #498) call
 * this; nothing here knows what a tracker is.
 */
export class WorkGraph {
  private readonly store: GraphStore;

  constructor(store: GraphStore) {
    this.store = store;
  }

  /** Backend capability, not a receipt verdict (§2.5). */
  get attestation(): AttestationCapability {
    return this.store.attestation;
  }

  /** Validate at the boundary, then create. Additive mutation — free after structural validation (§1 clause 2). */
  async createNode(spec: unknown): Promise<NodeRef> {
    return await this.store.createNode(parseNodeSpec(spec));
  }

  async readNode(ref: NodeRef): Promise<NodeState> {
    return await this.store.readNode(ref);
  }

  /**
   * Add `blocks(blocker, blocked)` after the structural validation §1 clause 2
   * requires. The graph is a DAG: an edge that would close a cycle is rejected,
   * because `blocks(a,b)` + `blocks(b,a)` removes both nodes from the frontier
   * forever — no claim, no close, no error (§2.3).
   */
  /**
   * #530 finding 4 wanted the ancestor reading shared across the several edges
   * of one `soma graph add`, since the cycle check re-walks overlapping
   * ancestors once per edge. It was built and **reverted on review of #578**.
   *
   * The check is already best-effort against a concurrent writer — GitHub has
   * no compare-and-swap, so read-then-write is never atomic — but sharing a
   * reading across edges widens that window from one check to the whole batch,
   * and a stale ancestor is exactly how a path to `blocked` goes unseen and the
   * cycle this rejects gets written. The saving is real only for an `add` with
   * three or more blockers whose ancestries overlap, which is rare; a
   * structural-validation gate is the wrong place to spend correctness on it.
   */
  async addBlockingEdge(blocker: NodeRef, blocked: NodeRef): Promise<void> {
    if (blocker.id === blocked.id) {
      throw new WorkGraphError("invalid-edge", `node ${blocker.id} cannot block itself`);
    }
    if (await this.reaches(blocker, blocked.id)) {
      throw new WorkGraphError(
        "cycle",
        `blocks(${blocker.id}, ${blocked.id}) would close a cycle — ${blocked.id} already blocks ${blocker.id} transitively`,
      );
    }
    await this.store.addBlockingEdge(blocker, blocked);
  }

  /** Walk blockers upward from `start`, looking for `targetId`. Visited-guarded against pre-existing cycles. */
  private async reaches(start: NodeRef, targetId: string): Promise<boolean> {
    const seen = new Set<string>([start.id]);
    const queue: NodeRef[] = [start];
    // The array iterator re-reads `length` each step, so nodes pushed below are
    // visited in this same loop — a breadth-first walk over a growing queue.
    for (const current of queue) {
      const state = await this.store.readNode(current);
      for (const blocker of state.blockedBy) {
        if (blocker.id === targetId) return true;
        if (seen.has(blocker.id)) continue;
        seen.add(blocker.id);
        queue.push({ id: blocker.id });
      }
    }
    return false;
  }

  /**
   * Frontier = open ∧ unassigned ∧ all blockers closed (§2.4), over the root's
   * whole membership subtree.
   *
   * **A pure filter over one read** (#576) — no re-fetch, because
   * {@link GraphStore.readSubtree} is required to report live state and
   * therefore confirms. That contract, and why the second read cost coherence
   * rather than buying it, is stated once on the seam method; spec §2.4 is
   * normative.
   *
   * False *negatives* remain unrecoverable — the frontier is advisory and may
   * return short, self-healing on a later tick. Correctness rests on the claim
   * and close gates, never on frontier completeness.
   *
   * Known fail-open path (phase 1): "blockers closed" derives purely from
   * tracker status, so a blocker hand-closed via raw tracker writes releases
   * its dependents without any checkpoint gate having run. Accepted in phase 1
   * and, until the phase-2 auditor is built, undetected as well as unprevented.
   */
  async frontier(root: NodeRef): Promise<NodeState[]> {
    const subtree = await this.store.readSubtree(root);
    const confirmed: NodeState[] = [];
    const seen = new Set<string>();
    for (const state of subtree) {
      if (seen.has(state.ref.id)) continue;
      seen.add(state.ref.id);
      if (state.status !== "open") continue;
      if (state.assignees.length > 0) continue;
      if (state.blockedBy.some((blocker) => blocker.status !== "closed")) continue;
      confirmed.push(state);
    }
    return confirmed;
  }

  /**
   * Claim = becoming the node's sole assignee, written before any work (§2.4).
   * Refuses on a closed node: claiming what is already done is never the
   * intent, and it would silently reopen the race on a settled receipt.
   */
  async claim(ref: NodeRef, identity: string): Promise<ClaimResult> {
    const state = await this.store.readNode(ref);
    if (state.status === "closed") {
      throw new WorkGraphError("node-closed", `node ${ref.id} is closed — nothing to claim`);
    }
    return await this.store.claim(ref, identity);
  }

  /**
   * Identity-bound self-release (§2.4). Refuses on a closed node, matching
   * {@link claim}: a settled receipt is not the place to mutate the assignee
   * set, and there is nothing to abandon on a closed node.
   */
  async release(ref: NodeRef, identity: string): Promise<ReleaseResult> {
    const state = await this.store.readNode(ref);
    if (state.status === "closed") {
      throw new WorkGraphError("node-closed", `node ${ref.id} is closed — nothing to release`);
    }
    return await this.store.release(ref, identity);
  }

  async postComment(ref: NodeRef, body: string): Promise<CommentRef> {
    return await this.store.postComment(ref, body);
  }

  async readComment(ref: CommentRef): Promise<CommentRef> {
    return await this.store.readComment(ref);
  }

  async readCommentReactions(ref: CommentRef): Promise<Reaction[]> {
    return await this.store.readCommentReactions(ref);
  }

  async listComments(ref: NodeRef): Promise<NodeComment[]> {
    return await this.store.listComments(ref);
  }

  /** The raw subtree read `frontier` filters — exposed for the walks that need every node (audit, decisions). */
  async readSubtree(root: NodeRef): Promise<NodeState[]> {
    return await this.store.readSubtree(root);
  }

  async readRawBody(ref: NodeRef): Promise<string> {
    return await this.store.readRawBody(ref);
  }

  async writeRawBody(ref: NodeRef, body: string): Promise<void> {
    await this.store.writeRawBody(ref, body);
  }

  /**
   * Consuming mutation (§1 clause 2): gated by {@link assertClosable} against
   * the node as the store currently reports it — never against a caller-supplied
   * copy, which the agent authors.
   */
  async close(ref: NodeRef, receipt: CloseReceipt): Promise<void> {
    const state = await this.store.readNode(ref);
    if (state.status === "closed") {
      throw new WorkGraphError("node-closed", `node ${ref.id} is already closed`);
    }
    assertClosable(state.node, receipt);
    await this.store.close(ref, { ...receipt, autonomy: state.node.autonomy });
  }
}
