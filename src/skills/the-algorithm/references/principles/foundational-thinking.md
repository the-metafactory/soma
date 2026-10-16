# Foundational thinking

**When it applies:** before writing logic: choosing core types and data structures, ordering scaffold against feature work.

**Rule:** get the data shape right first, so the code that uses it becomes obvious. Structural decisions protect option value. Code-level decisions protect simplicity.

- Define core types early. Trace every access pattern and pick structures that fit the common paths.
- DRY the structure, not every line. Three similar statements beat a premature abstraction. Explicit beats clever.
- Scaffold first. If every later phase benefits from something existing (CI, lint, test setup, shared types), build it first: setup before features, tests before fixes.
- Each increment lands a coherent abstraction or deepens an existing one. Do not spread a new capability across callers as special-case coordination.
- Subtraction comes before scaffolding: `references/principles/subtract-before-you-add.md`.
- Before actors share state, ask what happens if another one changes it concurrently. If the answer is not "nothing", isolate: `references/principles/separate-before-serializing-shared-state.md`.

You skipped this when logic was written before anyone named the types it moves.
