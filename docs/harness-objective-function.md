# Harness Objective Function

*What "better" means for this harness. 2026-07-10, derived from the full run corpus (232 runs), the event stream (52k events), the memory tree, and the principal's purpose/retrospective notes — via a 50-agent ground-truth + adversarial-verification sweep plus inline synthesis.*

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

The headline story these numbers tell: **execution is healthy, the learning loop is nearly open-circuit.** The biggest available win is not doing more work — it is closing feedback→learning→recall.

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

Not shipped because the data doesn't exist yet — each needs a small emitter first:

1. **Hollow-pass attempt rate** — the VerificationGate detects the single most on-mission signal (an attempted unverified "done") and throws it away (`src/algorithm.ts` throw site emits no event). One-line event emit unlocks it.
2. **Contradicted-claim rate** — "done" claims later contradicted within N days. Needs a claim journal or flinch/recurrence keys.
3. **Lesson-prevents-repeat rate** — did a promoted note's failure class recur? Needs recurrence keys on notes and digests.
4. **Recall-before-act rate** — requires the real read paths (MEMORY.md projection, `soma memory search`) to emit recall/resurface events; today only the manual CLI does.
5. **Attention cost per verified outcome** — run wall-time per probe-verified criterion, trended.

## Operating rules

- The gate (`--check`) runs on the trailing window only; all-time aggregates would dilute fresh degradation under months of healthy history.
- Baseline updates are deliberate acts (`--write-baseline`, committed) — never automatic.
- When a metric and the felt experience disagree, the felt experience wins and the metric gets audited: the metric is the map.
