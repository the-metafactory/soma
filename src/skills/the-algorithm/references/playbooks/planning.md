# Playbook: Planning

**Task shape:** an accepted design that needs more than one PR.
**You own:** the slices, their blockers and live probes. The principal owns the go to execute.

## Steps

1. 1–2 PRs with an obvious approach → skip; run Feature.
2. Settle open questions with the Prototype card first.
3. Slice into vertical, independently verifiable PRs with explicit blockers (`to-tickets` rules; expand-contract for wide refactors).
4. Each slice carries a deliverable, acceptance criteria and a live probe: the command or verify-skill run that shows it working. Tests alone don't count.
5. File the slices: as orienteer build nodes on a map (build-brief), otherwise with `to-tickets`. No plan file unless the principal asks; one would go in `docs/plans/` and be deleted on completion.
6. Run the structure check (`soma graph audit`) and fix what it reports.
7. Hand back and stop. Execution starts only on the principal's go.

## Criteria

- every slice has a live probe separate from the suite.
- audit clean.
- blockers form a DAG.
- Anti: no implementation in the planning run.

## Principles

`references/principles/analysis-is-read-only.md`, `references/principles/sequence-verifiable-units.md`, `references/principles/one-probe-per-criterion.md`.

**Reply:** the filed slices, blockers, live probes and audit result, and the go still waiting on the principal.
