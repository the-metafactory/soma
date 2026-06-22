---
status: accepted
---

# De-Miessler the working-method vocabulary: `checkpoint`, `intent`, `Purpose`, `Verification`, `VSA`

## Context

Soma's working-method vocabulary was inherited wholesale from Daniel Miessler's
PAI: the **Telos** compartment and the **ISA / ISC / Algorithm / effort-tier /
euphoric-surprise** apparatus. Two problems. First, the lineage: these are
Miessler's constructs, and Soma's differentiation argument weakens if its core
nouns are borrowed. Second, the weight: PAI's Telos is a nine-category LifeOS
schema (mission, beliefs, narratives, strategies, problems, challenges, measures),
and JC's explicit stance is *"Personal AI Infrastructure, not a LifeOS."*

First-principles on the two constructs showed both reduce to the **same bone**: a
checkable criterion + required evidence → typed verdict, behind a completion gate.
ISA points that bone at *done-ness*; Telos's one durable function points it at
*direction*. The code already proves the shape — `IdealStateCriterion { text,
status, verification }` (`src/types.ts`) is exactly the bone, and `Telos` is
already slimmed to `{ mission, goals, principles, commitments }`.

## Decision

Three canonical terms, locked in `CONTEXT.md`:

- **`checkpoint`** — the extracted evidence-gated verification primitive
  ({ criterion, evidence, typed verdict, completion gate }), applied on two axes:
  done-ness and intent. The deterministic spine: *inference proposes, the
  checkpoint disposes.*
- **`intent`** — the checkable directional anchor a checkpoint scores work against
  (the one durable bone of Telos, minus the schema).
- **`Purpose`** — the compartment formerly named **Telos** (the English meaning of
  *telos*). Unchanged in shape and role; only the brand moved.
- **`Verification`** — the compartment formerly named **ISA**. Names its actual job:
  done-ness, established with evidence. (Policy's descriptor reworded from
  "verification rules" to "evidence and audit rules" to clear the lowercase collision.)
- **`VSA` (Verification State Artifact)** — the artifact formerly named **ISA**
  (Ideal State Artifact). One-for-one swap: Ideal → Verification, keeping State
  Artifact. `soma isa` → `soma vsa`.

This is a **shared primitive across two existing compartments, not a compartment
merge** — the seven compartments stay seven (Identity · Purpose · Verification ·
Skills · Memory · Policy · Learning). The Algorithm/effort-tier/euphoric-surprise
apparatus remains as an *optional workflow pack* over checkpoints, not the canonical
primitive name.

## Considered options

- **Direction-anchor name.** `heading` was locked first, then rejected — it
  collides with markdown section titles, which are ubiquitous in a docs-native
  repo. `bearing` was rejected — it collides with "load-bearing," pervasive in the
  architecture prose. `intent` chosen: clarity over the nautical-metaphor cohesion.
- **Compartment merge vs. shared primitive.** A literal ISA+Telos merge (seven → six)
  was rejected: it would rewrite `architecture.md`, `soma-home-layout.md`, the home
  layout, and the `soma isa` CLI while discarding structure (Algorithm runs, phases,
  reconcile partitions) that is not the primitive.
- **`Purpose` vs. `Aim`.** `Aim` was the runner-up; `Purpose` won as the literal
  translation of *telos*, preserving meaning while dropping the brand.
- **`Verification` vs. `Method`.** `Method` was the zero-collision runner-up but
  broader than the compartment's verification core; `Verification` chosen, with the
  Policy descriptor reworded to clear the lowercase collision.
- **`VSA` vs. `Verifact` / `VA`.** `Verifact` (catchier, full break) and `VA`
  (overloaded acronym) rejected; `VSA` keeps the ISA cadence so the rename is
  mechanical.
- **Killing `ISA` now vs. deferring.** Deferring ISA was initially recommended
  (descriptive English, large footprint). JC chose to kill it in the same pass for a
  fully de-Miesslered set; accepted.

## Consequences

- `CONTEXT.md` glossary updated now (this session).
- **Pending code/doc/path rename** (not done here, larger than the glossary):
  - Telos → Purpose: `interface Telos` (`src/types.ts`), the `telos/` home path,
    `~/.claude/rules/soma/TELOS.md` projection, `soma`/migrate references, `docs/`.
  - ISA → Verification / VSA: `soma isa` → `soma vsa` CLI, `IsaFrontmatter`,
    `SomaActiveIsaState`, `IsaSection`, `isa-reconcile`, `src/skills/ISA/`, the five
    `e1`–`e5` example docs, and ISA mentions across `docs/`.
  Scope as a follow-up task before the terms are load-bearing in code. The CONTEXT.md
  glossary is the source of truth in the interim.
- `ISA` / `ISC` / effort tiers / euphoric surprise are retired as *canonical* Soma
  terms but retained as an optional Algorithm pack — existing VSA docs and CLI keep
  working under the old names until the rename lands.
- Reversible only at meaningful cost once the code/path rename lands; hence this record.
