# Playbook: Feature

**Task shape:** new behavior, a new command, a new surface.
**You own:** the design. Implementation can be delegated; the decisions cannot.

## Steps

1. Read the subsystem the feature lands in, and recall prior work on it.
2. Write the criteria before the code: what the feature does, how each claim is probed, what must not change.
3. Choose the data shape first: a typed model, a table or registry over branching, a state machine over scattered flags.
4. Plan the order: blocking steps first, independent workstreams in parallel, shared write targets split per actor or serialized.
5. Get a second opinion at the commitment boundary when the design admits several valid shapes: settle them with the Prototype card first, and the `Advisor` judges the prototype's evidence, not the plan.
6. Build in small units; verify and commit each before starting the next.
7. Verify on the surface the user will touch, not only through unit tests. When the project has a verify skill (`verify-<project>`), drive the change through it and attach its evidence to the review.
8. Run the suites, then open the change for review in small, ordered commits.

## Criteria

- C1: Each behavior the request names has a test or a probe that exercises it (probe: the test names).
- C2: The feature works on the real surface (probe: the command, the page, the API call, with output).
- C3: The design choice and the rejected alternative are in the run's decisions (probe: `algorithm show`).
- Anti: Existing behavior outside the feature is unchanged (probe: the full suite, green).

## Principles

`references/principles/one-probe-per-criterion.md`, `references/principles/separate-before-serializing-shared-state.md`, `references/principles/change-only-what-was-asked.md`.

**Reply:** what you built, what you chose and why, how you verified it on the real surface, and the decisions still open.
