# HANDOVER — Remove PAI from the Claude installation

*Written 2026-07-06. Updated 2026-07-06 (part 2) with progress + corrections. Read this first when resuming the "de-PAI Claude" work.*

## PROGRESS — session 2026-07-06 part 2 (DONE)

**Phase 1 (hooks + config) is complete and verified. PAI tree deliberately left on disk.**

- **settings.json — unwired all 34 `${PAI_DIR}/hooks/*` PAI hooks.** Kept: soma-policy-guard (fail-closed), soma lifecycle hooks, Cortex (BashGuard/EventLogger/Context), rtk, and **ACR** (repathed `${PAI_DIR}/hooks/ACR.hook.ts` → absolute `/Users/fischer/.claude/hooks/ACR.hook.ts`). PreCompact event removed (was PAI-only).
- **settings.json — stripped dead PAI config:** `loadAtStartup`, `dynamicContext`, `contextFiles`, `postCompactRestore`, `pai{}`, `paiVersion`, `counts`, `_docs`, and env `PAI_SOURCE_APP`/`PAI_CONFIG_DIR`. **KEPT `PAI_DIR` env** (the Cortex statusline script uses `$PAI_DIR` 19×; it just means "~/.claude").
- **CLAUDE.md overlay — surgical de-PAI:** removed `@PAI/USER/*` imports, `# PAI 5.0.0` header, the `PAI/Algorithm/v6.3.0.md` pointer (→ now "invoke the `the-algorithm` skill"), and the `PAI/CONTEXT_ROUTING.md` section. **Kept** completion guard, Critical Rules, MODES concept, `@LSP.md`/`@RTK.md`. Overlay markers intact.
- **VERIFIED:** settings.json is valid JSON; `soma-policy-guard` returns `{"continue":true}` on benign input (fail-closed path works → next session won't block tools); CLAUDE.md has zero PAI residue; kept `@`-imports exist.

### ⚠️ Restore points (READ — settings.json rollback differs from the handover's assumption)
- **`settings.json` is GITIGNORED** (`~/.claude/.gitignore:47`) — the "git snapshot" safety net does **NOT** cover it. There was no clean pre-edit backup (only a stale 2026-03-29 one). **The pre-edit settings.json content lives only in this session's transcript** (full Read + every removed block is quoted in the edits). A forward restore point of the *verified-good* post-edit file was saved: `~/.claude/settings.json.backup-20260706-dePAI-verified`.
- **`CLAUDE.md` IS git-tracked** — revert via `/usr/bin/git -C ~/.claude checkout CLAUDE.md` (pre-edit state is in history).
- **Shell recovery always works:** if a fresh session ever fail-closes on tools, fix `~/.claude/settings.json` from a plain terminal (no Claude tools needed).

## FINDINGS from the `CLAUDE_CONFIG_DIR` isolation test (2026-07-06 part 2)

Ran a clean Soma-only install to see the de-PAI end-state: `soma install claude-code --substrate-home ~/claude-fresh --apply`, then `CLAUDE_CONFIG_DIR=~/claude-fresh claude`.

- **The de-PAI end-state is good.** The Soma-only instance self-describes cleanly: "the identity **Soma** projects", peer/first-person, Soma-as-source-of-truth, and — crucially — **no bloated skill catalog** (only the `VSA` skill projects as a real dir; the 110-skill catalog is entirely PAI-migrated `~/.claude/skills/*`, which Soma does not project by default).
- **`CLAUDE_CONFIG_DIR` does NOT isolate identity — only `settings.json`/hooks/auth. `$HOME` is the real lever.** (Proven definitively 2026-07-06 in Claude Code v2.1.201.) Claude discovers `~/.claude/{rules,skills,CLAUDE.md}` **relative to `$HOME`** (binary uses bare `.claude/rules/`, `.claude/skills/` paths) and reads them **unconditionally**, regardless of `CLAUDE_CONFIG_DIR`. Evidence chain:
  - `CLAUDE_CONFIG_DIR=~/newuser-home/.claude claude -p "name?"` → **"Ivy"** (that config dir's identity is "Soma") — so config-dir rules are NOT read.
  - Move `~/.claude/rules` aside, same command → **"Soma"**; restore → **"Ivy"**. So `~/.claude/rules` is the identity source and it dominates.
  - `HOME=~/newuser-home claude` → looks for `~/newuser-home/.claude.json` (needs onboarding) — confirming `$HOME` relocates the *whole* `.claude` tree.
  - **Consequence:** the `~/claude-fresh` "Soma-only" runs earlier were NOT identity-isolated — they showed "Ivy" because `~/.claude/rules` was still being read. Only the **hook** isolation (settings.json) was real. So the de-PAI *hook* verification stands; the *identity/skill* observations from `CLAUDE_CONFIG_DIR` tests are invalid.
  - **Correct new-user test = override `HOME`.** Launcher `~/bin/claude-newuser` now does `export HOME=~/newuser-home; exec claude` → `~/.claude`→`~/newuser-home/.claude` (Soma rules, VSA-only skills, no CLAUDE.md) and `~/.soma`→`~/newuser-home/.soma` (clean). First run onboards + `/login` (authentic new-user). This is disposable.
- **The residue is now a 3-layer map:**
  1. `~/.claude` hooks/config — **DONE** (phase 1).
  2. `~/.claude/skills/*` descriptions — **58 SKILL.md files literally say "PAI"** ("PAI skill development", "monitoring for PAI", "routine PAI bookkeeping"). Source of the "PAI ecosystem" framing in the `~/.claude` sessions.
  3. **Soma's OWN source** `~/.soma/profile/{principal,assistant,telos}.md` — `focus: AI infrastructure (PAI)`, `source: Claude PAI … identity`, `Migrated from ~/.claude/PAI/…`. This is why **even a hermetic Soma instance says "PAI"**. Projects to every substrate on reproject. **CONFIRMED by elimination 2026-07-06:** ran a fully hermetic test (`~/.claude/CLAUDE.md` moved aside + empty scratch cwd + fresh config dir) — the instance *still* said "your own PAI infrastructure (Soma)", so layer-3 is the sole remaining source. (It phrased PAI as the *name* of the infra with Soma as kernel = reading (b) below.) Also confirmed the hermetic Soma instance is otherwise coherent: correct peer/first-person identity, accurate skill map (`/verify`,`/run`,`/code-review`,Security,Education,RedTeam,Council,Tana,Tado), mode classifier fired-but-self-corrected on a trivial Q, and `PURPOSE.md` commitment-filter language projected through.
- **⚠️ DECISION, not cleanup:** "PAI" = Personal AI Infrastructure, and it's the name of JC's own active project (Projects P4 "KAI/PAI (Ivy)", Telos G1 "KAI/PAI"). So layer-3 "PAI" may be a **legitimate project name to KEEP**, not residue. Two readings to resolve with JC: (a) Soma *replaces* the PAI name → strip "(PAI)" from `focus`, clean provenance/migration notes; (b) PAI stays the *name of the infra project*, Soma is the portable kernel underneath → leave it. Provenance lines (`source: Claude PAI … identity`, `Migrated from …`) are harmless historical breadcrumbs regardless.
- Test artifacts (both disposable — `rm -rf ~/claude-fresh ~/claude-fresh-cwd` when done): `~/claude-fresh/` (the fresh Soma-only config dir) + `~/claude-fresh-cwd/` (empty scratch launch dir for hermetic runs). For a hermetic run: move `~/.claude/CLAUDE.md` aside, `cd ~/claude-fresh-cwd`, launch — then **restore `~/.claude/CLAUDE.md`** (it was moved to `.dePAI-test-aside` and restored 2026-07-06). Recipe: `soma install claude-code --substrate-home <dir> --apply` (add `--claude-md`/`--skills` for a fuller comparison); launch with `CLAUDE_CONFIG_DIR=<dir> claude` (needs one-time `/login` — auth is keychain service `"Claude Code-credentials"`, not shared to a fresh config dir's account record).

## REGRESSION from the CLAUDE.md edit (found + fixed 2026-07-06)

The surgical CLAUDE.md edit repointed ALGORITHM mode from `PAI/Algorithm/v6.3.0.md` to "invoke the `the-algorithm` skill" — but that skill was **not invocable** (`Skill(the-algorithm)` → "Unknown skill"), because of the **Soma skill-projection gap**: the catalog lists it as text, but no invocable dir was projected into `~/.claude/skills/` (siblings VSA/Purpose/Agents *were* — Purpose as a symlink, VSA/Agents as copies). **Fix applied:** symlinked `~/.claude/skills/the-algorithm → ~/.soma/skills/the-algorithm` (invocable next session — skill discovery is at startup), and added a Read-the-SKILL.md-file fallback to the CLAUDE.md ALGORITHM instruction so it degrades gracefully if the symlink is ever lost to a reproject. ⚠️ The symlink is a workaround for the projection gap (soma should project `the-algorithm` like it does VSA); a future `soma install` may not recreate it. Also note: `the-algorithm/SKILL.md` description still says "PAI Algorithm" — part of the layer-2 skill-content residue.

## SKILL PROJECTION — ✅ DONE 2026-07-06 (branch `feat/project-the-algorithm-skill`)

**Shipped.** `the-algorithm` + `Memory` now project as invocable skill dirs via `soma install` on ALL substrates (claude-code, cursor, codex, grok, pi-dev). 1850 tests pass, typecheck clean, E2E-verified in temp homes. The manual `~/.claude/skills/the-algorithm` symlink is now redundant (kept as belt-and-suspenders until JC reinstalls claude-code for real).

**Two JC decisions made this session (both via AskUserQuestion):**
1. **Scope = all substrates** — bundled soma skills ship everywhere via one "home is source of truth" mechanism.
2. **Loop = repo-bundled skills only** — the portable-skill loop projects ONLY `src/skills/*` (the-algorithm, Memory), NOT arbitrary `~/.soma/skills` dirs. This was forced by a discovered conflict: the naive "project all `profile.skills`" (codex's incidental behaviour) would (a) flood `~/.claude/skills` with all 106 PAI-migrated dirs colliding with natives, and (b) collide with the existing `soma install --skills <name>` selective-symlink flow (a user skill got real-dir'd by the loop, then `--skills` couldn't symlink over it). Scoping to the bundle fixes both; user/registry skills still reach a substrate via `--skills`.

**What landed (commit on this branch):**
- `src/install.ts` — wires `installBundledSkillsIntoHome` (copies `src/skills/*`→`<somaHome>/skills/` before the reload) AND sets `input.bundledSkillNames = listBundledSkills()` so the loop is scoped.
- `src/types.ts` `ProjectionInput.bundledSkillNames` + `src/adapters/shared/index.ts` `projectableSkills(skills, bundledNames?)` — filters to bundled `basename(skill.path)` when provided (install path), else legacy all-minus-VSA (direct/test callers). All 5 adapter call sites pass `input.bundledSkillNames`.
- `src/adapters/claude-code.ts` + `src/adapters/cursor.ts` — new portable-skill loop (mirror codex). claude-code's `skills/` is SHARED → uses the manifest; cursor's `.cursor/rules/soma/skills/` is INSIDE its owned subtree → owned-subtree reconcile + `uninstall.remove` already handle it (no manifest).
- `src/adapters/shared/portable-skill-manifest.ts` — generalized grok's `install-manifest.ts` (substrate-param'd schema `soma-<substrate>-…` + path `projections/<substrate>/`); `grok/install-manifest.ts` now delegates byte-identically. claude-code install/uninstall wired to it in `home-projection.ts` + `claude-code/install.ts`.
- Tests: new `test/portable-skill-manifest.test.ts` (unit: write/read/reconcile/remove + edited-file/user-added/tampered/foreign-home guards); updated codex/pi-dev/grok exact-set + count tests (use `expectPlanCoversApplyModuloBundledSkills` helper in fixtures — bundled skills are dynamic, excluded from the static plan like active-VSA); grok manifest/uninstall tests rewritten to the bundled-Memory model; codex reproject/upgrade/codeOnly tests use bundled Memory as the projected-skill proxy (a `Widget` user skill no longer projects via the loop). Also fixed a PRE-EXISTING stale assertion in `algorithm-importer.test.ts` (still expected "PAI Algorithm" after the 1a260e8 de-PAI).

**Gotcha for next session:** codex/grok double-write `skills/the-algorithm/SKILL.md` (portable copy THEN static rendering-contract render overwrites — anticipated by grok's own comment; harmless, static wins). This is why codex's projected file count is 28 not 27.

---
### Original plan (for reference — superseded by the above)

Goal: `the-algorithm` (and all bundled skills) ship as invocable skill dirs via `soma install`, not a manual symlink. JC chose **generic** (project all `src/skills/*`).

**Naming fix DONE** (working tree, uncommitted): `src/skills/the-algorithm/{SKILL.md,Workflows/RunAlgorithm.md}` now fully PAI-free + `an VSA`→`a VSA` grammar fix.

**Architecture (verified 2026-07-06):**
- Repo ships 3 skills: `src/skills/{VSA,the-algorithm,Memory}`.
- **codex / grok / pi-dev** already project ALL `profile.skills` as invocable dirs via the generic `projectableSkills(input.profile.skills)` loop (grok's manifest already lists `skills/the-algorithm/SKILL.md`).
- **claude-code + cursor DO NOT** run that loop — they emit only catalog text (`rules/soma/SKILLS.md`) + the VSA dir (dedicated edit-preserving `installVsaSkillProjection`). **This is the whole gap.** JC's `~/.claude/skills/{Purpose,Agents}` dirs were placed manually, like the current `the-algorithm` symlink.
- A fresh soma home has NO the-algorithm/Memory skill (`soma init` → "skills: empty"); only VSA is installed into the home. So bundled skills must be copied into `<somaHome>/skills/` to enter `profile.skills`.

**The real fix = 2 parts:**
1. Copy bundled skills into the soma home so they're in `profile.skills` → catalog + auto-project on codex/grok/pi-dev. The failed fork wrote a reusable helper for this: `src/bundled-skills.ts` (`listBundledSkills`, `installBundledSkillsIntoHome` — copies every `src/skills/*` except VSA into `<somaHome>/skills/<name>`; VSA keeps its dedicated installer). Typechecks; **unwired** (fork died on an API error before wiring it into `install.ts`).
2. **Add portable-skill dir projection to the claude-code + cursor adapters** (mirror codex `projectCodexHome`: `projectableSkills(input.profile.skills).flatMap(skill => skill.files.map(f => ({path:`skills/${skill.name}/${f.path}`, content:…})))`). Wire `skills/*` into reconcile/manifest so projected dirs aren't pruned and are cleaned on skill removal, keeping the VSA-dir exclusion. This is the substantial part — claude-code's projection is rules-based, so emitting `skills/<name>/` dirs is new capability there.
3. Wire `installBundledSkillsIntoHome` into `install.ts` (before the somaHome reload at ~:161 so the catalog lists them on install #1). Add tests (fresh install projects the-algorithm+Memory+VSA as invocable dirs into claude-code; idempotent; VSA byte-identical). Then remove the manual `~/.claude/skills/the-algorithm` symlink and reinstall to prove it lands via install.

**Not blocked meanwhile:** the manual symlink `~/.claude/skills/the-algorithm → ~/.soma/skills/the-algorithm` makes it invocable in new sessions right now; the CLAUDE.md instruction also has a Read-the-file fallback.

## LEFT TO DO (next session)
1. **Fresh-session end-to-end verify** (the real test): open a NEW Claude session, confirm Soma context loads (`rules/soma/CONTEXT.md`), mode + policy hooks fire from Soma, tools are unblocked, no `${PAI_DIR}` errors, ACR still surfaces "previous session context".
2. **Remove the PAI tree** `~/.claude/PAI/` (18MB) — the deferred step. FIRST: grep `~/.claude` for live refs (`autoMode` prose mentions `~/.claude/PAI/MEMORY/WORK/`; `daidentity._docs` mentions `hooks/lib/identity.ts`); confirm nothing JC-owned lives under the tree (rescue first). Tree removal is *not* git-reversible for ignored paths — copy to a backup first.
3. **Retire the 34 unwired PAI hook FILES** still sitting in `~/.claude/hooks/` (+ `handlers/`, `security/`, parts of `lib/`). They're inert (unwired) but clutter. A `~/.claude/hooks/_retired-2026-07/` dir already exists from a prior cleanup — move them there. Verify no *kept* hook imports from `hooks/lib/` shared by PAI first.
4. **Cosmetic prose pass in settings.json:** `spinnerTipsOverride` tips + `autoMode.allow`/`environment` text still say "PAI"; `daidentity`/`principal` blocks are superseded by Soma identity — verify nothing (esp. Cortex) reads them, then remove. Also `somaDisabledHooks` can be dropped once the ModeClassifier file is gone.
5. **Migrate the kept CLAUDE.md guidance into `~/.soma`** so the completion guard / MODES / Critical Rules are sourced portably (currently they live only in the hand-maintained overlay).
6. **Scope soma #403** (per-prompt recall hook, on #425 evented recall) as ACR's eventual Soma-native successor — ACR stays regardless; #403 is a decision, not a forced swap.

---

## Goal

Retire **PAI** (Personal AI Infrastructure — the pre-Soma "Life Operating System") from `~/.claude`, leaving **Soma** as the sole assistant kernel. Soma is now the source of truth for identity, purpose, memory, skills, and policy, and (as of today) is deployed to all present substrates (claude-code, codex, pi-dev, cursor).

This is **outward-facing and risky** — it edits `~/.claude/settings.json` (hook wiring), `~/.claude/CLAUDE.md`, and removes ~18 MB under `~/.claude/PAI/`. A wrong hook edit can **block every tool** (see Risks). Do it incrementally, verify after each step.

## The #1 safety net: `~/.claude` is git-tracked

`~/.claude` is a git repo (last commit `9fe4189f auto-sync … MEMORY`). **Snapshot before touching anything** and you can revert any breakage:
```bash
cd ~/.claude && git add -A && git commit -m "snapshot before PAI removal"
# if anything breaks: git reset --hard HEAD   (or checkout the specific file)
```
There's also a live auto-sync committing to it — coordinate so your snapshot isn't buried.

## Current state (inventory, verified 2026-07-06)

| Thing | Where | Disposition |
|-------|-------|-------------|
| PAI tree | `~/.claude/PAI/` (**18 MB**) — USER/, Algorithm/, CONTEXT_ROUTING.md, hooks/ | **REMOVE last** |
| PAI hooks in settings.json | **34** entries `${PAI_DIR}/hooks/*.hook.ts` | **REMOVE** (after coverage-mapping) |
| Soma hooks in settings.json | **8** entries (3 unique): `soma-claude-code-hook.mjs`, `soma-mode-classifier.mjs`, `soma-policy-guard.mjs` | **KEEP** (today's deploy) |
| Cortex hooks in settings.json | **5**: `CortexBashGuard`, `CortexContext`, `CortexEventLogger` | **KEEP** — metafactory Cortex, NOT PAI |
| CLAUDE.md | lines **3–13** = Soma section ("# Ivy", "Reproject with `soma install claude-code --apply --claude-md`") | **KEEP** |
| CLAUDE.md | lines **19+** = PAI: `# PAI 5.0.0`, `# MODES`, `## ALGORITHM`, `@PAI/USER/*` imports, `CONTEXT_ROUTING`, `@RTK`, `@LSP` | **REMOVE** |
| CLAUDE.md backups | `CLAUDE.md.pre-v5-backup`, `CLAUDE.md.template` | reference only |
| Skills | `~/.claude/skills/` — PAI-migrated + soma-native mix | reconcile (Soma projects its own catalog + invocable dirs) |

## Map PAI hook → Soma coverage BEFORE removing (do NOT drop a capability)

The dangerous PAI hooks each need a Soma equivalent confirmed, or a conscious decision to drop:

| PAI hook | What it does | Soma coverage | Action |
|----------|--------------|---------------|--------|
| `ModeClassifier` | emits the `Soma MODE: ALGORITHM E1` reminders | **`soma-mode-classifier.mjs`** (wired) — confirm the reminders now come from Soma's, then remove PAI's | likely covered |
| `PromptGuard`, `ContentScanner`, `ContainmentGuard`, `EvidenceGate` | PAI security (prompt-injection, inbound content, blast-radius, evidence gate) | **`soma-policy-guard.mjs`** (Soma runtime-policy). **Verify it covers each** before removing — this is the security-critical mapping | VERIFY first |
| `LoadContext` | session context loader | Soma `rules/soma/*` projection + `soma-claude-code-hook.mjs` | likely covered |
| `ACR` | session-context recall (the `ACR Context` / "previous session context" reminders) | **JC's OWN hook, NOT PAI — KEEP.** But it physically lives at `${PAI_DIR}/hooks/ACR.hook.ts`, so **relocate it out of the PAI tree** (e.g. `~/.claude/hooks/ACR.hook.ts`) and update its `settings.json` path *before* deleting `~/.claude/PAI/`. Soma-native successor to be **scoped next session** (soma #403 per-prompt recall hook, on top of #425 evented recall) — but ACR stays regardless; #403 is a decision, not a forced swap | KEEP + RELOCATE |
| the rest (~26) | KVSync, PreCompact, FileChangeTracker, IntegrityCheck, KittyEnvPersist, QuestionAnswered, DocIntegrity, PrePushSmokeTest, etc. | mostly PAI-specific conveniences | remove, note any you actually rely on |

**Note:** `PrePushSmokeTest.hook.ts` is a PAI hook — it's the one that ran the full soma test suite on `git push` this session (and timed out under contention). Removing PAI removes that pre-push gate for the soma repo.

## Suggested removal order (safe, incremental, reversible)

1. **Snapshot** `~/.claude` (git commit, above).
2. **Coverage-map** the security hooks: read `soma-policy-guard.mjs` + `docs/runtime-policy*.md` in the soma repo; confirm PromptGuard/ContentScanner/ContainmentGuard/EvidenceGate behaviours are covered. Decide the ACR question.
3. **CLAUDE.md**: delete the PAI block (lines 19→end: PAI 5.0.0 / MODES / ALGORITHM / @PAI imports / CONTEXT_ROUTING / @RTK / @LSP), keeping the Soma section (3–13). Re-project to be safe: `soma install claude-code --apply --claude-md`.
4. **settings.json**: remove the 34 `${PAI_DIR}/hooks/*` entries in small batches. **After each batch, open a NEW Claude session (or run a trivial tool) to confirm tools still work** — a broken hook fails closed and blocks everything.
5. **Relocate JC's ACR hook first** (`${PAI_DIR}/hooks/ACR.hook.ts` → `~/.claude/hooks/ACR.hook.ts`, update its `settings.json` path, verify it still fires). Then **remove `~/.claude/PAI/`** — only once nothing references it (grep settings.json + CLAUDE.md for `PAI_DIR` / `@PAI` / `~/.claude/PAI`, and check for any OTHER JC-owned files living under the PAI tree that should be rescued first).
6. **Skills**: let `soma install claude-code --apply` own the skills catalog + invocable dirs; prune orphaned PAI-only skill copies.
7. **Verify**: fresh session loads Soma context (`rules/soma/CONTEXT.md`), mode/policy hooks fire from Soma, no `${PAI_DIR}` errors, tools unblocked.

## RISKS (read before editing hooks)

- **Fail-closed hook deadlock (hit twice this session).** A hook that can't load/parse blocks **all** tools. If you break settings.json or a hook, you may lose tool access mid-session — recover via `~/.claude` git revert from a shell (`! git -C ~/.claude checkout settings.json`). The soma policy hook specifically fails closed if the dev-tree soma source won't parse — **never sed/perl soma src** (see memory `stale-rebase-reverts-epic` / `soma-migration-phase1`).
- **`$PAI_DIR` env var**: hooks reference `${PAI_DIR}`. Confirm what it resolves to and that removing the tree doesn't leave dangling references that error.
- **Do it in a throwaway/second session first if possible**, so a hook break doesn't strand the session doing the removal.

## Pointers

- Soma projection source: `~/.soma/` (identity, purpose, memory, skills, policy). Projections regenerate via `soma install <substrate> --apply`.
- Soma policy/runtime docs: `~/work/mf/soma/docs/runtime-policy*.md`, `docs/governance-event-runtime-policy.md`, `POLICY.md` projection.
- Today's state: note-based memory subsystem (M0–M8) + AUTOMEM feedback loop (#425/#427/#428) all merged to soma `main`; #429 schema-loop is `ready-for-human`.
- Deploy done to: claude-code, codex, pi-dev, cursor (grok absent).
