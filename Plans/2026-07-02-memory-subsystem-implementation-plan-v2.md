# Soma Memory Subsystem — Implementation Plan v2 (recall-informed)

**Date:** 2026-07-02
**Status:** Active. **Supersedes** [`Plans/2026-07-02-memory-subsystem-implementation-plan.md`](2026-07-02-memory-subsystem-implementation-plan.md) (v1).
**Rationale:** [`Plans/2026-07-02-recall-adoption-analysis.md`](2026-07-02-recall-adoption-analysis.md) — three-lens fit analysis + three-judge panel on adopting `~/work/mf/recall` (Andreas Aastroem's between-session cognition layer).
**Precedence rule (unchanged from v1):** where this plan and the design doc ([`Plans/2026-07-01-memory-skill-design.md`](2026-07-01-memory-skill-design.md)) disagree on mechanics, this plan wins.

---

## 1. Verdict on recall

**Adoption strategy: `concepts_only` — unanimous** (pragmatist 8.5, architect 9, skeptic 7; all three recommended it; `all_in` scored 1.5–2.5, `engine_dependency` 3–4). Soma keeps its own M0–M7 skeleton and owned code, and takes from recall exactly four surgical transplants (ideas and formulas, not verbatim files), two named plan amendments, and its falsification corpus as design evidence.

**Decisive reasons:**

1. **No LICENSE exists.** As analyzed at recall commit `c57a196` (2026-07-03), `~/work/mf/recall` has no LICENSE file; recall's ADR 0023 public/MIT flip is still operator-gated. Any code dependency or vendoring is legally unfounded at that revision — porting *ideas* is the only clean move, which is what this plan does. (Pinned to a commit so the claim is auditable and re-checkable if upstream adds a license later.)
2. **Recall's canon is SQLite, soma's commitment is files.** `session_summaries`, `memories`, `edges`, `proposals` exist only in `~/.recall/recall.db` with no file representation and no rebuild-from-files path. Adopting it breaks soma's stated commitment "Keep memory filesystem-native" (`src/soma-home.ts:63`, projected into `~/.claude/rules/soma/PURPOSE.md`).
3. **~80% of recall's cognition surface is falsified by its own author.** ADR 0019 flag-disabled the proposal gate ("theatre", flat 0.95 confidence), decay/consolidation ("fired hundreds of times producing nothing"), the knowledge graph, and the InsightDetector. Wholesale adoption imports the corpse alongside the working 20%.
4. **The proven 20% is small and portable.** Freshness math (`freshness-score.ts`, 102 lines), dedup (`dedup.ts`/`proposals.ts`, ~131 lines), inject budget mechanics, and sub-agent suppression are deterministic, dependency-free ideas that fold into soma's existing milestones in days — most of recall's surviving philosophy (summaries-as-primary-unit, read-path-first, budget-bounded injection) soma had already converged on independently.
5. **Recall's tempo layer is Claude-Code-shaped.** Its retention signal is ~1,949 access-events/day from hot-path hooks (UserPromptSubmit/PostToolUse/PreCompact/SubagentStop) with no Pi or Codex equivalent — a memory kernel that behaves differently per substrate violates "substrate adapters translate; they do not own core concepts."

**Fatal flaws avoided by this choice:** SQLite-as-canon (loses memory with the DB, nothing migrates as files); the 7-hook Claude-Code tempo coupling that starves on hookless substrates; dual-write governance poison (recall's autonomous capture pipeline vs soma's 5-explicit-trigger invariant); the missing-LICENSE dependency on a single-maintainer private repo; ops inheritance (Homebrew libsqlite3 dylib, 86MB ONNX, LLM detectors) against soma's no-new-deps/deterministic ground rules; and the silent-failure dependency class (three documented "shipped but silently broken in prod" incidents, each caught only by manual live-DB audit).

**On SQLite explicitly:** the architect's judgment is that a *rebuildable derived index* over markdown canon would be constitutional — but recall as-built is not that, and soma v1 does not need it. **This plan introduces no SQLite at all.** A BM25-style derived index (rebuildable from files, loss = telemetry only) is a named memory-v2 trigger: revisit only after the corpus exceeds ~5K files AND recall's LICENSE has landed (§6).

---

## 2. Fixed contracts (carried from v1 — judges did not overturn the storage/schema/index contracts)

Note: the *storage, note-schema, and INDEX* contracts below are unchanged from v1. The write-path **trust** governance is the one refinement (see M1): v1's self-assertable `--trust` flag is superseded — trust is derived from the write trigger. The section header scopes to the data contracts, not the trust CLI.

- **Note schema** (v1 §2.2): 12 frontmatter keys — `id, type, created, last_verified, valid_until, provenance, trust, source_of_truth, project, links, resurface_count`, optional `hook:`/`review:`. Hand-written parser, tiny grammar, reject unknown keys, round-trip law `parse(serialize(n)) == n`.
- **Filesystem-native source of truth**: markdown under `~/.soma/memory/` — `INDEX.md`, `semantic/<id>.md`, `episodic/{sessions,actions}/YYYY-MM/`, `episodic/digests/YYYY-MM.md`, `procedural/<id>.md`, `archive/`, `state/` — git-versioned, no database.
- **INDEX contract** (v1 §2.3): generated, ≤200 lines AND ≤25KB; line grammar `- [<id>] <hook ≤120ch> (<type>, verified <N>d ago)`; inclusion is *earned* (L3 ladder), never given.
- **Retention score** (v1 §2.4): `trustWeight × typeWeight × recency × (1 + log2(1 + resurface_count))`; `valid_until ≠ null → 0`; deterministic tiebreaks. **Amended** in M3 to adopt recall's freshness curve for the recency term (§3, M3).
- **Event kinds** (v1 §2.5): 9 kinds appended via `appendSomaMemoryEvent` to `state/events.jsonl` (the lowercase `state/` path from the storage layout above, one canonical spelling — not the legacy uppercase `STATE/` tree); one event per mutating CLI call.
- **Ground rules**: TypeScript/Bun, zero new runtime deps, deterministic only (no LLM calls M0–M7), injected `now?: Date`, never write outside `~/.soma/memory/`, never delete memory files (except state GC), 19 legacy dirs untouched.
- **Write policy**: exactly 5 triggers, recall-first refusal, merge/supersede/create, invalidate-never-delete.

---

## 3. Milestones

Ordering unchanged: M0→M1→M2→M3→M4; M5 needs M0–M1; M6 needs M0–M3+M5; M7 needs all; M4 ∥ M5. One PR per milestone, each independently mergeable with binary probes.

### M0 — Note schema, parser, serializer
- **Delivers:** `src/memory-note.ts` (~250 LOC): parse/serialize/validate per §2 contract, round-trip tested.
- **Reuses from recall:** nothing — recall has no file-native note layer (its M0-equivalent is SQLite migrations, a different artifact class).
- **Soma builds:** everything. TDD; property test for round-trip law.
- **Acceptance:** `parse(serialize(n)) == n` on generated corpus; unknown key → typed error; `bun test` green.

### M1 — Write + verify CLI with recall-first refusal
- **Delivers:** `src/memory-write.ts` (~350 LOC): `soma memory write|verify`; create-mode refuses when candidates exist; merge appends `**Update (date):**`; supersede sets `valid_until` + links; verify bumps `last_verified` + `resurface_count`.
- **Reuses from recall (transplant #1 — highest value):** the **dedup engine idea** from `recall/src/lib/proposals.ts` + `dedup.ts` — sha256 exact-hash + Jaccard ≥ 0.6 near-match — reimplemented over a file corpus (walk `semantic/` + `procedural/`, hash normalized bodies, Jaccard on token sets) to power the refusal gate: error lists candidate ids + "re-run with `--merge`/`--supersede`/`--force`". Idea-port, not code copy (license).
- **Soma builds:** trust tiers, merge/supersede semantics, refusal UX — recall has none of these. **Trust is NOT a free caller flag** (superseding v1's `--trust <t>`, which let a caller self-assert `principal` and bypass the poisoning defense): trust is derived from the write *trigger* — principal-authored writes require an explicit human-approval path, tool/import/agent-derived writes default to `quarantined`. `--trust principal` from an agent is refused.
- **Acceptance:** create against a ≥0.6-similar existing note refuses with candidate ids; `--force` overrides; one event per mutation; verify-bump visible in frontmatter.

### M2 — Recall command with verification banners
- **Delivers:** `src/memory-recall.ts` (~250 LOC): `soma memory recall <query>` — term scoring, whole-file retrieval (limit 3), 1-hop links, superseded excluded, banner `⚠ Nd old · trust · provenance · verify against <source_of_truth>`, QUARANTINED warning.
- **Reuses from recall:** the **3-layer progressive disclosure shape** (`search-l1.ts` → `expand.ts` → `transcript.ts`) as design validation for soma's Tier-1-pointers → Tier-2-whole-file split. No code: recall's L1 is FTS5/BM25 over SQLite.
- **Soma builds:** read-time verification banner and superseded-exclusion via `valid_until` — recall has neither concept.
- **Acceptance:** superseded notes never returned; quarantined notes carry the warning; banner ages derive from injected `now`.

### M3 — Index renderer (earned inclusion)
- **Delivers:** `src/memory-index.ts` (~200 LOC): `retentionScore`, `collectAllNotes`, `renderMemoryIndex`, `rebuildMemoryIndex`.
- **Reuses from recall (transplants #2 and #3):**
  - **Freshness formula** from `recall/src/lib/freshness-score.ts:87-102`: `count × 0.5^(daysSince/halflifeDays)` with future-timestamp clamp — adopted as the recency term of `retentionScore`, operating on frontmatter `last_verified`/`resurface_count` instead of `access_events` rows. Battle-tested, deterministic, dependency-free; soma's trust/type weights stay on top. This *amends* v1's linear `max(0.1, 1−days/365)` recency term.
  - **Budget/truncation mechanics** from `recall/src/lib/inject.ts` (chars/4 token estimate, per-section shares, shed-longest-tail, min-1-item-per-section) for enforcing the ≤200-line/≤25KB INDEX budget gracefully instead of hard-cutting.
- **Soma builds:** the earned-inclusion admission ladder (resurfaced-verified ≥2×, principal-marked, or <7d grace) — recall's hot-zone ranks by behavioral heat, soma's INDEX admits by governed promotion; the semantics are deliberately different.
- **Acceptance:** quarantined score 0 and never in INDEX; budget enforcement sheds lowest-score lines first with deterministic output; golden-file test for `INDEX.md` given a fixture tree and fixed `now`.

### M4 — Claude Code projection
- **Delivers:** projection of `INDEX.md` → `~/.claude/rules/soma/MEMORY.md` wired into `src/adapters/claude-code.ts` (array AND map; `ProjectionInput` gains `memory.indexContent` — a sibling surface, NOT under `profile`, keeping Memory a peer compartment to Identity rather than a sub-field of the profile; ~120 LOC). `MEMORY_LAYOUT.md` untouched.
- **Reuses from recall (transplant #4a):** the **soft-fail exit-0 contract + kill-switch hierarchy pattern** (recall's `RECALL_DISABLE`/`RECALL_DISABLE_INJECT` tiers) → `SOMA_MEMORY_DISABLE=1` (all memory behavior) and `SOMA_MEMORY_DISABLE_PROJECT=1` (projection only). Pattern copy, zero code.
- **Soma builds:** idempotency — projected content is verbatim stored content, **no wall clock in projected output** (hard invariant AC-4; "verified Nd ago" is computed at index *rebuild* time, not projection time).
- **Acceptance:** two consecutive `soma install claude-code` runs with unchanged source write identical bytes; uninstall removes cleanly.

### M5 — Episodic digest + action log + single SessionEnd hook
- **Delivers:** `src/memory-episodic.ts` (~250 LOC): `soma memory digest|action`, ids `YYYYMMDD-<slug>`, exactly one 8–15-line digest per session; one SessionEnd hook for Claude Code, skip-silently on failure.
- **Reuses from recall (transplant #4b — recall's single biggest capture-quality fix):** **ADR 0014 sub-agent suppression.** Pre-fix, 52.9% of recall's facts were sub-agent noise and Stop events double-fire. Soma's hook adopts the doc-grounded markers: skip when `hook_event_name === 'SubagentStop'` or `agent_type`/`agent_id` is non-empty; overrides `SOMA_MEMORY_FORCE_PRIMARY`/`FORCE_SUBAGENT`. Without this the one-digest invariant breaks on day one in any sub-agent workflow. This was **missing from v1**.
- **Named accepted gap (recall ADR 0018):** SessionEnd fires only 1–4×/day against long-lived sessions, so the exactly-one-digest invariant **will under-capture multi-day sessions**. v2 accepts this explicitly rather than discovering it; the fix (a PreCompact-equivalent accumulation point) is a named `TODO(memory-v2)` trigger, not silent scope creep.
- **Soma builds:** the first-class action log (intent→approval→outcome) — no recall equivalent exists.
- **Acceptance:** digest CLI called twice for one session id → second call no-ops with event; sub-agent-marked invocation writes nothing; hook failure never blocks the session (exit 0 always).

### M6 — Deterministic consolidation
- **Delivers:** `src/memory-consolidate.ts` (~300 LOC) with `--dry-run`: prune episodic 90d/actions 180d → monthly digest → `archive/` (preserving relative path); mark `review: stale` (semantic `last_verified > 180d` AND `resurface_count == 0`, never auto-archive); mechanical contradiction listing (no auto-merge); state GC (`current-work-*.json > 7d` — the one true deletion); INDEX rebuild; reviewable git diff.
- **Reuses from recall:** **archive-before-prune + rescue-band** as convergent validation of invalidate-never-delete (recall shipped and hardened it — ADR 0016's 360-row id-collision documents the failure mode; soma's archive preserves paths, avoiding shared-id contracts entirely). And **ADR 0019 as the scope guard**: recall's LLM-driven consolidate "fired hundreds of times producing nothing" — this is the empirical proof that v1's deterministic-only consolidation was right. No LLM step enters M6.
- **Soma builds:** everything; contradiction listing reuses M1's Jaccard machinery.
- **Acceptance:** `--dry-run` output equals subsequent real-run diff; no file deleted except state GC; run is idempotent (second run = no-op diff).

### M7 — Memory skill + audit
- **Delivers:** `src/skills/Memory/` mirroring VSA layout (`SKILL.md` + `Workflows/{Remember,Recall,Consolidate,Audit}.md`, pack-id `soma-memory-v0.1.0`, plain-portable route like the-algorithm), plus `src/memory-audit.ts` (~150 LOC).
- **Reuses from recall (ops hardening, pattern only):** **ADR 0020's lesson** — recall 1.8 was a silent prod no-op for 13 days because a startup guard was missing. `memory-audit.ts` therefore probes **filesystem ground truth with deterministic counts only**: notes per type, INDEX freshness (mtime vs newest note), digest coverage (sessions with vs without digests), orphaned archive entries, event-line/mutation ratio. Recall's three silent-failure incidents were each caught only by manual live-DB audit — soma's audit automates the equivalent. Matches the no-self-graded-memory invariant (never LLM sentiment).
- **Acceptance:** audit exits non-zero on stale INDEX or schema-invalid note; all §15 design invariants traceable to a probe.

### Substrate-adapter story (degradation ladder)

Per-substrate, recorded as adapter limitations per soma operating rules:

| Substrate | Tier 0 (INDEX) | Tier 2 (recall) | Capture (digest) |
|---|---|---|---|
| **Claude Code** | projected `~/.claude/rules/soma/MEMORY.md` (M4) | `soma memory recall` via Bash | SessionEnd hook (M5), sub-agent-suppressed |
| **Pi** (`src/adapters/pi-dev/adapter.ts`) | extend `soma_context` with `action=memory_index` | existing `action=memory_search` pattern (`adapter.ts:181-186`) gains `memory_recall`; pull, not push | no hooks: prompt-rule instructs agent to call `soma memory digest` at wrap-up; reduced mode, recorded |
| **Codex** | static projection file regenerated at consolidation (M6) | CLI directly | none automatic; manual/cron `soma memory digest`; recorded limitation |

The kernel (M0–M3, M6) is identical on all three — only injection and capture tempo degrade. This is the inverse of recall's design, where the retention signal itself was hook-dependent.

---

## 4. What we deliberately do NOT take from recall

1. **SQLite storage, sqlite-vec, FTS5, Homebrew libsqlite3** — canon must be files (stated commitment); the dylib is macOS-coupled; v1 ground rule "no new runtime deps" stands. Not even as a derived index in v1 (gated, §6).
2. **The proposal/confidence gate** — recall's own ADR 0013 proved it was theatre (flat 0.95 confidence gated nothing). Soma's firewall is the 5-trigger write policy + `trust: quarantined`, human-gated by construction.
3. **Decay/consolidation daemon, knowledge graph, InsightDetector, multi-type ontology** — the exact machinery recall's ADR 0019 flag-disabled after it produced nothing. We adopt the *deferred-not-deleted-with-named-re-enable-triggers* discipline, not the features.
4. **Atomic fact extraction** — ADR 0017: "atomic facts shorn of context" = noise; summaries are the primary cognition unit. Soma's digest-first design is the same conclusion.
5. **The 7-hook tempo layer and passive access capture** — hot-path 30ms hooks, PreCompact, hot-zone/preconscious surfacing all assume Claude Code owns tempo and starve elsewhere (ADR 0021's worker-starvation incident shows the failure mode). Soma ships exactly one SessionEnd hook.
6. **LLM detectors / inference transport** — recall's summary pipeline is LLM-produced via `inference-transport.ts` (default hardcodes `~/.claude/PAI/Tools/Inference.ts`); soma M0–M7 are deterministic and the digest is principal/agent-authored text.
7. **ONNX/OpenAI embeddings and semantic search** — additive-never-load-bearing in recall, out of scope in soma until >5K files (design §6).
8. **Verbatim code of any kind** — no LICENSE file exists; until MIT lands, only idea-ports with attribution comments (`// adapted from recall freshness-score concept, see Plans/2026-07-02-recall-adoption-analysis.md`).

---

## 5. Named memory-v2 escape hatches (recall's re-enable-trigger discipline)

- **Passive verify-bump channel** — trigger: after ~90 days, audit shows corpus-wide `resurface_count` stuck at 0 (the earned-index ladder starving; recall's data says the loop only closes reliably with passive signal). Remedy: adapt recall's **file-native Obsidian-JSONL-drain pattern** (append access events to a JSONL file, drain at next session start) — zero hot-path hooks, zero DB, fits filesystem commitments.
- **Mid-session accumulation point** — trigger: audit shows long-lived sessions systematically missing digests (ADR 0018 class). Remedy: PreCompact-equivalent accumulator on Claude Code only, recorded as adapter enhancement.
- **Derived search index** — trigger: corpus >5K files AND recall LICENSE landed. Remedy: BM25 layer strictly as a **rebuildable index** over markdown canon (`soma memory reindex` rebuilds from files; index loss = telemetry loss only). Only then is SQLite acceptable, and only in that role.

---

## 6. Risks

- **Upstream single-maintainer (accepted, mitigated by strategy choice):** recall is one author, 50 commits, tuned to his Obsidian vault and long-lived sessions, already executed one architectural whiplash (1.5). `concepts_only` means soma inherits *zero* version-skew from future pivots — ideas already ported cannot be un-shipped. Residual: the §5 escape hatches reference recall patterns; if the repo vanishes, the analysis doc preserves what we need.
- **Inference/embedding deps (avoided):** no LLM, ONNX, or libsqlite3 enters soma. Residual risk is temptation drift — M6/M7 reviews must reject any nondeterministic step (the `TODO(memory-v2)` markers are the sanctioned pressure valve).
- **Doc drift:** recall's README still says "Design phase. No code yet." over 37K lines — proof that docs rot fast in solo projects. Countermeasure: `memory-audit.ts` probes ground truth, not docs; this plan supersedes v1 explicitly at the top; `CONTEXT.md`/ADR updates land in the same PR as the milestone they describe (per soma convention).
- **Divergence:** ported formulas (freshness, Jaccard threshold 0.6) will drift from upstream tuning. Accepted: soma owns its constants after port; record each port with source-commit reference in the analysis doc so future reconciliation is possible but never required.
- **Verify-loop starvation (skeptic's strongest concepts_only flaw):** with one hook and explicit verify only, `resurface_count` may sit at 0 and L3 ships dead. Mitigation: M3 grace window (<7d) and principal-marked entries keep the INDEX alive meanwhile; the 90-day audit trigger (§5) is the tripwire, checked by M7's deterministic counts.
- **Solo-capacity delivery risk:** soma's own death map shows this ecosystem abandons memory systems half-built (13/19 dirs README-only), and C0 capacity is the principal's central blocker. Mitigation unchanged from v1 and endorsed by all judges: independently-mergeable milestones with binary probes — every merged milestone is standalone value even if the sequence stalls.

---

## 7. Acceptance (unchanged from v1, plus v2 deltas)

1. Scripted integration test `test/memory-subsystem.test.ts`: write→recall→verify→index→install-projection→digest+action→age→consolidate→audit.
2. `bun test` + `tsc` + `eslint` clean.
3. Exactly one `events.jsonl` line per mutating CLI call.
4. Design §15 invariants traceable: recall-first refusal (M1), verify-bumps (M1), index-earned-not-given (M3), digest-per-session **with sub-agent suppression** (M5), deterministic health metrics (M7).
5. **v2 additions:** dedup refusal fires on a Jaccard-0.6 fixture pair (M1); retention recency term matches the half-life curve within float tolerance (M3); sub-agent-marked hook invocation writes zero files (M5); audit detects a deliberately staled INDEX fixture (M7).