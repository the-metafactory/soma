# Sequence work into verifiable units

**When it applies:** multi-step work (a sweep, a migration, a run of similar edits), and how you stack commits and PRs.

**Rule:** break the work into small units that each end in a checkable state. Do not start the next unit until the current one is green.

- Each unit is a bracket: known-good state, one change, the check, then on.
- Rebase onto a clean trunk first, so every check measures against the real baseline.
- When a tool does the edits, the per-unit check is nearly free. Run it anyway.
- Order commits so the sequence proves the work: the failing test, then the fix. Other orders: subtraction before reshape, baseline before treatment, scaffold before feature.
- Each commit stands on its own. The stack reads as an argument a reviewer can replay.

A break caught at its own unit is cheap to locate. One caught after a batch is buried under work built on it.

Related: `references/principles/build-the-lever.md` makes the per-unit check cheap; `references/principles/verify-before-claiming.md` keeps it real.
