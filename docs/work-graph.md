# Work graph — typed contracts and execution story

**Status:** Spec, pre-implementation (locked by DD-16, wayfinder map #477)
**Date:** 2026-08-02

The **work graph** is Soma's typed primitive for cross-session effort
topology: nodes of work joined by blocking edges, walked by agent sessions,
closed only through [[checkpoint]] gates. This document is the implementable
spec the map's decision tickets converged on (#483–#487, #491, #492). The
vocabulary entry lives in `CONTEXT.md` (`work graph`); the stance and its
rationale live in DD-16.

## 1. The determinism dividing line (normative)

Every contract below derives from the five clauses locked in #483:

1. **A gate is deterministic iff it reads facts the agent cannot author.**
   Agent-authored content is a proposal until ratified.
2. **Graph writes split by consequence.** *Additive* mutations (new node, new
   edge, tightening an autonomy class, comments) are free after structural
   validation. *Consuming* mutations (closing a node, claiming, loosening a
   gate) need external evidence or a human tick.
3. **Ceremony guard.** Every gate names its consumer; zero-consumer structure
   gets deleted; nothing synchronous on the message hot path.
4. **Models inform, never decide.** `judged` evidence never suffices alone;
   gates key on artifacts, not names.
5. **Enforcement sits out of the agent's reach** and never executes from the
   tree it guards.

Corollary: prefer **derived** state over declared state.

## 2. Typed contracts

### 2.1 Node

```ts
interface WorkGraphNodeBase {
  id: string;            // backend-native identity (GitHub: issue number),
                         // assigned by the store — never caller-supplied
  title: string;
  kind?: string;         // free-form doctrine tag (e.g. research, grilling);
                         // consumers interpret the VALUE, the runtime never
                         // does — but createNode validation normalizes it:
                         // absent kind is accepted; a present kind is stored
                         // trimmed + lowercased, and rejected if it trims
                         // to empty
  checkpointId?: string; // the checkpoint whose completion gate closes this
                         // node; may attach after creation, but close REFUSES
                         // while it is absent — required-by-close invariant
  budget?: NodeBudget;   // optional deterministic circuit breaker
}

interface NodeBudget {   // deterministic circuit breaker (§3.3)
  tokens?: number;
  agentInvocations?: number;
  wallClockMin?: number;
}

type WorkGraphNode =
  | (WorkGraphNodeBase & { autonomy: "auto"; probes: [Probe, ...Probe[]] })
    // the tuple type only guards TS literal-construction sites; the
    // AUTHORITATIVE barrier is createNode's validation at the store
    // boundary, which rejects an `auto` node with zero probes regardless
    // of caller typing (JSON/store-returned data is never trusted by cast)
    // — zero probes would mean zero machine-checkable evidence at close
    // (§1 clause 1)
  | (WorkGraphNodeBase & { autonomy: "propose" | "approve"; probes?: Probe[] });
```

- `autonomy` is the only classification the runtime enforces (#485). The
  work-kind vocabulary (research / prototype / grilling / task) is doctrine
  owned by consumers such as the orienteer skill.
- `autonomy` is declared over a projected **policy floor** (§4) and clamped
  never-below-floor at creation.
- A node **closes only through its attached checkpoint's completion gate**
  (#484). Node autonomy classes differ only in admissible evidence types.

### 2.2 Probe (typed, not prose)

Prose probes are `judged` evidence in disguise (#492 correction 1). A probe is
a machine-checkable expectation:

```ts
type Probe =
  | { type: "command"; run: string; cwd?: string; timeoutSec: number; expectExit: number }
    // the probe runner MUST treat timeout expiry as probe failure (spec
    // obligation on the future runner, not a shipped property) so a
    // hanging command cannot block the close path
  | { type: "url"; target: string; expectStatus: number }
  | { type: "git"; ref: string; expect: "exists"; repo?: string }
  | { type: "git"; ref: string; expect: "merged-into"; into: string; repo?: string }
  | { type: "artifact"; path: string; expect: "exists"; atRef?: string; repo?: string };

type ProbeResult =               // stored with the node's checkpoint record (§5)
  | { probe: Probe; state: "specified" }              // declared, not yet run
  | { probe: Probe; state: "probed";                  // run — output REQUIRED:
      observed: string;          // for command: exit code + bounded stdout/
                                 // stderr tail; for url: status; for git/
                                 // artifact: resolved sha / path presence
      at: string };              // ISO timestamp of execution
```

Probe lifecycle follows the algorithm-runner P1 lesson — self-declared
verification is hollow; the fix is typing evidence by whether it was
*specified up front* and then *actually probed* (see the telemetry mining in
[r4](https://github.com/the-metafactory/soma/blob/1ed2b8a057c9dc47388b979bdb72e0cb74d2e644/Plans/research/graph-of-work/r4-soma-internal-telemetry.md)):
evidence is typed `specified` at node creation and flips to `probed` only
when the runtime has executed the probe and recorded its output
(`ProbeResult` above).

### 2.3 Edge

Blocking only: `blocks(a, b)` means `b` is not frontier until `a` is closed.
No other edge types in v1 (ceremony guard — no consumer exists for them).

The graph is a **DAG**: `addBlockingEdge` performs the structural validation
§1 clause 2 requires and **rejects any edge that would close a cycle**
(`blocks(a,b)` + `blocks(b,a)` would silently remove both nodes from the
frontier forever — no claim, no close, no error).

### 2.4 Frontier and claim

- **Frontier** = open ∧ unassigned ∧ all blockers closed. The frontier verb
  confirms every search hit by direct fetch before reporting it, removing
  false positives from lagging tracker search indexes (#492 correction 3).
  False *negatives* — nodes a lagging index omits entirely — are not
  recoverable this way: the frontier is advisory and may return short,
  self-healing on a later tick. Correctness never rests on frontier
  completeness; it rests on the claim and close gates.
  **Known fail-open path (phase 1):** frontier derives "blockers closed"
  purely from tracker status, so a blocker hand-closed via raw tracker writes
  (bypassing `soma graph close`) releases its dependents without any
  checkpoint gate having run. This is the §2.6 bypass propagated one hop —
  accepted in phase 1, detected by the phase-2 auditor, which reopens the
  hollow-closed blocker and thereby re-blocks the dependents.
- **Claim** = the executing identity becoming the node's **sole** assignee,
  written **before any work**. GitHub offers no compare-and-swap, so the
  claim verb re-reads assignees after writing; if the re-read shows more than
  one assignee, the deterministic tie-break applies — the assignee whose
  login sorts first lexicographically holds the claim, every other claimant
  removes itself (#492 correction 2). All racers compute the same rule over
  the same eventual assignee set, so the race converges to one holder without
  coordination.

### 2.5 GraphStore seam

A typed interface behind the verbs, separating contract logic (frontier
computation, claim semantics, close gating) from store I/O (#491):

```ts
interface GraphStore {
  attestation: "verifiable" | "unverified";  // backend capability: CAN receipts
                                             // be independently attested here?
  createNode(spec: Omit<WorkGraphNode, "id">): Promise<NodeRef>; // store assigns id
  addBlockingEdge(blocker: NodeRef, blocked: NodeRef): Promise<void>;
  readNode(ref: NodeRef): Promise<NodeState>;
  listCandidateFrontier(root: NodeRef): Promise<NodeRef[]>; // hits re-confirmed by readNode
  claim(ref: NodeRef, identity: string): Promise<ClaimResult>; // re-reads after write
  postComment(ref: NodeRef, body: string): Promise<CommentRef>;
  readCommentReactions(ref: CommentRef): Promise<Reaction[]>;  // author from API, not body text
  close(ref: NodeRef, receipt: CloseReceipt): Promise<void>;
}
```

- **Single authority:** the tracker is the *sole* authoritative store for
  topology, claims, and status. Soma-home holds at most a disposable derived
  cache and `nodeId` *references* (DD-5/DD-6 pointers); **no sync contract
  exists** (#491).
- **Per-graph backend binding:** a graph records its backend at creation and
  lives there forever; moving is a one-way export into a fresh graph.
  (Orienteer doctrine calls a graph instance a *map*; the seam does not.)
- Day-one backend: **GitHub** (attestation capability: `verifiable` — the
  backend can attest reaction/comment authorship via its API). Backend
  capability is necessary, not sufficient: a *receipt* is marked verified
  only when the backend attests **and** credential separation exists (§3.2);
  until then every HITL receipt carries `attestation: "unverified"` even on
  a verifiable backend. A second backend lands only with its first real
  consumer; a backend that cannot attest at all runs degraded permanently.

### 2.6 CLI verbs

```bash
soma graph frontier <map>          # open, unassigned, unblocked — confirmed by direct fetch
soma graph claim <node>            # assign, re-read, back off on race
soma graph add <map> ...           # create node (+ edges) — additive, structurally validated
soma graph close <node>            # runs declared probes; refuses a hollow close
```

`close` enforcement lives in the **installed** soma binary, never the dev tree
(#483 clause 5). Bypass via raw `gh` remains visible-but-unprevented in
phase 1; the phase-2 auditor (§5) makes it detected.

### 2.7 planSteps bridge

`planSteps[]` stays the within-run execution checklist. A plan step may carry
an optional `nodeId` reference and then **derives its status from the node** —
one work item never has two authoritative homes. This is a contract on the
Algorithm runner, not just prose: `updateAlgorithmPlanStep` MUST refuse a
direct status write on a bridged step (status arrives only by re-deriving
from the node). The FeatureRegistry rule in
`docs/algorithm-execution-modes.md` is correspondingly narrowed to "no
parallel work registry **at the same scope**" (#484).

## 3. Receipts by autonomy class

### 3.1 AFK (`auto`)

`soma graph close` runs the node's declared probes and requires **≥1
agent-external evidence entry** (`probed` / `tested`: command exit codes, URL
responses, git state). `judged` evidence (e.g. adversarial review) may inform,
never suffices alone. The receipt proves *existence + probe passage, not
quality* — sound because `auto` work sits below the irreversibility line;
quality ratifies when a downstream HITL node consumes the artifact (#485).

### 3.2 HITL (`propose` / `approve`)

`approved` evidence is an attestation verifiable as coming from **a credential
the agent does not hold**. Concretely (#486): the executing bot posts the
resolution as a **proposal comment**; the receipt is the principal's 👍
reaction on that specific comment ID — or a principal-authored comment, which
wins when amending — verified via the API author field. A materially amended
proposal is re-posted and needs fresh ratification (the replay-rebind lesson).

**Degraded mode:** until credential separation exists, HITL receipts carry
`attestation: "unverified"` — on **every** receipt written under shared
credentials, visible state, never silent theater (#492 correction 4).

### 3.3 Budget circuit breaker

An optional per-node `budget` (`{ tokens?, agentInvocations?, wallClockMin? }`)
is a deterministic cap read at claim/execution time: exceeding it flips the
node to blocked with a budget-exhausted label. It is a circuit breaker, not a
scheduler (r3 evidence, folded from #485 fog).

## 4. Autonomy policy attachment

- The action-taxonomy policy (reversibility × blast radius →
  `auto` / `propose` / `approve`, per `docs/autonomy-hitl-design.md`) is a
  typed document under the existing `soma policy` inspection surface
  (`docs/governance-event-runtime-policy.md`) — no parallel policy registry.
- The policy maps node categories to a **minimum** class (comms, credentials,
  main-branch writes, self-governance ⇒ `approve`); declared classes are
  clamped never-below-floor.
- **Asymmetric mutation:** tightening (`auto → propose → approve`) is additive
  — free after structural validation, the agent may self-tighten. Loosening is
  a consuming mutation on the gate itself — the most-gated write there is:
  identity-bound `approved` evidence, fail-closed.
- Graph-mutation events are an inspection surface beside `governance_event`.
  Enforcement sits where mutations are applied (installed binary now, auditor
  in phase 2) and never executes from the tree it guards.

## 5. Execution story: tracker + Claude Code harness

The chosen host (#486): tracker issues are the graph surface, Claude Code
sessions are the node executors, soma supplies the verbs.

- **Identity:** a dedicated GitHub **machine-user account + fine-grained PAT**
  scoped to the repos (machine account over GitHub App: App bots cannot be
  issue assignees, and claim-as-assignee must survive). Agent sessions run
  with `GH_TOKEN` = the bot PAT; the principal's credential never enters an
  agent session — the principal acts only as themself via GitHub UI/CLI.
- **Tick, phased:**
  - *Phase 1 (day one):* human-triggered sessions claim frontier nodes; AFK
    research fans out as subagents inside them. The graph advances only when
    the principal starts a session.
  - *Phase 2 — gated on the bot identity existing:* a scheduled tick claims
    `auto`-class frontier nodes headlessly. Each claim is announced to Discord
    with a **60s 👎 veto window**; silence proceeds; terminal states never
    auto-resume (operator verbs only). No autonomous ticking under the
    principal's credentials, ever.
- **Close audit (phase 2):** a GitHub Actions auditor fires on issue-close,
  re-verifies structurally checkable evidence from the close receipt's
  pointers (commit SHAs, CI run URLs, comment IDs, probe outputs), and reopens
  the node with a failure label on mismatch — derived state over declared
  state, running where the agent has no hands.
- **Checkpoint record in Soma, receipt on the tracker** (#491): the typed
  checkpoint object stays in Soma's verification state; the close comment
  carries the checkpoint id plus externally checkable evidence pointers. The
  tracker never becomes a typed database; soma-home never becomes the
  authority.

### 5.1 Machine-account provisioning checklist

1. Create the GitHub machine-user account (one seat, org-invited).
2. Issue a fine-grained PAT: issues read/write + contents read on the target
   repos; no admin scopes.
3. Store the PAT where agent sessions resolve `GH_TOKEN` (env injection at
   session spawn, not in any repo or projection).
4. Flip HITL receipts from `attestation: "unverified"` to verified; phase-2
   tick and auditor unlock only after this.

## 6. First consumer: orienteer

Ships-with-consumer is structural (#484 clause 4): the primitive merges into
core only together with the **orienteer** skill (`src/skills/orienteer/`,
invoked `/orienteer`) — the wayfinder doctrine re-based onto the `soma graph`
verbs, versioned with them (#487). Upstream wayfinder changes arrive by manual
cherry-pick. Doctrine lines the prototype walk added (#492): scaffold nodes
attach below their spawning ticket, never to the map; work-kinds
(research / prototype / grilling / task) are orienteer vocabulary, not runtime
vocabulary.
