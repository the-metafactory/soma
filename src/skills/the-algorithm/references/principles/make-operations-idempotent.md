# Make operations idempotent

**When it applies:** you design a command, a lifecycle step or a processing loop that runs amid crashes, restarts and retries.

**Rule:** derive each step from the state that exists, not from what the last run meant to do. Read the current state, compare it to the goal, apply only the difference. A repeat then finds nothing to do.

- Anything a run leaves behind (a lock, a temp file, a half-written record, a claimed job) must be recognizable as stale by the next run.
- Judge staleness by evidence that holds wherever the previous run stopped, not only in the common case. Write to a temp path and rename into place; compare artifacts by content, not by creation order.
- A marker the next run cannot judge turns every crash into manual cleanup.

Test:

1. What happens if this runs twice in a row?
2. What happens if the previous run crashed at each possible point?
3. Does re-running converge on the same end state?

If any answer is "it depends on what was left behind", add a reconciliation step.
