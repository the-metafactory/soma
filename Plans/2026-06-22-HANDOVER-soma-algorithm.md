# HANDOVER — Soma Algorithm / Vocabulary work (2026-06-22)

Resume doc for a clean session. Read this first, then `CONTEXT.md` and
`docs/adr/0001-de-miessler-vocabulary.md`.

---

## TL;DR — what happened, what's next

Two bodies of work this session, both **merged to `main`**:
1. **De-Miesslered the vocabulary** (#334, commit `1d38545`) — the seven Soma
   compartments are now **Identity · Purpose · Verification · Skills · Memory ·
   Policy · Learning**, with new glossary terms `checkpoint`, `intent`, `Purpose`,
   `Verification`, `VSA`. Glossary in `CONTEXT.md`; rationale in `docs/adr/0001`.
2. **Verification integrity fix** (#330 → PR #335, commit `5e10109`) — the LEARN
   gate now rejects hollow "the design says X ∴ passed" verification. #330 closed.

**Next priority (in order):** #331 → #333 → #329. Details below.

---

## Strategic direction (the why)

Derived from a four-lens dissection of the PAI→LifeOS critique + Kyle's Letta/
Soma/PAI usage signal. Canonical doc:
`Plans/2026-06-22-soma-direction-verification-primitive.md`.

- Portability is **already solved** (5 shipping adapters). Don't re-sell it.
- The evolution = an **inference/agency layer on the deterministic spine**:
  agentic memory + goal-aligned consolidation, *inside* deterministic gates.
- Dividing line: **deterministic about movement/trust/gates/contracts; the model
  is free to propose, but every proposal is typed, audited, reversible.**
- `checkpoint` = the extracted primitive {criterion, evidence, typed verdict,
  gate}, two axes: done-ness + `intent`. Telos and ISA both collapsed into it.
- Naming is LOCKED (CONTEXT.md + ADR 0001). `heading` was rejected (collides with
  markdown titles); `intent` chosen.

---

## What's merged (don't redo)

| Item | Commit | Notes |
| --- | --- | --- |
| De-Miessler glossary + ADR + strategy/findings docs | `1d38545` (#334) | CONTEXT.md, docs/adr/0001, Plans/* |
| Verification evidence-kind + deferred-probe + LEARN gate | `5e10109` (#335) | closes #330; Sage-clean over 6 rounds |

**#330 detail:** `IdealStateCriterion` gained `evidenceKind` (`EvidenceKind` =
specified|probed|tested) and a `deferred-probe` status (`CriterionStatus`), both
round-tripping through ISA markdown (`~` mark, `Evidence (kind): …`). LEARN gate =
`learnGateViolations` in `src/algorithm.ts` (shared by the gate and
`algorithm-isa-sync.ts` `reachableTargetPhase` so they can't drift). CLI `verify`
has `--evidence-kind` + accepts `--status deferred-probe`.

**HONEST SCOPE (important — Sage's HonestOracle lens hammered this):** the evidence
kind is **caller-asserted on every surface** (CLI, ISA markdown, library). The gate
makes a hollow pass **explicit and auditable**, it does NOT verify the probe
happened. Necessary, not sufficient. Real probe enforcement (evidence↔artifact
linkage) is **future work**. Don't claim the hole is "closed" — say it's hardened.

**Deliberate back-compat boundary:** a `passed` with **undefined** evidenceKind is
**grandfathered** (legacy data can't be retro-probed); only an **explicit**
`specified` blocks. Synthetic frontmatter-progress passes ARE forced to `specified`
(they cap at VERIFY). Full enforcement (reject bare `passed`) waits on #331's
prompt emitting `Evidence (probed/tested):`.

---

## Open issues + priority

Source of truth: `Plans/2026-06-22-algorithm-runner-prompt-findings.md` (the
188-run analysis behind all of these).

1. **#331 — P2 OBSERVE current-state floor** (NEXT). 63% of 188 runs stall at
   OBSERVE; the most-repeated reflection was "verify current-state assumptions
   before proceeding." Add a gate: OBSERVE→THINK requires ≥1 recorded current-state
   probe. **Wide-impact** — adding a new gate means every full-cycle test must
   record a probe first (same churn pattern as #330's gate; budget for it). Was
   claimed + a worktree was set up then removed; start fresh from `main`.
2. **#333 — R7b port the meta-reflection layer** (the GENERATOR behind P2). PAI had
   a per-run "a smarter algorithm would have…" self-assessment (`reflection_q1/q2/q3`)
   that was never ported to Soma. Porting it makes P2-class fixes surface
   themselves. **New subsystem — wants JC's design steer before building.** It's the
   dream-cycle applied reflexively to the algorithm.
3. **#329 — Telos→Purpose / ISA→VSA code+path rename.** The glossary's code side:
   `interface Telos`→`Purpose`, `telos/` path, `TELOS.md` projection, `soma isa`→
   `soma vsa`, `Isa*` identifiers, `src/skills/ISA/`, ~22 docs. Large but mechanical
   find-replace with back-compat (CLI alias, home-path migration). Measured
   footprint in the issue body.
4. **#332 — backlog** (R2-R8, P3-P5): capability invoke-or-remove enforcement,
   worktree isolation for build, schema versioning, substrate auto-capture,
   read-only-vs-build phase branch, learning-writer dedup, classifier decision.

---

## SOP + tooling notes (learned the hard way this session)

- **Worktree SOP:** claim issue (`gh issue comment` + assign) → `git worktree add
  .worktrees/issue-<N>-<slug> -b issue-<N>-<slug> origin/main` → `bun install` →
  TDD → `bun run lint && bun run typecheck && bun test` → PR → Sage → merge →
  `git worktree remove`.
- **Sage review WITHOUT the bus (use this):**
  `sage review the-metafactory/soma#<PR> --post --emit-verdict-block --substrate claude`
  — runs offline, posts to the PR, prints a JSON verdict block. Loop until verdict
  is `commented`/`approved` with 0 blockers/0 majors. (HonestOracle lens always
  keeps ~1 philosophical nit; don't chase it forever.)
- **`pilot request-review`** works ONLY with `PILOT_PRINCIPAL=jc` env (principal id
  `jc`, stack `jc/default`, from `~/.config/cortex/default/stacks/default.yaml`).
  **`pilot wait-for-verdict`/`fetch` are BROKEN** — they need
  `~/.config/cortex/cortex.yaml`, retired in the 2026-06-18 config split. Use
  `sage review` offline instead until the cortex config path is restored.
- **Merge gate:** branch protection requires an *approving* review; Sage posts
  `commented`, not `approved`. So a clean Sage review still leaves the PR
  `MERGEABLE / BLOCKED`. Merge needs JC's approval or `gh pr merge --squash --admin`
  (JC authorized admin-merge this session) or `pilot approve --merge`.
- **Pre-existing lint baseline failure:** `bun run lint` fails on clean `main`
  (~23 problems in grok/doctor/bun-probe, #244-class). Unrelated to new work — lint
  only your changed files (`bunx eslint <files>`) to confirm you're clean.
- **Flaky tests under load:** grok-hook/install/init integration tests time out at
  exactly 5000ms when many sessions run concurrently. Re-run in isolation to
  confirm green before treating as a real failure.

---

## Gotchas

- Two ISA run schemas coexist in `~/.soma/memory/WORK/algorithm-runs/` (106
  unversioned flat-ISA, mostly PAI imports + 82 v2). Readers must handle both.
- "Reflections stopped May 7" was a MISREAD — the REFLECTIONS jsonl is a PAI-era
  artifact; Soma never wrote it. Soma's `LEARNING/ALGORITHM/*` capture is alive.
  R7b is a PORT, not a revive.
- When stacking PRs that touch `algorithm.ts` gates, branch off the prior branch,
  not `main`, or expect a rebase at merge.

---

## State pointers

- Project memory: `~/.claude/projects/-Users-fischer-work-mf-soma/memory/` —
  `project_soma_dividing_line.md` (direction + locked vocab) and
  `project_algorithm_runner_findings.md` (188-run findings + run status).
- This repo's session memory protocol: `.claude/memory/decisions.md` +
  `session-log.md` (per the work CLAUDE.md).
