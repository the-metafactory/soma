---
name: orienteer
description: "Plan a huge chunk of work — more than one agent session can hold — as a shared map of decision nodes on the work graph, and resolve them one at a time until the way to the destination is clear. Use to chart a map for a loose idea, or to walk an existing map's frontier. Every operation is a `soma graph` verb; nodes close only through their checkpoint gate."
effort: medium
version: 1.0.0
metadata:
  short-description: Soma work-graph navigation doctrine
---

# Orienteer

A loose idea has arrived — too big for one agent session, and wrapped in fog:
the way from here to the **destination** isn't visible yet. Orienteering is
about finding that way, not charging at the destination. This skill charts the
way as a **shared map** on the work graph, then works its **decision nodes** —
questions whose resolution is a decision, not slices of a build to execute — one
at a time until the route is clear.

The name is the practice: orienteering is checkpoint-based map navigation, and
the route only counts if you pass the controls.

## Fast path

Walking an existing map is the common case. Its root node id is the map:

```bash
soma graph frontier <root>     # what is takeable: open, unassigned, unblocked
soma graph claim <id>          # claim ONE, before any work
soma graph node <id>           # read it (body included), and any node it references
#  … resolve it …
soma graph close <id> --resolution-file <path> --gist "<one line>"
soma graph decisions <root> --write   # re-derive the map's decision index from receipts
```

The gist rides the receipt and `decisions --write` projects every closed node's
gist into the map body — the map's index is derived, never hand-edited. Then
graduate any fog the answer sharpened. Read `Workflows/WalkTheMap.md` before
step one.

## When to use

- A loose idea too big to hold in one session, where the *route* is unclear —
  not just the work. Chart it: `Workflows/ChartTheMap.md`.
- An existing map with open nodes. Walk it: `Workflows/WalkTheMap.md`.

**Do not use** when the way to the destination is already clear and the whole
journey fits one session — you don't need a map, you need to do the work. If
charting surfaces no fog, say so and stop.

## The verbs

Every graph operation is a `soma graph` verb. **Never reach past them to the
tracker's own CLI** — the verbs carry the rules (structural validation, cycle
rejection, claim tie-break, the hollow-close refusal), and a raw tracker write is
those rules not running. The backend hides behind the CLI, which is what makes
this doctrine tracker-agnostic by construction.

| Verb | What it does |
| --- | --- |
| `soma graph frontier <root>` | open ∧ unassigned ∧ unblocked, confirmed by direct fetch |
| `soma graph node <id>` | read one node, body included — never `gh issue view` |
| `soma graph claim <id>` | assign, re-read, tie-break on race |
| `soma graph add <root> … --checkpoint <id>` | create node (+ `--blocked-by` edges), structurally validated; refuses without a checkpoint |
| `soma graph close <id> --resolution-file <path> [--gist <line>]` | post the prose, run declared probes, derive the receipt, refuse a hollow close |
| `soma graph audit <root>` | what the gates cannot see: closed-without-receipt, can-never-close, claimed-in-flight |
| `soma graph decisions <root> [--write]` | the map's decision index, derived from receipts; `--write` splices it into the map body |

`--repo <owner/name>` (or `SOMA_GRAPH_REPO`) picks the backing repository; it
defaults to the origin remote of the working tree.

## Invariants

- **Plan, don't do.** Each node resolves a decision. The pull to just do the
  work is usually the signal you've reached the edge of the map and it's time to
  hand off. An effort can override this in its map **Notes**; absent that,
  produce decisions, not deliverables.
- **One node per session** — research nodes excepted.
- **Claim first**, before any work, so concurrent sessions skip it.
- **Refer by name.** In everything the human reads, name a map or node by its
  title, never by a bare id. A wall of `#42, #43, #44` is illegible; the id and
  URL ride *inside* the name, never stand in for it.
- **The map is an index, not a store.** A decision lives in exactly one place —
  its node. The map gists and links, never restates.
- **HITL means a human speaks for themselves.** The agent never stands in for
  their side of it; a grilling agent that answers its own questions has broken
  this.
- **Scaffold nodes attach below their spawning node, never to the map.** The
  map's children are the route; work thrown off by one step is an
  implementation detail of that step, and the edge records which one. This is
  **provenance, not concealment** — the frontier walks the whole subtree, so
  placement never hides a node (#557). To keep work off the frontier, use one
  of the three things the predicate actually reads: **close** it (past the
  destination), **block** it (waiting on something), or **claim** it (yours,
  in flight). Burying it is not among them.

## References

Load only what the task routes to.

| File | Load when |
| --- | --- |
| `Workflows/ChartTheMap.md` | Charting a new map from a loose idea |
| `Workflows/WalkTheMap.md` | Resolving a node on an existing map |
| `references/map.md` | Writing the map body, or creating a node — anatomy, `autonomy` vs `kind`, the four work kinds |
| `references/closing.md` | Closing a node — checkpoints, probes, the probe registry, AFK vs HITL receipts, attestation |
| `references/fog.md` | Deciding whether something is fog, a node, or out of scope |

## Lineage

Forked from Matt Pocock's `wayfinder` skill and re-based onto the `soma graph`
verbs. Upstream is a **manual cherry-pick** relationship: improvements are
ported by hand through a reviewed PR, never by re-syncing. Two copies with
diverging conventions would be the two-authoritative-homes problem this doctrine
exists to prevent.

Doctrine record: DD-16 and its Amendment A in `design/design-decisions.md`; the
typed contracts in `docs/work-graph.md`.
