# One probe per criterion

**When it applies:** you write or revise a criterion.

**Rule:** a criterion is one binary claim with one named probe that could fail.

- Split a criterion joined by "and" or "with", or one whose parts can fail independently: each half passes or fails on its own.
- Enumerate a criterion that says "all", "every" or "complete"; split one that crosses UI, API, data and logic into one per boundary.
- A criterion that needs human judgment names the tool-verifiable proxy that stands in for it.
- Name the probe in the criterion: the test, the grep, the command, the read.
- A tautological probe (one that passes whatever the work did) is not a probe.
- An anti-criterion (`Anti:`) is still a claim with a probe: what would you see if it happened?

You skipped this when a criterion can be marked passed by restating the plan.
