# Redesign from first principles

**When it applies:** a new requirement has to fit into an existing design.

**Rule:** do not bolt it on. Redesign as if the requirement had been a founding assumption, then deliver the redesign in increments.

1. Read every affected file and understand the current design.
2. Ask: if we wrote this from scratch with the new requirement, what would we build?
3. Carry the change through every reference: types, docs, examples, rationale.
4. Plan the whole redesign, then ship it in verifiable steps (`references/principles/sequence-verifiable-units.md`).

The redesign stays within the requirement's reach. Code it does not touch still falls under `references/principles/change-only-what-was-asked.md`.

You skipped this when the requirement lives in a special case the rest of the design does not know about.
