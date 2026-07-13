# Plan: Close soma's self-improvement loop (LifeOS-7 gap remediation)

**Created:** 2026-07-13
**Origin:** LifeOS-7 vs soma self-improvement trace (2026-07-13). soma captures
learning signal prolifically but consumes almost none of it — its own objective
function grades the loop "nearly open-circuit" (`docs/harness-objective-function.md`:
feedback closure **7.8%**, memory-loop closure **0.05 reads/write**, ~89% of
events have no reader). These figures are that doc's committed baseline, not new
claims — reproduce them against the current event stream with `bun run harness-eval`.
**North-star metrics moved:** feedback closure, memory-loop closure, hollow-pass
rate (see `scripts/harness-eval.ts`). Each phase should move at least one and not
regress the others.

## Governing constraints (read before executing)

- **soma's deliberate divergence from LifeOS:** LifeOS auto-applies self-heal at
  model confidence (>=0.70). soma does **not** auto-mutate principal-trust
  surfaces — proposals only, principal-gated / metric-gated (#429, #375). Every
  phase here honors that: deterministic + advisory/proposal, never autonomous
  mutation of principal-authority content.
- **Verify contract (AGENTS.md):** every change ends green on `bun test` +
  `bun run typecheck`, plus a behavioral verification (drive the actual surface,
  not only unit tests) per the `verify` skill.
- **Branch protection:** `main` requires review. Autonomous execution =
  branch -> implement -> test -> **open PR -> STOP at merge**. Do NOT self /
  admin-merge unless the principal pre-authorizes admin-merge for this sequence
  (see "Merge policy" below).
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Merge policy (pick one before an autonomous run)

- **Default (review-gated):** open one PR per phase, label `ready-for-human`,
  stop. Principal reviews + merges. Safest.
- **Fast (pre-authorized admin-merge):** principal states once "admin-merge this
  sequence"; then each phase self-merges after CI is green (as done for #457).
  Only with explicit standing authorization.

---

## Sequence

Ordering rationale: unblock the dead capture first (else readback + upgrade run
on a truncated corpus), then a cheap low-risk doctrine, then the self-contained
self-repair, then readback (which benefits from live capture), then the
principal-gated design work last.

### Phase 0 — Revive reflection capture  (bug; #332 R7)  [AUTONOMOUS]

- **Why first:** the reflection record is the input to `reflections --digest`
  and any future AlgorithmUpgrade; #332 R7 reports capture "stopped after
  2026-05-07". Readback (#458) and the upgrade loop are severed at the source
  until this is fixed.
- **Do:**
  1. Diagnose: when/why reflection capture stopped (git log around 2026-05-07 on
     `src/algorithm*.ts` / `src/lifecycle.ts`; check `recordMetaReflection` call
     sites and the session-end learning writer). Also the R7 learning-writer
     dedup bug (duplicate lines 10s apart).
  2. Fix the capture path; add a regression test that a completed run appends a
     reflection record and that the writer dedups.
- **Files (likely):** `src/algorithm.ts`, `src/lifecycle.ts`, learning writer,
  a new test under `test/`.
- **Acceptance:** a real run's `learn` phase produces a reflection record;
  `reflections --digest` sees it; dedup regression test passes; `bun test` +
  `tsc` green.
- **Verify:** run an actual `soma algorithm` run end-to-end, confirm the record
  lands on disk.
- **Closes/advances:** #332 (R7 -> suggest splitting into its own bug on the
  comment already posted).

### Phase 1 — SelfHealing doctrine  (#459)  [AUTONOMOUS]

- **Why second:** cheapest, additive, near-zero code-path risk; establishes the
  routing vocabulary the later phases plug into.
- **Do:** author a portable doctrine markdown in `policy/` (source of truth) with
  the signal->home routing table; project it via the existing
  `renderPolicyProjection` machinery. Advisory on substrates without enforcement;
  advice-to-route, NOT authority-to-apply (governance unchanged).
- **Files:** `policy/` source md, `src/policy/*` or the adapters' policy call
  sites, projection snapshot test.
- **Acceptance:** doctrine appears in the claude-code projection; drift test
  asserts single-source (no per-adapter duplication); `bun test` + `tsc` green.
- **Coordinates with:** #314 (verification policy — same machinery; if #314 lands
  first, host the doctrine there).

### Phase 2 — Projection self-repair  (#460)  [AUTONOMOUS]

- **Why third:** self-contained adapter feature, deterministic, directly fixes
  the class of fragility hit on 2026-07-12 (jq/exec-bit/reproject-revert).
- **Do:** a SessionStart repair sweep (optional PostToolUse) that restores exec
  bits on projected direct-exec scripts under the substrate home
  (containment-guarded, no symlink escape) and reports checksum drift vs the
  installed source; observability-logged; no-op when clean.
- **Files:** `src/adapters/claude-code/` (+ portable core helper where sensible),
  containment test, drift-detection test.
- **Acceptance:** exec-bit restored on a deliberately-chmod-644'd projected
  script; repair refuses to act outside the substrate home; clean no-op path;
  logged. `bun test` + `tsc` green.
- **Advances:** the `doctor` fix-path gap (grep showed no repair path today).

### Phase 3 — Session-start learning readback  (#458)  [AUTONOMOUS]

- **Why fourth:** highest-leverage on memory-loop closure; benefits from Phase 0
  (live capture) but can assemble whatever exists.
- **Do:** deterministic (no-LLM) SessionStart readback assembling a bounded,
  freshness-windowed digest: recent FAILURES/low-rating "avoid these" + verified
  high-confidence wisdom + rating trend + top `reflections --digest` items. Hard
  size budget, ~21d window, fail-open, clean no-op on empty trees. Injection only.
- **Files:** `src/lifecycle.ts` (SessionStart path), a readback assembler module,
  snapshot test, size/freshness-cap test.
- **Acceptance:** SessionStart emits a bounded block; caps enforced; no-op when
  empty; snapshot test; `bun test` + `tsc` green. Re-measure memory-loop closure
  via `harness-eval` before/after.
- **Distinct from:** #403 (per-prompt note recall) — this is the LEARNING/wisdom
  tree at session start.

### Phase 4 — Principal-gated design work  [NOT AUTONOMOUS — DRAFT ONLY]

Do not implement autonomously; produce design drafts for principal review:
- **#375** reliable learning-signal capture — answer the 4 questions + reliability
  acceptance criteria (auto-fire trigger for `capture-failure` is the concrete
  slice, but the trigger choice is a principal decision).
- **#429** metric-gated structure loop — needs the #425 retrieval metric + a
  baseline; the meta-LLM proposal loop touches the schema (principal-authority).
- **AlgorithmUpgrade workflow** (LifeOS mechanism 12) — mine reflections+FAILURES
  into Algorithm doctrine diffs; human-gated apply even in LifeOS.
- **Deliverable:** a design note per item; STOP for principal decision.

---

## How to resume autonomously

1. Read this file + the linked issues (#458, #459, #460, #332, #375, #429, #384).
2. Pick the lowest-numbered unfinished phase. Confirm its issue is still open and
   `ready-for-agent`.
3. Branch `fix/` or `feat/` off `main`; implement to the phase's Acceptance.
4. `bun install` if needed; `bun test` + `bun run typecheck`; run the phase's
   behavioral Verify; then open a PR that `Closes #<issue>` with the evidence.
5. Apply the chosen Merge policy. Update this file's phase status.
6. Re-run `bun run harness-eval` after Phase 3 to quantify loop-closure movement.

## Status

- [ ] Phase 0 — revive reflection capture (#332 R7)
- [ ] Phase 1 — SelfHealing doctrine (#459)
- [ ] Phase 2 — projection self-repair (#460)
- [ ] Phase 3 — session-start readback (#458)
- [ ] Phase 4 — principal-gated design drafts (#375, #429, AlgorithmUpgrade)
