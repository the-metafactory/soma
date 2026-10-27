# Second opinion at commitment boundaries

**When it applies:** multi-step work (E2 and up, multi-file edits, architecture changes) reaches one of three moments: before committing to an approach, when one problem has resisted two distinct attempts, or after a durable deliverable and before declaring done. At E4 and E5, also before completion.

**Rule:** ask something that did not produce the work a specific question ("this decision point", "any gaps before done?"), not "review this". At E4 and E5, the completion audit comes from a model outside the family that did the work.

The "before committing to an approach" boundary judges a concrete artifact (prototype, type sketch, measurement or failing test), produced through the soma-pstack pack's Prototype card, when installed, never an abstract plan.

Carve-out: the decision's output is prose (doctrine, policy, a grilling), or the approach cannot be exercised without making the commitment itself (a migration, a deploy, an external publish). The runner records the call in the run's `## Decisions`.

In a carve-out review, a risk citing no file:line, run artifact or measured number goes to a separate "unsupported" list. It never blocks and is not acted on unless the principal picks it up.

- Select `Advisor`, and at E4 and E5 also `CrossFamilyAudit`, and bind them locally (`references/capabilities.md`, contract rows and model roles). A same-family reviewer never stands in for the cross-family audit: the shared blind spot is what the audit checks.
- Nothing can satisfy the contract on this machine: do not select the capability, and record the gap in the run's decisions. Never fabricate the opinion.
- Act on the audit verdict:

| Verdict | Action |
| --- | --- |
| `pass`, no `critical` finding | continue to LEARN |
| `concerns` | show the findings to the principal; ask approve, iterate or defer |
| `fail`, or any `critical` finding | block completion; `references/principles/surface-conflicts.md` |

You skipped this when a commitment boundary passed with neither an opinion nor a recorded gap.
