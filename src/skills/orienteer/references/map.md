# The map and its nodes

## The map

The map is the **root node** of the effort — one issue, whose children are its
nodes. Find it by id, or by its `orienteer:map` label (see
[Labels](#labels-the-human-index)).

The map is an **index**, not a store. It lists the decisions made and points at
the nodes that hold their detail; a decision lives in exactly one place — its
node — so the map never restates it, only gists it and links.

### The map body

The whole map at low resolution, loaded once per session. Open nodes are **not**
listed — they are open children, found by `soma graph frontier`.

```markdown
## Destination

<what reaching the end of this map looks like — the spec, decision, or change
this effort is finding its way to. One or two lines; every session orients to it
before choosing a node.>

## Constraints

<!-- see below: what is fixed regardless of route — every node's answer must
     respect these -->

- <one line each: budget, time, tooling that cannot change, things that must not
  break, capabilities not available>

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index — one line per closed node: enough to judge relevance, then zoom
     the link for the detail the node holds -->

- [<closed node title>](link) — <one-line gist of the answer>

## Not yet specified

<!-- see references/fog.md: in-scope fog you can't chart yet; graduates as the
     frontier advances -->

## Out of scope

<!-- see references/fog.md: work ruled beyond the destination; closed, never
     graduates -->
```

### Constraints

A constraint is what is **fixed regardless of route**: no budget, a deadline, a
runtime that cannot change, something that must not break, a capability not
available. It sits with the destination because the two together fix the
effort's shape — the destination says where this is going, the constraints say
what the way there may not cost.

The test is whether an **answer could violate it**. That is what separates it
from the four sections around it:

- not **fog** — it is not a question awaiting an answer,
- not **out of scope** — it is not past the destination,
- not a **decision** — nobody decided it, it is simply true,
- not a **Note** — Notes orient *the session* (the domain, the skills to
  consult, standing preferences); a constraint is a predicate on the *answers*.

Nothing enforces it. No verb reads this section, the close gate does not test an
answer against it, and `decisions --write` does not project it. It binds the way
the Destination binds — the agent reads it and honours it — so write constraints
a reader can actually check an option against: "no budget for paid services" is
checkable, "keep it cheap" is not.

Constraints live on the map and **only** on the map. A node never restates one:
a constraint amended in one place would leave stale copies in every node that
had copied it, which is the two-authoritative-homes problem the index rule
exists to prevent. What a node carries instead is the *dimension* — under a
budget constraint, options come with their cost visible, so the constraint is
applied where the choice is made rather than discovered after it.

## Nodes

Each node is a child of the map; the backend's issue id is its identity. Its
body is the question, sized to one 100K token agent session:

```markdown
## Question

<the decision or investigation this node resolves>
```

Membership and blocking are **native edges written by the verbs**, not body
lines:

```bash
soma graph add <root> \
  --title "…" --autonomy propose --kind grilling \
  --checkpoint <id> --body-file <path> \
  --label orienteer:grilling \
  --blocked-by <id> --blocked-by <id>
```

A node is **unblocked** when every blocker is closed, and the **frontier** is
the open, unblocked, unclaimed children — the edge of the known. The graph is a
DAG: an edge that would close a cycle is rejected, because a cycle silently
removes both nodes from the frontier forever — no claim, no close, no error.

When charting, ids don't exist until create returns, so wire what you can with
`--blocked-by` and add the rest in a second pass.

A session **claims** a node with `soma graph claim` — first, before any work.
That assignment *is* the claim; the verb re-reads after writing and reports a
lost race rather than assuming it won.

The answer isn't part of the body — it's recorded on close. Assets created while
resolving a node are linked from the issue, not pasted in.

## Labels: the human index

**Always label a node you create.** `--label orienteer:<kind>` on every node,
`orienteer:map` on the root.

No pre-step is needed on GitHub: creating an issue with a label that does not
exist **creates the label**. The hazard runs the other way — a typo does not
fail, it silently adds a junk label to the repo's vocabulary. Read back what you
created rather than assuming the spelling took.

Labels are **write-only decoration, never a second source of truth**. Nothing
derives them: you supply the label, and the runtime neither generates it from
`kind` nor ever reads it back. `soma graph node` derives `kind` and `autonomy`
from the typed block alone, so a label that is mistyped, edited, stale, or
missing misleads a reader and never changes what a verb decides. Keeping label
and `kind` in step is your discipline, not an invariant the runtime holds.

They earn their place by making a list view readable at a glance. The node block
is an HTML comment: it does not render in the tracker UI and never appears in a
default `gh issue list`, so without labels a ten-node map is ten
indistinguishable rows, the root included, and you open each one to learn what it
is.

The block is not *unreachable* — `gh issue list --search` matches body text, and
`--json body` returns it, so a scripted reader can recover `kind` from unlabelled
or legacy nodes. Labels buy the glance, not the only access path.

That glance is the job: `gh issue list --label orienteer:map` finds every map in
a repo, and scanning the list tells you which nodes are conversations and which
are fact-finding.

Suggested vocabulary — `orienteer:map` for the root, then one of
`orienteer:grilling`, `orienteer:research`, `orienteer:prototype`,
`orienteer:task` matching the node's `kind`.

## What the runtime enforces, and what is yours

Two vocabularies live on a node, and confusing them is the most common mistake.

**`autonomy`** — `auto` / `propose` / `approve`. The **only** classification the
runtime enforces, and it decides what evidence closes the node. An `auto` node
with zero probes is refused at creation: zero probes means zero machine-checkable
evidence at close.

Choose it honestly, because **nothing checks your choice yet**. The spec has
`autonomy` declared over a projected policy floor and clamped never-below-floor
at creation (`docs/work-graph.md` §4); that clamp is not implemented — the
runtime validates the literal value and nothing more. Until it lands, declaring
`auto` on work that belongs behind a human is a self-imposed rule, not an
enforced one.

**`kind`** — `research` / `prototype` / `grilling` / `task`. **Orienteer's own
vocabulary.** The runtime normalises its form (trimmed, lowercased, non-empty)
and never interprets its meaning. It exists for the human reading the map.

Also on a node: `checkpointId` (required before close — see
`references/closing.md`), `probes`, and an optional `budget`
(`tokens` / `agentInvocations` / `wallClockMin`) read as a deterministic circuit
breaker at claim and execution time.

## The four work kinds

Every node is either **HITL** — human in the loop, worked *with* a human who
speaks for themselves — or **AFK**, driven by the agent alone. A HITL node only
resolves through that live exchange. This is doctrine, and `autonomy` is how the
runtime holds you to it: HITL work belongs on `propose` or `approve`, never
`auto`.

- **Research** (AFK): Reading documentation, third-party APIs, or local
  resources like knowledge bases to surface a fact a decision waits on. Resolved
  by a `/research` **subagent**. Use when knowledge outside the current working
  directory is required.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap,
  rough, concrete artifact to react to — an outline, a rough take, a stub, or
  UI/logic code via the `/prototype` skill. Links the prototype as an asset. Use
  when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation via the `/grilling` and `/domain-modeling`
  skills, one question at a time. The default case.
- **Task** (HITL or AFK): Manual work that must happen before a *decision* can
  be made — nothing to decide, prototype, or research, but the discussion is
  blocked until it's done. Signing up for a service so its API can be judged,
  provisioning access, moving data so its shape can be seen. This is the one
  kind that *does* rather than decides — and it earns its place by unblocking a
  decision, not by delivering the destination. Resolved when the work is done;
  the answer records what was done and any resulting facts (credentials
  location, new URLs, row counts) later nodes depend on.
