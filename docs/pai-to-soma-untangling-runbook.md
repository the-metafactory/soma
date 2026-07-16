# Reference runbook: untangling a live PAI install into Soma

> Distilled from a real PAI → Soma untangling exercise (PAI 4.0.3 → Soma 0.13.0,
> July 2026): a planned, criteria-verified migration plus the post-migration soak
> sessions where the non-obvious steps surfaced. Companion to
> [integration-with-pai.md](integration-with-pai.md), which documents the
> importer mechanics; this runbook documents the *operation* — ordering,
> verification gates, and the traps that only show up on a live installation.
>
> Commands reflect Soma 0.13.x; check `soma --help` for your version.

**The single most important idea:** migrate *meaning*, not files. Classify
everything first; import only what's real; verify with probes, not assertions;
and keep the old world bootable until the new one has survived a soak.

## Phases

1. Inventory & classify (read-only)
2. Snapshot & rollback anchors
3. Migrate portable state
4. Curate what the importer can't
5. Stage a standalone substrate home
6. Project & verify
7. Reproject after migration — the step everyone misses
8. Project the skills you actually use
9. Launchers & the soak period
10. Cutover — or deliberately don't

Plus: the condensed checklist and failure modes observed.

---

## 1 — Inventory & classify: read-only, before anything

Plan the migration as its own gated piece of work before running any `--apply`.
Classify every source into exactly one of five buckets — the buckets drive every
later decision:

| Bucket | Examples | Disposition |
|---|---|---|
| Portable assistant state | identity, purpose, skills you use, durable memory | migrate into the Soma home |
| Substrate-native state | auth, history, plugins, MCP config, permissions | stays in the substrate home; carry into the staged home |
| Legacy runtime state | PAI hooks, statusline, Algorithm files, the PAI tree | retain in place as rollback; exclude from Soma |
| Secrets | `.env` files, API keys, credential dirs | never copy into the Soma home — symlink from the substrate home |
| Templates / scaffold | unedited `BASICINFO.md`, `DAIDENTITY.md`, TELOS files | exclude — do not promote empty structure |

> ⚠️ **Trap — your memory is probably not where you think it is.**
> Before declaring the PAI memory migration "empty", probe *external and
> symlinked* MEMORY/WORK roots. In the source exercise, 2.3 GB of real memory
> lived outside `PAI/MEMORY` (in an XDG config dir, reached via symlink). The
> importer reported "no PAI MEMORY tree present" while gigabytes sat one
> `readlink` away.

> ⚠️ **Trap — PAI's life-OS files are usually scaffold.**
> PAI ships `BASICINFO.md`, `DAIDENTITY.md`, and the TELOS tree as fill-in
> templates. If they were never edited, the *real* identity lives in
> `settings.json` (`daidentity`, `principal`, `techStack`, `preferences`
> blocks). Importing the templates pollutes every future projection with
> placeholder life-OS content. Check for real edits before promoting anything.

> ✅ **Gate.** Every source category has an explicit
> migrate / translate / retain-only / exclude decision recorded. No `--apply`
> has run. If you can't say which bucket something is in, you are not ready.

## 2 — Snapshot & rollback anchors

Two anchors, different jobs:

- **Soma snapshot** — the Soma home is a local git repo. Commit a named
  snapshot before importing.
- **The old substrate home stays bootable.** If `~/.claude` is a symlink into a
  versioned PAI release, *leave it alone* — it is your rollback anchor for the
  entire migration.

```sh
# rollback anchor: record what the world looked like
readlink ~/.claude            # where does the live home actually point?
soma snapshot --name pre-pai-migration --trigger import
soma history                  # list snapshots; restore later with: soma rollback <id>
```

Apply-mode Soma commands also auto-snapshot before writing — but a named
snapshot marks the intent. Note that `~/.claude/settings.json` is commonly
*gitignored* in the old home's repo: a git snapshot of `~/.claude` does **not**
cover it. Back it up separately before anything edits hooks.

> ⚠️ **Trap — decouple your tooling from the thing you're migrating.**
> If the `soma` binary (or any launcher) resolves through the directory under
> migration (e.g. `~/.claude/bin/`), repoint it first. At the moment of a
> cutover, your rollback tooling — including `soma rollback` itself — must not
> depend on the directory being replaced. Grep for launchers that `exec`
> through the old home; absolute-path greps miss `$HOME`-relative ones.

> ⚠️ **Trap — migration artifacts never live inside the Soma home.**
> The Soma home is a git repo and snapshots commit what's there. In the source
> exercise, staging artifacts (including a secrets tarball) under its `.tmp/`
> nearly got committed by the next snapshot because `.tmp/` wasn't gitignored.
> Stage migration working files in a mode-700 directory *outside* any git repo.

## 3 — Migrate portable state

Two import paths, both additive, both idempotent. Always dry-run first — the
importer refuses loudly rather than falling back silently:

```sh
# A. idea layer — identity, purpose, Algorithm doctrine, memory, docs, skill packs
soma migrate pai --pai-repo <path-to-PAI-checkout>          # dry-run: shows the plan
soma migrate pai --pai-repo <path-to-PAI-checkout> --apply
soma migrate pai --status                                    # prints the audit manifest

# B. skill layer — from the installed flat tree (avoids pack-collision soup)
soma migrate claude-skills --from ~/.claude/skills --smoke all \
  --rewrite-descriptions auto              # fits the 1024-char description caps
```

Each sub-importer diffs source vs. target and writes only changes. The audit
trail lands in the import manifest (`MIGRATION.md` under the Soma home's
import records) with per-pack outcomes and fingerprints. Read it — it is your
evidence trail.

Expect some packs to be refused, legitimately:

- `refused-reserved` — the pack name collides with a bundled Soma skill.
  Re-run with `--overwrite-reserved` only if you genuinely want to replace
  Soma's version. (A curated `purpose.md` is protected the same way once it
  exists.)
- `refused-unrecognized-layout` — opt in with `--include-unrecognized` if the
  content is real.
- `refused-other` — a genuine error (non-zero exit under `--apply`). Fix the
  pack or migrate that skill by hand.

### Symlink skills that have an upstream; copy what is truly yours

Skills managed by a package manager should be *symlinked* from the Soma home's
`skills/` to their upstream repos, not copied — a copy is a fork that will
silently rot. In the source exercise, 72 skills had been imported as copies
and 7 of 8 checked had already drifted (one 16 days, one 40 days behind
upstream). Personal customizations with no upstream are the opposite case:
copy them in, deliberately, and keep the pre-symlink copies as a dated backup.

> ⚠️ **Trap — don't symlink a skill whose only copy is the local one.**
> Before converting a copied skill to a symlink, check whether the local copy
> holds content that exists nowhere upstream (the source exercise found three
> such skills, including ~73 KB of tooling that a symlink would have
> destroyed). Symlink what has a true upstream; keep unique content as the
> copy it is. Also check for *already-broken* symlinks whose targets no longer
> exist.

Port prose customizations explicitly: if skills reference shared customization
files (the source exercise had 11 markdown files referenced by 41 skills), copy
them into Soma — they are prose the model reads, and they break *silently* when
the legacy tree retires.

> ✅ **Gate.** Import manifest reviewed; every refused pack has a decision;
> skill symlinks verified unbroken (`find <soma-home>/skills -type l ! -exec
> test -e {} \; -print` returns nothing).

## 4 — Curate what the importer can't

The importer moves files. It cannot decide what is *true*. Three curation jobs:

- **Identity** — resolve real values (usually from `settings.json`) into the
  Soma profile's assistant and principal files. Record *where each value came
  from* in the file.
- **Preferences & tech stack** — real prefs hide in `settings.json`
  (`techStack`, `preferences`). Write them as a durable Soma memory note so
  they survive substrate hops (`soma memory write --trigger import …` with a
  `--source-of-truth` pointer back to settings.json).
- **Purpose** — keep `purpose.md` a lean distillation (mission, goals,
  principles, commitments). Do *not* paste template TELOS structure into it.
  If rich real life-OS content exists, promote it into Soma memory as
  recall-able notes instead (the bundled `migrate-pai-purpose` skill does
  exactly this placement).

> ✅ **Gate.** `soma memory recall` returns the migrated prefs note. Identity
> files carry provenance. No profile file contains unfilled `[placeholder]`
> brackets.

## 5 — Stage a standalone substrate home

**Never cut a replacement projection directly into a substrate home that is
symlinked to a versioned legacy release. Stage a standalone home and switch
atomically.**

Build the staged home (e.g. `~/.claude-soma`) so it can run a real session:

- **Carry over substrate-native state:** auth/account records, history,
  plugins, MCP config, permissions, tool-state dirs. Sweep for config dirs
  added after your inventory — the source exercise found two that postdated
  the checklist, and the tool CLIs that used them hardcode paths under the
  home.
- **Symlink, don't copy, secrets** into the staged home. Secrets never enter
  the Soma home.
- **Symlink the preserved legacy memory store** if sessions still reference
  it. Preserve raw; promote selectively, later.
- **Strip legacy hook wiring** from the staged `settings.json` (keep a
  reference copy beside it). Legacy hooks fail *closed* — one broken path can
  block every tool in the new home.

> ⚠️ **Trap — the live home may write through symlinks.**
> If `settings.json` or `CLAUDE.md` in the old home are symlinks into a
> personal-data repo, any tool that writes them (including `soma install`
> pointed at the live home) writes *through* into the real files — and if
> those aren't git-tracked, the pre-edit state is unrecoverable. This is the
> deeper reason the staged-home approach wins: it never touches the live home
> at all.

> ⚠️ **Trap — `CLAUDE_CONFIG_DIR` does not isolate identity.**
> Claude Code discovers `~/.claude/{rules,skills,CLAUDE.md}` relative to
> `$HOME` and reads them *unconditionally*, regardless of `CLAUDE_CONFIG_DIR`.
> The config-dir override isolates `settings.json`, hooks, and auth — not
> rules, skills, or CLAUDE.md. A staged-home session still sees the old home's
> rules. For a hermetic identity test, override `$HOME` itself. For the
> migration this leak is usually acceptable during the soak — but know it
> exists, and plan to de-fang the old home's CLAUDE.md eventually.

## 6 — Project & verify

```sh
soma install claude-code --substrate-home ~/.claude-soma --apply
soma doctor --substrate claude-code
```

`doctor` is the drift oracle for the whole rest of the system's life. Its two
key findings and what they mean:

| Finding | Meaning | Action |
|---|---|---|
| `projection-missing` | files in the install manifest aren't on disk | `soma reproject <substrate>` |
| `projection-unmanaged-edit` | projected files lost their Soma provenance header (hand-edited, or written by an older Soma) | move durable changes into the Soma home *first*, then reproject — reprojecting overwrites them |

> ✅ **Gate.** `soma doctor` reports `ok — no onboarding drift detected` for
> the substrate. Do not proceed on a dirty doctor.

## 7 — Reproject after migration — the step everyone misses

This deserves its own phase because it bit the source exercise and it will bite
you: **a successful migration + install is not the end state.** Two forces
immediately create drift:

1. **Soma upgrades add projection files.** Upgrading Soma (e.g. 0.12 → 0.13)
   adds bundled skills (`Memory`, `the-algorithm`, `migrate-pai-purpose`) and
   new rules files to the manifest. Your projection is now *missing* files it
   never had.
2. **Older projections lack provenance headers.** Files written by an earlier
   Soma read as "unmanaged edits" to a newer one.

The fix is one command per substrate — but you have to know to run it:

```sh
soma reproject claude-code            # and codex, cursor, pi-dev, grok…
soma doctor --substrate claude-code   # verify: ok
```

In the source exercise the observed ordering was: install → migrate skills →
**reproject** → doctor green. Doctor stayed dirty until the reproject ran.

**Make this a habit:** after any Soma upgrade, after any change under the Soma
home, and whenever behaviour looks stale — run `doctor`, and if it flags
drift, `reproject`. Reproject every substrate you use, not just the one in
front of you; in the source exercise a second substrate carried silent drift
(missing memory index, stale skills catalog) for days while the primary was
clean.

> ⚠️ **Trap — reprojecting destroys hand-edits, by design.**
> Anything you hand-edited inside a projected file is overwritten on
> reproject. The workflow is always: author the change in the Soma home, then
> reproject. If doctor says `unmanaged-edit`, rescue the content *before*
> running reproject.

## 8 — Project the skills you actually use

> ⚠️ **Trap — `reproject` does not project your skills.**
> `soma reproject` refreshes projection files and *bundled* skills only.
> Skills you added to the Soma home — including everything `soma migrate pai`
> imported — reach a substrate only via an explicit, additive install.

```sh
soma install claude-code --skills skill-a,skill-b,skill-c --apply
soma install codex       --skills skill-a,skill-b,skill-c --apply
```

Consequences of forgetting: substrates silently diverge (the source exercise
found 5 skills present in one substrate but absent in another), and you debug
"missing skill" as if the migration failed when it's just an unprojected link.

Derive the skill list *deterministically*, not from memory: extract Skill-tool
invocation names from your session logs, intersect with live skill dirs, and
project that set. Migrating 100+ skills indiscriminately floods every
substrate; migrating from memory misses the ones you use weekly.

> ⚠️ **Trap — a skill is not a slash command.**
> Skills (`skills/*/SKILL.md`) are invoked by the assistant from natural
> language. Typed `/commands` are separate files (`commands/*.md`). If you
> want a typed entrypoint for a skill, add a command *shim* that invokes the
> skill — and give it a **different name** than the skill, or both surface in
> pickers as duplicates (a `/review-pr` command invoking a `CodeReview` skill
> is the right shape). New commands register at session start, not live.

> ✅ **Gate.** Every substrate you use lists the same effective skill set.
> Doctor still ok after the installs.

## 9 — Launchers & the soak period

Give the staged home a low-friction entrypoint that matches your existing
habit, so the soak actually happens:

```sh
#!/bin/bash
# launch Claude Code against the staged Soma home, guarded auto mode
export CLAUDE_CONFIG_DIR="$HOME/.claude-soma"
exec claude --permission-mode auto "$@"
```

- Prefer a **guarded** permission mode over the fully-unguarded flag for the
  soak — you want to notice surprises, not blast through them.
- If your launcher wraps a shared/team script you don't own, *transform it at
  launch* (read source, swap the flag, exec the result) instead of forking
  it — a fork goes stale silently.
- Soak for about a week of real work. During the soak: run doctor
  occasionally, note anything that reads stale, and check the substrate loads
  Soma context (rules, identity, skills) at session start.

> ✅ **Gate (cutover readiness).** Doctor clean · a real session ran
> end-to-end from the staged home (this is your smoke test) · memory recall
> returns migrated notes · skills invoke · no unmanaged diffs.

## 10 — Cutover — or deliberately don't

The counter-intuitive ending, and the source exercise's most useful lesson:

**Switching the config-dir env var *is* the real cutover. The old-home symlink
swap is cosmetic rollback-anchor management — safely deferrable, indefinitely.
Verify the criteria, not the symlink.**

Once your launcher points at the staged home and every verification gate is
green, you are running on Soma. The legacy `~/.claude → PAI` symlink can stay
exactly where it is, as a permanently-parked rollback anchor. If you do want
the full swap:

- Stop **all** substrate sessions first — never swap a live home's symlink
  from inside a session running on it.
- Preserve the old symlink under a dated rollback name; make the swap atomic
  (`ln -sfn`).
- Audit background services first: launchd agents / cron jobs that exec
  scripts under the old home (observability, voice servers, watchers) break at
  swap time if the staged home lacks them.
- Repoint CLI wrappers that resolve through the old home's `bin/` before the
  swap (see Phase 2) — and reproduce that `bin/` in the staged home for
  anything else that needs it.
- Re-run the full probe set after: doctor, identity, memory, skills,
  MCP/plugins, permissions.
- Only archive the PAI tree after the soak, and only after grepping for live
  references to it — including env vars like `PAI_DIR` that other tooling may
  still read, and hooks that physically live under the tree (relocate them
  first).

Rollback levers, smallest first: `soma uninstall claude-code` removes only the
generated projection files (never touches the Soma home); `soma history` +
`soma rollback <id>` restore the Soma home to any snapshot; and the untouched
old home is the full substrate rollback.

---

## The condensed checklist

- [ ] Inventory classified into the five buckets; probed symlinked/external memory roots
- [ ] Soma snapshot committed; old home confirmed bootable as rollback anchor
- [ ] `soma migrate pai` run (dry-run first); import manifest reviewed; refused packs dispositioned
- [ ] Upstream-managed skills symlinked (not copied); unique-content skills kept as copies; customization files ported
- [ ] Real identity/prefs curated from settings.json; templates excluded; recall-verified
- [ ] Standalone home staged: native state carried, secrets symlinked, legacy hooks stripped
- [ ] `soma install` applied; `soma doctor` ok
- [ ] **Reprojected after migration/upgrade; doctor re-verified ok — on every substrate**
- [ ] Used skills explicitly projected with `--skills` to every substrate
- [ ] Launcher created (guarded auto); ~1 week soak with real work
- [ ] Cutover = env var + green gates; symlink swap deferred or done cold; PAI retained as rollback

## Failure modes observed, at a glance

| Symptom | Root cause | Fix |
|---|---|---|
| Doctor: projection-missing | Soma upgrade added files; projection never refreshed | `soma reproject <substrate>` |
| Doctor: unmanaged-edit | hand-edits in projected files / pre-header projections | rescue to the Soma home, then reproject |
| Skill missing on one substrate | `--skills` install never run there | `soma install <substrate> --skills <names> --apply` |
| Duplicate entries in skill picker | command shim named identically to a skill | rename the shim; keep names distinct |
| "No PAI memory to migrate" | memory lives outside PAI/MEMORY via symlink | probe external/symlinked roots before believing it |
| Skill drifted from upstream | copied instead of symlinked during import | symlink to upstream; keep pre-symlink copies as backup |
| Staged session missing tool config | config dirs added after the inventory was written | sweep for .env/profile-bearing dirs before cutover |
| All tools blocked in new home | legacy fail-closed hook with a broken path | fix settings.json from a plain shell; strip legacy hooks in staging |
| Old home's real config edited unexpectedly | settings.json/CLAUDE.md are symlinks; writes pass through | use a staged home; back up gitignored files separately |
| Secrets appear in a Soma snapshot | migration artifacts staged inside the Soma home (not gitignored) | stage artifacts in a mode-700 dir outside any git repo |
| Background services die at cutover | launchd/cron exec scripts under the old home | audit + migrate or retire them before the swap |
| `soma` itself breaks mid-cutover | CLI resolves through the directory being swapped | repoint wrappers to the tool's repo before cutover |
