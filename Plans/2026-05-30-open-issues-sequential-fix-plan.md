# Open Issues Sequential Fix Plan

**Created:** 2026-05-30

**Scope:** Work every currently open issue in `the-metafactory/soma`
sequentially from a clean `main`.

**Issues in scope:** #274, #272, #267, #266, #265, #264, #263, #260, #248,
#244, #243, #153, #152, #150, #149, #146.

**Operating mode:** one issue at a time. Claim, branch from fresh `main`, TDD,
implement, run full verification, request Sage review, fix and loop until clean,
then merge before starting the next issue.

## Queue Order

| Order | Issue | Branch | Type | Why here |
| --- | --- | --- | --- | --- |
| 0 | #244 lint baseline failure | `issue-244-close-lint-baseline` | close/update | Already fixed by `c295437`; verify current `main`, comment, and close if still clean. |
| 1 | #243 path guard delete hardening | `issue-243-path-guard-delete-hardening` | needs-info / hardening | Reporter issue is not reproducible, but defensive direct-API path normalization is small and security-adjacent. |
| 2 | #260 sync-from-isa debug logging nits | `issue-260-sync-debug-nits` | small cleanup | Low-risk warm-up issue touching known bridge code. |
| 3 | #267 memory search positional query | `issue-267-memory-search-positional-query` | CLI bug | Small, user-visible CLI fix with clear TDD acceptance criteria. |
| 4 | #263 install dry-run is silent no-op | `issue-263-install-dry-run-banner` | CLI UX bug | Prevents repeated install confusion; isolated output behavior. |
| 5 | #265 sync-from-isa honors frontmatter progress | `issue-265-sync-frontmatter-progress` | bridge correctness | Fixes real run reconciliation before provenance work. |
| 6 | #272 date-prefix run slugs | `issue-272-date-prefixed-run-slugs` | identity/run lifecycle | Prevents future same-task collision; depends on understanding sync/run slug behavior. |
| 7 | #266 per-hop substrate provenance | `issue-266-substrate-provenance` | Algorithm metadata | Needs stable run identity and sync semantics from #265/#272. |
| 8 | #264 substrate path rewrites | `issue-264-substrate-path-rewrites` | projection portability | Broader adapter/projection fix; should follow provenance/sync fixes. |
| 9 | #274 opt-in Claude Code mode classifier | `issue-274-claude-code-mode-classifier` | feature | Builds on projection/install confidence; includes classifier parity tests. |
| 10 | #248 Sigstore-sign official-tier publishes | `issue-248-sigstore-release-signing` | release process | Human decision plus publish pipeline implementation if decision is yes. |
| 11 | #153 MCP server tools | `issue-153-mcp-server` | large feature | Needs a design slice first, then implementation slices. |
| 12 | #150 identity versioning snapshots/rollback | `issue-150-identity-snapshots` | large feature | Safety net that benefits the remaining large stateful work. |
| 13 | #146 cross-machine memory sync | `issue-146-cross-machine-memory-sync` | architecture feature | Depends on snapshot/rollback and clear state mutation semantics. |
| 14 | #152 multi-principal support | `issue-152-multi-principal-support` | architecture feature | Depends on sync and strict personal/team boundary design. |
| 15 | #149 daemon mode with Myelin bus | `issue-149-soma-daemon` | architecture feature | Last: it depends on stable memory, identity, MCP/tool, and multi-principal boundaries. |

## Repeated Runbook

Replace `<N>` and `<slug>` for each issue.

### 1. Claim

```bash
gh issue comment <N> \
  --repo the-metafactory/soma \
  --body "Claiming for implementation. Plan: clean main, isolated branch/worktree, TDD, PR, Sage review loop, merge when clean."

gh issue edit <N> \
  --repo the-metafactory/soma \
  --add-assignee @me
```

If assignment fails, keep the claim comment and continue. For #243, claim only
after deciding whether to implement defensive hardening despite the
`needs-info` label.

### 2. Fresh Branch / Worktree

```bash
git fetch origin
git switch main
git pull --ff-only
mkdir -p .worktrees
git worktree add .worktrees/issue-<N>-<slug> -b issue-<N>-<slug> origin/main
cd .worktrees/issue-<N>-<slug>
bun install
```

### 3. TDD

Start with focused failing tests derived from the issue body.

```bash
bun test <focused-test-file>
# implement smallest useful change
bun test <focused-test-file>
```

Before PR:

```bash
bun run lint
bun run typecheck
bun test
```

### 4. Commit and PR

```bash
git status --short
git add <changed-files>
git commit -m "Fix #<N>: <short summary>"
git push -u origin issue-<N>-<slug>
gh pr create \
  --repo the-metafactory/soma \
  --base main \
  --head issue-<N>-<slug> \
  --title "Fix #<N>: <short summary>" \
  --body "Closes #<N>

## Summary
- ...

## Verification
- bun run lint
- bun run typecheck
- bun test"
```

### 5. Sage Review Loop

```bash
pilot request-review \
  --pr the-metafactory/soma#<PR> \
  --capability code-review.typescript \
  --title "Fix #<N>: <short summary>" \
  --note "Please review this Soma issue fix. Focus on repo conventions, adapter boundaries, runtime safety, regression risk, and test coverage." \
  --wait \
  --timeout 30m \
  --json > /private/tmp/soma-review-<N>-cycle-1.json
```

If Sage reports findings:

```bash
gh pr view <PR> --repo the-metafactory/soma --comments
gh pr diff <PR> --repo the-metafactory/soma
bun test <focused-test-file>
bun run lint
bun run typecheck
bun test
git add <changed-files>
git commit -m "Address Sage review for #<N>"
git push
```

Repeat Sage review until clean.

### 6. Merge and Cleanup

```bash
gh pr merge <PR> --repo the-metafactory/soma --squash --delete-branch
cd <repo-root>
git fetch origin
git pull --ff-only
git worktree remove .worktrees/issue-<N>-<slug>
```

## Issue Notes and TDD Targets

### #244 Lint Baseline

Current state: fixed by `c295437 Clean ESLint baseline`.

Plan:
- Verify `bun run lint`, `bun run typecheck`, and `bun test` on current `main`.
- Comment with the commit and verification.
- Close #244 if still clean.

### #243 Path Guard Delete Hardening

Current state: labeled `needs-info`; the reported runtime path is not
reproducible.

Plan:
- Add a direct `evaluatePathGuard` test for protected memory-root delete input
  that reaches the lower-level API without shell normalization.
- Harden the direct API boundary to normalize shorthand and relative targets
  consistently with shell target extraction.
- Keep the issue comment clear: this is defensive hardening, not confirmation
  of the originally reported runtime bypass.

Focused tests:
- `test/policy-path-guard.test.ts`
- `test/policy-targets.test.ts` if shell target extraction changes.

### #260 sync-from-isa Debug Nits

Plan:
- Add a focused test for malformed/corrupt run index handling that asserts no
  throw and a useful debug signal.
- Replace empty catch in `algorithm-isa-sync.ts` with bounded debug output.
- Switch the polling helper to `Bun.sleep` if it remains clearer without
  increasing flake risk.

Focused tests:
- `test/algorithm-isa-sync.test.ts`
- `test/claude-code-install.test.ts`

### #267 Memory Search Positional Query

Plan:
- Add CLI tests for positional query and existing `--query`.
- Prefer `--query` if both are provided, or reject mixed query inputs if that
  matches the surrounding CLI style.
- Improve missing-query and unknown positional errors.

Focused tests:
- `test/cli.test.ts`
- `test/memory.test.ts`

### #263 Install Dry-run Banner

Plan:
- Add CLI/install tests proving dry-run output says no changes were written and
  names `--apply`.
- Add the same footer/header for all install substrates.
- Keep default dry-run behavior unless the issue is explicitly expanded to
  default-on apply.

Focused tests:
- `test/cli.test.ts`
- `test/install.test.ts`

### #265 sync-from-isa Frontmatter Progress

Plan:
- Add tests where ISA checkboxes are unticked but frontmatter progress and phase
  indicate completion.
- Reconcile criteria up to the strongest trustworthy completion signal.
- Preserve idempotency and do not regress manually ticked checkbox behavior.

Focused tests:
- `test/algorithm-isa-sync.test.ts`
- `test/isa-accessors.test.ts` if parsing frontmatter progress needs helpers.

### #272 Date-prefixed Run Slugs

Plan:
- Decide same-day collision policy before coding. Default recommendation:
  `yyyy-mm-dd-<base>` plus `-2`, `-3` suffix when the dated slug already exists.
- Add tests for `algorithm new` and `isa scaffold` slug derivation.
- Preserve existing bare slugs; apply only to newly minted slugs.
- Document that the upstream Claude-side scaffolder must adopt the same
  convention in its repo.

Focused tests:
- `test/algorithm.test.ts`
- `test/cli.test.ts`
- `test/cli-isa.test.ts`
- `test/session-naming.test.ts`

### #266 Per-hop Substrate Provenance

Plan:
- Add append-only provenance entries to Algorithm run mutations.
- Record substrate for phase advance, criterion verify, capability invoke, and
  learn/promote operations.
- Surface a compact `touched by:` line in `algorithm show` and preserve raw
  provenance in JSON.

Focused tests:
- `test/algorithm.test.ts`
- `test/algorithm-isa-sync.test.ts`
- `test/cli.test.ts`
- `test/lifecycle.test.ts`

### #264 Substrate Path Rewrites

Plan:
- Add projection tests showing non-Claude substrate outputs do not contain
  Claude-specific home paths, hook refs, or Claude-only ISA tool refs.
- Add adapter-level path normalization for imported Algorithm skill/context
  payloads.
- Keep Claude Code projection unchanged where Claude-specific paths are valid.

Focused tests:
- `test/home-projection.test.ts`
- `test/substrate-adapters.test.ts`
- `test/portability-ci.test.ts`
- `test/skill-entrypoints.test.ts`

### #274 Claude Code Mode Classifier

Plan:
- First fix classifier parity: port minimal/native behavior into Soma tests.
- Add an opt-in `soma install claude-code --mode-classifier` flag.
- Project a `UserPromptSubmit` hook that calls Soma's classifier and emits the
  tightened no-downshift instruction.
- Disable conflicting external classifier entries while enabled; uninstall
  should restore or remove only Soma-owned settings.

Focused tests:
- `test/algorithm.test.ts`
- `test/claude-code-install.test.ts`
- `test/install.test.ts`
- `test/cli.test.ts`

### #248 Sigstore Release Signing

Plan:
- Treat as a design+release-pipeline issue.
- First PR should document the decision in release docs and add a CI/release
  check or script stub.
- If signing is approved, implement the publish-time Sigstore step and a local
  verification command.

Focused tests:
- `test/release-privacy-guard.test.ts`
- release script tests if available.

### #153 MCP Server

Plan:
- Start with a design PR: tool inventory, schema budget, write confirmation
  model, and adapter/MCP boundary.
- Implement a small read-only vertical slice first:
  `soma_memory_search`, `soma_isa_active`, `soma_algorithm_classify`.
- Add write tools only after per-call confirmation semantics are explicit.

Focused tests:
- New MCP server tests.
- `test/memory.test.ts`, `test/isa.test.ts`, `test/algorithm.test.ts`.

### #150 Identity Versioning

Plan:
- Decide snapshot backend first. Git-backed snapshots are the default
  recommendation because Soma state is file-native and diffs matter.
- Implement `soma snapshot`, `soma history`, and `soma rollback <snapshot>`.
- Add auto-snapshot hooks before migrations/upgrades/bulk imports.

Focused tests:
- New snapshot tests.
- `test/cli.test.ts`
- `test/pai-migration.test.ts`
- `test/isa-skill-installer.test.ts`

### #146 Cross-machine Memory Sync

Plan:
- Design the sync model before implementation: git remote vs cloud backend,
  conflict handling, and personal-compartment policy.
- Implement a minimal git-backed `soma sync status/pull/push` first.
- Keep append-only JSONL conflict handling explicit and tested.

Focused tests:
- New sync tests.
- `test/memory.test.ts`
- `test/work-registry.test.ts`
- `test/policy.test.ts`

### #152 Multi-principal Support

Plan:
- Design personal vs team compartments before writing runtime code.
- Add read-only shared skill registry overlay first.
- Add team memory only after the privacy model is enforced by policy tests.

Focused tests:
- New multi-principal tests.
- `test/home-projection.test.ts`
- `test/memory.test.ts`
- `test/policy.test.ts`

### #149 Daemon Mode

Plan:
- Start with a design PR around Myelin subject contracts and what Soma may own.
- Implement `soma daemon --dry-run` / health surface first.
- Add Myelin subscription and routing only after the contracts are explicit.

Focused tests:
- New daemon tests.
- `test/cli.test.ts`
- `test/lifecycle.test.ts`
- integration tests behind a mock Myelin bus.

## Completion Definition

All issues are considered handled when:

- Each issue has either a merged implementation PR, a merged design decision
  that intentionally splits the implementation, or a clear maintainer-approved
  close/no-action comment.
- Every implementation PR passed `bun run lint`, `bun run typecheck`, and
  `bun test`.
- Every PR completed a clean Sage review loop.
- `main` is clean and fast-forwarded after the final merge.
