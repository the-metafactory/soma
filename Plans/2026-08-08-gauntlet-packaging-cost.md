# What adding — and renaming — a bundled skill actually costs

Findings for node #567 on map #565. Fact-finding only; no decision.

All claims below were read out of the working tree at `main` on 2026-08-08.

## 1. What a bundled skill is, and what it is not

`src/bundled-skills.ts` is the whole mechanism. `listBundledSkills()` reads the
directory names under `src/skills`; `installBundledSkillsIntoHome()` copies every
one of them **except VSA** into `<somaHome>/skills/<dirname>`, byte-for-byte,
overwriting on every run (`src/bundled-skills.ts:52-71`).

Today that set is five: `Memory`, `VSA`, `migrate-pai-purpose`, `orienteer`,
`the-algorithm`.

VSA is excluded because it has a dedicated versioned installer
(`installVsaSkillProjection`) that owns its baseline and does drift tracking;
copying it here would fight that installer (`src/bundled-skills.ts:41-45`).

**Two distinct routes reach a substrate, and they behave differently:**

| Route | How | Reconciled? |
|---|---|---|
| **Bundled** (`src/skills/*`) | copied to soma-home, then **copied** into the substrate by the portable-skill loop | yes — install-time manifest reconcile (§4) |
| **Registry/principal** (`~/.soma/skills/*` only) | **symlinked** into the substrate loader by `project-skill` / `soma install --skills` | only by `unprojectSkill` |

`projectableSkills` (`src/adapters/shared/index.ts:59-83`) is the gate: when
install supplies `bundledSkillNames`, **only those directories project as
invocable dirs**. Everything else in a 100-skill home is filtered out —
"principal-authored/registry skills reach a substrate through
`soma install --skills` symlinks, not this always-on loop" (`:66-68`).

**`agentic-loop` is on the second route today.** Verified on this machine:
`~/.claude/skills/agentic-loop` is a **symlink** to `~/.soma/skills/agentic-loop`.
It is listed in `SKILLS.md` (because `renderSkills` maps *every* entry of
`profile.skills` with no filter — `src/adapters/shared/index.ts:209-213`) and it
is invocable *because someone symlinked it*, not because install projects it.

## 2. Two different keys, and which one is authoritative

- **Bundle membership** keys on `basename(skill.path)` — the on-disk directory
  name the install copied (`src/adapters/shared/index.ts:80`).
- **The projected output directory** keys on `skill.name` — the SKILL.md
  frontmatter (`buildPortableSkillFiles`, `:105`).
- `loadSomaSkills` sets `name` from frontmatter, **falling back to the directory
  name** when absent (`src/soma-home.ts:182`).

So "renaming a skill" is really *two* renames that can be done independently:
rename the directory (changes membership and the home path) and rename the
frontmatter (changes the projected dir at every substrate). Doing one without
the other is a legal, silent, half-rename.

## 3. Adding a sixth skill — the cost

Low, and mostly mechanical:

- Create `src/skills/<name>/` with a `SKILL.md`. Nothing else registers it —
  `listBundledSkills` is a `readdir`, so the directory's existence *is* the
  registration. No list to update, no manifest entry, no version bump.
- `test/fixtures.ts:18` derives its expectation from `listBundledSkills()` minus
  VSA, so tests follow automatically rather than pinning a hard-coded five.
- It lands in `SKILLS.md`, `profile.skills`, and projects as an invocable dir to
  every substrate on the next `soma install --apply`.

**The one real trap: ship the whole skill, not just SKILL.md.** `the-algorithm`
is the cautionary precedent. Its bundled `SKILL.md:17-20` points at
`references/algorithm.md`, `references/capabilities.md`,
`references/mode-detection.md`, and `references/parameter-schema.md` — and
`src/skills/the-algorithm/` contains **only** `SKILL.md` and
`Workflows/RunAlgorithm.md`. Those four references exist solely in the
principal's home (`~/.soma/skills/the-algorithm/references/`, 7 files, PAI-era).
They survive there because the copy leaves principal-added files untouched — so
on *this* machine the skill looks whole, and on a fresh install it ships four
dangling pointers.

If a loop skill is promoted, `references/agentic-loop-master.md` must go into
the repo with it or the same bug repeats.

## 4. Renaming — where it is handled, and where it is not

### Handled: the substrate projection (claude-code, grok)

Portable skills land in a **shared** `skills/` dir, so the owned-subtree
reconcile cannot own them — `ownedSubtrees` for claude-code is
`["rules/soma", "hooks/soma"]` only (`src/adapters/claude-code/install.ts:36`).
The gap is closed by an install manifest instead
(`src/adapters/shared/portable-skill-manifest.ts`):

- install records every projected portable-skill file (path + sha256) at
  `<somaHome>/projections/<substrate>/<homeHash>/install-manifest.json`;
- `reconcilePortableSkillProjection` (`:190-203`) removes what the **previous**
  install recorded and the **current** projection no longer contains — "a skill
  removed or renamed in the Soma profile would otherwise stay orphaned";
- wired for claude-code at `src/home-projection.ts:133-144`, and for grok via
  `src/adapters/grok/install-manifest.ts`.

Guards worth knowing: a file whose bytes differ from the install-time hash is
**preserved** (principal-edited), and directories are pruned with a
non-recursive `rmdir` that fails closed on `ENOTEMPTY`. So a locally-edited
projected file survives a rename as an orphan.

cursor and pi-dev project into an **owned** subtree, so `reconcileOwnedSubtrees`
handles them (`src/install.ts:279-300`). codex's uninstall is reserved. Only
claude-code and grok use the manifest (`portable-skill-manifest.ts:13`).

### Not handled: the soma home

`installBundledSkillsIntoHome` only ever `mkdir`s and `writeFile`s. **Nothing
removes a renamed-away directory from `<somaHome>/skills/`.** Because
`loadSomaSkills` enumerates every dir there and `renderSkills` lists all of them,
a stale directory keeps appearing in `SKILLS.md` forever, while no longer
projecting as an invocable dir (it is not in `bundledNames`). The residue is a
catalog entry pointing at nothing.

The precedent is explicit. The one rename Soma has done — ISA → VSA (#329) —
needed a **bespoke migration shim**: `pruneLegacyVsaSkill`
(`src/legacy-skill-prune.ts`), hard-coding `LEGACY_VSA_SKILL_DIR = "ISA"`, gated
on two provenance signals (frontmatter `name: ISA` **and** the description
containing "Owns the Ideal State Artifact") so a user's own `ISA` dir is not
destroyed. It is `rm -rf` with no backup, run from `src/install.ts:156` on the
home and from a per-substrate `prepare` hook (`vsaSiblingPrunePrepare`,
`src/adapters/claude-code/install.ts:67`). It is labelled a removable migration
shim.

**There is no general rename mechanism.** Each rename costs a hand-written,
provenance-gated, destructive shim plus a `prepare` hook per substrate, or it
leaves a permanent stale catalog entry.

### Not handled: an existing symlink at the target slot

This bites the specific case at hand. `~/.claude/skills/agentic-loop` is a
symlink into `~/.soma/skills/agentic-loop`. If that skill is promoted to
`src/skills/`, the portable-skill loop starts projecting to the same slot, and
`writeProjection` uses a plain `writeFile` (`src/projection.ts:25-38`) — which
**follows the symlink** and writes into soma-home. Worse, uninstall's
`removeListedProjectionFiles` `rm`s the manifest-listed paths, which would delete
*through* the link and destroy the soma-home source.

`projectSkill`'s own reconciliation is scoped to the single name slot and
"an existing symlink is replaced unconditionally (a link loses no data)"
(`src/skill-projection.ts:26-30`) — but that only applies when `project-skill`
runs, not when the bundled loop writes. Cheap fix, must not be forgotten:
`unprojectSkill` the old symlink before the first install that bundles it.

## 5. Provenance / lineage

Nothing in the code records a skill's origin. There is no lineage field, no
manifest entry, nothing that survives a copy. The only mechanism in use is prose:
`src/skills/orienteer/SKILL.md` carries a `## Lineage` section naming its
upstream (Matt Pocock's `wayfinder`) and declaring the relationship a manual
cherry-pick, never a re-sync. That convention is the whole state of the art here.

## 6. Summary for the decisions downstream

- **Adding**: trivial — one directory under `src/skills`. Ship the references.
- **Renaming the directory**: changes bundle membership and the home path;
  leaves an unreachable stale dir in the home that keeps showing in `SKILLS.md`
  until a bespoke prune shim is written.
- **Renaming the frontmatter**: changes the projected dir name at every
  substrate; the manifest reconcile cleans the old one up on claude-code and
  grok, *unless* a file there was locally edited.
- **The half-rename** (one but not the other) is legal and silent.
- **Before promoting `agentic-loop`**: remove the `~/.claude/skills/agentic-loop`
  symlink, or the projection writes and later deletes through it.
- **Lineage** has no home but a prose section, and `orienteer` is the pattern.
