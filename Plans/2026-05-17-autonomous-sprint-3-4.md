# Autonomous Execution Plan — Sprints 3 + 4

**Written:** 2026-05-17 (early)
**Mode:** Autonomous execution. User away. No clarifications mid-flight.
**Budget:** A few hours.

## Done so far (context)

| Issue | PR | SHA | Sprint |
|---|---|---|---|
| #41 unify ISA type | #44 | `50c61d79` | 1 |
| #33 ship skill source | #46 | `afc985f4` | 1 |
| #18 PAI pack normalizer | #49 | `e29daf28` | 1 |
| #32 storage contract | #51 | `6efc9181` | 2 |
| #34 library CRUD | #53 | `82b39945` | 2 |
| #36 CLI surface | #58 | `4e90ace0` | 3 |

## Queue — strict order

### Sprint 3 remainder

1. **#38** ISA Layer 7 lifecycle hooks (`runSomaLifecycleIsaUpdated` +
   session-start/session-end ISA awareness + append decisions to active
   ISA). Depends on #34 ✓.
2. **#39** Algorithm advisory hint (`suggestIsaAtObserve` non-halting +
   `appendIsaDecision`/`appendIsaChangelog` already shipped in #34;
   wiring to AlgorithmRun mutators + telemetry events + suppression
   config). Depends on #34 ✓ + #38.
3. **#37** Adapter projections (Codex, Pi.dev, Claude Code render
   active ISA + skill installer wires into each substrate). Depends
   on #34 ✓ + #33 ✓.

### Sprint 4 (PAI migration unblock)

4. **NEW architecture issue: `.claude/rules/` pivot.** File it on
   GitHub with the test harness evidence (home-dir `@`-imports fail
   silently in Claude Code v2.1.138). Decision: pivot to
   `.claude/rules/` auto-discovery. Close architectural question in
   the issue body, don't wait for review.
5. **#29** Claude Code adapter full install + projection (using the
   `.claude/rules/` design from step 4). Large; budget ~2 hours.
6. **#28** Automatic PAI installation migration (one-shot + idempotent
   + manifest). Depends on #29.
7. **#30** is replaced by two new CLI commands:
   - `soma migrate-pai` (orchestrator collapsed to single command)
   - `soma adopt-claude` (same)
   Close #30 with redirects.

If time runs out, **stop after merging the latest in-flight PR** and
leave a session note in the soma channel with the final cumulative
state.

## Cycle invariants (per Plans/2026-05-isa-rollout.md)

- Each issue: claim in #soma → worktree at `../soma-issue-N/` → branch
  `feat/issue-N-<slug>` → implement → push → PR → sage NATS dispatch
  → wait → fix → re-dispatch → repeat.
- Cap Sage rounds at **5 per PR**. After 5 rounds OR when state goes
  `commented` (no blockers), merge immediately with final fix.
- Merge with `gh pr merge --squash --delete-branch`. Always close the
  issue with the merge SHA + Sage round summary.
- Worktree cleanup: `git worktree remove ../soma-issue-N` after merge.
- Sync main after each merge: `git fetch && git pull --ff-only`.

## Decision policy (autonomous)

- **`.claude/rules/` design**: Holly's research conclusive. Pivot
  without further review cycle.
- **Sage contradictions across rounds**: prefer the most recent
  finding; if it directly contradicts an earlier accepted decision,
  surface in commit message and apply the new one.
- **Cycle-cap reached**: merge anyway. Doctrine says "don't grind".
- **Test failures**: fix root cause, never weaken assertions.
- **New issues discovered**: file separately; don't expand PR scope.

## Risk surface

- Sage may flag the `.claude/rules/` design in #29 review even though
  the issue is filed separately. Accept those findings only if they
  are about implementation correctness, not the architectural choice.
- `#37` portability test (same ISA across 3 substrates byte-for-byte)
  is the most likely to surface real issues. Budget extra round there.
- Adapter installers may need filesystem fixture work; tests get
  larger than expected.

## Session end contract

When all 7 items done OR time runs out:
- Post final summary to #soma channel listing what shipped + what
  remains
- Update Plans/2026-05-isa-rollout.md status table inline
- Append a one-line memory entry to MEMORY.md if any non-trivial
  lessons surfaced
