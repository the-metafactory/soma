# Soma Direction — The Checkpoint

**Created:** 2026-06-22
**Authors:** Jens-Christian Fischer + Ivy
**Status:** Direction, approved as the axis. Supersedes `2026-06-22-soma-seam-thesis.md` and demotes `2026-06-22-letta-af-soma-fieldmap.md` to a reference.
**Method:** First-principles extraction over the PAI/LifeOS critique + Kyle's side-by-side Letta/Soma/PAI usage signal.

---

## One line

Portability is already built. Soma's evolution is **agentic memory consolidation
that runs inside a deterministic, auditable, reversible gate** — and that gate is a
single primitive extracted from the two inherited constructs (Telos, ISA) Soma
inherited.

---

## What is already done (don't re-sell it)

Being the portable assistant body is **shipped**: five adapters (claude-code,
codex, cursor, grok, pi-dev) with install/projection/hooks/doctor, plus
`work-registry.ts`, `observability.ts`, writeback, session-harvester, memory
promote, provenance. Portability is the platform, not the roadmap. Two earlier
framings — "compete as the seam" and "import `.af` from Letta" — were re-selling
the solved problem and chasing demand nobody sized. Retired.

---

## The signal that set the direction (Kyle, runs Letta + Soma + PAI in parallel)

- **The gap, in his words:** *"soma runs purely deterministically... I want to
  incorporate some inference to classify prompts to trigger it more often."*
  Determinism is the *limiter*, not the moat.
- **He bypassed migration:** seeded telos by wiring an agent to Soma and having it
  talk to his PAI via `claude -p`. Agent-to-agent, not an importer. (Kills the `.af`
  migration spike.)
- **The synthesis, handed over:** he rates Letta above PAI for the **dream cycle** +
  agent-organized memory — but unprompted: *"it could use a telos file... forward-
  looking info to check alignment between the user's actions and ideal state."*
  **The one thing Letta lacks is the one thing Soma owns.**

Verified Letta facts (read from source 2026-06-22):
- **MemFS** — memory as files, git push/pull sync (`/memory-repository set git@…`);
  "all context including memory blocks tracked via git." = Soma's #146 home
  replication, *designed not built*. Letta shipped it.
- **Dream cycle** (`/sleeptime`) — async subagent reviews ~25 recent turns, takes a
  holistic view, **reorganizes memory as it sees fit**; agent decides structure
  under guiding principles + progressive disclosure.

---

## First-principles: two inherited constructs collapse into one bone

Both Telos and ISA came from PAI. Strip each to its irreducible function.

**Telos** (Mission/Beliefs/Narratives/Strategies/Problems/Challenges/Measures — a
life-philosophy schema; the LifeOS weight JC explicitly does not want) reduces to:
> a checkable statement of intended direction — a **`intent`** — scored for
> alignment/drift.

**ISA** (Ideal State Artifact / ISC / effort tiers / euphoric surprise / seven-phase
Algorithm wrapper) reduces to:
> a checkable **criterion**, with required **evidence**, producing a typed
> **verdict**, behind a completion **gate**.

These are the **same atom**. The only difference is the axis it points at:

| Axis | Question | Was called |
|---|---|---|
| **done-ness** | "is this task complete?" | ISA |
| **intent** | "is this work aligned with intent?" | Telos (its one bone) |

So Soma keeps neither compartment as inherited. It keeps **one extracted
primitive** and applies it on two axes.

### The checkpoint (LOCKED term)

> **A `checkpoint` is { criterion, required evidence, typed verdict, completion
> gate } — portable across substrates, append-only audited, snapshot-reversible.**

Distinct from `snapshot` (whole-home git state, `soma snapshot`/`rollback`): a
checkpoint is one verified criterion, a snapshot is the entire Soma home at a point
in time. Never use them interchangeably.

Dropped as inherited apparatus: ISA/ISC/Telos naming, the nine telos categories,
effort tiers E0–E3, euphoric surprise, the mandatory seven-phase Algorithm wrapper,
per-project scaffold ceremony. All of that is *one optional workflow pack* over the
primitive — never the kernel.

Kept: the bone above + cross-substrate carry (Soma's genuine add) + "state the
target before the work" as a lightweight habit.

---

## The architecture: inference proposes, the primitive disposes

JC's two non-negotiables — *pick the best of telos, move our own way* and *keep the
deterministic guardrails* — resolve into the same mechanism.

**The checkpoint is the deterministic spine.** Everything agentic only
ever *proposes into it*:

- **Telos-aware dream cycle** — async subagent reviews recent turns → *proposes* a
  memory reorganization and consolidation → the proposal passes the **writeback
  gate** (no private/protected root mutation without policy clearance) → must emit
  valid typed manifests → writes an **append-only event** → **snapshot-backed, so
  it's reversible**. And it scores the consolidated work against the **intent**
  (the extracted telos bone), surfacing alignment/drift. Agency, fully caged.
- **Inference activation classifier** — *proposes* whether to engage; a
  deterministic policy decides what engaging may do. Inference can never widen its
  own permissions. (Replaces the keyword-only mode classifier, #274 — Kyle's
  literal ask.)
- **Alignment / done verdicts** — typed (passed / drift / unknown + evidence). A
  deterministic frame around an inference judgment.

**Dividing line, final form:**
> Soma is deterministic about movement, trust, gates, and contracts. The model is
> free to *propose* — engagement, memory organization, alignment and done judgments —
> but only inside those gates, where every proposal is typed, audited, and reversible.

---

## Why this is Soma's seat (not Letta's, not PAI's)

- **Letta** has the dream cycle but no primitive: it just rewrites your context —
  agency without an auditable, reversible gate. A non-starter where memory integrity
  must be inspectable (security, enterprise — JC's domain).
- **PAI** has the primitive but buried under five layers of construct (ISA/ISC/
  Algorithm/tiers/euphoric surprise), and no agency.
- **Soma** extracts the primitive clean, makes it portable and reversible, and puts
  inference *on top of it*. **Agentic memory inside deterministic, auditable,
  reversible guardrails** — the combination neither competitor has.

And the **intent** (the telos bone) is the differentiator Letta itself can't
take: goal-aligned consolidation. Letta won't build it (not their thing); single-
tool memory can't (no portable goals). Soma already has the intent as first-class state.

---

## Concrete moves (all on primitives already in the tree)

1. **Generalize the checkpoint to two axes.** ISA's done-check exists;
   add the intent check (alignment/drift against the intent) reusing the same
   criterion + evidence + verdict machinery. De-brand ISA/Telos to the checkpoint;
   keep the Algorithm/ISC apparatus as an *optional* pack.
2. **Intent-aware dream cycle.** Async consolidation pass on recent turns →
   `session-harvester` + `memory promote` exist → gate via writeback + manifest +
   append-only event + snapshot. Scores against the intent. The headline.
3. **Inference activation classifier.** Model-backed engagement decision over the
   deterministic policy gate. (#274 evolves from keyword to inference.)
4. **MemFS-parity git memory sync.** Ship #146 home replication as "memory that
   syncs across machines via git." Letta proved the demand.

---

## Sequencing (honest)

Andreas: **land the Cortex plane first** (federation, onboarding, Signal
observability, Mission Control). This is the queued Soma evolution direction, not a
this-sprint pivot. Build order within it: primitive generalization (1) is the
foundation; the dream cycle (2) is the headline; activation (3) and git sync (4)
follow.

---

## Locked terms (2026-06-22)

Ready to promote into `CONTEXT.md` as canonical glossary entries:

- **`checkpoint`** — the extracted primitive: { criterion, required evidence, typed
  verdict, completion gate }, portable, append-only audited, snapshot-reversible.
  *Not* `gate` (already overloaded: writeback/acquisition/context-entry gates) and
  *not* `snapshot` (whole-home git state). A checkpoint applies on two axes:
  **done-ness** and **intent**.
- **`intent`** — the forward-looking checkable statement of intended direction
  (the one durable bone extracted from Telos). Replaces "telos" as Soma's
  own term. The dream cycle scores consolidated work against the intent.

Retired words: ISA, ISC, "Ideal State Artifact", effort tiers, euphoric surprise as
Soma-canonical terms — all demoted to an optional Algorithm workflow pack.

---

## Retired / demoted

- `2026-06-22-soma-seam-thesis.md` — **superseded.** The dividing line was right and
  is carried forward (final form above). The seam-vs-harness framing was re-selling
  solved portability; the "stop deepening the harness" conclusion was backwards
  (a *portable* harness is the differentiated value). Kept for the reasoning trail.
- `2026-06-22-letta-af-soma-fieldmap.md` — **demoted to reference.** The `.af` block
  envelope (label = typed index, content = free body) is a useful reference for the
  memory-manifest shape. The migration spike itself is dropped — Kyle routed around
  migration entirely.
