# Routing rules

The rules the front-door router decides by. Human labellers, model labellers and the classifier read this list and nothing else. Each rule is at most 16 words (lesson L4: agreement comes from clear policy before any model).

Agreed with the principal on 2026-09-28 (D8 in `Plans/2026-09-28-front-door-router-design.md`). Change a rule here, and only here. After a change, measure labeller agreement again before relabelling (step 3 of the plan).

## Terms

- **Working mode**: how a prompt is worked. The three values:
  - **minimal**: a brief line, nothing more.
  - **native**: a direct answer or change, with no harness.
  - **Algorithm**: a harness run with criteria and verification, at an effort tier E1–E5.
- **One-probe test**: can "done" be stated in one line and checked by one probe (a test run, a grep, a read)?
- **Follow-up**: a prompt that answers my previous reply by approving, correcting or pushing back.
- **Lane**: where the work runs.
  - **inline**: in this conversation.
  - **subagent-light**: a cheap subagent.
  - **subagent-strong**: a capable subagent.
  - **second-opinion**: an independent reviewer.

## Mode

1. Default is native; Algorithm needs explicit invocation or failing the one-probe test.
2. Explicit invocation wins (/eN, "use the Algorithm", "ultracode"); naming a term is not invoking it.
3. Acknowledgements, ratings, thanks and declines are minimal; an approval never is.
4. Native if done fits one line and one probe checks it; otherwise Algorithm.
5. Follow-ups (approve, correct, push back) take the mode their work needs; tone and brevity never decide.
6. Inside an open Algorithm run, follow-ups stay in the run until it completes.
7. Length, file count and keywords alone never decide the mode.

## Effort (only when the mode is Algorithm)

8. Effort tracks what an unnoticed error would cost; size alone only earns E5.
9. E4 only for doctrine, security model, or cross-cutting architecture decisions.
10. "Analyze/review" is read-only; that never raises effort by itself.

## Lane

11. Inline by default; hand off only independent work that needs no conversation context.
12. Light for search and volume, strong for deep independent work, second-opinion only to review decisions.
