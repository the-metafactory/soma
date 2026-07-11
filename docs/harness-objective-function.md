# Harness Objective Function

*What "better" means for this harness. 2026-07-10, derived from the run corpus, event stream, memory tree, and the principal's purpose and retrospective notes. The metric definitions are reviewable in `scripts/harness-eval.ts` and its baseline.*

## The definition

The harness is better when, and only when:

1. **A claim can be trusted without re-checking.** The retrospective names the failure: "death by a thousand small overclaims" (coding sessions flat 5.1/10). Every "done" that later turns out hollow taxes every future claim.
2. **Started work finishes, and stays finished.** Not "phase advanced", not "verified flag set" — every criterion demonstrably closed, and the same intent not respawning under a new name.
3. **A correction given once changes future behavior.** Learning that doesn't alter what happens next session is storage, not learning. (Current state: 838 feedback events captured, ~0 consumed; 57/58 memory notes never resurfaced.)
4. **All of the above costs less of JC's time and attention over time.** Autonomy is the stated highest value. Ceremony, re-reads, re-explanations, and harness self-maintenance are the cost line.

Anything that can grow while these four stand still is a vanity metric.

## North-star metrics (shipped, computable today)

Run with `bun run harness-eval` (`--check` gates against `scripts/harness-eval-baseline.json`; `--explain` prints the Goodhart notes). Trailing 60-day window; baseline committed so drift is git-reviewable.

| Outcome | Metric | 2026-07-10 | Direction |
|---|---|---|---|
| Trustworthy claims | Probe-backed evidence rate (non-tautological, artifact-bearing, sync-minted excluded) | **39.7%** | higher |
| Finishes | True-finish rate (all criteria checked, criteria state not phase) | **85.8%** | higher |
| Finishes | Abandoned-run share (zero criteria closed, idle >7d) | **9.1%** | lower |
| Learning compounds | Learning capture rate on finished runs | **66.8%** | higher |
| Learning compounds | Feedback closure rate (candidates → downstream memory writes) | **7.8%** | higher |
| Learning compounds | Memory loop closure (instrumented reads per write) | **0.05** | higher |
| Learning compounds | Promotion rate (promotions per finished run) | **1.0%** | higher |
| Trustworthy claims | Hollow-pass attempt rate (gate refusals / (refusals + passed verifications)) | **0.2%** | lower |

*The last two shipped 2026-07-11 (loop-closure plan T1/T5), reading the `verification.gate_violation` and `memory.promotion` event streams. Both sit near their floor by design — they exist to make a real move visible, not to flatter the current state.*

These proxy metrics show a relatively high criterion-completion rate alongside a nearly open-circuit learning loop. They do **not** establish live executor correctness or substrate behavior. The biggest available win is not doing more work — it is closing feedback→learning→recall.

Every metric's Goodhart failure mode and countermeasure live in the metric registry itself (`scripts/harness-eval.ts`, printed by `--explain`). A metric without a documented Goodhart mode does not ship — that is the registry's contract, enforced by test.

## Rejected vanity metrics

These are explicitly **not** health signals. Several were live proxies found drifting in the 2026-07-10 audit (`Plans/2026-07-10-proxy-drift-audit.md`):

- **Tokens saved / rtk efficiency meter** — a cost line, never a score. 97% of it is one output-truncating command; nothing links savings to outcome quality.
- **Phase field distribution** (`observe`-stall %, `phase=complete` %) — dead pointer; 118/130 "observe" runs had all criteria checked. The old "63% stall at OBSERVE" headline measured tracker rot.
- **`verified: true` / criteria-checked counts alone** — mintable by the `enforceGate=false` sync path with "synced from ISA:" tautologies.
- **Counts of notes, skills, runs, events, digests, plans** — monotonic stocks. Use is the signal; volume is cost.
- **"verified Nd ago" freshness badges** — creation sets the field; 57/58 notes were never re-verified.
- **Capture volume** (feedback events, telemetry coverage) — ~89% of the event log has no reader; capture that nothing consumes is pure cost.
- **Test count / green CI** — protects code shape, not harness effectiveness (1,952 tests, none measured effectiveness before this suite).
- **Review rounds survived** — prices rework, not quality; more rounds is a cost signal.

## Instrumentation gaps (the next metrics, once signals exist)

The following signals remain incomplete or need stronger coverage:

1. **Hollow-pass attempt rate** — SHIPPED 2026-07-11 as `hollow_pass_attempt_rate`, reading `verification.gate_violation`. Remaining work is validating coverage and baseline stability over a soak window.
2. **Contradicted-claim rate** — "done" claims later contradicted within N days. Needs a claim journal or flinch/recurrence keys.
3. **Lesson-prevents-repeat rate** — did a promoted note's failure class recur? Needs recurrence keys on notes and digests.
4. **Recall-before-act rate** — the read paths now emit events: `soma memory search` and `recall` both emit `memory.recall`, `soma memory used` bumps `resurface_count` and emits `memory.resurface`, and the MEMORY.md reproject emits one `memory.projection` per projection (2026-07-11, T2). The remaining step is correlating a recall to the act it informed.
5. **Attention cost per verified outcome** — run wall-time per probe-verified criterion, trended.

## Operating rules

- The gate (`--check`) runs on the trailing window only; all-time aggregates would dilute fresh degradation under months of healthy history.
- Baseline updates are deliberate acts (`--write-baseline`, committed) — never automatic. **Who may re-baseline:** JC, or a session JC explicitly asks to. A session must never re-baseline to make the gate green — a red gate is the signal to investigate, not to move the goalposts. The one legitimate reason to re-baseline is that the PR *adding or redefining a metric* recaptures the window in the same PR (as T1/T5 did), and that recapture is reviewable in git history. If a number moved because a definition changed rather than because behavior changed, that is the exact failure this suite exists to prevent — revert the definition.
- **Where the gate runs:** CI (`bun test`, the Portability workflow) runs the unit tests — the metric math and the registry contract — on every PR. The live gate (`bun run harness-eval --check`) needs real soma-home data CI does not have, so it is meant to run on a developer machine on a schedule. The repo *ships the mechanism, not an active job*: a wrapper (`scripts/harness-gate-check.sh`, which also refuses a non-committed baseline) and a **placeholder** launchd plist (`scripts/launchd/ch.switch.soma.harness-gate.plist.template`). It is not active on a fresh checkout — you activate it by substituting the plist's `__PLACEHOLDER__` paths and `launchctl load`-ing it (the snippet is in the template header). Once installed, a nonzero exit logs to `~/Library/Logs/soma/harness-gate.log` and fires a macOS notification. (It is currently installed on JC's machine; that is local state, not something a checkout inherits.)
- When a metric and the felt experience disagree, the felt experience wins and the metric gets audited: the metric is the map.

### Event kinds and their consumers (after the 2026-07-11 sampling change)

Audit §3 found ~89% of the event log had no automated reader — capture that nothing consumes is pure cost. The high-volume `writeback.claude_code.tool` event is now **sampled 1-in-10** at the claude-code hook (`hook-runner.mjs`, deterministic file counter, not `Math.random`); the VSA-sync side effect it also carries runs unsampled because it is functional, not telemetry. What each kind is for after that change:

| Event kind | Consumer today | Sampled? |
|---|---|---|
| `verification.gate_violation` | `hollow_pass_attempt_rate` | no — rare, high-signal |
| `memory.recall` (incl. `via:"search"`) | `memory_loop_closure` | no |
| `memory.resurface` / `memory.verify` / `memory.promotion` | `memory_loop_closure`, `promotion_rate` | no |
| `memory.write.*` | `memory_loop_closure`, `feedback_closure_rate` | no |
| `feedback.candidate` | `feedback_closure_rate` | no (capture volume is itself a guard) |
| `lifecycle.session_start` / `session_end` | session bookkeeping, sampling denominators | no — low-volume |
| `writeback.claude_code.subagent_start` / `subagent_stop` | subagent accounting | no — low-volume |
| `memory.projection` | observational only (projection frequency vs read frequency) — **deliberately not** counted by `memory_loop_closure` | no — one per session |
| `writeback.claude_code.tool` | no automated metric reader; kept as a sampled audit trail | **yes, 1-in-10** |

A kind with no consumer that is not sampled is a standing cost; adding one should either wire a reader or sample it.
