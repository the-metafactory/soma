# Playbooks

A playbook card is the step list for one task shape. Route in this order:

1. Mode and effort tier first, from the classifier (`algorithm classify`; `references/mode-detection.md` for overrides).
2. Then the card whose task shape matches, from the table below. One card per run; when a task changes shape mid-run (an investigation that turns into a fix), switch cards and record the switch as a decision.
3. No card matches: run without one and record that in the run's decisions. A shape that keeps recurring without a card is a candidate for a new one.

| Card | Task shape |
| --- | --- |
| `references/playbooks/bug-fix.md` | something that worked is broken, throws or regressed |
| `references/playbooks/investigation.md` | a how or why question, or a choice between alternatives; no change asked |
| `references/playbooks/feature.md` | new behavior, a new command or surface |
| `references/playbooks/refactor.md` | the structure changes, the behavior does not |
| `references/playbooks/session-pickup.md` | resuming what a prior session or handoff left |
| `references/playbooks/pause-safely.md` | an explicit stop, or context about to run out |
| `references/playbooks/autonomous-run.md` | work the principal walks away from |
| `references/playbooks/authoring-a-skill.md` | creating or changing a skill or doctrine file |
| `references/playbooks/eval.md` | testing whether a variant changes behavior |

Using a card:

- Copy its steps, verbatim and numbered, as the first items of your substrate's todo list. A step you choose not to do stays in the list as `skip: <reason>`; never drop one silently.
- Its **Criteria** are templates: rewrite each for the task and pass them to `algorithm new --criterion "C1:…"`.
- Its **Principles** are the ones that most often decide that shape; the full vocabulary is `references/principles.md`.
- Its **Reply** line lists what the final message must contain.

Adapted in part from pstack (MIT, © 2026 Lauren Tan); notice in `references/third-party/pstack-NOTICE.md`.
