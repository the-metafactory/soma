# Workflow: Chart the map

The user arrived with a loose idea. Charting is **one session's work and it
hand-resolves nothing** — you end with a map and its first nodes, not answers.

## 1. Name the destination, and what constrains the way there

Run a `/grilling` and `/domain-modeling` session to pin down what this map is
finding its way to — the spec, decision, or change. One or two lines that a
later session can orient to before choosing a node.

The destination fixes the scope, so it is settled first: everything past it is
out of scope, and everything short of it is either charted or fog.

Then ask what is **fixed regardless of route** — budget, time, tooling that
cannot change, things that must not break, capabilities not available. This pass
is easy to skip, because nobody volunteers a constraint they think is obvious;
it is not obvious to the map. And a constraint that surfaces late is expensive:
the decisions it invalidates were charted, worked, and closed against options
that were never on the table. What to do with those closed decisions is an open
question with no verb behind it — which is why eliciting the constraint now is
the cheap half.

**Seed it from the principal's own store, then confirm.** A principal's recorded
purpose and constraints routinely encode exactly this class of fact — capacity,
budget, time, non-negotiables — and reading them costs less than waiting to be
told:

```bash
soma memory recall "budget capacity constraint deadline"   # read-only
```

Vary the query to the effort — that one is a starting point, and whole-file term
scoring returns near-misses beside the hits. Every result carries a verification
banner with an age on it: **respect it**. A note records what was true when it
was written, and a stale one proposed as a live constraint puts a predicate on
every answer that may no longer hold.

`~/.soma/profile/purpose.md` carries the same class under Commitments. Where
there is no Soma home — orienteer runs in any repository — this pass is simply
the question, asked.

**Propose what you find; never assume it.** A constraint read out of a store is a
candidate, not a fact about this effort: put it to the human and let them
confirm, amend, or drop it. Silently assuming one is worse than never eliciting
it, because the map then carries a predicate on every answer that nobody agreed
to.

**Propose the constraint, never the source.** That store holds a principal's
private material — health, finances, relationships, whatever they have recorded
— and a map body is an issue on a tracker, as public as the repository holding
it. So translate before you ask: put *"no budget for paid services"* to the
human, not the note you read it in, and never paste recall output into the map.
They are confirming a constraint on this effort, not approving a disclosure, and
should not have to catch one on your behalf.

What survives goes in the map's **Constraints** section (`references/map.md`).

## 2. Map the frontier

Grill again, **breadth-first** this time: fan out across the whole space rather
than deep on any one thread, surfacing the open decisions and the first steps
takeable now.

**If this surfaces no fog** — the way to the destination is already clear, the
whole journey small enough for one session — you don't need a map. Stop and ask
the user how they'd like to proceed.

## 3. Create the map

The map is the root node: an issue whose body carries Destination, Constraints,
and Notes filled in, Decisions-so-far empty, and the fog sketched into **Not yet
specified**. The body template is in `references/map.md`. Label it
`orienteer:map` — that label is how anyone finds this map again.

Put in **Notes** what every later session needs before choosing a node: the
domain, the skills to consult, standing preferences, and any override of the
plan-don't-do default. Notes orient the session; anything an *answer* could
violate is a constraint, and belongs in Constraints where a later session will
check its options against it.

## 4. Create the nodes you can specify now

```bash
soma graph add <root> \
  --title "…" --autonomy <auto|propose|approve> --kind <research|prototype|grilling|task> \
  --checkpoint <id> --body-file <path> \
  --label orienteer:<kind> \
  [--probe '{"type":"command","run":"…","timeoutSec":600,"expectExit":0}'] \
  [--blocked-by <id>]…
```

On GitHub an unknown label is created by the call rather than rejected by it, so
there is no pre-step — but a typo silently adds a junk label instead of failing,
so check what you wrote. Labels are write-only decoration, not a second source of
truth (`references/map.md`); skipping them leaves the human with a list of
indistinguishable rows.

Ids don't exist until create returns, so wire the edges you can and make a
second pass for the rest. Wiring sorts the nodes into the frontier and the
blocked; everything you can't yet specify stays in the fog.

Before choosing `autonomy` and `kind`, read `references/map.md` — they are
different vocabularies and only one is enforced. Before declaring probes, read
`references/closing.md`: an `auto` node with zero probes is refused at creation,
and a `command` probe the adopter's registry doesn't authorise will refuse at
close.

Check the result: `soma graph frontier <root>` should return exactly the nodes
you expect to be takeable. A short frontier means a missing membership edge.

## 5. Fire the research subagents

For each `research` node you just created, spin up a `/research` subagent to
resolve it in parallel, capturing its findings on a throwaway `research/<name>`
branch with a context pointer from the node. Research is the one kind that may
resolve more than one per session.

## 6. Stop

Report the map by name, the frontier, and what stayed in the fog. Do not start
resolving — that is the next session's work.
