# ISA Gotchas

Load this reference before reconcile, tier checks, or any edit that may change
criteria structure.

- **ID stability is the cornerstone of Reconcile.** Never renumber on edit. Split
  by preserving the parent ID and adding child IDs such as `ISC-7.1`.
- **Ephemeral files are derived views.** Workers operate against the slice;
  Reconcile merges back. The master ISA remains the durable source of truth.
- **Changelog entries require all four fields.** Use `conjectured`,
  `refuted by`, `learned`, and `criterion now` in that order. If one is
  missing, record a Decision instead.
- **Project ISAs upgrade to E3+.** A long-lived project ISA must not be
  structurally downgraded by one small task.
- **Empty sections do not appear.** Required sections must be populated;
  non-required sections are omitted until they are meaningful.
- **Anti-criteria are derived from boundaries.** Out of Scope, Constraints, and
  Principles should become probe-able `Anti:` ISCs where relevant.
- **Experiential goals need antecedents.** Art, design, writing, brand, and
  other "has to land" work needs at least one `Antecedent:` ISC.
- **Reconcile is deterministic.** Unknown ISC IDs abort. Structural changes such
  as splitting criteria belong in the master before reconcile runs.
- **Executable contracts win over prose.** Parser, serializer, accessor, and
  workflow tests are canonical when prose drifts.
