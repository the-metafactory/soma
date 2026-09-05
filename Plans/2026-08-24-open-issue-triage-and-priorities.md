# Open-issue triage and priorities — 2026-08-24

Snapshot of all 76 open issues on `the-metafactory/soma`, grouped by root cause
and ranked. Counts come from a `gh issue list --json` dump plus `soma graph
audit`/`frontier` probes on every open map, taken 2026-08-24.

## Shape of the backlog

| | |
|---|---|
| Open issues | 76 |
| Orienteer nodes | 26 (34%), across **four concurrent maps** |
| Unlabeled | 21 (28%) |
| Labeled `bug` | 4 |
| `ready-for-human` / `ready-for-agent` | 18 / 5 |
| Oldest | #146, #149, #152, #153 — 96 days |

Ranking question used throughout: *does this defect erode a control the
principal has to trust daily?* That ordering differs sharply from label or age.

---

## Tier 0 — the guard cries wolf, and one bite is self-inflicted

The runtime policy layer produces `critical` denials on ordinary English, and
one failure mode brings down the session that would repair it.

- **#471** env-egress/credential-egress matched prose in outbound payloads.
  *Largely fixed already* by `1240631` (PR #472): `hasEnvDump` is now anchored to
  command position and `hasCredentialTerm` requires an attached value. Issue is
  still open with no comment — re-verify and close, or state what remains.
- **#540** heredoc bodies treated as command position. **Still live**: the
  command-position anchor includes `\n`, so any heredoc body line beginning with
  `env`/`set`/`export`/`printenv` is read as a command.
- **#474** `credential-file-egress` blocks `git push` on the strength of its own
  commit message. A description surface is scanned as a data-transfer surface.
- **#544** the prompt inspector denied the principal's own instruction — 4th
  false positive in 3 days, and the instruction it blocked was a request to file
  a bug about the inspector.
- **#640** the policy guard imports the live soma working tree, so the few
  seconds a refactor spends with a broken import brick every tool in the session
  doing the refactor, including the ones needed to fix it. Recorded four times.

**Why first:** a control with this false-positive rate gets routed around, and a
routed-around control protects nothing. #640 additionally makes soma hazardous
to develop in-place.

## Tier 1 — the verification gate can be lied to

Soma's claim is that the model proposes and Soma decides whether the process may
advance. Four places where it does not:

- **#581** `algorithm invoke` accepts any non-empty `--evidence` string as proof
  a capability ran. The hollow-pass the VerificationGate prevents for criteria,
  one layer up, unguarded. `hollow_pass_attempt_rate` does not cover it.
- **#602** anti-criteria are write-only — stored, then unreachable by `verify`,
  invisible in `show`, ungated by `advance`.
- **#594** the tier thinking floors are met by 0% of runs at E3 and above.
- **#314** the substrate-independent default Verification Policy is unshipped
  after 71 days.

## Tier 2 — correctness and data safety

- **#614** `--soma-home <scratch>` reads as sandboxed but does not redirect
  substrate home resolution; a benchmark run wrote into the live home.
- **#620** a claimed graph node vanishes from the next session's frontier. On a
  real map a node carrying a finished 7.6 KB resolution has been invisible to
  every walk since 2026-08-13.
- **#652 / #653 / #612** install aborts on symlinked slots leaving the home
  half-projected; stale casing reported as unchanged; `--compile` silently
  installs zero bundled skills.
- **#596 / #585** declared `privateRoots` are decorative for policy; capability
  bindings are not substrate-scoped.

## Tier 3 — waste that is already measured

- **#543** the identity block renders into two projected files and both reach the
  model: **2,143 B ≈ 595 tokens duplicated every turn**, measured over 40 real
  requests, across all five adapters. Cheapest win in the repo.
- **#613** session-start costs 6.3s against session-end's 327ms.
- **#366 / #531** hooks off per-call `bun src/cli.ts` spawns; standalone binary.

## Tier 4 — the memory loop

**#655**, **#656** (filed 2026-08-24), **#467**, **#403**, **#429**, **#375**,
**#146**. Coherent, not urgent: the write half works, the read half is where
#655/#656 sit.

---

## Two structural problems worth more than any single issue

**Four maps open at once.** #645 (evolution), #604 (hook cost), #565 (Gauntlet
loop), #533 (GitLab backend). All audit clean; #604 has six unblocked frontier
nodes and is Tier 3 under a different name; #533 is six grilling nodes deep with
no visible forcing function.

**Three orphan nodes.** #600, #601, #618 carry `parent: —` and `kind: —`, so no
frontier walk will ever surface them — the structural form of #620. Their
content is close-gate binding and post-decision constraints.

---

## Recommended sequence

| | Action | Closes |
|---|---|---|
| A1 | Position-aware egress matching, one PR | #471 (verify), #474, #540 |
| A2 | Policy guard loads a pinned build, not the live worktree | #640 |
| A3 | Render the identity block once per adapter | #543 |
| A4 | Walk #604 to close — it is the cost cluster | ~6 nodes |
| A5 | Park map #533 unless GitLab is real | −6 frontier nodes |
| A6 | Adopt #600/#601/#618 into a map, or close them | 3 orphans |
| A7 | Decide the #38x composability block — 9 issues filed in one sitting 51 days ago, zero movement | #374, #381–#388 |

A1–A3 are roughly a week and remove daily friction. Tier 1 is the strongest
argument after that: #581 and #602 mean the harness reports a rigour it does not
enforce, which is a worse failure for Soma than for most projects.

## Status

- **A1 — heredoc half shipped as PR #658** (`fix(runtime-policy): a data-heredoc
  body is data, not command position`), pushed from worktree
  `~/work/mf/soma-a1-egress`, branch `fix/a1-egress-prose-matching`, commit
  `66c50d9`, off `origin/main`. CI green (confidentiality-gate, deterministic
  portability). Sage review run offline at `--lens-concurrency 3 --timeout 300`.
  - **#540 fixed and reproduced first.** Data-heredoc bodies no longer count as
    command position; interpreter heredocs still do.
  - **Found while committing:** a bare backtick is in the command-position anchor
    set as legacy command substitution, so a markdown code span in a heredoc-
    delivered commit message scored `env-egress`. The guard denied the commit
    describing its own false positive. Same fix covers it; regression test uses
    that exact shape.
  - **#471 appears already fixed** by `1240631` (PR #472) and is covered by the
    existing "keys on shell semantics, not English words" test. Re-verify and
    close, or state what remains.
  - **#474 NOT reproducible** with default `credentialPathPatterns` — four
    candidate shapes (commit message naming a dotenv, a private-key term, a
    credentials.json, and a PR body naming an aws credentials path) all come back
    clean. Needs the operative config or the real denied command from
    `metafactory-cortex-agent-atlas`. Its acceptance criterion 3 (denials name the
    matched pattern) is independently worth doing and would make the next
    occurrence self-diagnosing.

- **A2 shipped as PR #668** (`fix(claude-code): the policy guard runs a pinned
  runtime, not the worktree`), from worktree `~/work/mf/soma-640-guard-runtime`,
  branch `fix/640-pinned-guard-runtime`, commit `1e3f8c5`, off `origin/main`.
  CI green (confidentiality-gate, deterministic portability). **Not reviewed
  yet — trust-path change, so the SOP wants an adversarial pass before merge.**
  - `soma install claude-code` builds `<somaHome>/runtime/soma-cli.mjs` (a
    `bun build` bundle, ~1.4 MB, ~91 ms) and freezes it into the hook configs as
    `runtimeEntry`. The build doubles as the load check, so a broken tree fails
    the *build* and the last known-good runtime keeps enforcing.
  - **Reproduced first.** A legacy config against a mid-rename tree denies
    `ls -la`; the pinned config allows it. Both shapes are asserted side by side.
  - Deny messages now carry a failure CLASS: `UNAVAILABLE (fail-closed — this is
    not a policy denial)` names `soma install claude-code --apply`; a rule that
    fired still carries its own reason.
  - `soma doctor` gained `claude-code-policy-guard-runtime-unloadable` (error)
    and `-unpinned` (warning).
  - **Left open by design:** codex and grok hook entries still spawn
    `trustedSomaRepo` and carry the same exposure. The pinned runtime is
    substrate-neutral (it lives under the Soma home), so that is a small
    follow-up rather than a redesign.
