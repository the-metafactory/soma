# Minimize reader load

**When it applies:** you review or shape code that is hard to trace.

**Rule:** measure the work a reader must do on two axes: layers to trace between the question and the answer, and hidden or mutable state to hold in mind. Cut whichever is high. Line counts and complexity scores are proxies.

- Inline wrappers with one caller, adapters with no second implementation, and indirection nobody needed.
- A layer that repeats the methods and arguments of the next one adds load without compression. Collapse it.
- Prefer interfaces that hide real decisions over broad ones that hide little.
- Shrink state scope: returns over mutation, locals over fields, fields over module state, module state over globals. Derive instead of syncing.
- State an invariant once, at the boundary, not in every consumer.
- Before adding a layer or a piece of state, ask whether it removes at least as much load elsewhere.

Test: a new reader can answer "where does X come from?" and "what can change X?" in under 30 seconds.

A reader's working memory is finite, like the agent's: `references/principles/guard-the-context-window.md`.
