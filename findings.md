# Findings: candidate incidents for the knowledge-orientation fixtures (node #1008)

Public record. It carries counts, ids and shas only. The fixtures, provenance, recovery packets, seed sketches and
probe-run logs are private, under `~/.soma/evals/knowledge-orientation/candidates/` (soma#984 Q12).

## Result

28 candidates, every cell ≥ 2. Each one is a schema-exact fixture (`<id>.json`, the soma#1002 keys, plus
`recovery_packet` for recovery) with a `<id>.notes.md` holding provenance, the seed ops for the other three
conditions, and the recorded probe runs.

| domain \ capability | discover-reuse | cross-system | prep-vs-outcome | recovery | total |
|---|---|---|---|---|---|
| soma          | 2 | 3 | 3 | 2 | 10 |
| ranger-cortex | 2 | 3 | 3 | 2 | 10 |
| seelite       | 2 | 2 | 2 | 2 | 8 |

## Probe evidence (acceptance criterion 2)

Every candidate's `acceptance_probe` was run in a throwaway clone at `rev`, in three variants:
(a) at `rev` unmodified, exit ≠ 0; (b) at `rev` plus the real fix's non-test diff, exit 0;
(c) at `rev` plus one or more synthesized known-wrong changes, exit ≠ 0. All 28 behave like that. The runs
(timestamps, exit codes, output tails) sit beside each fixture in its notes file. One probe per domain was
re-run independently by the supervising session (`VERIFY-parent.md` in the same directory) and reproduced
(a)=1, (b)=0.

| id | rev | fix | a | b | c |
|---|---|---|---|---|---|
| soma-discover-reuse-workday-window | bcfbcb5af48c | b724845 | 1 | 0 | 1 |
| soma-discover-reuse-run-ledger-funnel | 610f030bdcca | 3eb4365 | 1 | 0 | 1 |
| soma-cross-system-classifier-projection | 287226d4b964 | 59382af | 1 | 0 | 1 |
| soma-cross-system-map-template-decisions-markers | fa82aa74c227 | 3ba74b9 | 1 | 0 | 1 |
| soma-cross-system-purpose-missions-alias | 4c919f041639 | 5c87be8 | 1 | 0 | 1 |
| soma-prep-vs-outcome-vsa-pack-id-version | d9f167aea4ff | 0602405 | 1 | 0 | 1 |
| soma-prep-vs-outcome-compiled-binary-skills | 23f163ec1139 | 389cb94 | 1 | 0 | 1 |
| soma-prep-vs-outcome-pi-extension-parses | ad5f7f737742 | 4362cd7 | 1 | 0 | 1 |
| soma-recovery-runtime-artifact-deps | ed499bfbef77 | 59c0099 | 1 | 0 | 1 |
| soma-recovery-base-merge-pass | bb7e67b939a7 | 5eee1bb | 1 | 0 | 1 |
| ranger-cortex-discover-reuse-serve-queue-gate | a7aaa07a88b7 | d3d49721aaf5 | 1 | 0 | 1 |
| ranger-cortex-discover-reuse-offer-own-scope | 0d8113cf0b57 | bacb8f805dbb | 1 | 0 | 1 |
| ranger-cortex-cross-system-held-worker-eligibility | 3787d794f503 | 7b771a8 | 1 | 0 | 1 |
| ranger-cortex-cross-system-lane-busy-load | cdac65822f8d | 8389743 | 1 | 0 | 1 |
| ranger-cortex-cross-system-envelope-type-hyphens | b7a0e3f0264d | b75f2dfa | 1 | 0 | 1 (×3) |
| ranger-cortex-prep-vs-outcome-job-clean-exit-no-result | ee0010802e4b | d4dfe6f2495f | 1 | 0 | 1 (×2) |
| ranger-cortex-prep-vs-outcome-checkpoint-artifact-file | 0edbf4ea54bc | d16cfe22b5ea | 1 | 0 | 1 (×2) |
| ranger-cortex-prep-vs-outcome-stale-quota-cap | 59b7b9526b69 | 3fc281e69a31 | 1 | 0 | 1 |
| ranger-cortex-recovery-host-load-threshold | 55eaf38930a6 | 588ba62a9036 | 1 | 0 | 1 (×2) |
| ranger-cortex-recovery-parked-node-rebase | cc440f88d3f2 | ab15fce8bcc2 | 1 | 0 | 1 (×2) |
| seelite-discover-reuse-docking-computer-engage | 582773c81983 | a4a93af24c00 | 1 | 0 | 1 |
| seelite-discover-reuse-computer-step | c5b5a5a4c1b2 | ab6ab8e5729e | 1 | 0 | 1 |
| seelite-cross-system-till-honours-shelf | d67df3722272 | 892e90339216 | 1 | 0 | 1 |
| seelite-cross-system-every-hold-reader | d983362a3b46 | 099e9af3ee19 | 1 | 0 | 1 |
| seelite-prep-vs-outcome-eject-warning-ipa | 0c0e53eb02e7 | ba3708652028 | 1 | 0 | 1 |
| seelite-prep-vs-outcome-interiors-glb-size | 016fb3e1645c | 4974185a3242 | 1 | 0 | 1 (×2) |
| seelite-recovery-retro-followups | 531b6cb232ed | 0575d52 + f10b263 | 1 | 0 | 1 (×3) |
| seelite-recovery-neural-voice-boot | 9e186e07f01a | f4ee856 | 1 | 0 | 1 (×2) |

## Proposed condition assignment (Latin rectangle)

Every candidate's `condition` and `seed` already follow this table. Each notes file also sketches seed ops for
the other three conditions, so moving a cell does not mean re-mining it.

| domain | discover-reuse | cross-system | prep-vs-outcome | recovery |
|---|---|---|---|---|
| soma          | correct    | misleading | stale      | missing    |
| ranger-cortex | misleading | stale      | missing    | correct    |
| seelite       | stale      | missing    | correct    | misleading |
| *(abacus, optional)* | *missing* | *correct* | *misleading* | *stale* |

Seed ops by condition: `correct` adds or keeps a note that points truthfully at the authoritative source;
`misleading` adds a note that confidently points at the known-wrong approach; `stale` alters or adds a note
that was true at an older rev (old path, symbol, location); `missing` removes the real notes covering the
incident. Every seed also removes `evals/knowledge-orientation` from the trial's home copy, so the trial cannot
read its own answer key.

## Findings

- **F1. Q4's coverage rule cannot hold with three domains.** Each domain row sees all four conditions and each
  condition occurs three times. A capability column, though, has only three cells, so it sees three of the four
  conditions. Adding the optional Abacus row (soma#984 Q3) makes it a full 4×4 Latin square. Otherwise #1009
  should restate the rule as "every domain sees every condition; every capability sees three".
- **F2. Future history leaks the answer.** A clone at `rev` still carries every later commit, including the
  real fix, so `git log --all`, `git show <fix>` or a cherry-pick hands over the answer. The #1002 runner should
  strip refs past `rev` (or pin `main`/`origin/main` to the incident's main) before the trial starts. The
  probes themselves read hidden tests from the fix commit, so the stripping must happen after the probe has
  fetched them, or the hidden tests must be stored in the private fixture store.
- **F3. Two revs are not on the default branch.** `bb7e67b939a7` (soma) is reachable only via
  `refs/pull/899/head`; `cc440f88d3f2` (cortex) only on a ranger clone's node branch. A plain `repo` clone will
  not fetch them. #1002 trial step 1 needs to fetch PR refs, or these two need a mirrored ref.
- **F4. Probes need bash.** Several use `pipefail` and `env -u`, so the runner must run `acceptance_probe` with
  `bash -c`, not `sh -c`.
- **F5. One fixture can reach live state.** `ranger-cortex-prep-vs-outcome-stale-quota-cap` touches ranger's
  journal path. It must run with an isolated `HOME` (the #1002 isolation already covers `SOMA_HOME` and the
  Claude home, but not `~/.config/ranger`).
- **F6. Real recovery packets are scarce.** Real compaction summaries are rare: 1 soma-relevant session, 5 in
  ranger, 8 in seelite. Most resume into "report, change nothing", and a probe cannot fail at `rev` on that.
  `soma-recovery-base-merge-pass` and `ranger-cortex-recovery-parked-node-rebase` use ranger's re-dispatch or
  handoff prompt instead of a compaction summary. Both are real artifacts, but of a different kind.
- **F7. Memory notes are attached to the wrong domain.** Most of the memory notes that look like Seelite
  lessons come from two other game/planetarium projects (checked: each names the other project, not Seelite).
  Of two notes that look like Ranger lessons, one names Ranger only as the dispatcher of a Seelite node and
  the other names no project at all. This is organic misleading knowledge, and it argues for adding a domain or source field
  under #983/#986. Because of it, the Seelite seeds are synthesized from the incidents rather than built from
  real notes.
- **F8. Weaker candidates for #1009 to weigh:**
  - Synthesized known-wrong: in `soma-discover-reuse-run-ledger-funnel` and `soma-cross-system-purpose-missions-alias`
    the real worker got it right the first time.
  - Hidden tests that depend on fix-chosen names: `ranger-cortex-cross-system-lane-busy-load`,
    `seelite-prep-vs-outcome-interiors-glb-size`, `seelite-prep-vs-outcome-eject-warning-ipa` and
    `seelite-cross-system-every-hold-reader`. For each, the prompt or H3 names the symbol; the notes record
    which one.
  - Cross-system within one repo: two ranger cases, producer and consumer, live in the same repo. Only
    `ranger-cortex-cross-system-envelope-type-hyphens` crosses repos (cortex and myelin).
  - Discover-reuse probes catch a copied rule by its reason string or a missing call. A copy that rewrites
    every string would get past them.
  - Private content: `soma-recovery-runtime-artifact-deps` has a packet that holds private goal wording. Keep it
    in the private store; the protocol already requires that.
- **F9. Third candidates that were dropped.** Discover-reuse and recovery are thin in every domain:
  - Discover-reuse: most duplicates that review caught were created and removed inside the same squashed PR,
    so no `rev` exists where the helper existed and the duplicate did not.
  - Recovery: see F6.
  - Other drops: a probe could not discriminate (ranger ref-lock retry), the case was browser-only (several
    Seelite leads), or the pre-fix commit was missing from the local clone and fetching it was out of scope.

## Method

Three domain miners worked from Claude Code transcripts (soma, ranger, cortex, seelite projects including
ranger worker worktrees), ranger worker logs and journal, Soma memory notes, the Errata ledger, and git history.
Node and PR threads were only partly reachable because the GitHub GraphQL quota ran out mid-run, so provenance
fell back to commit messages, worker logs and transcripts. Probes ran in `git clone --no-checkout` copies in
`/tmp`; no repo checkout was modified and nothing was pushed or written to GitHub.

## Next

#1009 (the principal's pick of 12) works from the private directory. The runner fixes F2–F5 belong on #1002
before the first trial.
