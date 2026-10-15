# Playbook: Bug fix

**Task shape:** something that worked is broken, throws, regressed or fails a check.
**You own:** the cause. Every shipped line traces to runtime evidence.

## Steps

1. Reproduce the failure on the surface the report names, before any edit. Capture the output.
2. If it will not reproduce, tighten conditions, synthesize the trigger or instrument until it fires.
3. List candidate causes, then rule them out one at a time with runtime evidence, taking the split that eliminates the most each pass.
4. Name where the bad state enters the system, and place the fix there if that removes the class.
5. Commit the failing reproduction as a test where a cheap one exists.
6. Make the smallest change the evidence justifies. Revert anything a refuted hypothesis motivated.
7. Rerun the original reproduction on the same surface. Wrong surface or "inconclusive" is not a pass.
8. Run the suites the change can reach, then open the change for review.

## Criteria

Seed `algorithm new` with these, rewritten for the bug:

- C1: The reported failure reproduces before the fix (probe: the captured repro output).
- C2: The same reproduction passes after the fix (probe: the same command, rerun).
- C3: A test fails without the fix and passes with it (probe: the test, both ways).
- C4: The ingestion point is named in the run's decisions (probe: `algorithm show`).
- Anti: No change ships that no probe in the run asked for (probe: the diff against the evidence list).

## Principles

`references/principles/reproduce-first.md`, `references/principles/fix-at-the-ingestion-point.md`, `references/principles/ship-what-the-evidence-justifies.md`; on a second report, `references/principles/diagnose-on-recurrence.md`.

**Reply:** what was broken, the root cause, the fix, and the failing-then-passing reproduction output, verbatim.
