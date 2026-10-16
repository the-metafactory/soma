# Boundary discipline

**When it applies:** you wire validation, error handling or a framework adapter.

**Rule:** validate, narrow types and handle errors at system boundaries (CLI args, config, network, external APIs). Trust internal types. Business logic lives in pure functions; the shell around it stays thin.

- Parse raw input into domain types at the boundary. Validate config at parse time, not inside business logic.
- Inside the system: typed data, propagated errors, no re-validation, no defensive null checks deep in call chains.
- Expose domain concepts across a boundary, not transport, storage or framework types.
- Keep general mechanism inside and special-purpose policy at the edge.
- Parsing, prompt building and scoring are pure transforms the shell just calls.

Tests: is this data crossing a boundary right now? If not, the validation is redundant. Can this be a pure function? If yes, extract it.

Related: `references/principles/type-system-discipline.md`, `references/principles/fix-at-the-ingestion-point.md`.
