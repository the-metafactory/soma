# Attack the premise

**When it applies:** two or more fixes that share one premise have failed the same gate.

**Rule:** suspect the premise, not the fixes. Write it down and test it directly before writing another fix that assumes it.

1. Write the premise as one sentence that every failed fix assumed.
2. Find an observation that would come out differently if the premise were false, and make it. Look at how the failures are distributed, not only how large they are.
3. If the evidence contradicts the premise, the cause is elsewhere: look for what the failures share that the premise did not predict.
4. If it confirms the premise, ask the next "why"; the fixes may have treated a consequence.

Stop: no next fix before the premise is written down and tested.

Distinct from `references/principles/diagnose-on-recurrence.md`, which builds the feedback loop; this questions what the loop is testing.
