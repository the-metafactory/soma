# Playbook routing A/B fixtures

`playbook-routing.json` extends the pstack adoption protocol settled in
[node #1042](https://github.com/the-metafactory/soma/issues/1042).
These are task-shape labels, after mode and effort selection; they do not
change the front-door mode router or its private training corpus.

Run each case in a fresh substrate session with the working method projected.
Give the labeller the `context` and `prompt`, withholding `expectedCard` and
`exactIndexRow` (structural-test metadata), and
ask it to select one playbook and copy its numbered steps into the todo list.
Record the selected card, the loaded file path and the copied steps. Score a
case as passing only when the selected card equals `expectedCard`, its file
loads, and the steps match the card verbatim. Do not implement the work.

Compare the same cases against `pre-pstack-baseline-2026-10-15` in soma and
soma-home. The baseline has neither new card, so neither can load; the changed
version must load Prototype and Planning respectively. The bug-fix case is
the regression control and must keep loading Bug fix. Planning's context
avoids its explicit Feature fast path for an obvious one- or two-PR change.

The cards now ship in the soma-pstack pack's `playbooks` skill, so the check
that each labelled card exists, and that the Prototype and Planning index rows
(`exactIndexRow: true`) match the card's task-shape text exactly, lives in that
pack's `test/playbooks.test.ts`. That structural check does not measure a model's routing agreement;
retain the labeller's selections and todo lists as the behavioral evidence.
