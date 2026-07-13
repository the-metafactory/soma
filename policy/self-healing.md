# SelfHealing Doctrine

> **Canonical source:** `src/adapters/shared/self-healing-doctrine.ts`
> (`SELF_HEALING_ROUTES` + `SELF_HEALING_DOCTRINE_ADVISORY`). That module is what
> Soma projects, and a drift test asserts every substrate's policy is
> byte-derived from it. This file is a human-readable companion — it explains the
> doctrine but does **not** restate the projected lines, so there is no second
> copy to keep in sync.

Soma files failures and learnings (`LEARNING/`, `FAILURES/`, `feedback.candidate`
events) that then sit inert. Without a principle directing that a *recurring*
miss be encoded as a structural change, the same class of miss can recur
indefinitely. The SelfHealing doctrine is that principle: **when a miss recurs,
encode the fix as structure, not an inert note.**

The doctrine is portable and substrate-neutral. It projects into every
substrate's policy as **advisory** content via the existing
`renderPolicyProjection` machinery (advisory on substrates without enforcement).

## What it does

It maps a recurring *signal* to a structural *home* — e.g. a recurring preference
or correction to a projected policy rule or a memory note with a `recall-trigger`;
a recurring process miss to an Algorithm/VSA criterion or a deterministic nudge; a
broken capability or projected artifact to a projection self-repair pass or a
`soma doctor` fix; a recurring code or test failure to a test-obligation rule. The
authoritative, enumerated mapping is `SELF_HEALING_ROUTES` in the module above —
read it there rather than a duplicated table here.

## Advice, not authority

The doctrine is **advice on _where_ a fix should land, not authority to apply
it.** Any mutation of principal-trust surfaces still requires the existing
`--principal-authority` governance — proposals only, principal-gated apply
(soma#429, soma#375). The doctrine steers routing; the existing governance gates
the write.

This is a deliberate Soma stance: Soma does **not** auto-apply self-heal changes
on model confidence. (It was chosen in contrast to confidence-gated auto-apply
patterns seen in other assistant stacks; that comparison is design motivation,
not a claim this change substantiates.)

## Provenance

- **Issue:** soma#459.
- **Natural host:** soma#314 (substrate-independent verification policy — same
  projection machinery).
- **Related:** soma#375, soma#429.
