# Separate before serializing shared state

**When it applies:** concurrent actors (agents, sessions, workers, hooks, CI jobs) might write the same file, branch, key or state object.

**Rule:** eliminate the sharing first. Serialize only when one shared writer is a real invariant, and then serialize structurally.

1. Identify the shared mutable state: files both read and write, branches both push to, keys both update.
2. Default: give each actor its own target (its own file, key, branch or directory) and merge only where it is read. Two workers writing their own field into one `state.json` still share it; two state files do not.
3. Only when one target must exist, enforce it with structure: a lock, a single-writer actor, sequential phases, compare-and-swap.

Instructions and conventions are not concurrency control. Treat "we need a lock" as a design smell to check, not the default answer.
