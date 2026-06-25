---
status: proposed
---

# Official skill collection + a shared projection primitive

## Context

Soma's primitive-operating skills — the ones that author and run Soma's own
compartments (Purpose, VSA, the Algorithm, and a future Memory skill) — are today
each a bespoke TypeScript *importer* that emits the skill's markdown as string
literals: `the-algorithm` via `renderSkill()` in `src/algorithm-importer.ts:37`
(`files.set("skills/the-algorithm/SKILL.md", renderSkill())` at line 246), and VSA
via a dedicated `src/vsa-skill-installer.ts` (20.5 KB). Every new official skill
costs another 15–20 KB code-gen renderer. That is the bloat path.

Two further problems compound it:

1. **No invocable-skill projection.** `soma install <substrate>` projects only a
   *catalog* — `rules/soma/SKILLS.md`, rendered by `renderSkills` in
   `src/adapters/claude-code.ts`, scanned by `loadSomaSkills` (`src/soma-home.ts:154`).
   It never materialises invocable skill *directories* into the substrate loader
   (e.g. `~/.claude/skills/`). The existing Soma-native skills (`VSA/`, `Interview/`)
   are hand-made copies there; the newly-added `Purpose` skill had to be symlinked by
   hand to become invocable. (Recorded as the skill-projection gap.)

2. **Tier confusion.** `~/.soma/skills/` holds 104 entries — a handful of
   primitive-operating skills mixed with ~100 migrated general PAI skills (art,
   research, scraping…) that have nothing to do with Soma's core. Meanwhile six
   genuinely third-party skills already install cleanly as external packs via arc
   (`~/.config/arc/pkg/repos/*`, symlinked into `~/.claude/skills/`). The boundary
   between "Soma's own skills" and "arbitrary skills" is unmarked.

JC's stance: a *collection* of official Soma skills that extends core without
bloating it — install what you need — with arc able to install further skills and
understand projection.

## Decision

Three tiers, named, with one projection truth shared across them.

- **Core** — primitives, CLI, data model (`src/`). No skills. Always present.
- **Soma skills (official)** — the skills that operate the primitives: Purpose,
  VSA, the-algorithm, Memory (future). They ship as **plain `.md` files** in the
  soma repo under `skills/`, versioned with core so a skill that encodes a core
  data format (e.g. the Purpose skill encodes the `purpose.md` parse shape) can
  never drift from the format in another release train. They are **opt-in**:
  `soma install <substrate> --skills purpose,memory` projects only the chosen
  skills. The Purpose skill (plain `.md`, symlink-projected) is the prototype of
  this pattern; the `vsa-skill-installer.ts` / `algorithm-importer.ts` code-gen
  renderers are the legacy pattern to retire.
- **Third-party** — general/optional skills, distributed as external packs (arc).
  Soma does not own them; it projects and catalogs them on request.

**Projection is a Soma-owned primitive that all installers delegate to.** Extract
the skill-dir → substrate-loader step (symlink into the loader + refresh the
catalog) out of `install` into a standalone capability:

```
soma project-skill <skill-dir> --substrate <id[,id…]>   # + a library export
soma unproject-skill <skill-dir> --substrate <id[,id…]>
```

- `soma install --skills <list>` calls it for in-repo official skills.
- **arc delegates to it**: arc's install/uninstall hooks shell out to
  `soma project-skill` / `soma unproject-skill` after dropping/removing a pack.
  Arc never reimplements adapter logic — soma stays the single source of
  projection truth, and any installer (arc, manual, future) gets correct
  multi-substrate projection for free. *That* is what "arc understands projection"
  means: it knows to call the primitive, not how projection works.

Default fan-out is settled separately at implementation time (one substrate vs.
all installed); the contract above is substrate-list-parameterised either way.

## Considered options

- **Distribution: in-repo bundle vs. external packs vs. hybrid.** Pure external
  packs were rejected for primitive-coupled skills: a Purpose skill encoding
  `purpose.md`'s format in a separate repo invites schema drift against core.
  Pure in-repo was rejected as the home for *all* skills — it would re-absorb the
  100+ third-party skills core has no reason to own. **Hybrid chosen**: official
  in-repo + versioned with core, third-party external via arc.
- **Projection ownership: arc-embedded vs. soma-owned, arc-delegating.**
  Teaching arc *how* to project (embedding adapter logic) was rejected — it
  duplicates `src/adapters/*` and forks the projection truth the moment soma's
  adapters change. **Soma-owned with arc delegating** chosen: one implementation,
  many callers.
- **Skill authoring: code-gen renderers vs. plain `.md`.** The current
  `renderSkill()`/`vsa-skill-installer.ts` string-literal renderers were rejected
  as the go-forward pattern: 15–20 KB of TS per skill, awkward to edit, no reason
  for skills (static prose) to be computed. **Plain `.md` in `skills/`** chosen;
  the legacy renderers are migrated to files and retired.
- **Catalog-only projection (status quo) vs. invocable-dir projection.**
  Catalog-only was rejected: a listed-but-not-loadable skill is not usable
  (exactly the Purpose failure). Projection must materialise an invocable
  dir/symlink in the loader, not only a markdown listing.

## Consequences

- A new `soma project-skill` / `unproject-skill` primitive (CLI + lib), reused by
  `install`, by `--skills` selective install, and by arc.
- `vsa-skill-installer.ts` and `algorithm-importer.ts`'s `renderSkill()` path are
  replaced by plain `.md` skills under `skills/` + the generic projector. Net code
  removed, not added.
- `soma install` gains a `--skills <list>` selector; official skills become
  opt-in. Default install stays minimal.
- arc gains a post-install / post-uninstall hook that calls the soma primitive;
  tracked as a separate arc issue (cross-repo contract).
- The ~100 migrated third-party skills squatting in `~/.soma/skills/` are evicted
  from core's skill dir (separate cleanup) so the tier boundary is legible.
- Backward compatibility: existing hand-materialised `~/.claude/skills/{VSA,
  Interview}` copies are superseded by projected symlinks; the projector must be
  idempotent and reconcile a prior copy without clobbering unrelated user skills.
