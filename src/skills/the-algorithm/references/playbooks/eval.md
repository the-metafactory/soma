# Playbook: Eval

**Task shape:** testing whether a variant (a prompt, a skill, a model, doctrine) changes behavior.
**You own:** the experiment design. Blind it, run it, explain the result.

## Steps

1. Frame: name the variant under test and the behavior that counts as success. Write a rubric of 3 to 6 concrete criteria for the judge only.
2. Record the baseline and the variant as reproducible states (a tag, a commit, a config).
3. Write one organic task prompt, as a user would type it. Nothing in it names the eval, the rubric or the comparison.
4. Run the candidates in separate working directories with sanitized names, on the same prompt.
5. Score with a judge that is not the producer, sees outputs by sanitized label only, and scores both sets on one scale (the registry's `JudgeOutput`).
6. Check what each candidate actually did from its transcript or trail, not from its own report.
7. Read every output yourself and compare to the judge. A disagreement means bias or an ambiguous rubric.
8. Explain the number: run count, spread, and what else it could be measuring.

## Criteria

- C1: Baseline and variant are named, reproducible states (probe: the tag or commit resolves).
- C2: The candidate prompt names no eval term (probe: grep the prompt).
- C3: Each result carries run count and spread (probe: the results table).
- Anti: The judge never saw a model or variant name (probe: the judge's input).

## Principles

`references/principles/explain-the-number.md`, `references/principles/surface-conflicts.md`.

**Reply:** the variant under test, the rubric, the per-candidate notes, the judge's verdict, your synthesis, and whether to promote the variant.
