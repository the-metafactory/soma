# Playbook: Session pickup

**Task shape:** resuming work a prior session, agent or handoff left behind.
**You own:** the resume point. The prior trail is input; do not redo it.

## Steps

1. Locate the trail: the Algorithm run (`algorithm list`, `algorithm show`), the VSA, a handoff note, the branch.
2. Read the last state first, then scan back for the decision points.
3. Reconstruct operational state: branch, what landed (`git log` and `git diff` against the base), open todos, decisions made.
4. Diff done against planned, and name the resume point.
5. Re-check only the inherited claims the remaining work depends on, on the real artifact. A prior self-report is not proof.
6. Route the remaining work to its matching card. This card ends here.

## Criteria

- C1: The resume point is named before new work starts (probe: the first decision recorded in the run).
- C2: Each inherited claim the next step depends on was probed this session (probe: the probe outputs).
- Anti: No completed step was redone (probe: the run's steps against the prior trail).

## Principles

`references/principles/ground-claims-in-this-session.md`, `references/principles/verify-before-claiming.md`.

**Reply:** where the prior session stopped, what you inherited and what you redid (ideally nothing), the resume point, and the card you routed to.
