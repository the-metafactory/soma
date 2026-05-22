# Codex-Friendly Skill Entrypoints

Soma skills should be discoverable without spending most of a Codex session's
context on instructions. Treat `SKILL.md` as a compact router, not as the whole
manual.

## Recommended Budget

- Keep checked-in `SKILL.md` entrypoints at or below 120 lines.
- Put purpose, trigger guidance, fast path, routing, and reference links in the
  entrypoint.
- Move doctrine, examples, detailed tables, command references, and long
  operational checklists into `references/`, `Workflows/`, `Examples/`, or
  `Tools/`.
- Load references only after the entrypoint routes to them.

The 120-line limit is intentionally simple. It catches the failure mode that
hurts Codex most: a selected skill pasting a long manual into context before the
task-local repo evidence has been read.

Rare exceptions are allowed only when the extra entrypoint material is needed
before routing. Record the exception in `SKILL.md` frontmatter:

```yaml
codex-entrypoint-max-lines: 160
codex-entrypoint-exception: "Why this skill needs more pre-routing material."
```

Waived entrypoints are still capped at 240 lines by the repository test. Prefer
splitting to references before using a waiver.

## Entrypoint Shape

Use this structure unless a skill has a strong reason to differ:

1. Frontmatter with name, description, effort, version, and pack id if relevant.
2. One short purpose paragraph.
3. `Codex Fast Path` with the common execution route.
4. `When To Use` and `Do Not Use` guidance.
5. Workflow or command routing table.
6. Critical invariants only.
7. Reference-loading table.

## Current Inventory

The first #172 audit found two checked-in Soma skill entrypoints:

| Entrypoint | Pre-refactor size | Role | Action |
| --- | ---: | --- | --- |
| `skill/SKILL.md` | 22 lines | Soma kernel skill | Already compact. |
| `src/skills/ISA/SKILL.md` | 241 lines | Bundled ISA skill projected into substrates | Refactored into a compact entrypoint plus references. |

The ISA skill was the highest-impact representative target because it is bundled
with Soma, projected into installed homes, and likely to be invoked inside Codex
when working through Algorithm/ISA flows.

## Authoring Rule

If adding a new long-form section to a skill, ask whether the model needs it
before routing. If not, place it behind a named reference and add one line to the
entrypoint explaining when to load it.
