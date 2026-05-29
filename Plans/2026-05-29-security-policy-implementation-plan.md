# Security Policy Implementation Plan

**Scope:** Work through the inbound-content and runtime-policy security issues
created from the PAI/Soma security parity review.

**Issues:** #250, #251, #255, #256, #257, #258, #259.

**Operating mode:** one issue at a time. Use an isolated git worktree, TDD, PR,
pilot review loop, and merge only when clean.

## Source Decisions

- DD-7: Soma owns inbound-content security; scanners provide evidence.
- DD-8: Soma runtime policy inspection replaces PAI security hooks.
- `CONTEXT.md`: glossary terms for inbound security, runtime policy
  inspection, runtime policy decisions, inspectors, security traces, and
  enforcement levels.

## Queue Order

| Order | Issue | Branch | Why here |
| --- | --- | --- | --- |
| 1 | #250 Integrate content-filter as Soma inbound-content security layer | `issue-250-inbound-content-security` | Establish shared security event/trace utilities, untrusted roots, scanner interface, and inbound decision model. |
| 2 | #251 Port PAI security hooks into Soma-native security core | `issue-251-runtime-policy-inspection` | Builds runtime policy inspection on the same Policy/event/trace foundation. First slice is Codex prompt + tool-call enforcement. |
| 3 | #255 Design Soma governance event runtime policy model | `issue-255-governance-event-model` | Design follow-up before implementing governance-event checks. May be docs/DD plus issue refinement rather than runtime code. |
| 4 | #257 Expand deterministic runtime command inspectors | `issue-257-command-inspectors` | Depends on #251's runtime policy inspection API and deterministic inspector shape. |
| 5 | #258 Implement runtime config-change auditing | `issue-258-config-change-audit` | Depends on #251 normalized event/trace contract and per-substrate enforcement-level language. |
| 6 | #259 Design opt-in permission-request intelligence for runtime policy | `issue-259-permission-request-intelligence` | Depends on #251 `ask` semantics and substrate capability mapping. |
| 7 | #256 Add opt-in model-backed runtime policy inspectors | `issue-256-model-backed-inspectors` | Last, because model-backed policy must sit behind deterministic policy and explicit opt-in config. |

## Cross-Issue Rules

- Start every implementation branch from `origin/main` in a fresh worktree.
- Do not include unrelated local docs or inventory files from the primary
  checkout.
- Use TDD for code issues: add failing focused tests first, then implement.
- Use docs/DD tests or targeted doc checks for design-only issues.
- Run `bun test`, `bun run typecheck`, and `bun run lint` before opening a PR.
- If `bun run lint` is unavailable, record that in the PR body and continue with
  tests + typecheck.
- Run `pilot request-review` on every PR and fix review findings until clean.
- Merge only after clean review and local verification pass.
- Remove the worktree after merge and fast-forward the primary checkout before
  the next issue.

## Repeated Runbook

Replace `<N>` and `<slug>` for each issue.

### 1. Claim

```bash
rtk gh issue comment <N> \
  --repo the-metafactory/soma \
  --body "Claiming for implementation. Plan: isolated worktree, TDD, PR, pilot review loop, merge when clean."

rtk gh issue edit <N> \
  --repo the-metafactory/soma \
  --add-assignee @me
```

If assignee update fails, keep the claim comment and continue.

### 2. Create Worktree

```bash
rtk git fetch origin
rtk mkdir -p .worktrees
rtk git worktree add .worktrees/issue-<N>-<slug> -b issue-<N>-<slug> origin/main
cd .worktrees/issue-<N>-<slug>
rtk bun install
```

### 3. TDD Implementation

Start with focused tests expressing the issue acceptance criteria.

| Issue | Focused tests |
| --- | --- |
| #250 | `test/inbound-security.test.ts`, `test/policy.test.ts`, `test/home-projection.test.ts`, Codex hook tests as needed |
| #251 | `test/runtime-policy-inspection.test.ts`, `test/policy.test.ts`, `test/install.test.ts`, `test/home-projection.test.ts` |
| #255 | docs/DD tests if available; otherwise focused glossary/design validation by review |
| #257 | `test/runtime-policy-inspection.test.ts`, `test/policy-targets.test.ts` |
| #258 | `test/runtime-policy-inspection.test.ts`, substrate install/projection tests for audited config surfaces |
| #259 | `test/runtime-policy-inspection.test.ts`, substrate permission capability tests where supported |
| #256 | `test/runtime-policy-inspection.test.ts`, inference mock/backend tests |

Loop:

```bash
rtk bun test <focused-test-file>
# implement smallest change
rtk bun test <focused-test-file>
```

Before PR:

```bash
rtk bun test
rtk bun run typecheck
rtk bun run lint
```

### 4. Commit and PR

```bash
rtk git status --short
rtk git add <changed-files>
rtk git commit -m "Fix #<N>: <short security summary>"
rtk git push -u origin issue-<N>-<slug>
rtk gh pr create \
  --repo the-metafactory/soma \
  --base main \
  --head issue-<N>-<slug> \
  --title "Fix #<N>: <short security summary>" \
  --body "Closes #<N>

## Summary
- ...

## Verification
- bun test
- bun run typecheck
- bun run lint"
```

### 5. Pilot Review Loop

```bash
rtk mkdir -p .worktrees/_tmp
rtk pilot request-review \
  --pr the-metafactory/soma#<PR> \
  --capability code-review.typescript \
  --title "Fix #<N>: <short security summary>" \
  --note "Please review the Soma security policy slice for issue #<N>. Focus on portability, policy boundaries, fail-closed/fail-soft behavior, audit safety, and test coverage." \
  --wait \
  --timeout 30m \
  --json > .worktrees/_tmp/review-<N>-cycle-1.json
```

If the review has findings:

```bash
rtk gh pr view <PR> --repo the-metafactory/soma --comments
rtk gh pr diff <PR> --repo the-metafactory/soma
rtk bun test <focused-test-file>
rtk bun test
rtk bun run typecheck
rtk bun run lint
rtk git add <changed-files>
rtk git commit -m "Address review for #<N>"
rtk git push
```

Repeat `pilot request-review` until clean.

### 6. Merge and Cleanup

```bash
rtk gh pr merge <PR> --repo the-metafactory/soma --squash --delete-branch
cd /Users/fischer/work/mf/soma
rtk git fetch origin
rtk git pull --ff-only
rtk git worktree remove .worktrees/issue-<N>-<slug>
```

## Issue-Specific Notes

### #250 Inbound Content Security

Implement the DD-7 core-first vertical slice:

- Policy-owned inbound security config.
- Default untrusted root at `<soma-home>/memory/RAW/untrusted/`.
- `InboundContentScanner` interface and fake scanner tests.
- `ALLOWED` / `BLOCKED` / `HUMAN_REVIEW` decision normalization.
- `STATE/events.jsonl` normalized events and `memory/SECURITY/` traces.
- Allowed content references bound to content hash.
- CLI under `soma policy` for scan/promote behavior.
- Codex first enforcement where feasible.

Dependency gate: before coding the real adapter, verify whether
`@metafactory/content-filter` is released as a package. If not released, do not
vendor or GitHub-pin it. Implement the Soma-owned scanner boundary and leave a
clear PR note about the pending package adapter.

### #251 Runtime Policy Inspection

Implement the DD-8 first slice:

- Runtime policy inspection types.
- Surfaces: `prompt` and `tool_call` implemented first; reserve the others.
- Decisions: `allow`, `deny`, `ask`, `alert`.
- `soma policy inspect` CLI/API.
- Deterministic inspectors only.
- Reuse existing path/private-root guard primitives.
- Narrow command inspection: credential egress, pipe-to-shell, env dump with
  outbound intent, inline interpreter alerts.
- Deterministic principal prompt inspection.
- Codex `PreToolUse` and `UserPromptSubmit` projection.

### #255 Governance Event Model

Design before implementation:

- Inventory PAI `TaskGovernance`, `SkillGuard`, and `AgentExecutionGuard`.
- Keep bare `agent` out of Soma core terminology.
- Decide whether each behavior is runtime policy, observability, or
  substrate-specific projection.
- Update `CONTEXT.md` and add a DD only if the model crosses hard-to-reverse
  policy/projection boundaries.

### #257 Expanded Command Inspectors

Build on #251:

- Expand deterministic command/path pattern coverage.
- Support Soma-owned runtime policy config.
- Preserve explicit non-goals: no full shell parser, no global network ban, no
  model-backed decisions.

### #258 Config-Change Audit

Build after #251:

- Map config surfaces per substrate.
- Redact/summarize sensitive values.
- Use normalized runtime policy events plus private security traces.
- Do not store raw config snapshots with secrets by default.

### #259 Permission-Request Intelligence

Design and implement conservatively:

- Inventory which substrates expose permission-request surfaces.
- Define trusted-root and approval-cache semantics in Soma Policy terms.
- Do not inherit PAI broad trusted prefixes.
- Read-only auto-approval must be opt-in or explicitly justified.

### #256 Model-Backed Inspectors

Implement last:

- Explicit opt-in only.
- Deterministic deny precedence.
- Mockable inference boundary.
- Timeouts, malformed model output, parse failures, and unavailable backends
  tested.
- Initial model-backed decisions should prefer `alert` or `ask`; `deny` needs a
  separate deterministic fallback or documented justification.
