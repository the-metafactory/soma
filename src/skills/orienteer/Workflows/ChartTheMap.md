# Workflow: Chart the map

The user arrived with a loose idea. Charting is **one session's work and it
hand-resolves nothing** — you end with a map and its first nodes, not answers.

## 1. Name the destination

Run a `/grilling` and `/domain-modeling` session to pin down what this map is
finding its way to — the spec, decision, or change. One or two lines that a
later session can orient to before choosing a node.

The destination fixes the scope, so it is settled first: everything past it is
out of scope, and everything short of it is either charted or fog.

## 2. Map the frontier

Grill again, **breadth-first** this time: fan out across the whole space rather
than deep on any one thread, surfacing the open decisions and the first steps
takeable now.

**If this surfaces no fog** — the way to the destination is already clear, the
whole journey small enough for one session — you don't need a map. Stop and ask
the user how they'd like to proceed.

## 3. Create the map

The map is the root node: an issue whose body carries Destination and Notes
filled in, Decisions-so-far empty, and the fog sketched into **Not yet
specified**. The body template is in `references/map.md`.

Put in **Notes** what every later session needs before choosing a node: the
domain, the skills to consult, standing preferences, and any override of the
plan-don't-do default.

## 4. Create the nodes you can specify now

```bash
soma graph add <root> \
  --title "…" --autonomy <auto|propose|approve> --kind <research|prototype|grilling|task> \
  --checkpoint <id> --body-file <path> \
  [--probe '{"type":"command","run":"…","timeoutSec":600,"expectExit":0}'] \
  [--blocked-by <id>]…
```

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
