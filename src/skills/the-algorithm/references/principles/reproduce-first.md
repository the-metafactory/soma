# Reproduce first

**When it applies:** a bug report, a regression, a failing check, "it broke".

**Rule:** reproduce the failure on the surface the report names before any edit. The same reproduction, rerun, is the verification of the fix.

- If it will not reproduce, tighten the conditions, synthesize the trigger or add instrumentation until it fires.
- A fix for a failure you never saw is a guess. A unit test shows a branch, not the absence of the bug.
- Commit the failing reproduction before the fix where a cheap test exists.
- No read or grep targets the suspect code path before the reproduction is captured:

| Symptom | Reproduction |
| --- | --- |
| Web or UI bug | a browser screenshot or network trace |
| HTTP endpoint failure | `curl -i` showing the broken response |
| CLI tool failure | the actual stdout and stderr |
| Deploy or build failure | the error message from the log |
| Test failure | the failing test output with its assertion |
| Data inconsistency | a `SELECT` showing the wrong row or value |
| Agent or hook misbehavior | synthetic input through `bun run` showing the broken behavior |

You skipped this when the first artifact of the run is an edit rather than captured failure output.
