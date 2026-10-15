# Probe the user-facing surface

**When it applies:** you mark a criterion passed, or claim done, for something a user or a caller touches.

**Rule:** mark it passed only with a tool probe of that surface, captured in the same tool block as the claim or the one right after it.

| Artifact | Minimum probe |
| --- | --- |
| Web page, UI | a browser screenshot of the target route |
| HTTP endpoint, API | `curl -i` with the status and the body shape checked |
| CLI output, command | the command run, stdout and stderr captured |
| Database write, schema change | a `SELECT` showing the row or the migration |
| File write, config or env change | a read-back of the file showing the new content on disk |
| Code edit | a grep for the new symbol, or a read of the range |
| Hook, skill | a direct `bun run` with synthetic input |
| Deploy | the deployed version string, not a successful push |

- "Should work", "should be", "expected to", "looks fine", "tests pass", and "done" or "no errors" with no output behind them are not evidence.
- A probe that is impossible right now: mark the criterion `[DEFERRED-VERIFY]` in the VSA (harness status `deferred-probe`) with a follow-up task id. It is not `[x]` until that probe runs.

You skipped this when the evidence for a user-facing criterion is a unit test or a sentence.
