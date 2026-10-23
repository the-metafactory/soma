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

`test/substrates/working-method.test.ts` checks that the fixture labels resolve
through the generated bundle and every projected index, with no duplicate
rows. Fixtures with `exactIndexRow: true` also require the index row to match
the card's task-shape text exactly. That structural check does not measure a model's routing agreement;
retain the labeller's selections and todo lists as the behavioral evidence.
