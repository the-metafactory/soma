# Fog of war, and what lies past the destination

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond
the live nodes lies the **fog of war** — the dim view of decisions and
investigations you can tell are coming but can't yet pin down, because they hang
on questions still open. Resolving a node clears the fog ahead of it, graduating
whatever's now specifiable into fresh nodes — one at a time, until the way to
the destination is clear and no nodes remain.

The map's **Not yet specified** section is where that dim view is written down:
the suspected question, the area to revisit later. It's the undiscovered
frontier _toward_ the destination — everything there is in scope, just not sharp
enough to chart. Write as loosely or as fully as the view allows; it doubles as
a signpost for collaborators reading where the effort is headed.

### Fog or node?

The test is whether you can state the question precisely now — _not_ whether you
can answer it now.

- **Node when** the question is already sharp — even if it's blocked and you
  can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't
  pre-slice the fog into node-sized pieces: it's coarser than a node, and one
  patch may graduate into several nodes, or none, once the frontier reaches it.

**Not yet specified** excludes what's already decided (Decisions so far), what's
already a live node, and what's out of scope.

### Graduating a patch

When a resolution sharpens a patch, create its node(s) and **clear the patch
from Not yet specified**, leaving a dated comment recording where it went:

```markdown
<!-- graduated 2026-08-04 (#526): probe runner hardening → #527. -->
```

Two records that disagree are worse than one stale one, so a graduated patch
lives only as its new node.

## Out of scope

Fog only ever gathers _toward_ the destination. The destination fixes the scope,
so work beyond it is **out of scope** — it isn't fog, and it doesn't belong in
**Not yet specified**. It gets its own **Out of scope** section on the map: work
you've consciously ruled out of _this_ effort. Scope, not sharpness, lands it
there.

Out-of-scope work never graduates — the frontier stops at the destination — so
it returns only if the destination is redrawn, and then as a fresh effort, not a
resumption.

Ruling something out of scope is a scoping act, not a step on the route. When a
node that already exists turns out to sit past the destination — mis-scoped in
while charting, or exposed by a resolution — **close it** (a closed node is
unambiguously off the frontier) and leave one line in the **Out of scope**
section: the gist plus why it's out of scope, linking the closed node. It stays
out of **Decisions so far**, which records the route actually walked — a scope
boundary isn't a step on it.

## Scaffold nodes

Work spawned *by* resolving a node — a research subagent's follow-up, a
prototype's cleanup, anything the node's own work threw off — attaches **below
its spawning node, never to the map**:

```bash
soma graph add <the-node-you-are-resolving> --title "…" --autonomy auto …
```

The map's children are the route. A scaffold node is an implementation detail of
one step on it, and hanging it off the map makes `soma graph frontier` report
work the effort does not actually gate on.
