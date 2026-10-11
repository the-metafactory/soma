# Workflow: Walk the map

The user arrived with a map — a root node id or URL. A node is **optional**:
without one, you pick the next decision, not the user.

**One node per session**, research excepted. Other sessions may be writing the
graph concurrently.

## 1. Load the map

Even when the user names a child node, follow `parent` references to the root.
Keep ancestry reads small by filtering the structured response before loading
it into context:

```bash
soma graph node <id> --json | jq '{ref, parent}'
```

Repeat for each parent; do not print a whole large map just to find its parent.
Read the named decision's body with `soma graph node <id>`. For ancestor maps
and the root, select sections:

```bash
soma graph node <root> --section Destination,Constraints,Notes
soma graph node <root> --section "Not yet specified,Out of scope"
soma graph frontier <root>
```

`--section` accepts repeated flags or comma lists and prints only matching H2
sections. A missing section is reported explicitly; retry with the sections
present on that map rather than silently skipping its Constraints. Use the filtered JSON ancestry query above when the parent reference is needed.

Read the Constraints on every ancestor map. Follow explicit constraint
inheritance in Constraints or Notes (for example, “#1's Constraints bind every
answer”), loading that map's Constraints and Notes too. Track visited IDs to
stop cycles; surface an unreadable inherited map before proposing an answer.

**Treat these Constraints as binding on the answer you are about to write**.
Read Destination, Notes, Not yet specified and Out of scope to orient to the
map. Do not load every child. Always scan frontier titles for overlapping work,
even for a named node; open likely siblings before proposing scope or options.
Report overlap so the principal can decide whether to combine or rescope it.

## 2. Choose and claim

```bash
soma graph frontier <root>
soma graph claim <id>
```

If the user named a node, use it. Otherwise take the first frontier node in
order. **Claim before any work** — the assignment is the claim, and it is what
makes a concurrent session skip the node.

If the claim reports a lost race, pick another node. The verb re-reads after
writing rather than assuming it won, so trust what it says.

## 3. Resolve it

**Zoom as needed** — `soma graph node <id>` for any related or closed node on
demand, rather than loading them up front. Invoke the skills the map's Notes
name. If in doubt, use `/grilling` and `/domain-modeling`.

A HITL node (`propose` / `approve`) resolves only through live exchange with the
human. Never stand in for their side of it.

Where a constraint touches the options you are weighing, make that **dimension
visible in them** — cost under a budget constraint, effort under a deadline — so
the constraint is applied where the choice is offered rather than discovered
after it. The node never restates the constraint itself: it lives on the map
alone.

If resolving this node throws off work of its own, attach that **below this
node**, never to the map (`references/fog.md`).

## 4. Record the resolution

Read `references/closing.md` first — the close refuses a hollow one, and the
refusal is easier to avoid than to fix.

1. Write the answer to a file, then
   `soma graph close <id> --resolution-file <path> --gist "<one line>"` — one
   act: the prose rides the receipt into a single comment, and the gist is its
   one-line form. Add `--dry-run` first when you are unsure the receipt will
   hold. A close with no prose is refused before any probe runs. The gist should
   let a map reader judge relevance without opening the node; the detail stays
   in the resolution.
2. `soma graph decisions <root> --write` — the map's decision index re-derives
   from receipts. Never hand-edit the span between the decisions markers. The
   body template carries them, so a map charted from it is writable; a map
   charted before they were in the template — or from a hand-rolled body — has
   none, and the verb refuses rather than guessing where the index belongs. Its
   error prints the two lines: add them once, and it owns the span from then on.

For a HITL node wanting a second opinion, the two-phase `--propose` →
ratification → `--proposal-comment` sequence stands, and the proposal body is the
resolution — do not pass both.

## 5. Advance the frontier

- **Add newly-surfaced nodes**, wiring their blockers. On a map whose Notes allow Build nodes, build work a decision made specifiable is filed **unclaimed** unless this session builds it now. A claimed node is invisible to an autonomous walker (`references/walker.md`). Write each build node's body from `references/build-brief.md`, and split it there if it holds more than one slice; a choice the decision left open is a grilling node the build is blocked by, not part of the brief.
- **Graduate any fog** the answer made specifiable, clearing each graduated
  patch from **Not yet specified** so it lives only as its new node.
- **Rule out of scope** anything the answer revealed to sit past the
  destination — close it and record one line under **Out of scope**, not under
  Decisions so far.
- **Update or delete** nodes the decision invalidated.
- **Record a constraint the work surfaced** in the map's **Constraints**
  section, never only in this node's resolution — a constraint buried in a
  receipt is one no later session reads. If it invalidates decisions already
  closed, say so plainly in your report rather than quietly working around it:
  re-resolving them is hand work with no verb behind it yet.

Then report: what closed, what it means for the frontier, and what is now
takeable. Name things by their titles.
