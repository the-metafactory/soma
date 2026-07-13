# SelfHealing Doctrine

> **Source of truth for humans.** The lines Soma actually projects live in
> `src/adapters/shared/self-healing-doctrine.ts` (`SELF_HEALING_DOCTRINE_ADVISORY`).
> This markdown mirrors that module; a drift test asserts the projected policy
> comes from the module, not from a per-adapter copy of the text. Edit the
> module and this file together.

Soma files failures and learnings (`LEARNING/`, `FAILURES/`, `feedback.candidate`
events) that then sit inert. Without a principle directing that a *recurring*
miss be encoded as a structural change, the same class of miss can recur
indefinitely. The SelfHealing doctrine is that principle: **when a miss recurs,
encode the fix as structure, not an inert note** — fix the system, not your
notes.

The doctrine is portable and substrate-neutral. It projects into every
substrate's policy projection as **advisory** content via the existing
`renderPolicyProjection` machinery (advisory on substrates without enforcement).

## Routing table (signal → structural home)

When a signal recurs, route the fix to its structural home instead of leaving a
note that no one reads back:

| Signal | Structural home |
|---|---|
| recurring preference or correction | a projected policy rule (#314) or a memory note with a `recall-trigger` |
| recurring process miss | an Algorithm/VSA criterion or a deterministic nudge |
| broken capability or projected artifact | a projection self-repair pass or a `soma doctor` fix |
| recurring code or test failure | a test-obligation rule (#314 rule 4) |

## Deliberate divergence from LifeOS (advice, not authority)

LifeOS's `RULES/SelfHealing.md` lets the model **auto-apply** the fix at
confidence. Soma must **not**. This doctrine is **advice on _where_ a fix should
land, not authority to apply it**. Any mutation of principal-trust surfaces
still requires the existing `--principal-authority` governance — proposals only,
principal-gated apply (soma#429, soma#375). The doctrine steers routing; the
existing governance gates the write.

## Provenance

- **Issue:** soma#459.
- **Natural host:** soma#314 (substrate-independent verification policy — same
  projection machinery, same "distillate not artifacts" framing).
- **Related:** soma#375, soma#429.
- **Evidence:** LifeOS `LIFEOS/RULES/SelfHealing.md`.
