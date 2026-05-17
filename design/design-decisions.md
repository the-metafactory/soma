# soma — Design Decisions

**Date:** 2026-05-17
**Authors:** Jens-Christian Fischer
**Status:** Living document — updated as decisions are made
**Format:** metafactory DD (lightweight ADR)

---

## How This Document Works

Each decision is numbered, dated, and linked to the discussion or research that informed it. Decisions are grouped by domain. Status values: **decided**, **superseded**, **open**.

`ISA.md` is the live source of truth for current scope and verification. DDs are the durable rule-record — the *why* behind decisions that future readers would otherwise have to reconstruct.

---

## 1. Boundary & Canonical Home

### DD-1: Soma is the new canonical home of personal AI state

**Status:** Decided (2026-05-17)

**Context:** Soma's mission is "substrate-portable Personal AI Assistant core" (per `ISA.md`, `CONTEXT.md`). A live migration path from PAI to Soma forced a foundational question: where does personal state *live*?

Three candidates surfaced:
- **(a) Soma is the new canonical home.** PAI's `~/.claude/` becomes a *projection* that Soma writes (via `soma install claude-code`). PAI conventions are translated to Soma's shape during import.
- **(b) Soma is a portable wrapper around PAI.** Soma mirrors PAI's structure. PAI conventions win where they conflict. Soma's existing memory/identity taxonomies adjust to match PAI's.
- **(c) Dual-write contract.** Soma and PAI both write to a shared "personal data" location via a write-through layer.

**Decision:** **(a)** — Soma is the canonical home. The `*core*` lives in Soma; substrates (Codex, Pi.dev, Claude Code) are projections of it. PAI becomes one substrate among several, projected into via the existing `soma install claude-code` verb.

**Rejected:**
- (b) would invert the stated mission — Soma would be a packaging tool, not the canonical home.
- (c) is genuinely powerful but introduces coupling that breaks Soma's "filesystem-native, no-daemon-required" principle. Tracked as a possible future direction; not a prerequisite.

**Implications:**
- Migration from PAI to Soma is fundamentally a **translation** (PAI memory taxonomy → Soma taxonomy, PAI skill format → Soma skill format), not a copy.
- Once migrated, PAI continues to work iff the user runs `soma install claude-code --apply` so Soma's projection covers PAI's runtime surface.
- The "perfect world" dual-write (`(c)`) is a deferred follow-on, not a blocker.

**Discussion:** `/grill-with-docs` session 2026-05-17 (Q6).

---

## 2. Memory Taxonomy

### DD-2: Adopt PAI v5.0.0 memory taxonomy wholesale, mark PAI-specific categories

**Status:** Decided (2026-05-17)

**Context:** Soma currently bootstraps 5 memory categories (`WORK`, `KNOWLEDGE`, `LEARNING`, `RELATIONSHIP`, `STATE`). PAI v5.0.0 canonical form has 19 categories — the above 5 plus 12 substrate-neutral (`OBSERVABILITY`, `SECURITY`, `SCRATCHPAD`, `BOOKMARKS`, `RESEARCH`, `PROJECT`, `WISDOM`, `VERIFICATION`, `DATA`, `RAW`, `REFERENCE`, `SKILLS`) plus 2 PAI-specific (`PAISYSTEMUPDATES`, `AUTO`).

PAI's v5.0.0 hooks actively write to several categories Soma does not bootstrap (`OBSERVABILITY`, `SECURITY` are referenced by `ToolActivityTracker.hook.ts`, `ConfigAudit.hook.ts`, `StopFailureHandler.hook.ts`, `TaskGovernance.hook.ts`). Soma's existing 5-category bootstrap is pre-v5.0.0 PAI taxonomy.

Three candidates:
- **(a) Wholesale** — adopt all v5.0.0 categories verbatim including PAI-specific ones.
- **(b) Substrate-neutral subset** — adopt the categories that have substrate-neutral meaning; skip `PAISYSTEMUPDATES`/`AUTO`; allow free-form extension.
- **(c) Wholesale + mark PAI-specific** — adopt all, tag PAI-bound categories in their READMEs.

**Decision:** **(c)** — wholesale adoption of v5.0.0 taxonomy, with READMEs in `PAISYSTEMUPDATES/`, `AUTO/`, and any other PAI-bound categories explicitly marking them as substrate-bound. Soma's canonical taxonomy includes both portable and substrate-bound categories; READMEs do the explanatory work.

**Rejected:**
- (a) wholesale-without-marking weakens Soma's portability claim by smuggling PAI-specific categories in unannotated.
- (b)'s purity is academic — every Soma user today is migrating from PAI; the PAI-specific categories will be populated regardless.

**Implications:**
- `SOMA_BOOTSTRAP_DIRECTORIES` in `src/install.ts` grows from 5 to 19 categories (14 new: 12 substrate-neutral + 2 PAI-bound).
- New entries each ship a `README.md` describing what belongs there. PAI-bound ones additionally state "this category is populated by the PAI substrate; portable Soma cores may leave it empty".
- No backcompat migration needed (pre-release per principal directive).
- The 1:1 alignment with v5.0.0 means PAI hooks writing to `MEMORY/SECURITY/...` resolve to `~/.soma/memory/SECURITY/...` cleanly after `soma install claude-code` projection.

**Discussion:** `/grill-with-docs` session 2026-05-17 (Q5, Q7).

---

## 3. Glossary

### DD-3: `migrate` reinstated for system-to-system orchestration

**Status:** Decided (2026-05-17)

**Context:** An earlier glossary lock (`CONTEXT.md` Q10) killed `migrate` as a synonym for [[upgrade]], on the principle of "one canonical term per concept". This conflicted with the existing CLI verb `soma migrate pai` (PR #67) and with the natural prose for moving an existing PAI installation into Soma.

After [[DD-1]] established Soma as the new canonical home, the verb describes a real, distinct operation that `upgrade` cannot:
- `upgrade` = same system, new version
- `migrate` = move ownership from one system-of-record to another

Three candidates:
- **(a) Rename CLI to `soma import pai`** — drop `migrate` entirely, subsume into existing `import` verb.
- **(b) Un-ban `migrate`** with sharper meaning.
- **(c) Keep `migrate pai` as legacy alias** while building forward under `import`.

**Decision:** **(b)** — `migrate` reinstated with sharper meaning. Glossary updated inline (`CONTEXT.md` new `## migrate (system-to-system orchestration)` section).

| Term | Direction | Scope |
| --- | --- | --- |
| **import** | external source → Soma | one artifact (one pack, one identity file, one algorithm) |
| **migrate** | external system → Soma | full orchestration: multiple imports + structural alignment + manifest |
| **upgrade** | Soma → Soma (or adapter → adapter) | new version of same thing |

**Rejected:**
- (a) loses the principal-facing simplicity of "I want to move from PAI to Soma" as one verb.
- (c) keeps two names for one concept — drift later; principal directed "no backcompat worry pre-release" so cleaner to commit to one verb.

**Killed synonyms (still banned):**
- `transfer`, `move`, `port`, `convert` → `migrate`

**Naming for future migrations:** `soma migrate <source-system>` where `<source-system>` is the system being moved out of (`migrate pai`, future: `migrate cortex`, `migrate <other-personal-ai>`).

**Supersedes:** `CONTEXT.md` line 235 ("`migrate`, `republish`, `bump` → `upgrade`") — `migrate` removed from that kill-list; `republish` and `bump` remain killed.

**Discussion:** `/grill-with-docs` session 2026-05-17 (Q8).
