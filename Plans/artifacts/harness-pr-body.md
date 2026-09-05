Closes the feedback→learning→recall loop gaps found in a 2026-07-10 review of the run corpus, event stream, and memory tree. Split out of the shared execution branch so this change set reviews on its own scope. Each item below is self-contained; the review notes and task breakdown that motivated it are working notes, summarized here so this PR is inspectable on its own.

## What ships

- **`hollow_pass_attempt_rate` metric** (`scripts/harness-eval.ts`): reads the `verification.gate_violation` event stream. Numerator = gate refusals; denominator = refusals + passed verifications. Factors `countPassedVerifications` out of `probe_evidence_rate`.
- **`promotion_rate` metric**: `memory.promotion` events / finished runs — makes the (near-empty) promotion funnel visible.
- **Memory read-path events**: `searchSomaMemory` emits one observational `memory.recall` (`via:"search"`); `reprojectSubstrateMemoryProjection` emits one `memory.projection` per projection with the note count (deliberately **not** counted by `memory_loop_closure` — passive injection ≠ use). `memory.resurface` is now counted by `memory_loop_closure` (a genuine deliberate-reconsultation signal).
- **Skill routing signal preserved**: the compact registry stripped `USE WHEN` prose assuming structured `triggers` replaced it, but only 1/106 entries had a `triggers:` line. `extractUseWhenTriggers` now fills the `triggers:` line from prose when the array is empty. Real catalog: **68 entries losing routing signal → 0**, within the 300-line budget.
- **Telemetry sampling**: `writeback.claude_code.tool` is sampled ~1-in-10 by a **stateless FNV-1a hash of the call** (session + source + tool + paths + a bounded signature of `tool_input`) — no per-call counter file, no shared state to race, per-call decisions. The functional VSA-sync side effect runs unsampled, ahead of the gate.
- **Automatic gate**: CI (`bun test`) runs the metric/registry unit tests every PR; a weekly launchd agent (shipped as a placeholder template + wrapper — install it to activate) runs `harness-eval --check` against live soma-home data, refuses a non-committed baseline, and alerts on nonzero exit.
- **Gate error kept internal**: `VerificationGateError` is imported directly from `../algorithm`, not re-exported through the public `../index` barrel.

## Verification

- `bun run typecheck` clean; full suite green.
- `bun run harness-eval --check` green; baselines recaptured deliberately (git-reviewable) in the commits that add/redefine a metric.
- Gate tamper-tested end-to-end: a doctored or non-committed baseline is refused; regressions trip `exited with code 1`.

## Naming note

This uses "harness" in the *measurement-harness* sense (the eval scaffold/metrics), documented at the top of `docs/harness-objective-function.md` — not the `CONTEXT.md`-forbidden use of `harness` as a synonym for **substrate**. The substrate stays "substrate" everywhere in identity/purpose/policy/adapter vocabulary.

## Not in this PR (human-gated follow-ups)

- Reprojection (`soma install <substrate> --apply`) to push the feedback hook, sampling, and skill-registry fix to live homes.
- Curated `triggers:` frontmatter backfill for the ~37 skills that carry no `USE WHEN` and no triggers.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
