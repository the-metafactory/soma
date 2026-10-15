# Ship what the evidence justifies

**When it applies:** you decide what goes into a fix or an iteration.

**Rule:** ship the smallest change the evidence supports. A belt-and-suspenders change that "might help" is a hypothesis; it does not ship.

- When evidence refutes a hypothesis, revert what it motivated.
- Each shipped line traces to an observation: a reproduction, a probe, a measurement.
- Verify each small unit before starting the next, instead of batching checks at the end.

You skipped this when the diff carries a change no probe in the run asked for.
