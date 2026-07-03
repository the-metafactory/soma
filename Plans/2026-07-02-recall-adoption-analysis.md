# Recall Adoption Analysis — for Soma Memory Subsystem

**Date:** 2026-07-02. Deep analysis of `~/work/mf/recall` (github.com/the-metafactory/recall, Andreas's between-session memory layer for PAI) as candidate for Soma's memory implementation.
**Method:** 12-agent workflow — 5 parallel readers (recall design/src/hooks+23 ADRs, soma plans, soma live state) → 3 fit lenses → 3 adversarial judges → synthesis.
**Outcome:** unanimous `concepts_only`. Plan rewritten: [2026-07-02-memory-subsystem-implementation-plan-v2.md](2026-07-02-memory-subsystem-implementation-plan-v2.md).

## Judge panel

| Judge | all_in | engine_dependency | concepts_only | Recommends |
|---|---|---|---|---|
| pragmatist | 2.5 | 4 | 8.5 | concepts_only |
| architect | 1.5 | 4 | 9 | concepts_only |
| skeptic | 1.5 | 3 | 7 | concepts_only |

## Fit lens verdicts

### portability

Recall's engine architecture (library-not-daemon, CLI-shelling hooks, configurable inference/vault, no SDK imports) is a strong fit for Soma's adapter model, and its empirical evolution (ADR 0019) independently converged on Soma's read-first, summaries-as-cognition philosophy. But as-built it violates "keep memory filesystem-native": session_summaries, memories, edges, and proposals live only in SQLite with no file canon and no rebuild path, making the DB a second source of truth rather than an index. Adoptable if durable content is re-homed to markdown canon with SQLite demoted to a rebuildable index+telemetry layer, and the 7-hook tempo layer is extracted into a per-substrate adapter with graceful degradation (pull tools on Pi, static projection + cron worker on Codex).

### architecture-mapping

recall is a convergent, production-hardened implementation of the same read-path-first thesis soma's memory plan codifies — but on a conflicting substrate (SQLite+sqlite-vec vs filesystem-native markdown) and a conflicting write-governance model (autonomous confidence-gated capture vs five explicit triggers with recall-first refusal). Milestone coverage: M5 (episodic capture/SessionEnd digest) and M2 (layered retrieval) are essentially solved in recall; M6/M1 are partially solved with directly portable deterministic pieces (dedup, archive-before-prune, freshness math); M0/M3/M4 — the file-native note schema, budgeted earned-inclusion INDEX.md, and idempotent install-time projection — have no recall counterpart and must be built fresh. Recall's biggest gift is not code but its falsification record (ADRs 0013/0017/0019): every mechanism soma's plan deliberately excludes (LLM detectors, proposal gate, decay/KG on by default) is one recall shipped and then empirically walked back.

### maturity-risk

recall is battle-tested (23 ADRs, 2,185 tests, 5,807 prod sessions) but its retro record mostly falsifies the elaborate cognition layer — ADR 0019 flag-disabled ~80% of it (proposal gate, decay, KG, InsightDetector) after empirical failure, and what survived (capture + session summaries + BM25 injection) sits on a SQLite/sqlite-vec/ONNX substrate that directly violates soma's filesystem-native commitment and no-new-deps/deterministic ground rules. Concepts-only reimplementation (option c, days of effort, largely already in soma's M0-M7 plan) is the right risk point; all-in (a) or engine-as-dependency (b) inherit macOS-coupled libsqlite3 ops, LLM detector dependencies, and a single-maintainer repo whose MIT license is decided but not yet landed (no LICENSE file; public flip hard-gated on JC review per ADR 0023). recall's greatest value to soma is as a falsification corpus: it already ran the experiment soma's design doc warns against, and the drops (fact extraction 0017, proposal-gate theatre 0013, sub-agent pollution 0014) map one-for-one onto soma's already-chosen constraints.

## Key facts driving the verdict

- **No LICENSE on disk** — recall ADR 0023 (MIT flip) is decided but not landed; code reuse legally unfounded today. Idea-ports only, with attribution.
- **SQLite is recall's canon, not an index** — session_summaries/memories/edges/proposals live only in `~/.recall/recall.db`, no file representation, no rebuild-from-files path. Direct conflict with Soma's 'keep memory filesystem-native' commitment.
- **ADR 0019 ('strategic simplification 1.5') flag-disabled ~80% of recall's cognition layer** after empirical failure: proposal gate ('theatre', flat 0.95 confidence), decay/consolidation ('fired hundreds of times producing nothing'), knowledge graph, InsightDetector. What survived: capture + session summaries + BM25-budgeted injection.
- **The surviving 20% is small + portable**: freshness curve (freshness-score.ts, 102 lines), Jaccard dedup (~131 lines), inject token-budget mechanics, sub-agent suppression (ADR 0014).
- **Tempo layer is Claude-Code-shaped**: ~1,949 access-events/day via 7 hot-path hooks; no Pi/Codex equivalent → per-substrate behavioral divergence, violating the adapter principle.
- **Battle-tested where it counts**: 2,185 tests, 5,807 prod sessions, 23 ADRs — the falsification record maps 1:1 onto constraints Soma's design doc had already chosen (no LLM detectors, no autonomous capture, explicit write triggers).

## What Soma takes (the four transplants)

All source references below are pinned to recall commit `c57a196` (2026-07-03), the revision analyzed; line numbers are as of that commit.

1. **Freshness/recency curve** → M3 retention recency term (replaces v1's linear recency).
2. **Jaccard dedup (0.6 threshold)** → M1 write-path refusal.
3. **Injection budget mechanics** → M3 index renderer (INDEX ≤200-line/≤25KB budget, shed lowest-scored). M4 owns projection idempotency + the kill-switch, not the budget.
4. **Sub-agent suppression** → M5 digest capture (sub-agent sessions write nothing).

Plus two amendments: file-native JSONL access-event drain as a named v2 escape hatch (not v1); PreCompact accumulator as Claude-Code adapter enhancement (not kernel).

## Full agent outputs

Workflow run `wf_63240eac-542`. Per-agent results are a **local session artifact**, not committed: `~/.claude/projects/<session>/subagents/workflows/wf_63240eac-542/journal.jsonl` (one result line per agent). The judge scores and fit-lens verdicts that drove the verdict are reproduced verbatim in this doc's tables above; the raw transcript is not attachable to the repo, so those tables are the auditable record here.
