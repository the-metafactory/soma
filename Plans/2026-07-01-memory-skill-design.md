# Soma Memory Skill — Design

**Date:** 2026-07-01
**Status:** Design proposal (greenfield; migration explicitly deferred)
**Inputs:** Audit of all 10 memory systems in the current PAI installation · Tana note `hS1HEbSQiZZU` ("Building own AI memory", YouTube HgAQOkG_v8c) · External research sweep (Sift corpus + web, 2025/26 literature)
**Related:** `docs/memory-policy-v0.md`, `docs/writeback-and-policy.md`, DD-2, VSA skill (structural precedent)

---

## 1. The core finding

The current installation runs ten memory systems. Audit result:

**Every system designed write-first is dead or dying. Both systems that work were designed read-first.**

Evidence:

- Writers vs readers: 11 hooks write memory; 4 read it back, and of those, `LoadContext` is broken (reads `~/.claude/PAI/MEMORY/STATE|SIGNALS|WISDOM` — none exist; live data lands in `~/.claude/MEMORY/`), leaving only ACR and Claude Code native auto-memory functioning.
- Volume without recall: 2,849 learning `.md` files, 5,570 rating lines, 6,363 soma `current-work-*.json`, a 3.3 MB `work.json` — none of it resurfaces. `learning-readback.ts:6` admits it: *"writes extensively (8,400+ files across 5 hooks) but previously had no readback mechanism."*
- Silent failure: every reader `existsSync`-guards and returns null, so the session-start "learning context" has been injecting nothing, and nobody noticed — proof that the injection was not load-bearing.
- Three generations of partial migration coexist (`~/.claude/MEMORY` → `~/.claude/PAI/MEMORY` → `~/.soma/memory`), each holding a fragment. 13 of soma's 19 memory categories contain only their README.
- The two working systems: **Claude Code auto-memory** (tiny always-loaded `MEMORY.md` index, one-fact-per-file bodies, staleness banner, consolidation, size cap) and **ACR** (prompt-time semantic surfacing of prior session pointers). Both start from the read side.

**Design law that follows:** *A memory may only be written if it names the future moment it will resurface. No resurfacing trigger → no write.* The unit of design is the resurfacing moment, not the store.

Systems-thinking framing: the old landscape is the "Fixes That Fail" archetype — each fix for "agent forgets" added a write path, grew the landfill, made recall harder, triggered the next migration. This design closes the loop instead: **usage is the retention signal** (resurfaced-and-useful memories get re-verified; unused memories age out).

## 2. What research and the video contribute

External findings (confidence-tagged, full citations in §10):

1. **Write is the hard part, not retrieval.** Microsoft Memora beat RAG/Mem0/Zep/LangMem on LoCoMo (86.3%) while storing *half* as many entries — merged under stable abstractions instead of fragmenting. [HIGH]
2. **Tiny index + just-in-time bodies.** Anthropic's own pattern (memory tool, auto-memory, "smallest set of high-signal tokens"): a pointer layer that is always loaded, bodies fetched by tool call. Context rot makes the marketed window unusable as memory residence — even 1M-token models degrade sharply past ~150-400K. [HIGH]
3. **Consolidation is background compute.** Letta sleep-time agents, Claude autoDream (orient → gather → consolidate → prune, ≤200 lines / 25KB), Generative Agents reflection: never do memory maintenance on the request path. [HIGH]
4. **Memory is a hint; verify at read.** GitHub Copilot memories carry citations and are verified against the code before being applied; Claude Code treats memory "as a hint, not a fact." Read-time verification replaces expensive write-time curation. [HIGH]
5. **Invalidate, don't delete.** Zep/Graphiti bi-temporal model: contradiction closes the old fact's validity window; history stays queryable. [HIGH]
6. **Delta updates, never full rewrites.** ACE: iterative full regeneration causes context collapse and brevity bias; itemized delta edits preserve detail. [HIGH]
7. **Procedural memory is the growth engine.** ACE-style playbooks and skill files updated after successes/failures deliver the measured capability gains; episodic recall is mostly UX. [HIGH]
8. **Memory is an attack surface.** MINJA: >95% injection success into agent long-term memory; OWASP agentic ASI06. Provenance + human-reviewable stores (files!) are the defense. [HIGH]
9. Taxonomy consensus: **episodic / semantic / procedural** (+ working state). Typed lifecycles — each type rots, updates, and resurfaces differently. [HIGH]

From the video ("own the memory, rent the intelligence"):

- Memory is the **portable, substrate-independent layer** — exactly Soma's thesis; the prize is "owning the context every future agent will need, so when an agent comes, you can just plug it right in."
- Memory has shifted from "remember me" to **action platform**: store the *context that would change an answer*, plus what the agent may do with it.
- **Action memory** is a distinct type: a visible, queryable record of what the agent did and why (the ticket/approval primitive) — "an agent that can prove that it did what it did on purpose." Not hidden in chat logs or chain-of-thought.
- **Break-in loop**: memory quality comes from repeated correction on recurring situations, not bulk ingestion. Human stays the write-approval authority.
- The video supplies principles but zero mechanics (no schema, scoring, forgetting) — those come from §3–§7 below.

## 3. Design principles

P1. **Read-path-first.** Every memory type declares its resurfacing trigger before its write path exists. (Corollary: anything currently written that nothing reads — ratings landfill, per-turn work JSONs — is telemetry, not memory, and moves out of the memory tree.)
P2. **Files are the substrate; search is an access method.** Markdown + frontmatter, git-versioned, human-auditable, substrate-portable. Grep/BM25/embeddings may index it; nothing lives *only* in an index.
P3. **Curated writes, few and merged.** Default disposition SKIP. Before create: search; then merge (delta), supersede (close validity), or create. One fact per file.
P4. **Tiny always-loaded index; bodies just-in-time.** Hard budget. Pointers carry enough hook to let a Fable-class model decide to read the body.
P5. **Consolidation off the request path.** A background "sleep" pass owns dedupe, promotion, pruning, index rebuild.
P6. **Memory is a hint — verify at read.** Age + provenance rendered at every read; memories cite their source of truth so the agent can check before acting.
P7. **Invalidate, never silently delete.** Bi-temporal frontmatter; superseded memories become tombstones; "what did I believe in March" stays answerable.
P8. **Provenance on every write; untrusted content quarantined.** Web/scraped/tool content never writes memory directly (poisoning defense). Trust tiers align with `docs/writeback-and-policy.md`.
P9. **Deterministic code first, prompts wrap code.** The `soma memory` CLI does the mechanics; the skill teaches the model when and how to call it. Hooks are substrate enhancements, never requirements.

## 4. Taxonomy — four types, not nineteen

The 19-category tree is an assumption disproven by its own emptiness (13/19 never written). Four types, each defined by its *lifecycle*:

| Type | Contains | Written by | Resurfaces via | Decays by |
|---|---|---|---|---|
| **semantic/** | Facts that are currently true: identity, people, preferences, project truths, decisions | Explicit "remember", corrections, consolidation promotions | Index (always) + recall search (task-time) | Superseded → validity window closed |
| **episodic/** | What happened: session digests, **action log** (what the agent did, with approval state) | Session-end digest (auto, one per session); action entries at consequential-action time | Recall search; consolidation reads it to mine patterns | Digested monthly, then archived; raw entries prune at ~90d |
| **procedural/** | How to do things: playbooks, break-in corrections ("never em-dashes"), learned strategies per recurring situation | Feedback moments; consolidation promoting repeated episodic patterns | Matched by task context at prompt/task time — highest-value injection | Delta-edited in place (never rewritten); dropped only when contradicted repeatedly |
| **state/** | Working memory: active work pointers, open loops | Harness/CLI during work | Session start (small, current only) | GC'd aggressively; never archived |

Notes:
- **Action log is first-class episodic memory** (the video's ticket primitive): `episodic/actions/` entries record intent → approval state → outcome for consequential actions. This is what lets the agent "prove it acted on purpose" and gives consolidation honest success/failure data for procedural promotion.
- Knowledge-base material (Tana graph, Knowledge archive, research notes) is **reference, not agent memory** — different lifecycle (curated by human, unbounded, browsed not injected). The memory skill may *cite into* it; it does not own it.

## 5. Storage layout

```
~/.soma/memory/
  INDEX.md                     # THE resurfacing artifact. ≤200 lines / ≤25KB, always projected.
  semantic/
    <slug>.md                  # one fact per file
  episodic/
    sessions/2026-07/<date>-<slug>.md
    actions/2026-07/<date>-<slug>.md
    digests/2026-06.md         # monthly consolidation output
  procedural/
    <situation-slug>.md        # playbook per recurring situation
  state/
    active.json                # open work pointers (exists today)
    events.jsonl               # append-only journal (exists today — keep as write journal)
  archive/                     # tombstones: superseded memories, pruned episodics
```

Memory file format (frontmatter is the schema):

```markdown
---
id: prefers-colon-over-emdash
type: procedural            # semantic | episodic | procedural
created: 2026-04-12
last_verified: 2026-06-28   # bumped when resurfaced-and-confirmed
valid_until: null           # set instead of deleting; bi-temporal close
provenance: conversation    # conversation | consolidation | import | tool:<name>
trust: principal            # principal | agent | quarantined
source_of_truth: null       # optional pointer to verify against (file, URL, calendar)
links: [ai-writing-tells, andreas-style-feedback]
---
One assertion, written for a future model that has no other context.
**Why:** the reason it matters (procedural/feedback entries).
**Applies when:** trigger conditions (procedural entries).
```

INDEX.md entry format — one line, ≤150 chars, pointer + hook:

```markdown
- [prefers-colon-over-emdash] Andreas reads em-dashes as AI tell; use colon/comma (procedural, verified 3d ago)
```

## 6. Resurfacing — the design center

Four tiers, ordered by cost:

**Tier 0 — Always loaded (projection).** `INDEX.md` is projected into every substrate (Claude Code: `~/.claude/rules/soma/MEMORY.md`, replacing today's static `MEMORY_LAYOUT.md` pointers). Hard budget ≤200 lines / 25KB (~5-6K tokens worst case; target ≤2K). This is the only permanently resident memory context. Fable-class models follow pointers reliably — the index entry's job is to make the model *want* to read the right body file, not to contain the content.

**Tier 1 — Prompt-time surfacing (hook, optional enhancement).** A UserPromptSubmit hook does deterministic entity/keyword match of the prompt against index lines and injects at most 3 *pointers* (never bodies): `Possibly relevant memory: semantic/andreas-mellanon.md — read before answering about Andreas.` Cheap, non-blocking, degradable — a substrate without hooks simply loses this tier, nothing breaks (Soma policy: hooks are enhancements). This is ACR's good idea, minus the broken paths and with pointers instead of excerpts.

**Tier 2 — Task-time recall (skill discipline).** The skill instructs: before non-trivial work, run `soma memory recall "<topic>"` (term-scored search over the tree — exists today as `soma memory search`; extend with type filters and link-following one hop). The model reads whole files it selects. No chunking, no vector infra required: retrieval-by-attention over 1-3 loaded files beats top-k fragments at this corpus size (personal memory is thousands of files, not millions).

**Tier 3 — Read-time verification banner.** `soma memory recall`/`read` renders each memory with a generated header: `⚠ 84 days old, provenance: conversation, source_of_truth: paroli/CONTEXT.md — verify before relying.` Stolen from Claude Code auto-memory (the only current system with decay signaling) and generalized. If the memory names a `source_of_truth`, the skill directs a check against it before consequential use (Copilot citation pattern).

**Usage closes the loop:** when a resurfaced memory proves correct, the agent bumps `last_verified` (one CLI call). Consolidation uses `last_verified` vs `created` as the retention/decay signal. Unused, unverified memories age toward the archive; used ones persist. This is the reinforcing loop the old systems never had.

## 7. Write policy

Triggers (exhaustive — anything else is SKIP):
1. **Principal says remember** / corrects the agent ("no, always X") → procedural or semantic, trust `principal`.
2. **Session end** → exactly one episodic digest (8-15 lines: what happened, what changed, open loops). Replaces today's 6,363-file `current-work-*.json` spray.
3. **Consequential action** (sent, deployed, deleted, paid, published) → one action-log entry at approval time.
4. **Consolidation** promotes/merges (see §8), trust `agent`.
5. **Import** (migration, external docs) → trust `quarantined` until human-reviewed. Web/tool content NEVER writes directly (MINJA defense).

Write procedure (skill-enforced, CLI-assisted):
- `soma memory recall` for the topic first. Then: **merge** (delta-edit existing file, ACE-style — never regenerate), **supersede** (set old file's `valid_until`, create new), or **create**.
- Every write through `soma memory write` (extends existing `promote` machinery): validates frontmatter, journals to `events.jsonl`, git-commits. Human can `git log` the whole memory history — the audit story.
- Deferred-by-design: no automatic per-turn writes, no rating capture into the memory tree, no reflection essays. Telemetry ≠ memory.

## 8. Consolidation — `soma memory consolidate` ("sleep")

Background run (idle-time, cron, or manual), never on the request path. A Fable/Opus-class model *is* the consolidation engine — this is where its judgment is spent, off-interactive:

1. **Dedupe/merge** semantic near-duplicates under one abstraction (Memora's lesson: fewer, merged entries outperform).
2. **Promote**: recurring episodic patterns (≥3 similar corrections/outcomes in the action log) → draft procedural playbook entry, flagged for principal review (break-in loop, human as write authority).
3. **Contradiction sweep**: newer fact vs older → close validity window, link supersession.
4. **Prune**: episodic raw >90d → monthly digest → archive. Enforce INDEX budget by dropping lowest-value lines (stale `last_verified`, never resurfaced).
5. **Rebuild INDEX.md** from frontmatter (deterministic code renders; model picks the hook phrases).
6. Emit a **reviewable diff** (git branch or plain diff) — the principal approves memory evolution the way they approve PRs. All operations delta-based; full-file regeneration forbidden (context collapse).

## 9. Skill surface + harness integration

Mirror the VSA skill (proven Soma pattern: `SKILL.md` frontmatter + `Workflows/` + `references/`, progressive Fast Path):

```
src/skills/Memory/
  SKILL.md            # contract: the four types, write triggers, recall discipline, budgets
  Workflows/
    Remember.md       # classify → recall-first → merge/supersede/create via CLI
    Recall.md         # tiered retrieval discipline + verification banner handling
    Consolidate.md    # the sleep pass (drives soma memory consolidate + review diff)
    Audit.md          # health check: index budget, orphans, quarantine queue, dead links
  references/
    format.md         # frontmatter schema, index line format
    gotchas.md        # incl. poisoning rules, "telemetry is not memory"
```

CLI additions to `src/cli/memory.ts` (deterministic layer): `soma memory recall` (typed, link-following), `write` (validated create/merge/supersede), `verify <id>` (bump last_verified), `consolidate`, `index` (rebuild). All journal to `events.jsonl` — the existing event contract is kept.

Claude Code projection: INDEX.md → `rules/soma/MEMORY.md` (always loaded); skill symlink-projected like every Soma skill; optional Tier-1 recall hook into `hooks/soma/`; session-end digest hook wired into the existing `soma-claude-code-hook.mjs` lifecycle. **Portability:** a substrate with only file-read + shell gets tiers 0/2/3 fully (codex, cursor, pi-dev); hooks add tier 1; nothing depends on a memory *service* running.

Fable/Opus-class exploitation (explicit): (1) retrieval-by-attention over whole just-in-time-loaded files replaces chunk-RAG and vector infra; (2) write-time judgment — merge-vs-supersede-vs-create decided inline by the model, no extraction pipeline; (3) instruction-following strong enough that the write policy is a prompt-level contract enforced by skill + CLI validation, not middleware; (4) background consolidation delegates the expensive judgment to sleep-time model runs; (5) long context tolerates a richer INDEX than 2024-era designs — spent on better *hooks*, not on resident bodies.

## 10. Relationship to current systems

| Current system | Disposition | Rationale |
|---|---|---|
| Claude Code auto-memory | **Keep pattern, generalize** — index + one-fact files + staleness banner become the Soma-wide design | Only fully healthy loop found |
| ACR prompt surfacing | **Keep idea as Tier 1**, deterministic + pointer-only | Only working injection path; fix its hardcoded paths by owning the layout |
| soma `events.jsonl` + `promote` + PROMOTED | **Keep as write journal / trust machinery** | Sound contract (`memory-policy-v0.md`); this design is its planned "later layers" |
| 19-category soma tree | **Collapse to 4 types** | 13/19 empty; lifecycle, not topic, is the right partition |
| `~/.claude/MEMORY` + `~/.claude/PAI/MEMORY` learning hooks | **Retire from memory; reclassify as telemetry** | Split-brain paths; 8,400+ files, zero readback |
| Tana #ai-memory | **Demote to optional projection target** | No runtime evidence of use; graph is reference knowledge, not agent memory; desktop dependency breaks portability |
| Knowledge skill / KNOWLEDGE | **Reference layer, not memory** | Different lifecycle; memory may cite into it |
| `~/work/CLAUDE.md` decisions.md protocol | **Superseded by episodic digests + semantic decisions** | Unenforced convention, uneven adoption (10KB in 2 repos, empty seeds elsewhere) |
| work.json / ContextSearch | **Replace with `state/active.json` + episodic recall** | Registry read path already broken |

Migration: **deferred by prior agreement.** Single note: `src/pai-memory-migrator.ts` already exists as the natural home; quarantine-import (§7 trigger 5) is the intended path — nothing auto-migrates.

## 11. Open questions for Jens-Christian

1. **Consolidation cadence + engine** — nightly cron with which model? Local (privacy) vs frontier (quality) for the sleep pass?
2. **Embedding tier** — add optional semantic index (ACR-style) once corpus outgrows grep, or is deterministic search + links enough for years at personal scale? (Recommendation: defer; revisit >5K memory files.)
3. **Scoping** — one global memory tree, or per-project semantic namespaces (auto-memory's per-project scoping is part of why it works)? (Recommendation: global tree + `project:` frontmatter key + recall filter.)
4. **Action-log granularity** — which actions are "consequential" enough to log? Tie to writeback trust tiers?
5. **Index budget** — 25KB ceiling matches Claude auto-dream; comfortable, or tighter for multi-substrate projection?
6. **Tana** — drop from the memory path entirely, or keep a one-way nightly projection of semantic/ into #ai-memory for browsing?

## 13. The death map — where knowledge goes to die

Forensic deep-dive (5 parallel investigators + adversarial reviewer, atime forensics validated against bulk-sweep artifacts). Ranked by value destroyed:

1. **Purged transcripts with uncaptured corrections** — `~/.claude/projects/*` rolls off at ~30 days (oldest survivor 2026-05-26). Sampled 8 recent sessions: **~70% of durable, typed corrections never landed in any memory.** Gone forever: the soma-inter "you are here to oversee, don't do the work" role rule; the field-tested natural-prompt preference (whose stored recipe still encodes the *opposite* guidance); the sage-vs-persona classifier decision. Gold-grade signal on a 30-day fuse, zero recoverability. Capture is bimodal: projects with maintained auto-memory (cyphr-secwg26, 60+ files) capture nearly everything; projects without a memory dir capture nothing.
2. **Ratings/sentiment pipeline** — 8,700+ entries; read back only as a *line count*. Content-analysis died Jan 17 (its one output, "NaN/10", fails its own reader's regex). Purpose-built consumers `OpinionTracker.ts` and `RelationshipReflect.ts` are complete, never-invoked programs. Since May the writer corrupts 50–62% of entries with timeout default rating=5.
3. **Algorithm learning tail** — ~3,960 of 3,966 learning files reachable only via ACR's embedding index, whose hourly indexer stalled Jun 24; session-start readback surfaces just the 3 newest files; promotion pipeline dead since Jan 16 (2 files ever promoted).
4. **The soma memory tier itself** — sole session-start reader is non-recursive (sees only `README.md`, never `ALGORITHM/` or `PROMOTED/`), and the hook launches it detached with `stdio: ignore`, discarding even that. `PROMOTED/` — the *curated best* of the tier — has no reader at all. 12 of 19 dirs README-only because writers were never repointed after the 2026-05-18 scaffold (RELATIONSHIP/OBSERVABILITY/RESEARCH signal streams live on, landing in the legacy root; 72 MB of tool activity).
5. **Self-reflection & identity layer** — `algorithm-reflections.jsonl` write-only (zero code readers); reflection self-assessment is *anti-informative* (predicts 7.6/10 vs 4.7/10 actual, r=0.177, 96-100% self-reported criteria pass); TELOS abandoned since Feb 22 with template placeholders (`[What this problem is]`) that get injected into **every session** — the one store with actively negative value.

Also never-captured entirely: ExtractWisdom/ContentAnalysis distillations (no write path exists — insights emitted into conversation, then dropped); OPINIONS.md (two complete writer tools, no scheduler).

## 14. Verdict: smarter, or just accumulating?

**MIXED — one hand-curated compounding loop rides on a rotting automated tier.**

- **Genuinely compounding:** project auto-memory, end-to-end proven — MEMORY.md read at session start, gotcha files preventing re-paid lessons, and retrieval demonstrably changing behavior (mf-cortex applied "the network-join-broke-bus pattern from memory" to diagnose a *new* crash). Where the index is maintained, no re-derivation and no repeated user questions were found.
- **Not compounding:** the entire automated learning tier (Groundhog Day: split-brain paths, write-only jsonl, dead synthesis, stalled index). ACR fires reliably but injects pointer-less last-action snippets and transcript garbage; zero observed cases of the agent acting on an injection.
- **"Getting smarter" is unprovable from the harness's own instrumentation.** The apparent rating uptrend (4.78→5.13, z≈11.7) collapses under adversarial review: 62% of June entries are timeout defaults hardcoded to 5; the capture hook, rubric, and rated population were all replaced mid-series (Apr 27 / May 5); and January ran on Sonnet while June is 81% Opus 4.8 — any residual gain is confounded with model upgrades. Meanwhile the #1 failure class (claiming completion without verification) recurs in 6 of 7 months, and the named failure patterns (barge-in, consolidation-table, arc-manifest) exist only as raw captures injected as bare slug titles — **no corrective rule exists anywhere that would prevent recurrence.**
- Even "accumulating" is too kind: artifact production fell 15× per interaction — not deliberate distillation but writer death. The system is simultaneously under-reading *and* under-writing its automated tier.

Instrumentation lesson for the new design: **memory health is measured by deterministic counts (captures, verifications, index churn, recurrence), never by LLM-inferred sentiment** — the sentiment pipeline mismeasured itself into a fictional trend.

## 15. Retention, decay, and promotion rules — the compounding mechanics

The rules that make session N+1 strictly better-informed than session N. All computable from frontmatter by the CLI; the model supplies judgment only where marked.

### Promotion ladder

| Level | Surface | Enters by | Leaves by |
|---|---|---|---|
| L0 Signal | transcripts, `events.jsonl`, tool logs | exists automatically | purged at TTL; only consolidation may mine it first. **Telemetry is not memory** |
| L1 Episodic | `episodic/sessions|actions/` | session-end digest (1/session); action entries at approval time | digest → archive (see decay) |
| L2 Durable | `semantic/`, `procedural/` | **P-promote**: principal correction/"remember" → written *same turn*, trust `principal`. **C-promote**: consolidation finds pattern ≥3 occurrences across ≥2 sessions → draft, quarantined until principal approves. **S-promote**: contradiction → supersede (close validity window, link) | superseded or refuted (see decay) |
| L3 Index line | `INDEX.md` (always loaded) | earned: resurfaced-and-verified ≥2×, OR principal-marked, OR created <7d (recency grace) | evicted by retention score when budget hit |
| L4 Identity | projected profile/purpose | principal-approved only, rare | principal edit only |

### The five compounding invariants

1. **Correction-capture-same-turn.** Any correction or stated preference becomes a procedural/semantic write *in the session where it happens* — the transcript's 30-day fuse means the session IS the capture window. The write must recall-first and **update contradicting memory** (the natural-prompt case: a stale recipe survived a field-tested correction because nothing forced the update).
2. **Every session ends with exactly one digest** (write gate) — never zero (soma-inter's evaporated sessions), never 6,363 JSON droppings (state spray).
3. **Every resurfaced-and-used memory bumps `last_verified`** (one CLI call). Usage is the retention signal; the loop the old systems never closed.
4. **Consolidation cadence ≤ weekly** — must outrun the L0 purge cycle (30d), or minable signal dies unmined. Consolidation converts failure captures into *corrective rules routed to where they'd fire* (the arc-manifest lesson lived in mf-blueprint's memory, invisible to the soma repo where the miss happened → rules carry `project:` scope or go global-procedural).
5. **No self-graded memory.** Store principal signal (corrections, approvals, explicit ratings) and deterministic outcomes (test passed, deploy verified); never store the agent's own satisfaction predictions (r=0.177 — noise).

### Decay rules (per type; invalidate, never silently delete)

| Type | Rule |
|---|---|
| L0 signal | ratings/tool logs 90d then delete; transcripts stay on their native purge |
| episodic/sessions | raw >90d → folded into monthly digest → raw archived |
| episodic/actions | raw 180d (audit value) → digest → archive |
| semantic | no TTL. Staleness = now − `last_verified`, always rendered at read. Unverified >180d AND never resurfaced → index eviction, archive-candidate flagged at next consolidation review |
| procedural | decays **only by refutation**: 2 contradicting outcomes → flagged for principal review; unused >1y → dormant pool (greppable, not indexed) |
| state | GC at session end + weekly sweep (kills the 6,363-file pattern) |

### Retention score (index eviction, deterministic)

`score = trust × recency(last_verified) × type_weight × resurface_count`
with trust: principal 3 / agent 1 / quarantined 0 — and type_weight: procedural 3 / semantic 2 / episodic 1. When INDEX exceeds budget, lowest scores evict first (file remains; only the always-loaded line is lost). No model call needed.

### Health metrics (deterministic, replaces sentiment pipeline)

Weekly consolidation report: corrections captured vs detected (target: 100% same-turn); % of index lines with `last_verified` <30d; recurrence count of failure classes in action log (the real "getting smarter" metric: does the same failure class re-appear after a corrective rule exists?); index budget headroom; quarantine queue age.

## 16. Sources

- Memora: infoworld.com/article/4191031 · Context rot: research.trychroma.com/context-rot · ACE: arxiv.org/abs/2510.04618 · Zep/Graphiti: arxiv.org/abs/2501.13956 · Letta sleep-time: letta.com/blog/sleep-time-compute · Anthropic context engineering: anthropic.com/engineering/effective-context-engineering-for-ai-agents · Claude Code memory: code.claude.com/docs/en/memory · autoDream: claudefa.st/blog/guide/mechanics/auto-dream · Copilot memory: github.blog (1/15/2026) · MINJA: arxiv.org/abs/2601.05504 · Survey: arxiv.org/abs/2512.13564 · Generative Agents: arxiv.org/abs/2304.03442 · Reflexion: arxiv.org/abs/2303.11366 · anup.io memory-architecture series (5-6/2026) · Video: youtube.com/watch?v=HgAQOkG_v8c (Tana node hS1HEbSQiZZU)
