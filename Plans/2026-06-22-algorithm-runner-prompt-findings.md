# Algorithm Runner & Prompt — Findings from 188 Real Runs

**Created:** 2026-06-22
**Authors:** Jens-Christian Fischer + Ivy
**Evidence:** 188 run records in `~/.soma/memory/WORK/algorithm-runs/`, 33 `LEARNING/ALGORITHM/*` notes, 4 `REFLECTIONS` rows, 1 PROMOTED critical review. Quantitative aggregation + qualitative corpus sweep.

---

## Headline

The deterministic runner is **ceremony-heavy and its feedback loops are largely abandoned**, and the verify gate **accepts assertion as evidence**. Two numbers tell it:

- **63% of runs stall at OBSERVE** (118/188); only **18% reach `complete`** (33); only **33% are ever verified** (62).
- The **loop is dead** (68 paused, 0 ran or completed, plateau counter never fired), **reflection capture stopped after 2026-05-07** (4 rows total), and the **effort classifier verdict is never used** (0 runs sourced effort from the classifier; 170/188 explicit).

Read together: the runner asks for *manual advancement work the agent does out-of-band*, so the record goes stale at OBSERVE; and where verification does happen, it is often tautological ("the design says X ∴ X passed"). This is exactly the case for the **checkpoint + inference direction** (`2026-06-22-soma-direction-verification-primitive.md`): the fix is not more gates, it is *the agent proposing real phase-advances and probes, the checkpoint gating them* — not more CLI ceremony.

---

## Quantitative signals (188 runs)

| Signal | Value | Reading |
| --- | --- | --- |
| Stall at OBSERVE | 118/188 (63%) | advancement abandoned at phase 1 |
| Reached `complete` | 33/188 (18%) | low completion |
| `verified: true` | 62/188 (33%) | most runs never verified |
| Reached build+ ("deep") | 48/188 (26%) | ¾ never reach execution |
| Loop status | 68 paused, 0 completed, 0 plateau | loop feature inert |
| effortSource = classifier | 0 | classifier verdict unused (170 explicit, 16 auto) |
| substrate unset | 165/188 (88%) | cross-substrate provenance empty in practice |
| learning array empty | 87/188 (46%) | half capture no learning |
| schemaVersion missing | 106 (flat ISA) vs 82 (v2) | two incompatible run schemas coexist |

---

## RUNNER fixes (deterministic CLI / state machine)

Ranked by evidence strength × impact.

### R1 — Type the verification evidence: `specified` vs `probed` vs `tested` *(HIGH)*
The verify command accepts free text and marks `passed`. The PROMOTED review names the failure: *"All 37 ISCs are marked 'passed-design' … tautological verification … should claim 37/37 specified, not verified."* Add an evidence **kind** and split criterion status into `passed-design` vs `passed-verified`. The completion gate requires `probed`/`tested` for behavioral criteria, else forces a `deferred-probe` state. This is the single highest-leverage fix — it attacks hallucinated green, which the 33%-verified number says is rampant.

### R2 — Actually enforce capability invoke-or-remove *(HIGH)*
~6 learnings: *"Capabilities are data/gate state only … AlgorithmRun.capabilities is string[]."* Selection is recorded, invocation never happens, the gate is unenforced (15 uninvoked selections across the corpus). Either wire selection → skill load, or block `complete` on an uninvoked selection. Today it is theater.

### R3 — Worktree isolation for build/execute *(MED)*
6 runs carried a hand-rolled criterion like *"unrelated local dirty files are not committed,"* with the recurring lesson *"use a temporary git worktree for PR rescue."* The runner re-pays attention budget guarding dirty state every time. Make build/execute phases offer/auto-create a worktree (Soma already has worktree infra).

### R4 — Schema versioning + migration *(MED)*
106 runs have no `schemaVersion` and use a flat ISA shape (`isa.phase`, `isa.criteria`); 82 use v2 (`isa.frontmatter`, `isa.sections`). Readers must handle both or rot. (Caveat: the 106 are largely PAI-era imports — partly inherited, not all Soma's bug.) Add a one-time migrate to v2 and make all readers version-aware.

### R5 — Auto-capture substrate *(MED)*
88% of runs have no substrate. The cross-substrate provenance that is Soma's whole selling point is empty because `--substrate` is manual. Default it from env/session; never require it.

### R6 — Read-only vs build as a phase branch, not a criterion *(MED)*
The "deepening" flow encodes *"No files are modified"* as a criterion that the user then overrides — it was **dropped mid-run in 6 runs** ("superseded after the user approved implementing"). Model it as an explicit branch (survey → optional build), not a criterion to invalidate.

### R7 — Fix the learning-writer dedup bug *(LOW)*
Duplicate learning lines written 10s apart (e.g. skill-selection-parity). Minor dedup bug in the learning writer.

### R7b — Port PAI's meta-reflection layer *(MED — corrected 2026-06-22)*
**Correction:** an earlier draft claimed "reflection capture stopped after 2026-05-07." That was a misread of the PAI→Soma boundary. The `REFLECTIONS/algorithm-reflections.jsonl` is a **PAI-era artifact** (fields `doctrine_fired`, `satisfaction_prediction`, `reflection_q1/q2/q3`); Soma's `src` has **no reflection writer**, and Soma's own `LEARNING/ALGORITHM/*` capture is alive and continuous (2026-05-14 → 2026-06-11). The reflections didn't break — they were never ported.

The real gap: Soma kept *criterion-level* learning ("a lesson from this run") but dropped PAI's *meta-reflection* layer — the per-run self-assessment "a smarter algorithm would have verified current-state earlier / launched Council in parallel." That signal is the highest-value improvement source (it's where P2 came from) and is exactly dream-cycle material. Worth **porting**, substrate-neutral, into Soma's learning capture.

### R8 — Path-segment validation for slugs/manifest fields *(LOW)*
2 runs: *"every manifest field that becomes a path segment needs a validation rule before implementation."*

---

## PROMPT fixes

### P1 — Verifier prompt: "the doc says X" is NOT evidence *(HIGH, pairs with R1)*
Instruct the model that a specification/design statement cannot verify a *behavioral* criterion; require an executable probe (test output, curl, grep of running state) or mark `deferred-probe`. This is the prompt half of the tautological-verification fix.

### P2 — OBSERVE current-state-verification floor *(HIGH)*
The recurring reflection: *"a smarter algorithm would have verified all current-state assumptions before the interview / before planning."* Combined with the 63% OBSERVE stall, the OBSERVE prompt should force probing current-state assumptions (read the repo/system, confirm the named field/flag/route exists) before advancing. Reduces both the stall and the proceed-on-assumption rework.

### P3 — Classifier prompt: tie effort to a current-state floor — or drop it *(MED)*
The classifier fires on 0 runs and under-scopes (E3 with 34 criteria vs E4 with 8 — no mapping). Decide: improve it so its verdict is trustworthy and *wire it in*, or remove the pretense. A deterministic step nobody trusts is dead weight.

### P4 — Capability prompt: stop implying invocation *(MED, pairs with R2)*
Until selection → load exists, describe capabilities as *commitments/contracts*, not active invocations, so the prompt stops promising behavior the runner doesn't deliver.

### P5 — Scaffold prompt surfaces the private-path placeholder up front *(LOW)*
The policy guard blocks first drafts that embed literal private Soma paths (3 runs). Tell the model to use `<soma-home>` in the scaffold prompt, not discover it via a terminal write-block.

---

## Priority (updated 2026-06-22)

**Tier 1 — integrity:**
1. **R1 + P1 — kill tautological verification** (#330). Highest severity, most recurrent, the integrity of the whole gate. Runner: evidence kinds + `deferred-probe`. Prompt: specified ≠ probed.

**Tier 1 — the meta-reflection pair** (prioritized by JC; both came from PAI's meta-reflection layer):
2. **R7b — port the meta-reflection layer** (#333). The *generator*. PAI's per-run "a smarter algorithm would have…" self-assessment was never ported. Porting it makes P2-class fixes surface themselves instead of waiting for a manual 188-run dig.
3. **P2 — OBSERVE current-state floor** (#331). The *first harvested output* of that layer (one recurring `reflection_q2`). Attacks the 63% observe-stall directly.

The causal shape is the point: **R7b is upstream of P2.** P2 is what you get when you read the meta-reflections by hand once; R7b is the loop that produces P2-class improvements continuously. Do P2 now (it's already harvested and cheap), and build R7b as the engine that finds the next ten P2s.

All three feed the checkpoint direction: a `checkpoint` whose verdict carries an evidence *kind* and is *probed not asserted* is the typed primitive; the meta-reflection is the Algorithm's LEARN phase / dream-cycle applied reflexively (the agent proposes, a checkpoint records). These findings are the empirical case for that direction.
