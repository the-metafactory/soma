# Explain the number

**When it applies:** you are about to trust, report or act on a number you measured: a speedup, a regression, a latency, a rate, an eval score.

**Rule:** find what limits the number, and rule out that it measured something other than the work you think.

1. Ask "why not double?" Name the resource or code path that bounds the result (a core, a lock, the disk, the network, the load generator), from a profile or counters taken during the run. A guess from reading code is not a limiter.
2. List what else the number could be measuring and rule out each with evidence: errors, skipped or cached work, code that never ran, an untuned baseline, noise, a piece too small to matter end to end.
3. Keep the evidence with the number: run count, spread, limiter.

For an eval result, ask the same of the trials: did every run do the task, and does the gap hold across trials and models?

You skipped this when a reported number has no run count, no spread or no named limiter.
