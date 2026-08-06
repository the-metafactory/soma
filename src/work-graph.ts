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
 *   both need it, and `listCandidateFrontier(root)` needs the membership edge
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
}

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

export interface CommentRef {
  id: string;
  nodeId: string;
  author?: string;
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

export interface AttestationFacts {
  backendCapability: AttestationCapability;
  confinement?: {
    checked: boolean;
    reachableIdentities: readonly string[];
    at: string;
    probes?: readonly ConfinementProbeRecord[];
  };
  proposal?: { commentId: string; author: string };
  ratification?: { kind: "reaction" | "comment"; id: string; author: string };
  root?: { nodeId: string; author: string };
  /**
   * Why the verdict came out as it did, one line per failed conjunct — empty on
   * `verified`. The facts above are what a re-audit re-judges; these say which
   * remediation the reader needs, since a wrong ratifier and a reachable keyring
   * look identical in the verdict and are fixed differently.
   */
  reasons?: readonly string[];
}

export interface CloseReceipt {
  /** Must match the node's attached checkpoint — one work item, one completion gate. */
  checkpointId: string;
  closedBy: string;
  /** ISO timestamp. */
  at: string;
  evidence: readonly CloseEvidence[];
  probeResults: readonly ProbeResult[];
  attestation: AttestationState;
  attestationFacts?: AttestationFacts;
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
  /** Candidates only — hits are re-confirmed by {@link WorkGraph.frontier} via direct fetch. */
  listCandidateFrontier(root: NodeRef): Promise<NodeRef[]>;
  /** Assigns, then re-reads (no compare-and-swap exists on GitHub) and applies {@link resolveClaimRace}. */
  claim(ref: NodeRef, identity: string): Promise<ClaimResult>;
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
 *    auditor rather than a self-report.
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

  // Evidence is required of `auto` nodes only, and there it costs nothing: the
  // `probed` entry is derived from probes that already ran and passed.
  //
  // HITL nodes close on the session's say-so. Requiring a ratified proposal here
  // was the original rule, and it was wrong for what this primitive is: a way to
  // structure work whose route is unclear, walked by a human who is *present*.
  // A gate naming no consumer is ceremony (§1 clause 3), and where one person
  // walks a map the ratification gate named none — nobody else could ratify, so
  // it did not verify the close, it only prevented it. #499 is the worked
  // example: finished, merged, evidenced work that the gate refused, protecting
  // no one.
  //
  // The removal is UNCONDITIONAL, not scoped to single-operator deployments, and
  // that is the deliberate part. "How many people are watching" is not derivable
  // — two attempts to derive it failed review — so conditioning the gate on it
  // would condition it on a guess. A multi-party deployment instead gets the
  // receipt: proposal, ratifier, root authorship and confinement are all still
  // recorded, so an unratified close is visible rather than prevented. If a
  // consumer appears who needs it gated, it returns as an opt-in naming them.
  //
  // The receipt still records everything it recorded before — proposal, ratifier,
  // root authorship, confinement, `attestation`. Nothing is hidden; a reader can
  // still tell a ratified close from an unratified one. What changed is that an
  // unratified close is now *possible*, not *approved*.
  //
  // The two-phase `--propose` flow remains for when a second opinion is wanted.
  // It is a tool, no longer a toll.
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

/** Render the receipt as the close comment body (§5: checkpoint id + evidence pointers on the tracker). */
export function renderCloseReceipt(receipt: CloseReceipt): string {
  const lines: string[] = [
    `## Close receipt`,
    ``,
    `- **checkpoint:** \`${receipt.checkpointId}\``,
    `- **closed by:** ${receipt.closedBy}`,
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
    for (const result of receipt.probeResults) {
      lines.push(
        result.state === "probed"
          ? `- \`${probeKey(result.probe)}\` — **${result.outcome}** at ${result.at}: ${result.observed}`
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
   * Frontier = open ∧ unassigned ∧ all blockers closed (§2.4). Every candidate
   * is confirmed by direct fetch, removing false positives from lagging tracker
   * search indexes. False *negatives* are not recoverable this way — the
   * frontier is advisory and may return short, self-healing on a later tick.
   * Correctness rests on the claim and close gates, never on frontier
   * completeness.
   *
   * Known fail-open path (phase 1): "blockers closed" derives purely from
   * tracker status, so a blocker hand-closed via raw tracker writes releases
   * its dependents without any checkpoint gate having run. Accepted in phase 1,
   * detected by the phase-2 auditor.
   */
  async frontier(root: NodeRef): Promise<NodeState[]> {
    const candidates = await this.store.listCandidateFrontier(root);
    const confirmed: NodeState[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      const state = await this.store.readNode(candidate);
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

  async postComment(ref: NodeRef, body: string): Promise<CommentRef> {
    return await this.store.postComment(ref, body);
  }

  async readComment(ref: CommentRef): Promise<CommentRef> {
    return await this.store.readComment(ref);
  }

  async readCommentReactions(ref: CommentRef): Promise<Reaction[]> {
    return await this.store.readCommentReactions(ref);
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
    await this.store.close(ref, receipt);
  }
}
