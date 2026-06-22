> **⚠️ SUPERSEDED 2026-06-22 by `2026-06-22-soma-direction-verification-primitive.md`.**
> The dividing line survives (in final form there). The seam-vs-harness framing
> re-sold already-shipped portability, and "stop deepening the harness" was
> backwards — a *portable* harness is the differentiated value. Kept for the
> reasoning trail only.

# Soma Seam Thesis — Strategy (SUPERSEDED)

**Created:** 2026-06-22
**Authors:** Jens-Christian Fischer + Ivy
**Method:** Four-lens dissection (FirstPrinciples, BeCreative, ApertureOscillation, Council) of the PAI→LifeOS rebrand and the MetaFactory Discord critique thread.
**Status:** Direction proposed. Luna review incorporated 2026-06-22 (see Review log). **Ratify the direction + dividing line; the schedule below is cut to two bets this quarter.**

---

## Thesis

Soma's trap is becoming a *better PAI* — a deeper harness. Its actual moat is being
the **seam**: the portable assistant body that substrates move through. Lean into
determinism where it buys portability; loosen structure where it fights the model;
turn the governance grievance into the product.

> **Epistemic caveat (Luna).** Four analytical lenses produced agreeing
> conclusions, but they are *not* independent evidence: same authors, one session,
> one seed thread, shared priors. Their agreement says the framing was *consistent*,
> not that the conclusion is *correct*. Treat the agreement as a clarity check, not
> a proof. The dividing line below earns ratification on its own logic and its
> falsifiable test — not on "the lenses converged."

---

## Origin: what the thread exposed

Daniel Miessler renamed PAI → LifeOS and is pivoting from "clone a `~/.claude`
directory" to an LLM-driven agentic per-machine installer. The Discord critique
(Vincent Zontini, Kyle, Robert Chuvala, Andreas Aaström) named the real failures:

- **Brittle monolith** — "one directory, one layout, hope it matches your setup."
- **Stale harness** — hooks not on current Claude Code API; Algorithm-as-`CLAUDE.md`
  monolith against best practice; skills not on the Anthropic skill spec.
- **Rigid memory** — fixed telos/ISA/memory schema; letta's counter-bet is that 2026
  models self-organize memory better than a prescribed schema.
- **Governance** — the deepest critique. Ignored PRs, mass-closed issues, "open
  source in concept." Architecture was never the gating failure; trust and adoption were.

Wishlist (#647): reproducible builds, dependency/API-key docs, lowercase paths,
foundation/extension repo split, Handlebars-style templating, JSON task slices.

Most of these Soma already answers structurally. The interesting work is the two
forward-looking tensions: **rigid vs. agent-managed structure**, and
**deterministic vs. LLM-driven install**.

---

## What the lenses surfaced (consistent framing, not independent proof)

| Claim | FirstPrinciples | Creative | Oscillation | Council |
|---|---|---|---|---|
| Deterministic projection/adapters = the moat | HARD atom | proof (#4) | the seam | Mara/Pim |
| 7-compartment **content schema** is inherited, not load-bearing | INHERITED, drop as requirement | — | tension #2 | concede |
| Don't out-build letta/beads — consume them | — | exit standard | seam not harness | Devansh |
| Real gating risk is governance/adoption, not architecture | — | #3/#5 | — | Theo |
| LLM *diagnoses* install, typed code *commits* | — | #4 | — | Pim |

---

## The dividing line (keystone)

> **Soma is deterministic about *where things go* and *what may move between
> substrates*. The assistant is free about *what it writes inside a compartment*.**
> Structure governs movement and trust; the model governs content.

**Stays typed / `git diff`-able / fixture-tested:**
- projection + adapters
- install / uninstall
- Algorithm / ISA phase gates, criterion verification
- policy ownership, writeback gates
- compartment *boundaries* — as namespace + policy scope

**Becomes agent-managed (inside the gates):**
- memory *content and organization* — free-form, assistant-authored, **no field schema**
- the compartment is a folder + policy, not a struct

### The boundary contract (Luna — the schema didn't vanish, it moved)

"Drop the content schema" and "the index stays typed and eager" are only
non-contradictory if the boundary is named. A typed index over untyped bodies
requires a contract *at the seam*:

> **Each loose body emits a minimal typed manifest** (id, compartment, title,
> created/updated, optional tags/links). The body content is free-form; the
> manifest is the typed surface the index, projection, and writeback gate read.

So the schema moved from the *body* to a thin *per-body manifest*. That manifest
is the precise point where letta's "models self-organize" bet meets Soma's
portability requirement. Name it, version it, fixture-test it. Everything below
the manifest is the model's; everything at and above it is Soma's.

This satisfies letta's agency critique without surrendering the one property letta
structurally cannot have — portability. The manifest + index have fixtures; the
body is just files; a 1.5-FTE team can test all of it.

---

## Highest-leverage structural move: kernel / content-pack split

Split Soma into:

- **Portability kernel** — the 5 load-bearing atoms only: home, projection,
  writeback, policy, identity contract.
- **Content-pack layer** — Telos / ISA / Algorithm / compartment-schema as *one
  default pack among possible packs*.

**Falsifiable acceptance test:** a user installs kernel + zero content schema and
still gets a recognizable portable assistant; a letta-style self-organizing-memory
pack and the current structured PAI-derived pack both install over the same kernel
**without touching adapter code**. If swapping the pack forces adapter changes, the
split has failed.

This is the architectural form of the dividing line — and what lets Soma *host*
best-of-breed instead of cloning it. (Scheduled **next quarter**, not this one.)

---

## The reframe: seam, not harness

Stop spending the quality budget deepening Algorithm/ISA — substrates are
commoditizing exactly that via native `/goal`, memory, and skills. Spend it on the
seam instead.

### "Lossless" is a destination, not a milestone (Luna)

Bidirectional lossless writeback across letta memory + a beads graph + native
`/goal` is a CS-hard, unbounded problem — the kind that eats small teams.
*Deepening Algorithm is bounded; interop is not.* Don't let the reframe invert the
risk and treat interop as the safe spend.

**Scope a v0 with explicit edges:**
- **one substrate pair**, **one direction** of writeback
- an explicit **lossy-fields register** — what does *not* round-trip, named in the doc
- "lossless across all tools" is the north star, never a sprint goal

### Interop spine: target `.af`, don't author a Soma format (verified 2026-06-22)

letta-code is the reference implementation of the "self-organizing-memory pack" the
kernel/content-pack test names — so researching it *is* building Exhibit A. Two
verified facts make it the v0 seam:
- **letta-code persists via git (MemFS), not a DB** — "all context including memory
  blocks is tracked via git." The DB-impedance fear is downgraded; local letta-code
  is Soma's own shape. Only hosted Constellation is DB-backed.
- **`.af` (Agent File, Apache-2.0) already ships Luna's boundary contract**: memory
  blocks = label (typed index) + content (free-form body). Don't invent a Soma
  interchange — **emit/ingest `.af`**. It already excludes archival passages and
  nulls secrets, so the lossy register is partly pre-defined.

Full mapping + bounded v0 scope: `2026-06-22-letta-af-soma-fieldmap.md`. The `.af`
ingest spike (memory blocks → Soma bodies+manifest, one direction) is the smallest
test that proves or breaks the dividing line.

### Position Soma as the Exit / Migration standard

"Data portability for assistants." This inverts the Discord grievance (lock-in,
mass-closed issues, "open source in concept") into Soma's core promise, already the
README tagline: *change tools without losing the assistant.*

> **Unvalidated assumption (Luna).** This bet asserts demand it never sizes —
> the same chicken-and-egg that dinged the Notary and Escrow directions. Portability
> only has value if users actually churn substrates. **Validate before betting the
> roadmap on it:** who feels substrate lock-in pain today, how many, how often? If
> most users live in one substrate, the exit standard is insurance nobody buys. The
> moat is real; the *market* is assumed. Size it.

---

## Non-negotiable: governance as product

Architecture is moot if two part-time maintainers can't merge community work. The
decisive differentiator vs PAI is an **explicit, honored contribution + triage
contract** — and it must be enforced, not aspirational.

**Two concrete CI checks to start (Luna — make it real, not rhetoric):**
1. **Stale-PR / stale-issue auto-labeling** with a published response SLA timer
   (e.g. label `needs-maintainer` after N days untouched; surface the count
   publicly). The opposite of silent backlog.
2. **Won't-fix register enforcement** — a tracked, public `WONT_FIX.md`; closing an
   issue as won't-fix requires an entry, and CI fails a close that bypasses it.
   The opposite of mass-closing without a trace.

Ship this **alongside 0.9**, this quarter. Being-the-exit is only credible if Soma
visibly runs an open door.

---

## Plan — sequenced by leverage, not listed (Luna)

Six large bets numbered 1–6 is 12+ months for 1.5 FTE wearing a quarter's clothing.
A plan that ships all six ships none. Forced pick:

### This quarter (ship)
1. **Distribution leaks** — #302 (`arc install` exposes **no runnable `soma` on
   PATH**; every README command assumes a binary that isn't installed) and #305
   (registry serves untagged 0.8.5 as "latest"; `@0.8.4` pin resolves to 0.8.5;
   install record internally inconsistent). *Verified 2026-06-22.* Trust-critical,
   cheap, blocks the reproducibility story at its edge. **Do first.**
2. **Governance contract + won't-fix register + stale-PR CI** (the two checks above).

### Item 0 — dogfood proof (cheapest, possibly the headline)
Promote the coda. This Claude Code session runs a giant PAI `CLAUDE.md` monolith
with ~100 eager-loaded skills — the exact anti-pattern the thread mocks. Dogfood
Soma's indexed-registry / on-demand-body model on Soma's *own* dev env and you
rebut "open source in concept" with a **running demo instead of a promise**. Likely
shippable inside the quarter; sequence it before or beside the distribution fix.

### Next quarter
3. **Kernel / content-pack split** (+ the named manifest boundary contract).
4. **Loose-memory tier** (assistant-authored bodies, typed manifest + index).

### Backlog (not this half)
5. **JSON task-graph as ISA-native** — runs are already JSON under
   `WORK/algorithm-runs/`; make spec→plan→JSON-slice→spawn first-class. Real gap,
   but not gating.
6. **`soma doctor` → machine-quirk diagnosing agent.** *Correction (verified):*
   `src/adapters/doctor.ts` already does per-substrate **projection-drift**
   diagnosis (codex/claude-code/grok) — it is not a presence-only check. The
   *extension* is to have an LLM diagnose **machine quirks** doctor doesn't cover
   (hook API version, paths, OS, case-sensitivity) and *propose* typed adapter
   config the adapter validates and writes. Beats LifeOS's pure-LLM installer
   (auditable + reproducible) and PAI's static clone (adaptive).

### Cheap trust sweep (opportunistic, any quarter)
Per-skill dependency/API-key manifest; lowercase/case-sensitive path normalization
on `migrate claude-skills` (**unverified — check before scheduling**); document
foundation/extension separation as the headline advantage it already is.

---

## What NOT to do

- Don't chase LifeOS into LLM-driven install (nondeterministic, unauditable per machine).
- Don't abandon structure wholesale for letta-style freedom — that throws away the moat.
- Don't keep deepening Algorithm/ISA as if harness depth is the product.
- Don't treat "lossless interop" as a milestone, or the exit-standard market as proven.

---

## Divergent directions considered (Creative lens, for the record)

1. **Notary** — cryptographically attest the same assistant ran across N substrates. Too early.
2. **Escrow for agent labor** — portable ISA + provenance settles trust between strangers' agents. Chicken-and-egg with the network.
3. **Exit/Migration standard** — *selected, market unvalidated.* Governance grievance inverted into product.
4. **Differential installer** — LLM diagnoses, code commits. *Carried as proof for #3.*
5. **Governance-as-code** — posture as product. Not defensible IP alone; folded into the non-negotiable above.

---

## Review log

- **2026-06-22 — Luna (logic review; could not reach repo, did not re-audit code).**
  Verdict: ratify the seam thesis + dividing line as *direction*; send back four
  things before they are load-bearing — (a) the convergence framing (cut/caveat),
  (b) "lossless" scope (bound it), (c) the index/body boundary contract (name it),
  (d) the quarter plan (cut to two bets). All four incorporated above. Flagged that
  load-bearing facts were author assertions; **#302, #305, and `doctor.ts` since
  re-verified against the repo** — #302/#305 confirmed (302 worse than written),
  the `doctor.ts` "presence-only" claim corrected to projection-drift diagnosis.
