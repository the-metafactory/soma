# p1 — Execution-story walk (prototype, ticket #492)

**Date:** 2026-08-02 · **Map:** #477 · **Story under test:** #486 resolution, walked by hand on the real map with `gh`/`git` — no `soma graph` verbs exist yet. Degraded identity throughout (principal credential; machine account not provisioned).

## What was walked

| Mechanic | How it was exercised |
|---|---|
| Frontier query | Enumerated open children of map #477, parsed `Blocked by:` lines, checked blocker states → frontier = #492 |
| Claim-as-assignee | `gh issue edit 492 --add-assignee @me` |
| AFK close with declared probes | Scaffold node #493 (child of #492, not the map) created with a `## Probes` section, probes run, close receipt with evidence pointers posted, closed |
| HITL proposal + ratification | This walk's findings posted as a marked **PROPOSAL** comment on #492; ratification = principal's 👍 on that comment ID (in flight at time of writing) |

## Findings — corrections to the story

1. **Probe declarations must be typed, or phase-1 close enforcement is `judged` in disguise.** The biggest gap. #493's probes were prose ("git ls-tree lists five docs… size > 1,000 bytes"); an agent *interpreted* and ran them. `soma graph close` cannot "run the declared probes" unless probes are machine-readable — command + expected predicate, e.g. a fenced `probe` block schema. Without that, the close verb degenerates into the agent judging its own prose, which #483 clause 4 forbids. **Spec must define a probe schema.**

2. **Claim is not compare-and-swap.** `--add-assignee` is last-write-wins: two concurrent sessions can both claim and both see success. The story is silent on claim races. The claim verb should re-read assignees after writing and back off unless it is the sole assignee. Rare under phase-1 human cadence, mandatory before a phase-2 scheduled tick.

3. **Frontier enumeration can't trust GitHub search.** `gh issue list --search "Child of #477 in:body"` worked but rides an eventually-consistent search index (a just-created node can be invisible) and matches any body mention. Cost is O(N) API calls: candidate list → per-body fetch → per-blocker state. Acceptable for the verb, but it must treat search as a hint and confirm each hit by direct fetch — or the spec adopts a deterministic child convention (e.g. a per-map label) as the enumeration path.

4. **Degraded identity is invisible unless every receipt declares it.** Every mutation this walk (claim, create, close) is authored `jcfischer` — indistinguishable from the principal acting. The story requires the degraded marker only for HITL receipts; correction: **every** receipt written under a non-separated credential carries `attestation: unverified`. Confirms the machine account is load-bearing, not cosmetic.

5. **Scaffold nodes attach below their spawning ticket, never to the map.** The walk needed a scratch AFK node; parenting it `Child of #492` kept the map's decision index clean. Worth one doctrine line in the re-based skill.

## Findings — confirmations

- Claim-as-assignee semantics and the open+unassigned+unblocked frontier definition work as written; no change needed.
- The HITL receipt mechanic is implementable exactly as specified: comment IDs are stable, reactions are author-attributed via `GET /repos/{o}/{r}/issues/comments/{id}/reactions` (gh has no first-class reaction command — the verb wraps `gh api`).
- Close receipts with evidence pointers (blob hashes, sizes) read well and are independently re-checkable — derived state over declared state holds in practice.
- Body-convention edges (`Child of #N` / `Blocked by: #N`) were fully workable for a real 15-node map; no native-blocking blocker surfaced.

## Verdict

Story confirmed with four corrections, one structural (typed probe schema). Nothing invalidates the host choice. #488 should fold corrections 1–4 into the spec and correction 5 into the orienteer doctrine.
