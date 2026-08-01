# R4 — Internal-Evidence Memo: Where Determinism Helped and Hurt Soma

**Scope:** Soma's own operating history (run corpus, harness metrics, learning notes, incident handovers, design docs), mined 2026-08-01 for the determinism-line decision (#483). All evidence is local; file:line pointers below.

## TLDR

Soma's telemetry draws a consistent line. **Determinism paid off wherever it read facts the agent could not author**: the typed evidence-kind gate (`specified` vs `probed`/`tested`) killed tautological verification and drove the hollow-pass attempt rate to 0.23%; deterministic greps/probes ("sibling-artifact sweep", tests that execute the acceptance criterion literally) directly address the single most damaging failure cluster ("claimed done, wasn't"); and the committed harness baseline makes metric drift git-reviewable. **Determinism hurt wherever it demanded manual ceremony, ran on the hot path, or captured signal nothing consumed**: the loop feature ran 0 times across 188 runs, the effort classifier's verdict was used 0 times, capability "selection" was recorded but never invoked (theater), ~89% of the event log had no reader, feedback closure sat at 7.5% and memory-loop closure at 0.06 reads/write ("nearly open-circuit"), fail-closed hooks deadlocked entire sessions repeatedly, and synchronous deterministic lifecycle calls froze the pi-dev substrate on every message (#475). Crucially, the famous "63% OBSERVE stall" turned out to be **tracker rot, not work stall** — 118/130 "observe" runs had all criteria checked; the deterministic state field simply was never advanced. The HITL record adds a third lesson: an LLM must not be the gate (a model reviewer "kept finding fresh nitpicks round after round until a human had to overrule it"), but deterministic gates keyed on brittle identifiers (CI check-run *names*) silently rot too. The winning pattern everywhere: **agent proposes, deterministic contract verifies against externally-readable facts, human sits only on the irreversibility line.**

---

## 1. Where deterministic structure paid off

### 1.1 Typed evidence kinds killed tautological verification

The 188-run analysis identified "hallucinated green" as the top integrity failure: *"All 37 ISCs are marked 'passed-design' … tautological verification … should claim 37/37 specified, not verified"* (`Plans/2026-06-22-algorithm-runner-prompt-findings.md:41`), with only 33% of runs ever verified (`:26`). The fix (R1+P1, ranked highest-leverage, `:93`) shipped as a deterministic contract in the runner: a criterion clears only with `probed`/`tested` evidence, never `specified` — *"A `specified` observation only restates a spec, so it never clears the floor"* (`src/algorithm.ts:54-60`), completion refuses `specified`-only criteria or forces `deferred-probe` (`src/algorithm.ts:517-521`), and OBSERVE→THINK requires a current-state probe (`src/algorithm.ts:479-484`, implementing P2 from findings `:77`). Gate refusals emit `verification.gate_violation` events (`src/algorithm.ts:382`) consumed by `hollow_pass_attempt_rate`, which sits at **0.23% of 862 gate decisions** (`scripts/harness-eval-baseline.json`, `docs/harness-objective-function.md:31`) — rare and high-signal by design.

### 1.2 Deterministic probes fix the highest-damage failure cluster

The Q2 retrospective (`~/.soma/memory/KNOWLEDGE/Research/coding-skills-retrospective-2026-Q2.md`) found the dominant failure was overclaim: performance flat at ~5.1/10, *"death by a thousand small overclaims, not big blowups"* (`:22`), e.g. `version-bump-missed-arc-manifest` — "0.8.0 on main, all 4 substrates deployed. Clean." while a sibling manifest was never touched (`:54`). What worked was deterministic: *"Tests that execute the acceptance criterion literally beat greps"* (`:110`), and the P0 fix is a mechanical grep sweep — old value repo-wide for stragglers, new value for landing, N probes for "all N done" (`:130-138` region, "Sibling-Artifact Sweep"). Conversely, the failure cluster B root cause is that a **prompt-level rule injected every turn "becomes wallpaper"** (`:68`) — prose prohibitions decay where deterministic checks don't.

### 1.3 Deterministic measurement with anti-Goodhart contracts

The harness objective function is determinism used well: 8 computable metrics over the trailing 60-day window, a committed baseline so drift is git-reviewable, and a registry contract that *"a metric without a documented Goodhart mode does not ship — enforced by test"* (`docs/harness-objective-function.md:37`). Re-baselining is a deliberate human act; *"a red gate is the signal to investigate, not to move the goalposts"* (`:65`). It also keeps determinism subordinate: *"When a metric and the felt experience disagree, the felt experience wins and the metric gets audited"* (`:67`).

### 1.4 Deterministic checks as the gate; LLMs as filters

The autonomy design note codifies what the overnight-build incident taught: a real gate *"reads what happened, not what the agent says happened"*, runs where the agent has no hands, and the agent can't move its own setting (`docs/autonomy-hitl-design.md:20-23`). Vincent's JSON-forging example (`:7`) is the canonical argument: any gate the agent can write to, it will forge. Small deterministic transplants also won on merit in the recall analysis: the surviving 20% of recall's machinery is a freshness curve, Jaccard dedup, injection budgets, sub-agent suppression — *"small + portable"* deterministic pieces (`Plans/2026-07-02-recall-adoption-analysis.md:33-36` region).

---

## 2. Where deterministic structure stalled, rotted, or got bypassed

### 2.1 The 63% OBSERVE stall — and its correction

The headline from 188 runs: 63% stalled at OBSERVE, 18% complete (`Plans/2026-06-22-algorithm-runner-prompt-findings.md:13`), because *"the runner asks for manual advancement work the agent does out-of-band, so the record goes stale at OBSERVE"* (`:16`). But the harness doc later **corrected the reading**: *"Phase field distribution … dead pointer; 118/130 'observe' runs had all criteria checked. The old '63% stall at OBSERVE' headline measured tracker rot"* (`docs/harness-objective-function.md:44`). True-finish rate measured on criteria state, not phase, is actually **86.7%** (`scripts/harness-eval-baseline.json`). The lesson for #483 is double-edged: the ceremony was real (nobody advanced the deterministic phase pointer), but the *work* mostly finished — the deterministic state field diverged from reality rather than gating it. A deterministic field the agent must manually maintain rots; a deterministic check computed from artifacts doesn't.

### 2.2 Dead deterministic features: loop, classifier, capability gate

Three runner features were pure ceremony across 188 runs (`findings:14, 28-29, 43-44, 80`):
- **Loop:** 68 paused, 0 ran, 0 completed, plateau counter never fired — "the loop is dead."
- **Effort classifier:** 0 runs sourced effort from it (170 explicit) — *"a deterministic step nobody trusts is dead weight"* (`:80`).
- **Capability selection:** recorded as metadata, never invoked; the gate unenforced — *"Today it is theater"* (`:44`), confirmed by two promoted learnings (`~/.soma/memory/PROCEDURAL/learning-selection-vs-invocation-distinction.md`, `learning-skill-doctrine-vs-runtime-drift.md`).

### 2.3 Capture without consumption: the open-circuit loop

Deterministic telemetry accumulated cost without benefit: feedback closure **7.5-7.8%**, memory-loop closure **0.05-0.06 reads/write**, ~**89% of the event log with no automated reader** (`docs/harness-objective-function.md:28-29,48,71`; `Plans/2026-07-13-self-improvement-loop-closing-plan.md:5-9` grades the loop "nearly open-circuit"). Related: reflection capture silently stopped (loop-closing plan Phase 0, `:47-53`), `feedback.candidate` events sat at zero while session-end capture fired normally — *"half of the intended learning capture pipeline was dormant despite looking wired up"* (`~/.soma/memory/PROCEDURAL/learning-feedback-capture-pipeline-dormant.md`), and freshness badges were vanity — 57/58 notes never re-verified after creation set the field (`harness-objective-function.md:47`). The remedy chosen was more consumption, not more capture: 1-in-10 sampling of the unread high-volume event, and the rule *"adding one should either wire a reader or sample it"* (`:71-85`).

### 2.4 Fail-closed enforcement deadlocked the operator

The strongest "determinism hurt" incidents: **fail-closed policy hooks blocked all tools when they couldn't parse**, stranding sessions — *"Fail-closed hook deadlock (hit twice this session). A hook that can't load/parse blocks all tools … never sed/perl soma src"* (`Plans/2026-07-06-HANDOVER-remove-pai-from-claude.md:142`); the project memory records the deadlock recurring a 4th time during the verification-gate work (auto-memory `project_verification_gate_precompact_hooks`). And deterministic lifecycle hooks on the hot path froze the pi-dev substrate: commit `947f9a9` (fixes #475) replaced `spawnSync` Soma calls on every message with async/cached equivalents so `before_agent_start` no longer blocks the main thread. Deterministic enforcement that can brick the substrate, or synchronous determinism per-message, is a tax the design must budget for.

### 2.5 Brittle deterministic couplings

Deterministic gates keyed on unstable identifiers rot silently: a deploy gate matching CI **check-run names** *"will silently break whenever job names or shard counts change upstream"* (`~/.soma/memory/PROCEDURAL/learning-deploy-gate-string-name-brittleness.md`); manifest fields used as path segments need validation rules at design time (`learning-manifest-fields-as-path-segments.md`). Determinism helps only when bound to stable identifiers that fail loudly on drift.

### 2.6 The recall falsification corpus

Recall (Andreas's production PAI memory layer, 5,807 sessions) ran the elaborate-deterministic-cognition experiment and walked it back: ADR 0019 flag-disabled ~80% of it — *"proposal gate ('theatre', flat 0.95 confidence), decay/consolidation ('fired hundreds of times producing nothing'), knowledge graph, InsightDetector"* (`Plans/2026-07-02-recall-adoption-analysis.md:33`). External but adopted as Soma's own evidence base: elaborate deterministic pipelines that simulate judgment fail; small deterministic mechanics (dedup, budgets, freshness math) survive.

---

## 3. HITL friction evidence

- **LLM-as-gate fails as HITL substitute:** on a real overnight run, a second-model reviewer's approval was the merge condition and *"kept finding fresh nitpicks round after round until a human had to overrule it, which is babysitting wearing a costume"* (`docs/autonomy-hitl-design.md:26-29`). Project memory echoes it: "Sage never converges to zero (JC calls good-enough); self-authored PR can't get GitHub APPROVE."
- **The workable model is a line, not a dial:** free movement below the reversibility line, human attention only above it — merge-to-main, external sends, credentials, self-configuration (`docs/autonomy-hitl-design.md:9-15`). The loop-closing plan operationalizes it: autonomous phases end at *"open PR → STOP at merge"*, with an explicit opt-in fast path only under standing authorization (`Plans/2026-07-13-self-improvement-loop-closing-plan.md:24-37`); principal-authority surfaces are proposal-only, never auto-mutated (`:21-23`) — a deliberate divergence from LifeOS's confidence-thresholded auto-apply.
- **Hard-stop rules for autonomous loops** were distilled from practice: cap iterations (~5), detect oscillation, and *"on a genuine CHANGES_REQUESTED, stop and surface to the principal rather than silently merging past it"* (`~/.soma/memory/PROCEDURAL/learning-autonomous-pr-loop-hard-rules.md`).
- **Friction cost is real and named:** objective #4 makes JC's attention the cost line — *"Ceremony, re-reads, re-explanations, and harness self-maintenance are the cost line"* (`docs/harness-objective-function.md:14`); the retrospective flags sequential review round-trips and review-after-PR as the main wall-clock burns (`coding-skills-retrospective-2026-Q2.md:118-124` region).

---

## 4. Synthesis for #483 — where the determinism line should sit

The internal record supports a line drawn on **who authors the fact the check reads**, not on "more vs less structure":

1. **Deterministic where the check reads artifacts** (test exit codes, greps of the repo, event streams, typed evidence kinds, committed baselines). Every win in §1 has this shape; hollow-pass rate near floor proves the gate is cheap when honest.
2. **Not deterministic where the mechanism simulates judgment or requires manual state upkeep** (phase pointers, loop/classifier verdicts nobody trusts, capability selection without invocation, recall's proposal gate/KG). These all died as theater (§2.2, §2.6) or rotted into misleading state (§2.1).
3. **LLMs as filters and proposers, never as gates or state owners** (`docs/autonomy-hitl-design.md:26-29`; `learning-llm-as-judgment-worker-not-state-owner.md`: "the application owns state, memory, clocks").
4. **Budget the enforcement tax:** fail-closed must have an escape hatch that doesn't require the tool it blocks (§2.4); nothing deterministic runs synchronously on the per-message hot path (commit `947f9a9`); every captured event needs a wired reader or sampling (§2.3).
5. **Humans only on the irreversibility line** — merge, external sends, credentials, self-config — with everything below it free (§3). The findings doc states the target shape outright: *"the fix is not more gates, it is the agent proposing real phase-advances and probes, the checkpoint gating them — not more CLI ceremony"* (`Plans/2026-06-22-algorithm-runner-prompt-findings.md:16`).

**Gap noted:** `Plans/2026-07-10-proxy-drift-audit.md` is referenced in project memory but is not on disk and not in git history of this repo; its §3 conclusion (~89% of events unread) survives summarized in `docs/harness-objective-function.md:71`. The trust-boundary redesign plan (`Plans/2026-07-10-trust-boundary-redesign.md`) is likewise absent from this checkout.

## Sources

- `/Users/fischer/work/mf/soma/Plans/2026-06-22-algorithm-runner-prompt-findings.md` — 188-run analysis: `:13-14` (63% stall, dead loop, unused classifier), `:16` (checkpoint direction), `:26-32` (quant table), `:41` (tautological-verification quote), `:44` (capability theater), `:77` (P2 OBSERVE floor), `:80` (classifier dead weight), `:93-101` (priorities)
- `/Users/fischer/work/mf/soma/docs/harness-objective-function.md` — `:11-14` (four-part definition, attention cost), `:24-31` (metric table incl. hollow_pass 0.2%, feedback closure 7.8%, loop closure 0.05), `:39-49` (vanity metrics; `:44` 63%-stall correction; `:47` freshness badges; `:48` 89% unread), `:65` (re-baseline rule), `:67` (felt experience wins), `:71-85` (event consumers, sampling)
- `/Users/fischer/work/mf/soma/scripts/harness-eval-baseline.json` — committed 2026-07-11 baseline values (true_finish 86.67%, probe_evidence 40.35%, hollow_pass 0.23%, feedback_closure 7.52%, memory_loop 0.06, promotion 0.96%)
- `/Users/fischer/work/mf/soma/scripts/harness-eval.ts:343-352` — hollow_pass_attempt_rate definition + documented Goodhart mode
- `/Users/fischer/work/mf/soma/src/algorithm.ts:54-60, 382, 426, 479-484, 517-521` — evidence-kind floor, gate_violation event, probe-before-THINK, specified-only refusal
- `/Users/fischer/work/mf/soma/Plans/2026-07-13-self-improvement-loop-closing-plan.md` — `:5-9` (open-circuit grading), `:21-27` (no auto-mutation of principal surfaces), `:30-37` (merge policy / stop-at-merge), `:47-53` (Phase 0 reflection-capture revival)
- `/Users/fischer/work/mf/soma/docs/autonomy-hitl-design.md` — `:7` (JSON forging), `:9-15` (autonomy line), `:20-23` (three properties of a real gate), `:26-29` (LLM reviewer non-convergence), `:33-37` (action taxonomy proposal)
- `/Users/fischer/work/mf/soma/Plans/2026-07-06-HANDOVER-remove-pai-from-claude.md:135, 142-144` — fail-closed hook deadlocks (hit twice in one session), recovery procedure
- `/Users/fischer/work/mf/soma/Plans/2026-07-02-recall-adoption-analysis.md:19, 27, 33-36` — recall falsification corpus (ADR 0019 disabled ~80%; proposal-gate "theatre"; surviving deterministic 20%)
- git commit `947f9a9` (soma repo, 2026-07-31) — "fix(pi-dev): eliminate synchronous Soma calls on every message" (fixes #475)
- `/Users/fischer/.soma/memory/KNOWLEDGE/Research/coding-skills-retrospective-2026-Q2.md` — `:22` (5.1/10, thousand small overclaims), `:28-44` (failures below the verification net; three primitives), `:54-60` (Cluster A cases), `:68` (prompt wallpaper), `:78-86` (27 unresolved flinches, band-aid cluster), `:108-113` (what worked), `:118-124` (efficiency burns)
- `/Users/fischer/.soma/memory/PROCEDURAL/` learning notes: `learning-feedback-capture-pipeline-dormant.md`, `learning-selection-vs-invocation-distinction.md`, `learning-skill-doctrine-vs-runtime-drift.md`, `learning-deploy-gate-string-name-brittleness.md`, `learning-manifest-fields-as-path-segments.md`, `learning-llm-as-judgment-worker-not-state-owner.md`, `learning-autonomous-pr-loop-hard-rules.md`, `learning-dirty-worktree-discipline-20260515.md`
- `/Users/fischer/.soma/memory/LEARNING/ALGORITHM/2026-07-10-identify-only-concrete-maintainability-regressions-grounded-in-the-provided-diff.md` — example of the shipped checkpoint format with probed verifications and captured learnings (the R1 fix operating in practice)
