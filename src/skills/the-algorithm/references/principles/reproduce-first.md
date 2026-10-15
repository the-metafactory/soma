# Reproduce first

**When it applies:** a bug report, a regression, a failing check, "it broke".

**Rule:** reproduce the failure on the surface the report names before any edit. The same reproduction, rerun, is the verification of the fix.

- If it will not reproduce, tighten the conditions, synthesize the trigger or add instrumentation until it fires.
- A fix for a failure you never saw is a guess. A unit test shows a branch, not the absence of the bug.
- Commit the failing reproduction before the fix where a cheap test exists.

You skipped this when the first artifact of the run is an edit rather than captured failure output.
