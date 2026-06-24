# VSA Format Reference

Load this reference only when the active task needs exact VSA structure, tier
requirements, guardrail distinctions, ID stability, ephemeral feature behavior,
or Algorithm integration details.

## Twelve-Section Body

Every VSA may contain up to twelve body sections. The tier completeness gate
decides which are required. Sections never appear empty. Order is fixed.

| # | Section | Purpose | Written at |
| --- | --- | --- | --- |
| 1 | `## Problem` | What is broken or missing right now | OBSERVE |
| 2 | `## Vision` | What euphoric surprise looks like | OBSERVE |
| 3 | `## Out of Scope` | What is explicitly not included | OBSERVE |
| 4 | `## Principles` | Substrate-independent truths the work must respect | OBSERVE |
| 5 | `## Constraints` | Immovable mandates that bound the solution space | OBSERVE |
| 6 | `## Goal` | Verifiable done in 1-3 sentences | OBSERVE |
| 7 | `## Checkpoints` | Atomic ISCs, including derived `Anti:` ISCs | OBSERVE to EXECUTE |
| 8 | `## Test Strategy` | Per-ISC verification approach | OBSERVE / PLAN |
| 9 | `## Features` | Work breakdown tied to ISC IDs | PLAN |
| 10 | `## Decisions` | Timestamped decisions and dead ends | any phase |
| 11 | `## Changelog` | Conjecture / refuted-by / learned / criterion-now trail | LEARN |
| 12 | `## Verification` | Evidence that each ISC passed | VERIFY |

> Section 7 was renamed `## Criteria` → `## Checkpoints` (soma#329). The reader
> dual-reads both headings (slice-4 code, #348), so pre-rename VSAs that still
> carry `## Criteria` keep loading; that section is rewritten to `## Checkpoints`
> only when it is next mutated. No migration. Where a workflow names
> `## Checkpoints`, operate on `## Criteria` instead if that is what the file has.

## Guardrail Taxonomy

| Guardrail | Binds | Tone | Lives in |
| --- | --- | --- | --- |
| Principles | The thinking | Aspirational and generalizable | `## Principles` |
| Constraints | The solution space | Immovable and non-negotiable | `## Constraints` |
| Out of Scope | The vision | Explicit prose boundary | `## Out of Scope` |
| Anti-criteria | The test surface | Granular yes/no probe | `## Checkpoints` with `Anti:` |

Principles, Constraints, and Out of Scope are author-stated. Anti-criteria are
derived from those guardrails so they become probe-able.

## Tier Completeness Gate

| Tier | Required sections |
| --- | --- |
| E1 | Goal, Checkpoints |
| E2 | Problem, Goal, Checkpoints, Test Strategy |
| E3 | Problem, Vision, Out of Scope, Constraints, Goal, Checkpoints, Features, Test Strategy |
| E4 | All twelve sections |
| E5 | All twelve sections plus an active Interview workflow run before BUILD |

Project VSA override: any `<project>/VSA.md` requires E3+ structure regardless
of the active task tier.

`CheckCompleteness` enforces this gate. A miss blocks `phase: complete` until
the missing sections are filled in.

## ID Stability

ISC IDs never renumber on edit. If `ISC-7` is split, preserve it as the parent
and add `ISC-7.1`, `ISC-7.2`, etc. If an ISC is dropped, leave a tombstone:

```markdown
- [ ] ISC-7: [DROPPED - see Decisions 2026-04-15]
```

Reconcile is keyed on ISC IDs. Renumbering breaks feature-file merges and
historical references in Decisions, Changelog, and Verification.

## Ephemeral Feature Files

For isolated feature work, the Algorithm may invoke:

```text
Skill("VSA", "extract feature <name> as ephemeral file")
```

`Scaffold` with ephemeral mode writes a derived view at
`MEMORY/WORK/{slug}/_ephemeral/<feature>.md` containing only:

- Vision and Goal as read-only context
- relevant Constraints
- ISCs from the feature's `satisfies:` list, with stable IDs preserved
- matching Test Strategy entries
- optional Decisions mentioning those ISC IDs
- empty Verification section

A fresh-context agent works against the ephemeral file. `Reconcile` then merges
checkmarks, Verification evidence, Decisions, and Changelog entries back to the
master VSA and archives the ephemeral file.

Ephemeral files are derived views. They are never sources of truth and should
not be used to hand-edit the master VSA.

## Relationship To The Algorithm

The Algorithm may use this skill at specific phases, but this skill does not run
the Algorithm.

| Phase | VSA skill action |
| --- | --- |
| OBSERVE | scaffold from prompt at tier T |
| OBSERVE | check completeness of an VSA at tier T |
| PLAN | extract feature as ephemeral file |
| LEARN | reconcile ephemeral path back to master path |

## Format Authority

The canonical format lives in Soma's VSA library and workflow files. If this
reference ever contradicts the parser, serializer, accessor tests, or workflow
contracts in this repo, update this reference to match the executable contract.
