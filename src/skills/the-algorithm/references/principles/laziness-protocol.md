# Laziness protocol

**When it applies:** you refactor, size a diff, or feel the pull to add an abstraction, a layer or a parameter threaded through several calls.

**Rule:** bias to deletion. Make the smallest change that solves the problem.

- Make each decision once. When the same choice appears in several places, put it behind one source of truth and pass the result down as a plain value.
- Fewer lines beat elegant boilerplate.
- A new abstraction earns its place by removing more code than it adds.

You skipped this when the diff adds a layer whose only caller is the change itself.

Distinct from `references/principles/ship-what-the-evidence-justifies.md`, which decides what goes in; this decides how small it is.
