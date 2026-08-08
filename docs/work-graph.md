# Work graph — typed contracts and execution story

**Status:** Phase 1 implemented and on `main` (§2-§4, via map #495); §5 phase 2 unbuilt. Locked by DD-16, wayfinder map #477
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
                         // the runtime never interprets its MEANING but
                         // normalizes its FORM in createNode validation:
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
  | { type: "git-ref-exists"; ref: string; repo?: string }
  | { type: "git-merged-into"; ref: string; into: string; repo?: string }
  | { type: "artifact-exists"; path: string; atRef?: string; repo?: string };
// `type` alone is the runner's dispatch key — one switch, no nested
// discriminants.

type ProbeResult =               // stored with the node's checkpoint record (§5)
  | { probe: Probe; state: "specified" }              // declared, not yet run
  | { probe: Probe; state: "probed";                  // run — REQUIRED fields:
      outcome: "pass" | "fail"; // ran-and-passed vs ran-and-failed — close
                                 // requires every probe probed AND passed
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

Runner semantics settled while implementing #498:

- `repo` on the git and artifact probes is a **local working-tree path**
  (relative to the runner's cwd), not `owner/name` — `artifact-exists`'s
  `path` + `atRef` pair resolves as `git cat-file -e <atRef>:<path>`, which
  needs a checkout rather than an API.
- **A probe that cannot run is a failed probe, never a skipped one.** Runner
  errors (network refused, git absent, bad path) record `outcome: "fail"` with
  the reason in `observed`, so the close refuses. The one thing a runner may
  not do is let an unrun probe read as a passed one.
- Git probes execute as argv, never through a shell, so a ref name cannot
  inject.

#### Probe registry (DD-16 Amendment A)

**Status: enforced** ([#526](https://github.com/the-metafactory/soma/issues/526)),
in `src/work-graph-probe-registry.ts` — the gate — and `src/work-graph-probes.ts`,
which consults it before dispatch so a probe type added later cannot inherit
"ungated" by omission.

Probe declarations are **tracker content**, so they may parameterise a probe but
may never introduce executable code or a network destination. The tracker is a
parameter of `soma graph` — adopters point it at their own repos — so Soma
cannot know its visibility, collaborator set, or issue policy, and no rule may
depend on knowing who is trusted there.

| Probe type | Gate |
| --- | --- |
| `command` | Refused unless the exact `run` **and** `cwd` pair is declared in the local probe registry for this repo. `cwd` is part of the match: a declared command run in an attacker-chosen directory is a different command. |
| `url` | Refused unless the target host is in the declared host set. Ungated, this is a blind SSRF oracle — the request issues from the closing machine and the receipt publishes the observed status to a possibly world-readable tracker. |
| `git-ref-exists`, `git-merged-into`, `artifact-exists` | Ungated — argv, no shell, no egress, bounded to existence checks in a local tree. |

The registry lives in **soma-home only, scoped by repo identity**, under the
`soma policy` surface (§4 forbids a parallel policy registry). Not repo-local:
§1 clause 5 keeps enforcement off the tree it guards, and a committed registry
is writable by any agent holding Write. Concretely
`~/.soma/policy/probe-registry.json` — and **the close path takes no flag that
moves it**. A caller-selectable registry path is the same hole the home
placement closes: point it at a file you just wrote and the exact-match
authorises itself. An adopter whose soma home is not `~/.soma` configures that
for the environment, never per invocation.

```json
{
  "version": 1,
  "repos": {
    "the-metafactory/soma": {
      "commands": [{ "run": "bun test", "cwd": "/Users/you/work/soma" }],
      "urlHosts": ["status.example.com"]
    }
  }
}
```

Declaration rules, all deny-by-default:

- `cwd` is matched as the **resolved absolute directory** the runner would
  execute in, not the literal `cwd` field on the node — that field is
  tracker-supplied and resolves against the closing session's cwd. Declared
  paths must be absolute (`~` expands); a relative declaration would authorise a
  different directory per invocation, which is the substitution the `cwd` match
  exists to prevent.
- `run` matches **byte for byte**. No trimming, no normalisation.
- `urlHosts` are bare hostnames — no scheme, port, path, or wildcard. A declared
  host authorises any port on it; a non-http(s) target is refused outright,
  since a `file:` or `data:` URL has no host for a host set to authorise.
- Repository keys are compared case-insensitively. The **whole document** is
  validated, not just the entry being read: in an authorisation list a
  silently-ignored typo is what makes an adopter believe something is declared
  when it is not.
- Adding an entry is a **loosening** mutation (§4), so it stays identity-bound
  and fail-closed: the adopter edits the document. `soma policy probes
  [--repo <owner/name>]` shows what is declared and where; soma ships no verb
  that writes it, because a gate the agent can widen is not a gate.

The rule is **uniform** — same for every autonomy class and for the phase-2
headless tick (§5). A machine with no declaration refuses those closes;
fail-closed. Refusal is a **failed probe** (`outcome: "fail"`, reason in
`observed`), not an exception and not a skip, so `assertClosable` refuses the
close through the path it already owns; `soma graph close` additionally reports
the refusal ahead of that generic failure, naming the exact `run`/`cwd` to
declare. **Reading is not executing:** `soma graph node` and
`soma graph frontier` read any node regardless, because a node is data. Only the
close path gates.

Exact match yields DD-7's *exact-bytes* property for the two fields it covers:
editing a probe's `run` or `cwd` on the tracker breaks its match and the close
refuses, with no scanner involved. It does **not** extend to the rest of the
probe. `expectExit` and `timeoutSec` remain tracker content the gate never reads
— which is the residual DD-16 Amendment A already records ("an attacker who can
write a node body … can set `timeoutSec` and `expectExit` freely"). Concretely:
flipping a declared `bun test` from `expectExit: 0` to `expectExit: 1` makes a
*failing* suite record as a passed probe. The registry bounds **whose code
runs**, not what counts as success; widening it to the whole probe would be a new
decision, not an implementation detail of this one.

**Migration:** existing nodes carrying undeclared `command` probes are
unclosable by machine until their command is declared. Intended — the refusal is
specific and copy-pasteable, and no node silently changes meaning.

### 2.3 Edge

Two edge kinds, and only two. They answer different questions, and the
ceremony guard is satisfied because each has a consumer that the other cannot
serve:

- **`blocks(a, b)`** — `b` is not frontier until `a` is closed. This is the
  gate, and the only relation that withholds work.
- **`memberOf(child, parent)`** — the child belongs to the parent: a step on a
  map, or scaffold thrown off the node whose work produced it. This is what
  `readSubtree(root)` walks (§2.4), what `CreateNodeSpec.parent`
  writes, and what the root walk behind §3.2 conjunct 4 follows. It records
  provenance and **never gates**: depth confers nothing, and a node three
  levels down is exactly as takeable as a direct child (#557).

Membership was present from #497 — `CreateNodeSpec.parent` had no other
purpose — but this section said "blocking only" until #564. Stating one
relation while shipping two is what let depth quietly acquire a gating role it
was never given.

No third kind without a consumer that neither of these serves.

The graph is a **DAG**: `addBlockingEdge` performs the structural validation
§1 clause 2 requires and **rejects any edge that would close a cycle**
(`blocks(a,b)` + `blocks(b,a)` would silently remove both nodes from the
frontier forever — no claim, no close, no error).

### 2.4 Frontier and claim

- **Frontier** = open ∧ unassigned ∧ all blockers closed, over the root's
  entire **membership subtree** — every descendant, at any depth, reported in
  depth-first pre-order (#557). Depth records where a node came from and never
  decides whether it is reported: gating is what a blocking edge means, and
  past-the-destination is what a close means. A one-level walk made scaffold
  invisible precisely when its spawning node closed and it became takeable,
  which is why the walk descends **into** closed nodes while never reporting
  them. An implementation that cannot carry a whole subtree in one request must
  detect the shortfall and complete it; truncating in silence is forbidden.
  **Discovery must be a live read of the authoritative store, and when it is,
  it confirms** (#576, superseding #492 correction 3). The original rule
  required the verb to re-fetch every candidate, and it was written for a
  discovery step assumed to be a lagging *search index* — the fetch existed to
  drop hits the index had gone stale on. Where discovery already reads the
  store directly, the second read buys nothing and costs coherence: N
  sequential fetches describe the subtree as it was across however long they
  took, so the measured GitHub path blended observations up to ten seconds
  apart, where one traversal is a single observation. A backend that *does*
  discover through a stale index still owes the second read — internally,
  before returning — because the obligation attaches to the staleness, not to
  the ceremony.

  Two consequences worth stating, because nothing downstream re-checks. Every
  returned state must be **whole**: a short read of assignees or blockers would
  make a claimed node look unclaimed or a blocked node look takeable. And
  membership is never revalidated — it never was, since the old fetch re-read
  the node and not its ancestry, so discovery has always been the only witness
  for whether a node belongs to this subtree. False *negatives* are not
  recoverable this way, so the frontier is advisory and may return short,
  self-healing on a later tick. Correctness never rests on frontier
  completeness; it rests on the claim and close gates.

  What can *produce* a false negative is backend-specific, and saying so
  matters because the two have different fixes. A store that discovers by
  search loses nodes its index has not caught up with. The GitHub backend does
  not search at all — it walks native sub-issue edges (#557) — so its false
  negatives come from **missing membership edges**: a node nobody attached is
  not in anyone's subtree, and no amount of confirmation will conjure it. A
  short read caused by the *walk* rather than by the graph is a defect, not a
  caveat, which is why truncation must refuse or recover.
  **Known fail-open path (phase 1):** frontier derives "blockers closed"
  purely from tracker status, so a blocker hand-closed via raw tracker writes
  (bypassing `soma graph close`) releases its dependents without any
  checkpoint gate having run. This is the §2.6 bypass propagated one hop —
  accepted in phase 1 and, until the phase-2 auditor is built, undetected as
  well as unprevented. That auditor is the design's answer — it reopens the
  hollow-closed blocker and thereby re-blocks the dependents — and it does not
  exist yet.
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
  readSubtree(root: NodeRef): Promise<NodeState[]>;         // whole subtree, pre-order,
                                                            // already confirmed (#576)
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
soma graph frontier <root>         # open, unassigned, unblocked — confirmed by direct fetch
soma graph node <id>               # read one node (GraphStore.readNode) — the bridge's read path
soma graph claim <node>            # assign, re-read, tie-break on race
soma graph add <root> ...          # create node (+ edges) — additive, structurally validated
soma graph close <node>            # runs declared probes; refuses a hollow close
```

`close` enforcement lives in the **installed** soma binary, never the dev tree
(#483 clause 5). Bypass via raw `gh` remains visible-but-unprevented in
phase 1; the phase-2 auditor (§5) is designed to make it detected and is not
built. A close run from a dev
tree warns on stderr rather than refusing — refusing would make the primitive
undevelopable, and the warning keeps the gap visible state rather than silent.

HITL closes are two-phase, inside the same verb rather than a sixth one:
`close --propose` posts the proposal comment and stops; `close
--proposal-comment <id>` reads its reactions and derives the receipt. Two seam
addenda fell out of implementing it (#498), both the same class as the
`CreateNodeSpec` addendum on #497:

- `GraphStore.readComment` — conjunct 3 needs the *proposal's* author from the
  API, and the two phases are separate process invocations, so the author must
  come back from the backend rather than ride on the command line where it
  would be caller-authored.
- The parent edge is read over **GraphQL**. `GET /repos/{repo}/issues/{n}`
  carries no `parent` key (only the child direction, `/sub_issues`, is in
  REST), so a REST-only read resolves every node as its own root — which
  silently degrades conjunct 4 from "the graph root's author may ratify" into
  "a ticket's own author may ratify its close".

### 2.7 planSteps bridge

`planSteps[]` stays the within-run execution checklist. A plan step may carry
an optional `nodeId` reference and then **derives its status from the node** —
one work item never has two authoritative homes. This is a contract on the
Algorithm runner, not just prose: `updateAlgorithmPlanStep` MUST refuse a
direct status write on a bridged step — status arrives only by re-deriving
from the node, read via `GraphStore.readNode` (surfaced as
`soma graph node <id>` for CLI callers). The FeatureRegistry rule in
`docs/algorithm-execution-modes.md` is correspondingly narrowed to "no
parallel work registry **at the same scope**" (#484).

**Implemented** (#501). The spec named one write path to refuse. The run has
three *mutation helpers* that can reach a step's status, and each is handled — but
be precise about what that buys, because the first version of this section claimed
exhaustiveness on the strength of a hand-made list that had missed one:

> The invariant is enforced at the **mutation layer, not in the type**, and the
> mutation layer is a set of speed bumps rather than a seal. Two holes — the
> second demonstrated by a test, the first following from the signature:
>
> - `writeAlgorithmRun` is on the public barrel and takes a whole run, so a caller
>   can construct an `AlgorithmRun` literal with a bridged step and a hand-written
>   `done` and persist it.
> - `setAlgorithmPlan`'s un-bridge refusal is **per-call**. Removing the step in
>   one call and re-adding it unbridged in the next reproduces the end state the
>   single-call refusal rejects; nothing sees across two calls.
>
> Only moving `status` out of a bridged step's shape would actually close these,
> and that is a larger change than #501.

So the accurate claim is narrower than "one write path": a bridged step's status
cannot be forged **incidentally**. A re-plan that happens to omit a `nodeId`, a
VSA sweep that flushes every open step, a routine `--status done` — each is caught,
so a step's authority is never demoted as a side effect of something else. A caller
who sets out to un-bridge a step can still do it, and the end state is honest: the
step no longer claims a node backs it.

- `updateAlgorithmPlanStep` — the per-step write. **Refuses** on a bridged step.
  `applyAlgorithmBatch`'s `step` operation routes through it, so it is covered by
  construction rather than by a second check.
- `setAlgorithmPlan` — replaces `planSteps[]` wholesale with caller-authored
  status. **Refuses in both directions**, which took two passes to get right:
  - an *incoming* step carrying a `nodeId`, since bridging is not a planning act
    and a bridged step must not be authored into existence with a status that
    never came from its node; and
  - an incoming step reusing an *existing bridged* step's id, which silently
    dropped the bridge and left `updateAlgorithmPlanStep` willing to accept a
    hand-written `done` on a step a reader still believed was node-derived.

  Dropping the step from the plan entirely stays legal: the step ceases to exist,
  so nothing claims a node backs it. What is refused is the id surviving with its
  authority quietly removed.

  Note what that costs, since it is easy to read this section as stricter than it
  is: **dropping the step also clears the VERIFY gate**, because a removed step
  gates nothing. The "open bridged step holds the run short of VERIFY" property
  below is therefore a cost a caller can decline, not a lock — and the removal is
  neither refused nor recorded.
- The VSA sync's VERIFY sweep — flipped every open step to `done` from the VSA's
  phase alone. A whole-run map has no single step to refuse for, so
  `markUnbridgedPlanStepsDone` **skips** bridged steps instead of throwing.

- **Binding is a derivation.** `syncBridgedPlanStep(run, stepId, report, {bind})`
  is also how a step first acquires its `nodeId` — attaching the reference
  without deriving would leave the step bridged while still reporting its stale
  hand-written status, which is worse than two homes: it is none. `bind` does not
  license **re-homing**, either; an already-bridged step refuses a different node,
  or the one caller that always passes `bind` would make the mismatch check
  unreachable and a typo'd `--node` would move a step silently.
- **`BridgedNodeReport` is `Pick`ed from `NodeState`**, not re-declared to match
  it. Hand-written, its `blockedBy?` was optional where `NodeState`'s is
  required — a report missing the field type-checked and derived `open` where the
  node was `blocked`, a fail-open `tsc` could not see.

`status` on a bridged step is therefore a **cache** of the node's reported state,
and the derived `evidence` names the node and the derivation moment: a derived
status that is indistinguishable from a written one has the gate's shape without
its effect.

## 3. Receipts by autonomy class

### 3.1 AFK (`auto`)

`soma graph close` runs the node's declared probes and requires **≥1
agent-external evidence entry** (`probed` / `tested`: command exit codes, URL
responses, git state). `judged` evidence (e.g. adversarial review) may inform,
never suffices alone. The receipt proves *existence + probe passage, not
quality* — sound because `auto` work sits below the irreversibility line;
quality ratifies when a downstream HITL node consumes the artifact (#485).

### 3.2 HITL (`propose` / `approve`)

A HITL node **closes on the closing session's say-so**. The human in the loop is
the person running the session; requiring a second party to ratify named no
consumer where one person walks the map, and the rule did not verify those closes
— it prevented them (#499 is the worked example: finished, merged, evidenced work
that the gate refused, protecting nobody).

What remains:

- **The proposal flow is available, not required.** `close --propose` posts a
  proposal and `close --proposal-comment <id>` reads its reactions, for when a
  second opinion is genuinely wanted. Ratification is admissible evidence; its
  absence is not a defect.
- **An explicit refusal is surfaced, not enforced.** With `--proposal-comment`, a
  👎 from the graph root's author on that comment refuses that close, naming who
  refused.

  A reminder, not a control, and its limits are not a closed list: it lives in
  the CLI rather than `assertClosable`, so a non-CLI consumer of the seam gets
  none of it; a bare `close` reads no reactions; nothing binds a new proposal to
  a refused one; and it needs the root author to resolve, so where the root walk
  fails nothing refuses, silently.

- **A 👍 reaction is the only ratification (#525).** Literally that reaction —
  matched on `+1`, so no other emoji ratifies, and (per the rule above) any
  non-proposer's counts, with *whose* it is affecting `attestation` rather than
  admissibility.
  This section once admitted a second form — a principal-authored *comment*,
  winning over the 👍 when amending — and the seam carried a `"comment"`
  ratification kind nothing produced. It is withdrawn, not unimplemented: with
  ratification demoted from gate to label, deriving approval from free prose
  would let a root-author reply of "hold on, not this" produce `verified` on the
  one field the phase-2 auditor recomputes. A 👍 is a deliberate, unambiguous
  gesture; prose is not.

  The amendment rule it served is **caller discipline, not a structural
  guarantee**. Ratification is read from the comment id passed to
  `--proposal-comment`, so an amended proposal inherits nothing *when the new id
  is the one passed*; passing the superseded id ratifies from the superseded
  proposal, and nothing in the runtime rejects it. Same class of limit as the
  refusal one named above — nothing binds a new proposal to a refused one — and
  it has the same root: no verb binds a proposal to the one it supersedes.

- **The receipt distinguishes the two cases.** A ratified close records the
  proposal and ratifier; a bare one records their absence in
  `attestationFacts.reasons` ("no proposal comment recorded", "no ratification
  found"), alongside root authorship, confinement and `attestation`.

The removal is unconditional — it is not scoped to single-operator deployments.
A deployment wanting closes gated on a second party's approval does not get that
from this primitive; it gets a record of whether one happened.

#### Deriving `attestation` (#502)

`attestation` is **derived at close time, never configured**. There is no flag,
no policy field, no provisioning step that turns verification on: an adopter
with real credential isolation gets `verified` automatically, one without gets
honest `unverified` forever, and neither configures anything (§1 corollary —
derived over declared). Soma ships the rule, not the provisioning recipe.

`verified` asserts a **trust** claim — *a human the agent cannot impersonate
ratified this* — not merely that two logins appear. All four must hold:

1. **Backend attests** — `GraphStore.attestation === "verifiable"` (§2.5).
2. **Confinement** — the close path finds no GitHub credential other than the
   acting agent identity reachable from the session (`GH_TOKEN` unset →
   `gh auth status`, `gh auth token`, OS keychain item). **Downgrade-only:**
   reachability forces `unverified`; non-reachability never manufactures a
   `verified` by itself.
3. **Distinct authorship** — ratifier author ≠ proposal comment author, both
   read from the API author field, never from body text.
4. **Authorized ratifier** — the ratifier is the **author of the graph's root
   node**, reached by walking native parent edges up from the closing node.
   Deliberately not a configured binding: a configured one is agent-writable,
   and once the gate keys on *which* human, a rewritable binding is a forgery
   path — the agent may point it at an account it controls — not merely an
   authorization question. Root unreachable, or root authored by the acting
   agent identity → `unverified`.

Any conjunct failing yields `unverified`. `attestation` is a **label, not a
gate**: `close` proceeds either way. Refusing on `unverified` would deadlock
the bootstrap — the nodes that establish credential separation are themselves
`approve`-class, so they could never close.

The receipt records the **facts, not just the verdict**: proposal comment id +
author, ratifying comment/reaction id + author, root node id + author, backend
capability, and the confinement check's probe set, result, and timestamp.
Every input except the confinement result is re-derivable from the tracker
indefinitely; the session's credential topology is not, so an unrecorded check
leaves a future reader unable to tell *why* a receipt was unverified — wrong
ratifier and reachable-keyring have different remediations. The phase-2 close
auditor (§5) recomputes conjuncts 1, 3 and 4 from these fields — all
tracker-derived, all beyond the agent's reach — and reopens on mismatch.
Conjunct 2 is **not** recomputable: it is a session-asserted fact, and the
auditor can confirm only that a check was recorded, never that its result was
true.

#### Honest limits

- **Co-resident credentials are invisible at the tracker.** Distinct authorship
  alone cannot separate "the principal reacted" from "the session reacted as
  the principal". #496 is the worked example: clean, API-attested authorship
  separation, correctly closed `unverified`. Conjunct 2 catches this at
  runtime; the standing deployment invariant remains §5 — the principal's
  credential never enters an agent session — tracked as its own node (#511).
- **Conjunct 2 is a detector, not a defence.** It runs inside the environment
  it judges, so §1 clause 5 does not hold for it. An agent that shims it fakes
  confinement — and in exactly the deployment where the check would have
  failed, the credential the session can reach is the credential that produces
  the 👍. Conjuncts 3 and 4 then pass on a reaction the session made itself, so
  a shimmed check yields a **fully forged `verified`**, not a mislabelled one.
  The check earns its place by catching the honest-but-unisolated case
  automatically — today's case, and every adopter's until they isolate — and
  buys nothing against a session that sets out to subvert it. It is therefore
  necessary and never sufficient: it may lower `attestation`, and it may not,
  on its own, raise it.
- **What `verified` rests on.** Its trusted base is two facts the runtime
  cannot check: the §5 deployment invariant (#511) and an unshimmed installed
  binary (§1 clause 5). Conjunct 2 establishes neither. Read `verified` as
  *the four conjuncts held, under a deployment where that base is believed to
  hold* — which is why the receipt records facts rather than a bare verdict:
  where the base is later found not to have held, the recorded facts are what
  a re-audit re-judges.
- **Degraded mode:** whenever any conjunct fails, HITL receipts carry
  `attestation: "unverified"` — on **every** such receipt, visible state, never
  silent theater (#492 correction 4).

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
- The **probe registry** (§2.2, DD-16 Amendment A) is a typed document on this
  same surface — declared `command` literals (`run` + `cwd`) and `url` hosts,
  scoped by repo identity, held in soma-home
  (`~/.soma/policy/probe-registry.json`, read by `soma policy probes`). It is an
  authorisation list, not configuration: adding an entry is the adopter saying
  "I allow this command on this machine", so it follows the same
  asymmetric-mutation rule as the autonomy floors — tightening is additive,
  loosening is identity-bound and fail-closed. In practice that means the write
  is the adopter's hand: `soma policy probes` reads, and there is no verb that
  adds an entry.
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
    principal's credentials, ever. The tick runs `command` and `url` probes
    under the **same** registry gate as an interactive session (§2.2) — the
    registry answers *whose code this is*, and headlessness changes who is
    watching, not what is authorised. A tick machine with no registry refuses
    those closes rather than running them.
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
