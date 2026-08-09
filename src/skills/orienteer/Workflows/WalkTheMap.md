# Workflow: Walk the map

The user arrived with a map — a root node id or URL. A node is **optional**:
without one, you pick the next decision, not the user.

**One node per session**, research excepted. Other sessions may be writing the
graph concurrently.

## 1. Load the map

```bash
soma graph node <root>
```

Read its body: Destination, Notes, Decisions so far, Not yet specified, Out of
scope. This is the low-resolution view — do **not** load every child. Orient to
the destination before choosing anything, and honour whatever the Notes name.

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

If resolving this node throws off work of its own, attach that **below this
node**, never to the map (`references/fog.md`).

## 4. Record the resolution

Read `references/closing.md` first — the close refuses a hollow one, and the
refusal is easier to avoid than to fix.

1. Write the answer to a file, then
   `soma graph close <id> --resolution-file <path>` — one act: the prose rides
   the receipt into a single comment. Add `--dry-run` first when you are unsure
   the receipt will hold. A close with no prose is refused before any probe runs.
2. Append a one-line gist plus link to the map's **Decisions so far**. Enough to
   judge relevance; the detail stays in the node.

For a HITL node wanting a second opinion, the two-phase `--propose` →
ratification → `--proposal-comment` sequence stands, and the proposal body is the
resolution — do not pass both.

## 5. Advance the frontier

- **Add newly-surfaced nodes**, wiring their blockers.
- **Graduate any fog** the answer made specifiable, clearing each graduated
  patch from **Not yet specified** so it lives only as its new node.
- **Rule out of scope** anything the answer revealed to sit past the
  destination — close it and record one line under **Out of scope**, not under
  Decisions so far.
- **Update or delete** nodes the decision invalidated.

Then report: what closed, what it means for the frontier, and what is now
takeable. Name things by their titles.
