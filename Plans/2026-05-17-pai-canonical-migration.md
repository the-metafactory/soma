# PAI → Soma Canonical Migration — Sprint Plan

**Period:** 2026-05-17 → ~2026-05-24 (1 week, fresh session can start cold)
**Scope:** Ship the four GitHub issues (#88 → #89 → #90 → #91) that turn Soma into the new canonical home of personal AI state, with PAI v5.0.0 as the canonical source system. Includes memory taxonomy alignment, PAI docs import, full `soma migrate pai` orchestration, and importer normalization cleanup.
**Mode:** Autonomous execution (`pilot-review-loop` pattern, Sage via NATS as reviewer). User may be away; no clarifications mid-flight. Surface design questions only if they cannot be answered from this plan + linked DDs + the issue body.
**Budget:** ~1 day for #88 + #89 in parallel, ~2 days for #90, ~half day for #91 once #89 lands.

---

## Cold-start onboarding (read this first)

If you are picking this up in a fresh session, you need:

1. **This plan** — `Plans/2026-05-17-pai-canonical-migration.md` (you are here).
2. **The cycle doctrine** — `Plans/2026-05-isa-rollout.md`. The canonical issue-to-merge loop (worktree → branch → PR → Sage → merge → cleanup). Cycle invariants live there.
3. **Design decisions** — `design/design-decisions.md` (DD-1, DD-2, DD-3). These are the *why* behind the four issues. They are durable rule-records; don't relitigate them mid-implementation.
4. **Glossary** — `CONTEXT.md`. Locked vocabulary for all four issues; in particular `## migrate (system-to-system orchestration)`, `## Lifecycle verbs`, `## Runtime modes`.
5. **The four issues** — `gh issue view {88,89,90,91} --repo the-metafactory/soma`. Each has its own ACs, scope, dependencies.
6. **Repo state at plan time** — main at `3775081` (last commit: `fix(importer): generalize claude-path rewriter + strip PAI Customization block (#86) (#87)`). All prior sprint work (#52, #54, #78, #79, #43, #86) shipped. Pi.dev queue (#52/#54/#78) drained. Repo-only open issues at plan time: #85 (deferred renderer ACs from #43 — out of scope here), and #88-#91 (this plan).

---

## Decisions in force (do not relitigate)

These were resolved in a `/grill-with-docs` session on 2026-05-17 and recorded as DDs:

- **DD-1: Soma is the new canonical home of personal AI state.** PAI's `~/.claude/` becomes a *projection* that Soma writes via `soma install claude-code`. Migration from PAI is a **translation** (PAI memory taxonomy → Soma taxonomy, PAI skill format → Soma skill format), not a copy.
- **DD-2: Adopt PAI v5.0.0 memory taxonomy wholesale, mark PAI-specific categories.** 19-category bootstrap = 17 substrate-neutral (`WORK`, `STATE`, `LEARNING`, `RELATIONSHIP`, `KNOWLEDGE`, `OBSERVABILITY`, `SECURITY`, `SCRATCHPAD`, `BOOKMARKS`, `RESEARCH`, `PROJECT`, `WISDOM`, `VERIFICATION`, `DATA`, `RAW`, `REFERENCE`, `SKILLS`) + 2 PAI-bound (`PAISYSTEMUPDATES`, `AUTO`). PAI-bound READMEs explicitly call out provenance. No backcompat migration needed (pre-release).
- **DD-3: `migrate` reinstated for system-to-system orchestration.** Distinct from `upgrade` (same system, new version). `soma migrate <source-system>` is the principal-facing orchestration verb. CONTEXT.md updated; the prior glossary lock that killed `migrate` as a synonym for `upgrade` is superseded.

Read each DD in full before starting:

```bash
sed -n '/^### DD-1/,/^### DD-2/p' design/design-decisions.md
sed -n '/^### DD-2/,/^### DD-3/p' design/design-decisions.md
sed -n '/^### DD-3/,/^---$/p'    design/design-decisions.md
```

If you find yourself questioning a DD during implementation, stop and surface to the principal — don't silently diverge.

---

## Queue — strict dependency order

```
        ┌──────────────────────────────────────────────────────────────┐
        │                                                              │
        │   #88  Memory taxonomy alignment       (independent)         │
        │   ─────────────────────────────────                          │
        │       ▼                                                      │
        │   #91  Importer deterministic rewrites                       │
        │       (depends on #88 for memory rewrite + #89 for doc       │
        │        rewrite)                                              │
        │       ▲                                                      │
        │   ─────────────────────────────────                          │
        │   #89  soma import pai-docs            (independent)         │
        │       ▼                                                      │
        │   #90  Extend soma migrate pai         (depends #88 + #89)   │
        │                                                              │
        └──────────────────────────────────────────────────────────────┘
```

**Suggested execution order (one issue at a time, single implementer):**

1. **#88** — `Align Soma memory bootstrap to PAI v5.0.0 canonical taxonomy (17 categories)`. (Issue title kept as filed; canonical count is 19 = 17 substrate-neutral + 2 PAI-bound — see DD-2.) Pure bootstrap change. Independent of everything. Ship first.
2. **#89** — `New CLI: soma import pai-docs`. Independent of #88 but small and self-contained. Can also be done first; pick whichever has the fresher state in your head.
3. **#90** — `Extend soma migrate pai`. Depends on #88 + #89 being merged. This is the largest of the four; budget ~2 days. Memory translation is the most subtle piece (per-file SHA recording in manifest, idempotency contract).
4. **#91** — `Importer: replace UNMAPPED catch-all with deterministic rewrites`. Depends on #89 (need `~/.soma/PAI/` to exist) and #88 (need `~/.soma/memory/` taxonomy). Smallest of the four; mechanical follow-on.

**Alternative parallel execution:** spawn two background agents at start — agent A on #88, agent B on #89. They are file-disjoint (#88 touches `src/install.ts` + `src/install/bootstrap.ts` + new `memory/*/README.md` files; #89 adds a new file `src/pai-docs-importer.ts` + `src/cli.ts` parser hooks). Once both merge, run #90 + #91 sequentially.

---

## Development cycle (per issue)

This is the canonical loop from `Plans/2026-05-isa-rollout.md` adapted to the `pilot-review-loop` pattern with Sage as reviewer (NATS dispatch, no Luna/pilot CLI). All actions happen autonomously; the human is informed by GitHub state.

### Step 1 — Claim and worktree

```bash
cd /Users/fischer/work/mf/soma
git fetch && git pull --ff-only origin main
git worktree add -b feat/issue-<N>-<short-slug> ../soma-issue-<N> main
cd ../soma-issue-<N>
bun install
```

Slug convention: `feat/issue-88-memory-taxonomy`, `feat/issue-89-import-pai-docs`, `feat/issue-90-migrate-pai-full`, `feat/issue-91-importer-deterministic-rewrites`.

### Step 2 — Implement (TDD where it fits)

- Read the GitHub issue: `gh issue view <N> --repo the-metafactory/soma`. ACs are the contract.
- Add fixture-based tests for any pure-logic surface first; make them pass.
- Cross-reference DDs when implementation forces a design choice. If the DDs don't cover it, file a question as a PR comment and continue with the smallest reasonable interpretation; flag the assumption explicitly in the commit body.
- Run verification continuously:
  ```bash
  bun run typecheck    # must be clean
  bun test             # all-green; baseline 537 (after #87); grows as you add tests
  ```

### Step 3 — Commit

Conventional commit format per repo history (`feat(...)`, `fix(...)`, `chore(...)`). Title must end with `(#<N>)`. Body must include AC checklist with each box checked + test evidence.

Use HEREDOC for multi-line commit messages:

```bash
git commit -m "$(cat <<'EOF'
feat(<area>): <short summary> (#<N>)

<body — what shipped, why, AC checklist, test evidence>

Closes #<N>
EOF
)"
```

### Step 4 — Push and open PR

```bash
git push -u origin feat/issue-<N>-<slug>
gh pr create --title "<conventional title> (#<N>)" --body "$(cat <<'EOF'
<PR body — summary, AC checklist with all boxes checked, test plan,
follow-ups if any, Closes #<N>>
EOF
)"
```

### Step 5 — Sage review loop (NATS dispatch, autonomous)

```bash
~/bin/sage dispatch the-metafactory/soma#<PR> --post --wait 600
```

Notes:
- `--post` posts Sage's verdict back to the PR as a review comment.
- `--wait 600` blocks until verdict for up to 10 minutes. The dispatch is synchronous from your perspective; you don't need `ScheduleWakeup`.
- The dispatch requires NATS connectivity (`nats://localhost:4222` default). Check with `nats server check connection` if it stalls. Sage daemon may run remotely; the dispatch enqueues regardless.

**Per round:**
- **Important findings**: apply. Push fix commits to the same branch. Re-dispatch.
- **Suggestions**: apply unless principled pushback. If pushing back, post a PR comment with reasoning before re-dispatching ("Pushed back on R<n> finding X because Y").
- **Cap: 5 rounds per PR.** Doctrine says "don't grind". After 5 rounds OR when state goes `commented` (no blockers), merge with the final fix. The #43 / PR #84 9-round outlier is *not* the pattern — only stretch the cap if every round is producing a strictly smaller surface, and document the reason in the merge commit body.
- **Pushback rights**: Sage is the gate but can be wrong. Surface disagreement in the PR thread, not via bypass. See #54 / PR #81 R2 (Sage misread of uninstall-as-dry-run) for the canonical pushback example.

### Step 6 — Merge

```bash
gh pr merge <PR> --repo the-metafactory/soma --squash --delete-branch
```

Confirm:

```bash
gh pr view <PR> --repo the-metafactory/soma --json state,mergeCommit
# expect: state=MERGED
```

### Step 7 — Sync and cleanup

```bash
cd /Users/fischer/work/mf/soma
git fetch && git pull --ff-only origin main
git worktree remove ../soma-issue-<N>
git worktree list   # confirm gone
```

### Step 8 — Memory update

Append entries to `.claude/memory/session-log.md` and `.claude/memory/decisions.md` in the same style as existing 2026-05-17 entries (look at #80, #81, #82, #83, #84, #87). Each entry records: PR number, merge SHA, files changed, tests added, Sage rounds, pushbacks, what shipped, what's deferred.

The `.claude/memory/` directory is gitignored (per-user). The entries are for the next session's cold-start orientation.

### Step 9 — Repeat for next issue

Return to Step 1 with the next issue from the queue. New worktree, never reuse.

---

## Issue-specific notes

### #88 — Memory taxonomy alignment

**Smallest issue. Ship first.**

- Touches `src/install.ts` (`SOMA_BOOTSTRAP_DIRECTORIES` constant). Add the 14 new categories (12 substrate-neutral + 2 PAI-bound). Existing 5 stay. Final count: 19.
- Each new category needs a `README.md`. Use the existing `~/work/PAI/Releases/v5.0.0/.claude/PAI/MEMORY/<CAT>/README.md` as the textual basis where one exists; mark `PAISYSTEMUPDATES/` and `AUTO/` as PAI-substrate-bound in their READMEs.
- The bootstrap creates the dirs + README files. Match the existing pattern for the 5 dirs already there.
- Update `docs/private-source-guard-v0.md` and `docs/writeback-and-policy.md` if they enumerate memory paths.
- Tests: extend `test/install.test.ts` bootstrap assertion to cover all 19 dirs.

**No backcompat shims.** Pre-release. Existing `~/.soma/memory/` installs that lack the new dirs just need a `soma install <substrate> --apply` to backfill (idempotent).

### #89 — `soma import pai-docs`

**New verb. Self-contained.**

- New file: `src/pai-docs-importer.ts`. Exports `planPaiDocsImport(options)` and `importPaiDocs(options)`. Mirrors the shape of `src/pai-pack-importer.ts`.
- New CLI parser in `src/cli.ts`: `parsePaiDocsImportArgs` + dispatch. Follow the shape of the existing `import pai-pack` parser. Update `import` subcommand `COMMAND_HELP`.
- Writes to `~/.soma/PAI/{DOCUMENTATION,TEMPLATES,ALGORITHM}/` from `<pai-source-dir>/<same>/`. Lexical + symlink-realpath escape guards — copy from `soma export --out` (lands `src/cli.ts` around line 2375 after #54).
- `~/.soma/PAI/.import-manifest.json` records source path, release version (parse from `<pai-source-dir>/VERSION` if present or infer from path like `Releases/v5.0.0`), timestamp, per-file SHA. Used to detect drift on re-import.
- Refuse sources without a `DOCUMENTATION/` subdir — loud error.
- Tests: fixture-based. Use `~/work/PAI/Releases/v5.0.0/.claude/PAI/` if available in the test environment, or ship a minimal fixture tree under `test/fixtures/pai-source/v5.0.0/`.

### #90 — Extend `soma migrate pai`

**Largest issue. Budget 2 days.**

- Touches `src/pai-migration.ts` (orchestrator), `src/cli.ts` (flag parsing + dispatch), and adds `src/pai-memory-migrator.ts` (new — translates `~/.claude/PAI/MEMORY/*` → `~/.soma/memory/*`).
- New flags: `--pai-install <path>` (defaults to `~/.claude`), `--pai-source-dir <release>` (optional; triggers docs import via #89 verb), `--pai-packs-dir <path>` (defaults to `<pai-source-dir>/Packs/` or `~/work/PAI/Packs`), `--skip-memory`, `--skip-skills`, `--skip-docs`, `--overwrite-reserved`.
- Memory translation: 1:1 dir map per DD-2 mapping table. Content-preserving. Records per-file SHA in `~/.soma/imports/pai-migration/.manifest.json`. Idempotent (compare SHAs on re-run).
- Bulk skill import: iterate `<pai-packs-dir>/*` and call `importPaiPack` per pack. Reserved skill names (`ISA`, `the-algorithm`, `knowledge`, `telos`) refused unless `--overwrite-reserved`. Audit recorded as today.
- `--status` reports last successful migration: source paths, timestamp, file counts per phase. Read from the manifest.
- Sage is likely to flag idempotency edge cases and reserved-skill collision handling — preempt by having strong fixture tests for both before opening the PR.

### #91 — Importer deterministic rewrites

**Smallest follow-on. Half-day.**

- Touches `src/pai-pack-normalizer.ts`. Add the 4 deterministic rewrite rules (DOCUMENTATION, TEMPLATES, ALGORITHM, MEMORY) ordered *before* the existing UNMAPPED catch-all.
- Each rule gets a named action kind in the audit trail.
- Re-import `~/work/PAI/Packs/CreateSkill` and verify the audit shows zero `rewrote-unmapped-claude-path` actions for paths now covered. Add this as an explicit test in `test/pai-pack-importer-issue-86.test.ts` (or a sibling file).
- Update `docs/pai-pack-importer.md` classification table.

---

## Failure modes & escalation

| Failure | Response |
|---|---|
| Sage flags blocker | Fix in the same PR. No new issue. Re-dispatch. |
| Sage flags out-of-scope concern | File a new issue, link from the PR, ignore in the current cycle. |
| Sage and implementer disagree on a finding | Post PR comment with reasoning. Re-dispatch. If Sage holds firm and the implementer still disagrees → surface to principal. |
| Two Sage rounds with no progress | Pause issue. Re-scope or close. Don't grind. |
| CI fails after Sage approval | Fix in the same PR. Re-dispatch for the delta only. |
| Dependency PR not yet merged | Wait. Do not start a dependent issue against a not-yet-merged base. |
| Memory migration test fails on edge case | Surface the edge case via PR comment; the migration is content-preserving by contract — if it has to alter content to make a test pass, you're solving the wrong problem. |
| `--pai-source-dir` points at a directory that doesn't look like PAI | Refuse loud. Do not attempt heuristic guessing. |

---

## Session-end contract

When all 4 issues are merged OR you run out of budget:

1. **Update this plan** — append a final section enumerating which issues shipped (with PR numbers + merge SHAs) and which remain.
2. **Update `.claude/memory/session-log.md` and `.claude/memory/decisions.md`** with the per-issue entries.
3. **Verify repo state** — `gh issue list --repo the-metafactory/soma --state open` should show #85 (deferred renderer ACs from #43) and whatever this plan left unfinished. Nothing else.
4. **If time remains**: re-run the original stress test that triggered this whole arc:
   ```bash
   rm -rf /tmp/soma-test-final && bun src/cli.ts import pai-pack \
     --pai-pack-dir ~/work/PAI/Packs/CreateSkill --apply --soma-home /tmp/soma-test-final
   grep -rn "UNMAPPED" /tmp/soma-test-final/skills/create-skill/ || echo "ZERO UNMAPPED — success"
   ```
   Zero UNMAPPED warnings = the full chain (DD-1 + DD-2 + #88 + #89 + #90 + #91) actually closes the loop. Document the result in the final plan update.

---

## Quick reference

```
Issues:    https://github.com/the-metafactory/soma/issues/{88,89,90,91}
Doctrine:  Plans/2026-05-isa-rollout.md
Decisions: design/design-decisions.md
Glossary:  CONTEXT.md
Sage:      ~/bin/sage dispatch the-metafactory/soma#<PR> --post --wait 600
Tests:     bun test (537 baseline after #87)
Typecheck: bun run typecheck
PAI v5:    ~/work/PAI/Releases/v5.0.0/.claude/PAI/
PAI packs: ~/work/PAI/Packs/
User PAI:  ~/.claude/ (the install being migrated from)
Soma home: ~/.soma/ (the canonical home being migrated to)
```

---

## Sprint outcome (2026-05-17)

All four issues shipped. Canonical migration sprint complete.

### Shipped

| Issue | PR | Merge SHA | Title |
|---|---|---|---|
| #88 | #93 | `56ff030` | `feat(install): align memory bootstrap to PAI v5.0.0 canonical taxonomy` |
| #89 | #94 | `c66eddd` | `feat(cli): add soma import pai-docs verb` |
| #90 | #95 | `3c05ee0` | `feat(migrate): extend soma migrate pai with memory translation + bulk skills + docs wrap` |
| #91 | #96 | `fd7b4ba` | `feat(importer): replace UNMAPPED catch-all with deterministic ~/.soma/PAI/... rewrites` |

### Test baseline progression

- Before sprint (after #87): **537** passing.
- After #88 (PR #93):        **541** (+4).
- After #89 (PR #94):        **555** (+14).
- After #90 (PR #95):        **607** (+52).
- After #91 (PR #96):        **615** (+8; 2 superseded in-place).

### Final stress test (per §"Session-end contract" item 4)

```bash
rm -rf /tmp/soma-test-final && bun src/cli.ts import pai-pack \
  --pai-pack-dir ~/work/PAI/Packs/CreateSkill --apply --soma-home /tmp/soma-test-final
grep -rn "UNMAPPED" /tmp/soma-test-final/skills/create-skill/
```

**Result:** Remaining `UNMAPPED` matches are exactly the path classes the
issue body and DDs reserved for the UNMAPPED audit class — Soma has no
home for them. Concretely:

- `~/.soma/UNMAPPED/PAI/USER/SKILLCUSTOMIZATIONS/<rest>` (5 instances) —
  PAI USER overlay model has no Soma equivalent (deferred follow-on).
- `~/.soma/UNMAPPED/PAI/SkillSystem.md` (2 instances) — bare-under-PAI
  files with no subtree match; valid UNMAPPED behavior.
- `~/.soma/UNMAPPED/History/Backups/` (2 instances) — Claude history
  layout has no Soma equivalent.
- `~/.soma/UNMAPPED/PAI/` strings inside the audit trail (warning detail
  text in `soma-pack.json`); these *are* the audit trail and must remain
  visible.

DOC / TEMPL / ALGO / MEMORY paths from CreateSkill all landed
deterministically: `~/.soma/PAI/DOCUMENTATION/Skills/SkillSystem.md`,
`~/.soma/PAI/DOCUMENTATION/Notifications/NotificationSystem.md`,
`~/.soma/PAI/DOCUMENTATION/Tools/CliFirstArchitecture.md`,
`~/.soma/memory/SKILLS/execution.jsonl` — zero of these now go through
the catch-all. AC-2 of #91 verified end-to-end against the real pack.

`grep -E "UNMAPPED/(DOCUMENTATION|TEMPLATES|ALGORITHM|MEMORY|PAI/(DOCUMENTATION|TEMPLATES|ALGORITHM|MEMORY))"
returns zero matches against the projected skill — the full chain
(DD-1 + DD-2 + #88 + #89 + #90 + #91) closes the loop on the four
subtrees that have real Soma homes.

### Deferred / out of scope

- **#85** — Pi.dev Algorithm renderer ACs deferred from #43. Independent
  of this sprint; remains open.
- **PAI USER overlay model.** SKILLCUSTOMIZATIONS has no Soma equivalent
  yet (per issue #91 body). Currently routes through UNMAPPED warning.
  A future issue can decide whether Soma grows an overlay mechanism.
- **`SEARCH_ROOTS` expansion in `src/memory.ts`** — noted in #88 outcome;
  not blocking; can land as a small follow-on.

### Decisions in force (durable)

DD-1, DD-2, DD-3 (`design/design-decisions.md`) — all four issues
implement these. Do not relitigate.
