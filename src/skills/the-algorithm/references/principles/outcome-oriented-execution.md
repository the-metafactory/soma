# Outcome-oriented execution

**When it applies:** a planned rewrite or migration with explicit phase boundaries.

**Rule:** optimize for the verified end state, not for smooth intermediate states. Throwaway compatibility code tends to become long-lived debt.

- Planned breakage between phases is acceptable when it is scoped and reversible. Declare where it is allowed before you start.
- Keep fast, high-signal checks running on the areas you are touching.
- At plan completion, run full static and runtime verification. The end state carries the proof.
- Breakage nobody declared is a bug, not a phase.

You skipped this when a shim written "for the transition" outlives the migration.
