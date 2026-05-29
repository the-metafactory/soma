# PAI Tool Migration Implementation Plan

**Scope:** Implement or close out the individual PAI tool migration issues
created from umbrella issue #128.

**Issues:** #210, #211, #212, #213, #214, #215, #216, #217, #218, #219, #220,
#221, #222.

**Operating mode:** unattended. Do not wait for principal answers. Make narrow,
reversible engineering decisions, record them in issue/PR comments, and keep
moving.

## Non-Negotiable Process

Run every issue as its own isolated branch, PR, review loop, and merge:

1. Claim the issue.
2. Create a git worktree and branch.
3. Implement with TDD.
4. Open a PR.
5. Run `pilot-review-loop` via `pilot request-review`.
6. Fix review findings until clean.
7. Merge when clean.
8. Remove the worktree.
9. Update local `main`.
10. Start the next issue.

Temporary files and helper notes must stay inside this repository, preferably
under `.worktrees/_tmp/`. Do not use `/private/tmp` for this unattended run.

The current primary checkout may already contain unrelated local docs changes.
Do not include them in implementation branches. All implementation happens in
fresh worktrees from `origin/main`.

## Queue Order

The order keeps dependencies ahead of dependents and leaves packaging/non-port
decisions last.

| Order | Issue | Tool | Why here |
| --- | --- | --- | --- |
| 1 | #210 | `Inference.ts` | Track A primitive; failure capture and future skill packages depend on it. |
| 2 | #213 | `FailureCapture.ts` | Exercises inference injection and low-sentiment artifact writes. |
| 3 | #211 | `LearningPatternSynthesis.ts` | Ratings contract and synthesis behavior. |
| 4 | #212 | `OpinionTracker.ts` | Shared opinion model used by relationship reflection. |
| 5 | #215 | `SessionHarvester.ts` | Session/work-registry learning extraction. |
| 6 | #214 | `GetCounts.ts` | Metrics/count read model. |
| 7 | #217 | `SessionProgress.ts` | Multi-session continuity state. |
| 8 | #216 | `WisdomDomainClassifier.ts` | Wisdom frames routing, before update/synthesis hardening. |
| 9 | #219 | `WisdomFrameUpdater.ts` | Frame creation/update contract. |
| 10 | #221 | `WisdomCrossFrameSynthesizer.ts` | Cross-frame principles and health reports. |
| 11 | #218 | `RelationshipReflect.ts` | Depends on opinion/rating contracts. |
| 12 | #222 | `algorithm.ts` execution-mode gaps | Track A Algorithm gap-fill after tool surfaces are stable. |
| 13 | #220 | `FeatureRegistry.ts` non-migration decision | Final decision issue; should map and close the non-port explicitly. |

## Per-Issue Runbook

Use these steps for each issue. Replace `<N>` and `<slug>`.

### 1. Claim

```bash
rtk gh issue comment <N> \
  --repo the-metafactory/soma \
  --body "Claiming for implementation. Plan: isolated worktree, TDD, pilot review loop, merge when clean."

rtk gh issue edit <N> \
  --repo the-metafactory/soma \
  --add-assignee @me
```

If `--add-assignee @me` fails, keep the claim comment and continue.

### 2. Create Isolated Worktree

```bash
rtk git fetch origin
rtk mkdir -p .worktrees
rtk git worktree add .worktrees/issue-<N>-<slug> -b issue-<N>-<slug> origin/main
cd .worktrees/issue-<N>-<slug>
rtk bun install
```

Branch naming:

```text
issue-210-inference
issue-213-failure-capture
issue-211-learning-pattern-synthesis
issue-212-opinion-tracker
issue-215-session-harvester
issue-214-metrics
issue-217-session-progress
issue-216-wisdom-domain-classifier
issue-219-wisdom-frame-updater
issue-221-wisdom-cross-frame-synthesizer
issue-218-relationship-reflect
issue-222-algorithm-execution-modes
issue-220-feature-registry-decision
```

### 3. TDD

Start with tests that express the issue acceptance criteria.

Focused test files should generally be:

| Issue | Likely focused tests |
| --- | --- |
| #210 | `test/inference.test.ts`, possibly `test/cli.test.ts` |
| #213 | `test/learning-tools.test.ts` |
| #211 | `test/learning-tools.test.ts` |
| #212 | `test/learning-tools.test.ts`, `test/relationship-tools.test.ts` |
| #215 | `test/learning-tools.test.ts`, work-registry tests if needed |
| #214 | `test/learning-tools.test.ts`, `test/cli.test.ts` |
| #217 | `test/learning-tools.test.ts`, `test/cli.test.ts` |
| #216 | `test/wisdom-tools.test.ts` |
| #219 | `test/wisdom-tools.test.ts` |
| #221 | `test/wisdom-tools.test.ts` |
| #218 | `test/relationship-tools.test.ts`, `test/learning-tools.test.ts` |
| #222 | `test/algorithm-execution-modes.test.ts`, `test/algorithm.test.ts`, `test/cli.test.ts` |
| #220 | docs test or targeted Algorithm tests only if a gap is found |

TDD loop:

```bash
rtk bun test <focused-test-file>
# implement smallest change
rtk bun test <focused-test-file>
```

Before opening a PR, run:

```bash
rtk bun test
rtk bun run typecheck
rtk bun run lint
```

If `bun run lint` is unavailable or not in `package.json`, record that in the
PR body and continue with `bun test` + `bun run typecheck`.

### 4. Commit and PR

Use the issue number in the commit subject and PR body.

```bash
rtk git status --short
rtk git add <changed-files>
rtk git commit -m "Fix #<N>: <short tool migration summary>"
rtk git push -u origin issue-<N>-<slug>
rtk gh pr create \
  --repo the-metafactory/soma \
  --base main \
  --head issue-<N>-<slug> \
  --title "Fix #<N>: <short tool migration summary>" \
  --body "Closes #<N>

## Summary
- ...

## Verification
- bun test
- bun run typecheck
- bun run lint"
```

### 5. Pilot Review Loop

Use TypeScript review by default for this repo:

```bash
rtk pilot request-review \
  --pr the-metafactory/soma#<PR> \
  --capability code-review.typescript \
  --title "Fix #<N>: <short tool migration summary>" \
  --note "Please review the Soma PAI tool migration slice for issue #<N>. Focus on portability, path safety, test coverage, and substrate-neutral boundaries." \
  --wait \
  --timeout 30m \
  --json > .worktrees/_tmp/review-<N>-cycle-1.json
```

Exit handling:

- `0`: read verdict and fix findings if any.
- `4`: transient backpressure; sleep and retry.
- `124`: timeout; retry once, then comment on the PR with the timeout evidence
  and retry a final time.
- `1`, `2`, `3`, `5`, `6`, `7`: record the failure on the PR and issue, fix
  invocation/config if obvious, otherwise move the issue to a blocked note and
  continue the queue. Do not wait for principal input.

For each review cycle with findings:

```bash
# inspect review
rtk gh pr view <PR> --repo the-metafactory/soma --comments
rtk gh pr diff <PR> --repo the-metafactory/soma

# fix
rtk bun test <focused-test-file>
rtk bun test
rtk bun run typecheck
rtk bun run lint
rtk git add <changed-files>
rtk git commit -m "Address review for #<N>"
rtk git push

# request another review
rtk pilot request-review ... --cycle <next-cycle> ...
```

### 6. Merge

Merge only when:

- reviewer verdict is clean or all findings have been resolved,
- `bun test` passes,
- `bun run typecheck` passes,
- `bun run lint` passes or is explicitly unavailable,
- PR body says `Closes #<N>`.

Merge from the canonical checkout or with explicit `--repo` to avoid worktree
`main` ownership errors:

```bash
cd /Users/fischer/work/mf/soma
rtk gh pr merge <PR> --repo the-metafactory/soma --squash --delete-branch
rtk git pull --ff-only
```

If `gh pr merge` reports that `main` is already checked out elsewhere, stay in
the canonical checkout and rerun with `--repo the-metafactory/soma`.

### 7. Cleanup

```bash
rtk git worktree remove .worktrees/issue-<N>-<slug>
rtk git worktree prune
rtk gh issue view <N> --repo the-metafactory/soma --json state,closed
```

If GitHub did not auto-close the issue, close it with a comment linking the
merged PR.

## Issue-Specific Implementation Notes

### #210 `Inference.ts`

Audit current `src/tools/inference/` against the issue. This may be mostly a
parity/test hardening issue. Do not add a direct Codex/Pi backend unless the
adapter contract requires it; injected `InferenceBackend` is the portable
boundary.

Watch for:

- stdin path in CLI
- advisor state path via `createPaths()`
- credential scrubbing in subprocess backend
- no real LLM calls in CI

### #213 `FailureCapture.ts`

Work after #210 is merged. Keep failure description generation mockable. If the
current implementation already has deterministic fallback, test it explicitly.

### #211 `LearningPatternSynthesis.ts`

Focus on ratings contract and time windows. Avoid overfitting to PAI category
names if Soma has a better local vocabulary, but preserve recognizable
frustration/success grouping.

### #212 `OpinionTracker.ts`

Harden shared confidence logic before relationship reflection. Keep deltas
centralized so #218 cannot drift.

### #215 `SessionHarvester.ts`

Default to Soma work registry. Optional raw transcript mode must accept a caller
provided path and must not discover `~/.claude/projects` internally.

### #214 `GetCounts.ts`

Count Soma state, not substrate config. If statusline/banner-specific counts
are no longer meaningful, document the narrower Soma metric.

### #217 `SessionProgress.ts`

Keep this separate from Algorithm run state. It is a lightweight continuity
record, not a second Algorithm store.

### #216 `WisdomDomainClassifier.ts`

Classifier should discover existing frames dynamically. Bootstrap keywords are
allowed as defaults only.

### #219 `WisdomFrameUpdater.ts`

Frame render stability matters. Add tests that update the same frame multiple
times and assert no duplicate headings or broken metadata.

### #221 `WisdomCrossFrameSynthesizer.ts`

Prefer deterministic similarity and stable sorted output. Weekly scheduling is
out of scope for core.

### #218 `RelationshipReflect.ts`

Run after #212. Inject notification behavior. Do not hardcode `ntfy.sh`.

### #222 `algorithm.ts` execution-mode gaps

This is not a port of PAI's giant CLI. Only extract portable contracts:

- loop state
- plateau detection
- criteria partitioning
- ideate/optimize presets
- executor interface
- notification event data

Keep substrate spawning out of core.

### #220 `FeatureRegistry.ts`

Expected outcome is a documented non-migration decision. Map PAI
FeatureRegistry commands to Soma Algorithm concepts. Only implement code if the
mapping exposes a concrete gap.

## Closeout Criteria For #128

After all 13 child issues are closed:

1. Comment on #128 with the final issue/PR table.
2. Confirm `docs/pai-tools-migration-inventory.md` matches the final state.
3. Run:

```bash
rtk bun test
rtk bun run typecheck
rtk bun run lint
```

4. Close #128 if no remaining migration work is hidden behind it.

