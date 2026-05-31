---
name: ISA
description: "Owns the Ideal State Artifact: the commitment-time scaffold for articulating done, deriving ISC criteria, planning features, recording decisions, and verifying work. Use for ideal state, ISA/ISC criteria, project specs, scaffolding, completeness checks, reconciliation, or seeding an ISA from a repo."
effort: medium
version: 1.0.4
pack-id: pai-isa-v1.0.0
---

# ISA

The ISA is the document that articulates "done" for work whose ideal state is
being pursued: a project, feature, library, infrastructure change, work session,
art piece, or strategic decision. It acts as ideal-state articulation, test
harness, done condition, verification record, and system of record.

## Fast Path

1. Identify the requested ISA workflow from the routing table below.
2. Load only that workflow file from `Workflows/`.
3. Load `references/format.md` only when the task needs section, tier, ISC, or
   reconciliation rules.
4. Load `references/examples.md` only when scaffolding or comparing against an
   exemplar.
5. Load `references/gotchas.md` before reconcile, tier checks, or any edit that
   might renumber criteria.

Do not load the full examples directory by default. Pick the smallest example
that matches the task tier and domain.

## When To Use

Use when the prompt mentions ideal state, ISA, ISC, ideal state criteria,
project specification, articulating done, scaffolding an ISA, interviewing for
an ISA, checking completeness, reconciling an ephemeral feature file back to a
master ISA, or seeding an ISA from an existing project.

Do not use for creating new skills, running the Algorithm itself, generating
non-ISA artifacts, postmortems, decision logs, or engineering journals. Those
are retrospective; the ISA is a commitment-time scaffold.

## Workflow Routing

When ambiguous, default to Scaffold for new ISAs and CheckCompleteness for
audits.

| Intent | Workflow | Load |
| --- | --- | --- |
| scaffold, create, generate, new ISA, extract feature as ephemeral | Scaffold | `Workflows/Scaffold.md` |
| interview me, fill in, deepen, ask questions | Interview | `Workflows/Interview.md` |
| check, audit, score, is this complete | CheckCompleteness | `Workflows/CheckCompleteness.md` |
| reconcile, merge feature file back, ephemeral to master | Reconcile | `Workflows/Reconcile.md` |
| seed, bootstrap from repo, draft from existing code | Seed | `Workflows/Seed.md` |
| append decision, append changelog, append verification, record C/R/L | Append | `Workflows/Append.md` |

When executing a workflow, emit:

```text
Running the **WorkflowName** workflow in the **ISA** skill to ACTION...
```

Then follow the selected workflow file. If that workflow includes a substrate
notification step, execute it when the local substrate supports it; otherwise
continue with the workflow text notification.

## Core Rules

- Stable ISC IDs are sacred. Never renumber criteria after creation.
- Empty sections are omitted unless the active tier requires them.
- At least one `Anti:` ISC is required at every tier.
- Experiential work requires at least one `Antecedent:` ISC.
- Project ISAs require E3+ structure even when the active task is smaller.
- Ephemeral feature files are derived views, never sources of truth.
- Reconcile is deterministic and keyed by ISC ID.

Load `references/format.md` for the twelve-section body, tier gate, guardrail
taxonomy, ID-stability contract, and Algorithm relationship.

## Reference Loading

| Need | Load |
| --- | --- |
| Section order, tier requirements, guardrail taxonomy, ID stability | `references/format.md` |
| Failure modes and non-obvious operational traps | `references/gotchas.md` |
| Example selection by tier and domain | `references/examples.md` |
| Canonical full example | `Examples/canonical-isa.md` |
| Minimal E1 example | `Examples/e1-minimal.md` |

## Example Selection

Start with `Examples/canonical-isa.md` only when you need the full shape or
tone. Otherwise load `references/examples.md` and choose the closest small
reference from that single map.
