# Diagnose on recurrence

**When it applies:** the same symptom is reported a second time, after a fix that was supposed to end it.

**Rule:** stop editing. Build a feedback loop (a rerunnable check that shows the symptom) and find the cause with it before the next change.

- Another retry, log line, timeout bump or cache-bust over an undiagnosed cause is not a fix.
- The first fix is now evidence: it treated something, and that something was not the cause.

You skipped this when the second fix shipped without a check that failed before it and passes after it.

Related: `references/principles/attack-the-premise.md` when several fixes shared one belief.
