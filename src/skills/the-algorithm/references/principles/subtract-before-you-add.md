# Subtract before you add

**When it applies:** you sequence an addition, a refactor or a rewrite.

**Rule:** remove complexity first, then build on the simpler base. Leave the design a little simpler than you found it, behind the same or a smaller surface.

- Remove before you construct. Cut before you polish.
- Design for observed usage, not speculative edge cases.
- No validators, parsers or guards beyond what the spec demands.
- Prune prompts too: redundant instructions, oversized templates.
- A reference with nothing new in it gets deleted, not left as a stub.

Bounded by `references/principles/change-only-what-was-asked.md`: dead weight outside the ask becomes a note. Deleting files still needs `references/principles/ask-before-irreversible.md`.
