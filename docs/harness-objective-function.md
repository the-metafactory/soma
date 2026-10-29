# Harness Objective Function

> **On the word "harness."** Here it means the *measurement harness* — the eval scaffold and north-star metrics that observe how well the running assistant performs — in the ordinary "test harness" sense already used across `docs/architecture.md` and elsewhere. This is **not** the `CONTEXT.md`-forbidden use of `harness` as a synonym for **substrate** (the medium Soma inhabits: claude-code, codex, …). The substrate stays "substrate" everywhere in identity/purpose/policy/adapter vocabulary; this document is about the apparatus that *measures* the system, not the medium it runs on.

*What "better" means for this harness. 2026-07-10, derived from the run corpus, event stream, memory tree, and the principal's purpose and retrospective notes. The metric definitions are reviewable in `scripts/harness-eval.ts` and its baseline.*

## The definition

The harness is better when, and only when:

1. **A claim can be trusted without re-checking.** The retrospective names the failure: "death by a thousand small overclaims" (coding sessions flat 5.1/10). Every "done" that later turns out hollow taxes every future claim.
2. **Started work finishes, and stays finished.** Not "phase advanced", not "verified flag set" — every criterion demonstrably closed, and the same intent not respawning under a new name.
3. **A correction given once changes future behavior.** Learning that doesn't alter what happens next session is storage, not learning. The Errata ledger is the consumption link: a rejected output names the check that passed it, and a fix closes the cluster it belongs to (soma#785 Q18).
4. **All of the above costs less of JC's time and attention over time.** Autonomy is the stated highest value. Ceremony, re-reads, re-explanations, and harness self-maintenance are the cost line.

Anything that can grow while these four stand still is a vanity metric.

## North-star metrics (shipped, computable today)

Run with `bun run harness-eval` (`--check` gates against `scripts/harness-eval-baseline.json`; `--explain` prints the Goodhart notes). Trailing 60-day window; baseline committed so drift is git-reviewable.

The evaluator streams archived segments and the live file in order, then prints
the window start, earliest event, and the gap from window start to earliest
event, if any. This does not detect every missing event inside the window.
Missing or conflicting segments,
read failures, and a window older than the earliest event make `--check` exit 3
with `INCOMPLETE COVERAGE`. Exit 1 remains a measured regression; the weekly
wrapper records exit 3 as `could-not-run`. Baseline capture also refuses an
incomplete window. Daily snapshots remain as migration backups, not the normal
reader source.

Each `--check` writes `memory/STATE/harness-eval/<YYYY-MM-DD>.json` under `SOMA_HOME` (default `~/.soma`), using the UTC evaluation date. A temporary file and rename replace any receipt from the same day atomically. The receipt records all nine metrics with their values, baselines, tolerances, and `pass`, `fail`, or `unavailable` status, plus SHA-256 hashes of the run files, Errata ledger, baseline, and ordered event lines actually read (archived segments and live file, each line followed by a newline). Missing files have a null hash; an interrupted event stream has the hash of the lines read and incomplete coverage. Missing inputs, insufficient samples, incomplete coverage, and absent baselines cannot produce a metric pass. A measured regression remains `fail` even when another input is unavailable. The two ungated Errata metrics retain their values but have null baselines and tolerances and status `unavailable`. The overall `result` matches the printed `RESULT ok|regressed|could-not-run` line and preserves the existing gate verdict and exit codes, including exit 3 for incomplete coverage. If a receipt write fails, the evaluator reports the error on stderr and still prints `RESULT` with the original exit code. With `--json`, the `RESULT` line goes to stderr. `bun run harness-eval --trend` reads receipts without recomputing metrics and prints one row per date, oldest first.

| Outcome | Metric | 2026-07-10 | Direction |
|---|---|---|---|
| Trustworthy claims | Probe-backed evidence rate (non-tautological, artifact-bearing, sync-minted excluded) | **39.7%** | higher |
| Finishes | True-finish rate (all criteria checked, criteria state not phase) | **85.8%** | higher |
| Finishes | Abandoned-run share (zero criteria closed, idle >7d) | **9.1%** | lower |
| Learning compounds | Learning capture rate on finished runs | **66.8%** | higher |
| Learning compounds | Memory loop closure (instrumented reads per write) | **0.05** | higher |
| Learning compounds | Promotion rate (promotions per finished run) | **1.0%** | higher |
| Trustworthy claims | Hollow-pass attempt rate (gate refusals / (refusals + passed verifications)) | **0.2%** | lower |
| Trustworthy claims | Rejected passes per check (Errata linked to the check that passed them, plus `errata_unlinked`); source: Errata ledger `created` / `dropped` | n/a (no Errata yet, 2026-10-14) | lower |
| Learning compounds | Errata fix closure (proposed clusters whose `yes` filed a node that closed); source: Errata ledger `proposed` / `answered` / `node-closed` | n/a (nothing proposed yet, 2026-10-14) | higher |

*Hollow-pass and promotion rate shipped 2026-07-11 (loop-closure plan T1/T5), reading the `verification.gate_violation` and `memory.promotion` event streams. Both sit near their floor by design — they exist to make a real move visible, not to flatter the current state.*

### Errata metrics (node #853)

The two Errata rows replace the retired feedback-closure proxy (7.8% on 2026-07-10), which divided all memory writes by all feedback candidates without knowing whether any write answered any candidate. Both are derived from the private Errata ledger alone (`memory/STATE/errata/ledger.jsonl`, see `docs/errata.md`), over the same trailing window:

- **`rejected_passes`**: active (not dropped) Errata whose complaint falls in the window, one row per check that passed the rejected output, as `{check, count}`. An Algorithm verify reads `<runId>/<criterionId>`, a close receipt `<repo>#<nodeId>/<receiptCommentId>`. `errata_unlinked` counts the Errata with `passedBy: null`.
- **`errata_fix_closure`**: of the Errata clusters proposed in the window, the share fixed, reported as `fixed/proposed`. A cluster is fixed when an `answered` event with `answer: "yes"` is followed by `node-closed` for the node that yes filed. The ledger carries these events once proposals ship (node #852 appends `proposed`; Vigil's answer path appends `answered` and `node-closed`); every line carries `clusterId`, and unknown kinds are skipped.

An empty, missing or unreadable ledger, or a window without Errata or proposals, reports `n/a`, never zero. Both are reported by `bun run harness-eval` (text and `--json` under `errata`) and are not gated: they have no baseline yet, and alerts on them are out of scope. The silent-capture guard stays in `--check` as their countermeasure: it fails when no `feedback.candidate` lands in the window while sessions continue, because every Errata starts as one.

These proxy metrics show a relatively high criterion-completion rate alongside a nearly open-circuit learning loop. They do **not** establish live executor correctness or substrate behavior. The biggest available win is not doing more work — it is closing feedback→learning→recall.

Every metric's Goodhart failure mode and countermeasure live in the metric registry itself (`scripts/harness-eval.ts`, printed by `--explain`). A metric without a documented Goodhart mode does not ship — that is the registry's contract, enforced by test.

## Rejected vanity metrics

These are explicitly **not** health signals:

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
- **Where the gate runs:** CI (`bun test`, the Portability workflow) runs the unit tests — the metric math and the registry contract — on every PR. The live gate (`bun run harness-eval --check`) needs real soma-home data CI does not have, so it is meant to run on a developer machine on a schedule. The repo *ships the mechanism, not an active job*: a wrapper (`scripts/harness-gate-check.sh`, which also refuses a non-committed baseline) and a **placeholder** launchd plist (`scripts/launchd/ch.switch.soma.harness-gate.plist.template`). It is not active on a fresh checkout — you activate it by substituting the plist's `__PLACEHOLDER__` paths and bus settings and `launchctl load`-ing it (the snippet is in the template header). Once installed, every run logs to `~/Library/Logs/soma/harness-gate.log` with a `RESULT ok|regressed|could-not-run|guard` line, and each run calls `soma run finished --kind job --ref soma:harness-gate` once, with outcome `succeeded` (and state `soma:harness ok|regressed`), `failed` or `blocked`. That call reaches Vigil only when the plist sets `SOMA_PRINCIPAL` and the bus settings; until node #866 lands the installed CLI cannot load myelin and publishes nothing. Any call that does not publish leaves an `EMIT failed` line in the gate log. `ok` (exit 0) and `regressed` (exit 1) require harness-eval's own `OK:` or `REGRESSION:` verdict; `could-not-run` (exit 2) means there was no verdict (missing script, crash, unreadable baseline, git error); `guard` (exit 3) means the baseline differs from a resolvable HEAD and the check was not attempted. (It is currently installed on JC's machine; that is local state, not something a checkout inherits.)
- When a metric and the felt experience disagree, the felt experience wins and the metric gets audited: the metric is the map.

### Event kinds and their consumers (after the 2026-07-11 sampling change)

Audit §3 found ~89% of the event log had no automated reader — capture that nothing consumes is pure cost. The high-volume `writeback.claude_code.tool` event is now **sampled 1-in-10** at the claude-code hook (`hook-runner.mjs`, deterministic file counter, not `Math.random`); the VSA-sync side effect it also carries runs unsampled because it is functional, not telemetry. What each kind is for after that change:

| Event kind | Consumer today | Sampled? |
|---|---|---|
| `verification.gate_violation` | `hollow_pass_attempt_rate` | no — rare, high-signal |
| `memory.recall` (incl. `via:"search"`) | `memory_loop_closure` | no |
| `memory.resurface` / `memory.verify` / `memory.promotion` | `memory_loop_closure`, `promotion_rate` | no |
| `memory.write.*` | `memory_loop_closure` | no |
| `feedback.candidate` | `soma errata triage`; the silent-capture guard in `--check` | no (capture volume is itself a guard) |
| Errata ledger `created` / `dropped` (private file, not the event log) | `rejected_passes`, `errata_unlinked` | no |
| Errata ledger `proposed` / `answered` / `node-closed` (private file) | `errata_fix_closure` | no |
| `lifecycle.session_start` / `session_end` | session bookkeeping, sampling denominators | no — low-volume |
| `writeback.claude_code.subagent_start` / `subagent_stop` | subagent accounting | no — low-volume |
| `memory.projection` | observational only (projection frequency vs read frequency) — **deliberately not** counted by `memory_loop_closure` | no — one per session |
| `writeback.claude_code.tool` | no automated metric reader; kept as a sampled audit trail | **yes, 1-in-10** |

A kind with no consumer that is not sampled is a standing cost; adding one should either wire a reader or sample it.
