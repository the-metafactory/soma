# Playbook: Refactor

**Task shape:** the structure changes and the behavior does not.
**You own:** the contract. A missing feature or a real bug found on the way is split out, not folded in.

## Steps

1. Pin the current behavior first: a characterization test, a snapshot or an equivalence harness. Type check and lint are not a pin.
2. Name the structure the code is missing, and the target shape you would build today.
3. Subtract before adding: delete dead code, one-caller wrappers and orphan references first.
4. Move in small steps, each keeping the pin green.
5. For an interface change, migrate every caller and delete the old interface in the same change. No compatibility shims.
6. Check every rename against strings, docs and back-references, not only the compiler.
7. Prove behavior is unchanged on the real artifact; for a large reshape, diff old against new output.
8. Keep the change only if it lowers what a reader must hold; otherwise revert it.

## Criteria

- C1: A pin captures current behavior before any structural edit (probe: the pin's commit precedes the move).
- C2: The pin passes after the move (probe: the pin, rerun).
- C3: No caller of the old interface remains (probe: a repo-wide grep for the old name).
- Anti: No behavior change ships in this change (probe: the equivalence diff is empty).

## Principles

`references/principles/fix-the-class-not-the-instance.md`, `references/principles/change-only-what-was-asked.md`, `references/principles/probe-what-the-claim-asserts.md`.

**Reply:** the structure that changed, the pin it held against, the equivalence proof, and what you reverted.
