# Domain Docs

How the engineering skills should consume soma's domain documentation when exploring the codebase.

## Hierarchy of authority

1. **`ISA.md`** at repo root — current source of truth for scope, criteria, decisions in flight, and verification (per AGENTS.md).
2. **`design/design-decisions.md`** — the **metafactory Design Decisions** record. Numbered DD-N. If anything contradicts a DD, the DD wins.
3. **`CONTEXT.md`** at repo root — domain glossary (does not yet exist; `/grill-with-docs` creates it lazily as terms get resolved).
4. **`research/*.md`** — evidence base. DDs cite specific research findings.
5. **`docs/*.md`** — supporting docs: `architecture.md`, `substrate-adapters.md`, `naming.md`, `boundaries.md`, `default-availability.md`, etc.

If `CONTEXT.md` or `design/design-decisions.md` don't exist yet, **proceed silently**. Don't flag absence; don't suggest creating them upfront. The producer skills create them lazily when terms or decisions actually get resolved.

## Metafactory Design Decision format

Each DD is a section inside `design/design-decisions.md`:

````markdown
## DD-N: Title

**Status:** Accepted | Proposed | Deprecated | Superseded
**Date:** YYYY-MM-DD
**Authors:** Names
**Research:** research/<file>.md, <other refs>

### Context
What problem this addresses; what was previously the case.

### Decision
The actual rule. One paragraph, hard-to-vary.

### Consequences
What this commits the project to. Trade-offs accepted.
````

DD numbering is **per-repo sequential**. Pick the next free number when adding one.

## File structure

```
~/work/mf/soma/
├── AGENTS.md
├── ISA.md
├── CONTEXT.md                    ← lazily created by /grill-with-docs
├── design/
│   └── design-decisions.md       ← metafactory DD format, numbered DD-N
├── research/                     ← evidence cited by DDs
├── docs/
│   ├── architecture.md
│   ├── boundaries.md
│   ├── substrate-adapters.md
│   ├── naming.md
│   └── ...
└── src/
    ├── adapters/
    └── skills/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag DD conflicts

If your output contradicts an existing DD, surface it explicitly rather than silently overriding:

> _Contradicts DD-7 (single-process execution model) — but worth reopening because…_

Per metafactory SOP, contradictions go back through the design process: ground the counter-argument in research, propose a new DD that supersedes the old one (`**Status:** Superseded by DD-N`).

## Document lineage (metafactory canon)

```
Research (evidence in research/)
  └── Design Decisions (rules in design/design-decisions.md)
        └── Roadmap / iteration plans (if present)
              └── Design specs / feature issues
                    └── Code
```

Each level is grounded in the level above. See `~/work/mf/compass/sops/design-process.md` for the full metafactory design-process SOP.
