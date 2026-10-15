# Playbook: Autonomous run

**Task shape:** work the principal walks away from: overnight, a loop, a walker-driven node.
**You own:** the exit condition. Define done, then drive to it.

## Steps

1. State the exit condition as a checkable predicate before the first iteration.
2. Choose how you wake: an event to watch where one exists, otherwise an interval sized to when the result is worth re-checking.
3. Each iteration makes the smallest change the evidence justifies, verifies it against the predicate, and commits if it advanced.
4. Discard changes that did not help. Do not leave them to ride.
5. Append one row per fork, revert or verified unit to the run's decision trail: time, phase, decision, why, evidence pointer (a path or SHA), result.
6. Fix reversible problems you meet on the way yourself; stop for the principal only on an irreversible action, a real preference call, or a dead end.
7. Stop when the predicate is met. A plateau is not a stop; change approach. Never relax the predicate to declare victory.

## Criteria

- C1: The predicate is written down before iteration one (probe: the first trail row).
- C2: The predicate holds at the end (probe: the predicate's own check, rerun).
- C3: Every iteration has a trail row with an evidence pointer (probe: the trail against the commits).
- Anti: The predicate was not weakened during the run (probe: first and last statement compared).

## Principles

`references/principles/ship-what-the-evidence-justifies.md`, `references/principles/build-over-ask-when-reversible.md`, `references/principles/ask-before-irreversible.md`.

**Reply:** the exit condition, iterations run, what landed, what was discarded, the final predicate state, and where the trail is.
