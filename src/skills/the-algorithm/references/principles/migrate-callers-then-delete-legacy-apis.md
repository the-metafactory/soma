# Migrate callers then delete legacy APIs

**When it applies:** you introduce a new internal API while callers of the old one still exist, no external user depends on backward compatibility, the project can absorb a coordinated breaking change, and the new API is part of a simplification or refactor.

**Rule:** migrate every caller and delete the old API in the same wave. Do not keep a compatibility layer.

- Find every caller with a scan, not from memory (`references/principles/fix-the-class-not-the-instance.md`).
- Update tests to assert the new contract. Delete tests that only guarded the old implementation.
- A codemod usually migrates better than hand edits (`references/principles/build-the-lever.md`).

You skipped this when the old API survives "for now" and no remaining caller needs it.
