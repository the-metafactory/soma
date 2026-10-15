# Playbook: Authoring a skill

**Task shape:** creating or changing a skill, a doctrine file, or a reference an agent will read.
**You own:** the skill's voice. Keep only prose that changes a decision.

## Steps

1. Check that no existing skill or reference already covers this; extend it instead of adding a second home.
2. Write the trigger first: the `description` names when to use it and when not.
3. Tell the agent what to do; explain why only where the rule is confusing without a reason.
4. Point at structural sources (types, schemas, other skills by path) instead of restating them.
5. Move bulk detail into `references/` files read on demand; keep the entry file short.
6. Validate: frontmatter has `name` and `description`, every referenced file exists, links resolve.
7. Add a test where the skill has structure a test can hold (a table that parses, a pointer that resolves).
8. Project it with `soma install` and read the projected copy once.

## Criteria

- C1: Frontmatter has `name` and `description` (probe: read the head of the file).
- C2: Every pointer in the skill resolves (probe: the bundled-skill reference test, or a grep and stat).
- C3: The projected copy matches the source (probe: diff after install).
- Anti: No rule a check already enforces is restated in prose (probe: grep the doctrine for it).

## Principles

`references/principles/encode-lessons-in-structure.md`, `references/principles/fix-the-class-not-the-instance.md`.

**Reply:** what the skill does, the key design decisions, and the validation output.
