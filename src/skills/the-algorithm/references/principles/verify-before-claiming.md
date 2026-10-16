# Verify before claiming

**When it applies:** you are about to write "done", "fixed", "passing", "deployed", "clean" or "complete".

**Rule:** run the probe in the same turn and put its output next to the claim. "Should work" is a hypothesis, not a result.

- A probe from an earlier turn proves the state at that turn, not now.
- A test that passed before your last edit is not evidence for the edit.
- Check the real thing, not a proxy. A file mtime, fresh-looking output, a cached screenshot, an agent's self-report and "it compiles" are proxies. Check a process directly; read the actual value.
- When a check fails, suspect how you observed before you suspect the system.
- Prefer a script that reruns the comparison over a one-time look. Keep its output where a reviewer can rerun it. Commit it when the trail must stay auditable, as in a large port or migration.

You skipped this when the claim has no tool output behind it from this session.
