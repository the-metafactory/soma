# Soma Evolution — Council + ApertureOscillation

**Created:** 2026-08-23
**Authors:** Jens-Christian Fischer + Ivy
**Method:** Two-lens dissection of "how could Soma evolve" —

- **ApertureOscillation** (3 passes: narrow tactical / wide strategic / synthesis), run by Ivy.
- **Council** (Debate workflow, 3 rounds x 5 custom-composed members), run as *independent
  agents* — each member a fresh subagent context that saw only the shared brief and its own
  persona, fixing the independence caveat logged against the 2026-06-22 four-lens run.

**Status:** Direction proposed. Ratify the three-workstream quarter; the schedule is cut to
three bets plus one arbitration rule.

---

## One line

The checkpoint is currently advisory; make it load-bearing, wire up the read side of memory,
and rehearse the proposer behind the now-real gate — everything else waits.

---

## ApertureOscillation (3 passes)

🎯 **Tactical Target:** Soma v0.18 → next quarter of the repo (its gates, adapters, memory loop, open issues).
🌐 **Strategic Context:** JC's personal AI infrastructure and the MetaFactory stack — one portable assistant (Ivy) present in every substrate; portability as the platform others can adopt.

### 🔬 Pass 1/3 — Narrow aperture (tactical)

*Framing: the repo is primary. The ecosystem vision is background.*

Component logic — what Soma naturally wants to be right now:

- A system whose own invariants hold. The locked primitive says deterministic gates commit;
  #600/#601/#616/#640 say that is not yet true. The repo wants its claims *true*, not extended.
- Declared policy should be enforced policy (#596 privateRoots decorative; #602 anti-criteria
  write-only; #594 tier floors met by 0%).
- Natural interfaces: fixture-tested formats + typed manifests are the house style; the missing
  sibling is a per-adapter conformance harness (drift is currently detected by JC's broken session).

Tactical findings:

1. Bind the gate cluster (#600 receipt-less closes, #601 merged-vs-enforced gap, #640 guard
   loads its own mutable worktree, #616 stale installed artifact) before adding any surface.
2. Verify what doctrine declares: enforce privateRoots (#596); make anti-criteria reachable by
   verify (#602); restate or drop tier floors (#594).
3. Build the readback path that already has capture: digests exist; nothing consumes them.
4. Kill local friction: #613 session-start 6.3s vs 327ms at session-end.

### 🔭 Pass 2/3 — Wide aperture (strategic)

*Framing: the life-OS/ecosystem vision is primary. The repo is derived.*

System requirements:

- The ecosystem needs Soma to be *trustworthy infrastructure*: the assistant body other MF
  components host. Trust is the product; agency without an auditable gate is Letta's seat, not ours.
- The differentiator Letta structurally cannot take is the intent axis — goal-aligned
  consolidation. That only counts if the gate beneath it provably binds.
- Cross-substrate telemetry is a strategic need, not a nicety: no adapter reports recall/read
  traffic today, so neither consolidation nor conformance can be evidence-driven.
- For the human: memory must arrive at the moment of need ("Tuesday test"). Capture without
  readership is one more system to maintain — the exact failure JC's ADHD external-systems
  pattern punishes hardest.

Strategic findings:

1. Governance-as-product is the strategic story, but it is only sellable once the governance
   actually governs (advisory gates would make the story false advertising).
2. A small versioned kernel contract + content packs is the shape that survives host-API churn;
   it should be *evidence-arbitrated*, not scheduled by faith.
3. The read-telemetry contract belongs in the adapter contract itself — one schema, six projections.

### ⚡ Pass 3/3 — Oscillation (synthesis)

Divergences found:

- Narrow says "make claims true, shrink surface"; wide says "the moat is agentic memory with
  intent — build the dream cycle." Narrow missed that strategy lives or dies in enforcement
  details; wide missed that daily felt friction (#613) is strategic, because perceived
  reliability is what makes the human keep the assistant installed.
- Narrow treats capture-shrinkage as cleanup; wide treats capture as the principal's only
  zero-cost asset. Resolution: keep capture, add readership measurement, forget downstream
  through gated demotion — prune in the dream, not at ingest.
- What narrow missed entirely: nobody's backlog prices the six-second session-start toll the
  user pays daily. What wide missed: a dream cycle wired to signals no substrate emits.

Design tensions:

- ⚡ **T1 Truth-before-agency vs agency-as-moat.** Resolution: sequence, don't choose — bind
  gates first; then propose-only consolidation behind the real gate is a free rehearsal of the moat.
- ⚡ **T2 Shrink-capture vs keep-capture.** Resolution: measure readership per event class;
  demote deliberately downstream; never freeze the tap while the index is unbuilt.
- ⚡ **T3 Kernel split now vs after evidence.** Resolution: arbitrate with data — split only if
  the conformance matrix proves the seam bleeds.

Alignment status: **ALIGNED after sequencing** — both apertures agree on W1-first when forced to order.

📋 ISC implications:

- New criteria candidates: "gate binds at the write point (receipt required for every close)";
  "guard loads hashed frozen snapshot, never live worktree"; "conformance matrix green against
  live hosts"; "memory-loop closure ≥ 0.5 reads/write on harness-eval"; "session-start < 500ms".
- Anti-criteria become checkable (#602): each anti-criterion gets a verify binding.

💡 Key insight single-scope analysis would have missed: **the unread corpus and the unenforced
gate are the same defect** — Soma builds ingest paths (writes, declarations) and no commit/read
paths. First-class readback and gate-binding are one move seen from two apertures.

🔭 APERTURE OSCILLATION COMPLETE — tactical findings 4 · strategic findings 3 · divergences 3 · tensions 3 · ALIGNED

---

## Council Debate: How should Soma evolve over the next quarter?

**Council Members:**

| Member | Lens |
|---|---|
| Dr. Marek Voss | memory-systems researcher (MemGPT/Letta lineage) |
| Ingrid Halvorsen | security & governance auditor |
| Tomas Brandt | solo-maintainer pragmatist |
| Priya Raghavan | substrate/platform engineer |
| Elio Marchetti | principal's daily-user advocate |

**Rounds:** 3 (Positions → Responses → Synthesis). Each member ran in an independent agent
context; transcripts were carried forward between rounds. ComposeAgent was unavailable under
the file sandbox (bun temp-write denied), so personas were hand-composed to its spec:
topic-tailored traits, distinct voices, no generic roles.

### Round 1: Initial Positions

**Dr. Marek Voss (memory-systems researcher):**
Soma is becoming a write-only ledger: 89% of captured events have no reader, read/write ratio 0.05. That's not memory — it's a log with good manners. A system that writes and never reads consolidates nothing, forgets nothing, learns nothing.

Next quarter goes to (d) plus (b) — one mechanism, not two: scheduled consolidation passes where the agent proposes merges, promotions, and demotions driven by actual recall traffic, committed only through your checkpoint gate. You shipped the commit half of propose/commit and left the proposer unwired; a gate nobody proposes through is a lock on a door no one opens. Letta proves autonomous reorganization works; Soma owns the piece Letta lacks — a typed-verdict completion gate — so run the dream through it and you beat both frames.

Kill or defer (e) and (f): you can't productize governance while your own memory starves unread. Defer (c); keywords aren't why recall fails.

Sharpest insight: #602's write-only anti-criteria and the unread corpus share one root — Soma only builds ingest paths. First-class readback cures both.

**Ingrid Halvorsen (security & governance auditor):**
My biggest concern: your headline invariant is false today. The checkpoint says deterministic gates commit; #600, #601, #616 say closes happen without a gate ever running. That's not tech debt — that's an advisory control wearing a mandatory label. Add #640, where the guard loads its own mutable worktree, and the enforcer can be rewritten mid-flight by the thing it polices. Textbook self-reference failure.

Next quarter: make the checkpoint true before extending it. Gate binds at the actual write point; policy artifact hashed and frozen at invocation, never interpreted live from editable state; rollback exercised by test. That subsumes half of (d) — readback starts with the audit trail itself, and a log that's 89% unread is evidence, not control.

Kill (c): trading keyword determinism for an inference classifier swaps a boring deterministic check for a probabilistic verdict. Defer (b), (e), (f) until gates provably bind — a dream cycle behind an advisory gate is autonomous memory mutation with no control.

Sharpest insight: #596 says it all. privateRoots declared, never enforced. Your trust boundaries already exist as decoration — enforce what's declared before declaring anything new.

**Tomas Brandt (solo-maintainer pragmatist):**
My biggest concern isn't even on your list: the checkpoint is false advertising today. #600/#601 mean closes can land with the gate never having run — your single primitive, the thing separating you from Letta, is optional at exactly the moment it matters. Fix that or admit the primitive is prose. Next quarter goes to (d) plus the #640/#616 install-binding cluster, run as subtraction: stop capturing events nobody reads — 89% dead-on-arrival capture isn't a learning loop, it's a landfill with a write path. Shrink the capture surface until readback exists; the ratio fixes itself. Kill (b) and (c) outright — autonomous reorganization and inference-based triggers on top of an unverified base are how you corrupt memory elegantly and at scale. Defer (a) and (e): you don't split a kernel or recruit users for a house whose locks don't latch. Sharpest insight: every unread event is future guilt with a timestamp.

**Priya Raghavan (substrate/platform engineer):**
My biggest concern: the checkpoint's core promise — agents propose, deterministic gates commit — is currently a convention, not a contract. #600/#601 let closes bypass the gate through install lag; #596's privateRoots are decorative; #640 lets the guard brick the very session editing it. A gate you can bypass by being stale isn't a gate. Letta is more honest — it admits the agent is in charge.

So next quarter goes to enforcement, not new intelligence. First, make the gate load-bearing: install freshness (#616) becomes part of the commit contract itself, and the guard loads the installed snapshot, never the worktree. Second, the kernel/content-pack split (a) — it shrinks the surface six monthly-churning host APIs can break; adapters should project a small versioned contract, not a worldview.

Kill (c), defer (b), (e), (f) — every new agentic surface or host multiplies skew while the one seam that matters doesn't hold. Sharpest insight: six adapters, zero conformance tests against live hosts — drift is currently detected by JC's broken session. Fix that before dreaming.

**Elio Marchetti (principal's daily-user advocate):**
My biggest worry: we've built a brilliant diary nobody reads. Eighty-nine percent of captured events have no reader; the read/write ratio is 0.05. For Jens-Christian — ADHD working memory, already feeding Tana, journals, agents — capture without recall is just one more system to maintain. Ivy hoards; she doesn't show up. So the quarter belongs to (d): close the learning loop — readback, digest consumption, memory arriving at the moment of need. That's the only direction that passes my Tuesday test: does she remember what he told her last week when it matters now? Second: #613. Six-point-three seconds at every session start is a tax he pays daily — friction we add, not remove. Defer (e): you don't scale an assistant that doesn't yet serve its one user. Defer (f) and (g) — elegant, invisible to the human. And (b), a dream cycle without readers, is automated hoarding. Fix the return path first; everything else pours into a pipe with no outlet.

### Round 2: Responses & Challenges

**Dr. Marek Voss:**
Tomas, subtraction is where we part ways: stopping capture to fix recall is curing amnesia by taking fewer notes. Uncaptured context is unrecoverable, and the ratio improving arithmetically isn't consolidation. Forgetting belongs downstream — evidence-driven demotion through the gate — not abstinence upstream: prune in the dream, not at ingest. Ingrid, I concede sequencing: your commit half must bind first — proposals behind an advisory gate would be the uncontrolled mutation you warn of. But deferring the proposer entirely buys another quarter of write-only decay; proposals lacking commit authority are inert audit entries, so both tracks can run in parallel safely. Priya, strongest agreement: her conformance harness is exactly where recall instrumentation must live — measure readership per adapter, not per hope, and drift stops being detected by Jens-Christian's broken sessions. And Elio's "automated hoarding" jab lands: a readerless dream hoards, so his Tuesday moments become the demand signal my consolidation passes learn from. Double-down intact: (d) and (b) stay one mechanism — encode freely, forget deliberately, read always.

**Ingrid Halvorsen:**
Tomas, your subtraction funds my agenda — adopt it. Stop capturing what nobody reads: every unread event is unaudited evidence accruing liability. And Priya's snapshot rule is correct — but incomplete. Install-freshness without verification is stale-with-extra-steps: hash the policy artifact at invocation, check it against the audit chain, fail closed on mismatch.

Where I push back. Marek: wiring proposers into an advisory gate doesn't exercise the control — it exercises its absence. Autonomous reorganization through a gate #600 proves skippable isn't beating Letta; it's Letta with paperwork. Bind first, then dream.

Elio: your Tuesday test has a threat model. The moment recall works, memory stops being inert and becomes injection persistence — whatever rots unread today ships into context tomorrow. Readback requires provenance checks at recall time, not just capture.

Position adjusted, not softened: bind the gates, shrink capture, then open read paths under enforced provenance. Same order as Round 1, tighter scope.

**Tomas Brandt:**
Ingrid, I'm with you almost entirely — hashed artifact frozen at invocation, gate bound at the write point, rollback proven by test. That's the smallest change that makes the checkpoint true, and it's shippable by one person. Priya, your conformance-test line is the best sentence in this round — drift discovered by JC's broken session is a scandal — but it argues *against* your kernel split, not for it. Two versioned artifacts means twice the drift surface, and #611/#612 show we can't even keep one fresh. Test six adapters against live hosts first; split only if those tests prove the seam bleeds. Marek, your diagnosis stands — Soma builds ingest paths and nothing else — but the dream cycle is a proposer bolted onto a gate #600 proves optional. That's corruption on a schedule. Elio, readback without shutting the tap just gives the landfill a reading room. Double down: bind the gates, delete capture nobody reads, then talk about outlets.

**Priya Raghavan:**
Ingrid — hashed, frozen policy artifacts are right, and I'll extend them: version-pin like a lockfile and bring them under the conformance matrix, so rollback replay is a test, not a hope.

Two disagreements. Marek, your consolidator runs on "actual recall traffic," but no adapter today emits recall telemetry — you'd wire a dream cycle to signals six hosts don't report. Instrumentation is a cross-substrate contract; ship it before dreaming. Tomas, subtraction looks free but isn't: capture surfaces live in per-host projections, so "stop capturing" means touching all six adapters at once — maximum churn while our one seam still doesn't hold. A core-side readback path touches none of them.

Elio's Tuesday test moves me: I'm upgrading defer-(d) to pulling forward its instrumentation slice, since live-host conformance tests need those same read counters anyway. Otherwise I double down — install freshness belongs inside the commit contract, the guard loads snapshots, never worktrees, and (a) shrinks whatever monthly host APIs break next.

**Elio Marchetti:**
Tomas, I'll fight your subtraction. Capture costs Jens-Christian nothing — it happens agent-side, invisible; recall failure is the only cost he feels. Freeze capture until readback ships and Ivy forgets whatever he tells her during the fix window — for ADHD working memory, that's burning the notebook while building the index. Keep the pipe; add the outlet.

Ingrid, partial yield: verdicts must bind before he can trust them, and "an unread log is evidence, not control" is the line of the round. But your readback starts with the audit trail — that serves auditors. Digest consumption serves him at breakfast. Reading mutates nothing; don't queue all usefulness behind enforcement.

And note what four sharp minds missed: #613's six-second toll at every session start appears on nobody's list. That's the tax he actually pays daily.

Marek, conceded — a dream driven by real recall traffic isn't hoarding. Readers first, then dreams. Priya's "drift detected by JC's broken session" is my Tuesday test in engineer's clothing — ship her conformance tests.

### Round 3: Synthesis

**Dr. Marek Voss:**
Converged: gates bind before anything dreams. The #600/#601/#616/#640 cluster is one workstream — install freshness inside the commit contract, the guard loading frozen snapshots, rollback proven by test. Nobody dissents anymore, including me.

Second convergence: Priya's conformance tests and my recall telemetry are one artifact. No adapter emits read traffic today — my consolidator was wired to signals that don't exist, so she wins that point. Ship the read-counter contract inside her matrix, then core-side readback: digests consumed, memory arriving when Tuesday needs it.

Where I still dissent. Tomas, capture abstinence cures amnesia by taking fewer notes — forget deliberately, downstream, via demotion. Ingrid, deferring the proposer buys another write-only quarter; once gates bind, propose-only passes are inert audit entries — free rehearsal for the thing Letta does recklessly.

Ranked: (1) bind the gate cluster; (2) read-telemetry contract plus digest consumption; (3) propose-only consolidation behind the now-real gate, provenance checked at recall. And kill #613's six-second toll — daily friction is its own kind of forgetting.

**Ingrid Halvorsen:**
Where we've converged: the whole council now treats the checkpoint as false until fixed — gate bound at the actual write point, guard loading a hashed installed snapshot instead of its own mutable worktree, fail-closed on mismatch, rollback exercised by test. Priority one, non-negotiable. Two: shrink capture — Tomas and I hold this line; Elio's burning-the-notebook objection is heartfelt but backwards. Uncaptured context can't be poisoned; captured-and-unread is unaudited evidence accruing liability. Three: open read paths only under recall-time provenance — working memory is injection persistence. Remaining disagreements, honestly: Marek still runs proposers in parallel. Inert proposals aren't safe; they're organizational pressure to soften the gate. Bind first. Priya keeps her kernel split; I side with Tomas — conformance-test the seam before carving it, since #611/#612 prove we can't keep one artifact fresh. Her recall-telemetry-before-dreams point is correct and I adopt it. Killed: (c), unanimously. Live tension: my audit-trail-first readback versus Elio's digest-at-breakfast — reading mutates nothing, so queuing usefulness behind enforcement risks enforcement deferred forever. And #613 remains unowned. A six-second unexplained stall at session start is exactly where policy loads; someone should audit that.

**Tomas Brandt:**
More convergence than I expected. The checkpoint is false advertising today, and all five of us treat binding the gate as blocker zero: hash the artifact at invocation, load installed snapshots never worktrees, prove rollback by test — #600, #601, #616, #640, enforce #596 too. Priya's live-host conformance harness is consensus number two; her read-counters double as the recall telemetry Marek's dream will someday need. Elio shamed #613 onto the board — six seconds daily is real rent.

Still contested: subtraction. Only Ingrid stood with me; Marek and Elio keep the tap open. I'll trade sequencing, not thesis — 89% dead-on-arrival capture is liability compounding. I also hold against Priya's kernel split until conformance proves the seam bleeds, and against Marek's dream until gates bind and readers exist.

Ranked: one, make the gate load-bearing. Two, conformance tests plus read counters; kill the #613 toll. Three, digest consumption — Ivy remembers at breakfast. (c) died unanimous; split and dream wait on evidence. Deletion stays my favorite feature.

**Priya Raghavan:**
Convergence is real: all five of us now agree the checkpoint runs advisory — closes bypass the gate through install lag, the guard loads its own worktree. Priority one: make it load-bearing — install freshness inside the commit contract itself, version-pinned, hash-frozen artifact loaded at invocation, snapshots never worktrees. Second, my conformance matrix became consensus — Elio called it his Tuesday test in engineer's clothing, Marek wants readership per adapter — so live-host tests and the read-telemetry contract ship together: one schema, six projections. Third, core-side readback — digest consumption touching zero adapters — and Elio's #613 six-second toll folds into that same lifecycle work.

Still disagreeing: Tomas, on subtraction — capture lives in per-host projections; deleting it is a six-adapter edit while our one seam doesn't hold. And on (a): I won't concede the kernel split, but I'll arbitrate it with data — if the matrix proves the seam bleeds, we split; otherwise he wins. Marek, your dream waits for telemetry.

**Elio Marchetti:**
Convergence first: all five of us now hold that the checkpoint must become true before anything dreams through it — gate bound at the write point, guard loads installed snapshots, policy hashed at invocation (#640, #616, #600/#601). An assistant whose verdicts are optional can't be trusted on Tuesday. Second: Priya's read-counters ship early — they're conformance telemetry *and* the demand signal Marek's consolidator needs; nobody defends "drift detected by Jens-Christian's broken session." Third: (c) is dead by unanimous boredom; (e), (f), (g) wait.

Ranked for the quarter: one, bind the gates. Two, build the outlet — digest consumed at breakfast, memory recalled at need, readership measured per adapter. Three, kill #613's six-second session-start toll; it's the only cost he actually feels daily.

Still fighting: Tomas, freezing capture burns the notebook while we build the index — ADHD working memory can't re-ask what was never kept. And Ingrid, half-yielded only: your hashes may gate the audit trail, not his digest. Reading mutates nothing.

### Council Synthesis

**Areas of convergence (unanimous by R3):**
- The checkpoint is currently **advisory**, which makes the locked direction false advertising.
  Binding it is blocker zero: gate binds at the write point; install freshness joins the commit
  contract; the guard loads a hashed, frozen installed snapshot — never its own mutable
  worktree; mismatch fails closed; rollback proven by test. Covers #600, #601, #616, #640,
  plus enforcing #596.
- A **live-host conformance matrix + read-telemetry contract** ships as one artifact: drift
  stops being detected by JC's broken sessions, and read-counters become the demand signal a
  future consolidator needs.
- **Core-side readback/digest consumption** is the highest user-value move — and touches zero
  adapters, so it does not multiply skew.
- **(c) inference activation classifier: killed unanimously.** (e) distribution, (f)
  governance-as-product, (g) two-axis generalization: deferred until the gate provably binds.

**Remaining disagreements (honest):**
- **Capture shrinkage.** Tomas+Ingrid: uncaptured context can't be poisoned; captured-and-unread
  is accruing liability. Elio+Marek: freezing capture burns the notebook while building the
  index. Unresolved — resolved operationally below by measuring instead of deciding.
- **Proposer timing.** Marek: run propose-only passes in parallel once gates bind; Ingrid: inert
  proposals create organizational pressure to soften the gate. Sequenced compromise adopted.
- **Kernel/content-pack split (a).** Priya yes; Tomas+Ingrid only after conformance proves the
  seam bleeds. Arbitration rule adopted.

**Recommended path:** bind the gates → build the outlet → rehearse the proposer, with the
kernel split decided by conformance data rather than conviction.

---

## Cross-tabulation (lens agreement)

| Claim | Oscillation | Council |
|---|---|---|
| Checkpoint is advisory — binding it is blocker zero | T1 resolution | unanimous P1 |
| Readback/digest consumption = highest-value move | wide pass demanded it | all five ranked it top-2/3 |
| Read telemetry must precede any dream cycle | wide-pass requirement | Priya→Marek explicit concession |
| Consume-what-you-capture and enforce-what-you-declare share one root cause | key insight | Marek R1, independently |
| #613 session-start toll is strategically relevant | narrow pass missed it | Elio surfaced; adopted by all |
| Capture shrinkage | rejected (demote downstream) | contested 2–2, unresolved |
| Kernel/content-pack split | conditionally supportive, data-arbitrated | contested, same arbitration rule |
| Inference activation classifier | deferred | killed unanimously |
| Distribution/adoption, governance-as-product | out of scope this quarter | deferred unanimously |

---

## Recommended quarter: three workstreams + one rule

### W1 — Make the checkpoint true (blocker zero)
Gate binds at the actual write point; install freshness becomes part of the commit contract
(#601, #616); the policy guard loads a version-pinned, hash-frozen installed snapshot and fails
closed on mismatch (#640); receipt-less closes reconcile (#600); declared privateRoots enforce
(#596). Rollback is exercised by test, not hoped.

**Falsifiable acceptance test:** mutate home state out-of-band → the next close attempt fails
closed with a typed verdict; kill -9 mid-close → snapshot rollback restores a consistent home;
tamper with the policy artifact → invocation refuses on hash mismatch.

### W2 — Build the outlet (readback + telemetry)
Read-counter schema ships inside a live-host conformance matrix (one schema, six projections);
core-side digest consumption touches zero adapters; recall-time provenance checks open read
paths safely (Ingrid's injection-persistence point); #613 folds in here with a hard budget.

**Falsifiable acceptance test:** `bun run harness-eval` shows memory-loop closure moving from
0.05 toward ≥ 0.5 reads/write; digests consumed in ≥ 80% of sessions; session-start < 500ms;
conformance matrix green against all six hosts.

### W3 — Rehearse the proposer (after W1)
A propose-only consolidation pass emits typed merge/promote/demote proposals through the
now-real gate — no auto-commit, principal-gated promotion, downstream forgetting instead of
upstream abstinence (resolves T2 operationally: readership data decides capture's fate).

**Falsifiable acceptance test:** N proposals/week emitted with valid manifests; ≥ 1 promoted by
the principal within the window; zero ungated writes to protected roots; revert drill passes.

### Arbitration rule
The kernel/content-pack split happens **only if** the W2 conformance matrix proves the seam
bleeds (recurring cross-host failures attributable to surface size). Otherwise the small-contract
discipline continues inside one artifact.

---

## Epistemic caveat (carried forward, improved)

The 2026-06-22 four-lens run warned that agreeing lenses are not independent evidence. This run
improves independence — five fresh agent contexts debated across three rounds with transcripts,
and the oscillation ran separately from the council — but every member still shares one model
family, one brief, one author. Treat the unanimity on W1 as **consistency, not proof**. The
proof obligation sits in the falsifiable tests above, and in the baseline numbers
(`docs/harness-objective-function.md`) reproduced against current HEAD before W1 starts.
