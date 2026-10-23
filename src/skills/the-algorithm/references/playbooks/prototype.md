# Playbook: Prototype

**Task shape:** a design choice with several plausible answers that a run can settle.
**You own:** the decision and the comparison evidence. The principal owns the choice.

## Steps

1. Name the decision the prototype settles. No decision → Feature card.
2. Build 2–3 throwaway variants with the `prototype` skill, outside production source. UI variants go behind one switcher.
3. Drive each variant through `verify-<project>` (or `run`). Capture a screenshot for each, or the measured number for behaviour or timing.
4. Compare on that evidence. Give tradeoffs and a recommendation, and add an unasked variant when it earns a place.
5. The principal picks. The choice and the rejected variants go into the run's decisions. The prototype is captured per the skill's rule 6 (throwaway branch).
6. Hand off to Feature, or to Planning when it needs several PRs.

## Criteria

- C1: decision named before code.
- C2: an evidence path per variant.
- C3: the choice and the rejected variants in decisions.
- Anti: no prototype code on main.

## Principles

`references/principles/experience-first.md`, `references/principles/probe-what-the-claim-asserts.md`, `references/principles/exhaust-the-design-space.md`.

**Reply:** the decision, evidence per variant, tradeoffs and recommendation, the principal's choice or the choice still waiting, and the handoff.
