---
status: proposed
---

# Official skill collection + a shared projection primitive

## Context

Soma's primitive-operating skills (Purpose, VSA, the Algorithm, and a future
Memory skill) reach their substrates through inconsistent paths. **the-algorithm**
emitted its SKILL.md + workflow as TypeScript string literals — `renderSkill()` /
`renderRunWorkflow()` in `src/algorithm-importer.ts` — genuine code-gen bloat that
grew per skill.

**Correction (soma#354 slice 3):** VSA was initially assumed to be the same
pattern, but it is not. The VSA skill already ships as plain `.md` under
`src/skills/VSA/` (`SOURCE_SUBPATH = src/skills/VSA`, `vsa-skill-installer.ts:27`),
read by `computeSourceFileEntries()` (`:227`). The 20.5 KB is not a renderer but a
*drift-protected projector*: per-file SHA baseline hashing keyed per destination
(`baselineKey` `:37`), fail-closed drift detection against user edits
(`detectDrift` `:251`), edit-preserving `.upgrade-available` markers
(`writeUpgradeMarker` `:522`), per-substrate name override (pi-dev `vsa`, via
`SubstrateInstallSpec.vsaSkillProjection.skillNameOverride`), and substrate content
rewrites (`rewriteSubstrateProjectionContent`, imported `:7`). The slice-1 symlink
primitive does none of that — it cannot replace this installer without losing
user-edit protection. So this ADR's original "retire `vsa-skill-installer.ts`"
framing was wrong: only the-algorithm's string-literal renderers are retired; the
VSA installer stays.

Two further problems compound it:

1. **No invocable-skill projection.** `soma install <substrate>` projects only a
   *catalog* — `rules/soma/SKILLS.md`, rendered by `renderSkills` in
   `src/adapters/claude-code.ts`, scanned by `loadSomaSkills` (`src/soma-home.ts:154`).
   It never materialises invocable skill *directories* into the substrate loader
   (e.g. `~/.claude/skills/`). The existing Soma-native skills (`VSA/`, `Interview/`)
   are hand-made copies there; the newly-added `Purpose` skill had to be symlinked by
   hand to become invocable. (Recorded as the skill-projection gap.)

2. **Tier legibility.** `~/.soma/skills/` holds 104 entries — a handful of
   primitive-operating skills alongside ~100 PAI skills (art, research, scraping…)
   the principal migrated in and actively uses. These are not noise: Soma's mission
   is to be the portable home for the principal's assistant context, and those
   skills *are* that context — they belong in `~/.soma/skills/`. **Correction (see
   below):** the tier boundary turned out to already be legible without moving
   anything. Verified against the live home at decision time:
   `grep -c '^pack-id:' ~/.soma/skills/*/SKILL.md` finds a pack-id on exactly 2 of
   103 skills — `VSA` and `Purpose`, both official — and the remaining 101 migrated
   skills carry none, with their origin recorded in `imports/claude-skills/.manifest.json`
   (+ `imports/pai-*`). So there is a distinction to draw (official vs. imported),
   but it is metadata that already exists, not a reason to relocate the principal's
   skills.

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
  this pattern; the legacy pattern to retire is **string-literal code-gen** —
  `algorithm-importer.ts`'s `renderSkill()` / `renderRunWorkflow()` (done in
  slice 3, content moved to `src/skills/the-algorithm/`). The VSA installer is
  *not* in scope to retire — it is a drift-protected projector over already-plain
  `.md`, not a renderer (see Context correction).
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
- **Skill authoring: code-gen renderers vs. plain `.md`.** the-algorithm's
  `renderSkill()` / `renderRunWorkflow()` string-literal renderers were rejected
  as the go-forward pattern: TS string literals for static prose, awkward to edit,
  no reason to compute. **Plain `.md` in `skills/`** chosen; the renderers were
  migrated to `src/skills/the-algorithm/` and removed (slice 3). (VSA was *not* a
  renderer — it already ships plain `.md`; its installer is drift machinery and
  stays — see Context.)
- **Catalog-only projection (status quo) vs. invocable-dir projection.**
  Catalog-only was rejected: a listed-but-not-loadable skill is not usable
  (exactly the Purpose failure). Projection must materialise an invocable
  dir/symlink in the loader, not only a markdown listing.

## Consequences

- A new `soma project-skill` / `unproject-skill` primitive (CLI + lib), reused by
  `install`, by `--skills` selective install, and by arc.
- `algorithm-importer.ts`'s `renderSkill()` / `renderRunWorkflow()` are removed;
  the content lives in `src/skills/the-algorithm/{SKILL.md,Workflows/RunAlgorithm.md}`
  and the importer reads it from disk (slice 3). `vsa-skill-installer.ts` is
  retained — it is drift-protected projection, not a renderer.
- `soma install` gains a `--skills <list>` selector; official skills become
  opt-in. Default install stays minimal.
- arc gains a post-install / post-uninstall hook that calls the soma primitive;
  tracked as a separate arc issue (cross-repo contract).
- The ~100 migrated PAI skills in `~/.soma/skills/` are **not** evicted — they are
  the principal's actively-used skills and `~/.soma/skills/` is their rightful home.
  The original "evict squatters" framing was wrong (the principal pushed back).
  Official skills are distinguished by a `soma-*` `pack-id`; migrated ones lack one
  and are tracked in `imports/claude-skills/.manifest.json`. Tier is a label, not a
  directory partition. Official skill pack-ids use the `soma-*` prefix (renamed from
  the migration-era `pai-*`), since these are now Soma-native, not PAI imports.
- Backward compatibility: existing hand-materialised `~/.claude/skills/{VSA,
  Interview}` copies are superseded by projected symlinks; the projector must be
  idempotent and reconcile a prior copy without clobbering unrelated user skills.
