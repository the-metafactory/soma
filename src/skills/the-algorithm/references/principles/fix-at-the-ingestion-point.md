# Fix at the ingestion point

**When it applies:** a fix would change output-side behavior: a display, a report, a formatter, a downstream consumer.

**Rule:** name where the bad state enters the system, and fix it there if that removes the class of bug.

- Ask: if I fix it upstream, do similar bugs disappear too? If yes, move the fix upstream.
- Trace from the data up, not from the display down, unless the reproduction forces display-down.
- Record the ingestion point in the run's decisions.

You skipped this when the fix filters bad values that something earlier keeps producing.
