# Fix at the ingestion point

**When it applies:** a fix would change output-side behavior (a display, a report, a formatter, a downstream consumer), or add a guard where a symptom surfaced.

**Rule:** name where the bad state enters the system, and fix it there if that removes the class of bug. Ask "why" at each step until the answer is a wrong decision in the code, not a consequence of an earlier one.

- Ask: if I fix it upstream, do similar bugs disappear too? If yes, move the fix upstream.
- Trace from the data up, not from the display down, unless the reproduction forces display-down.
- Ask whether the state that triggered the symptom is legitimate. If the system may be in that state, the code that broke on it is the cause, and handling the state there is the fix. If the state should never exist, a check where it broke hides the bug: find what produced the state.
- Guards, retries, swallowed errors, clamped values and discarded state are the usual ways a bug gets hidden.
- A failure that appears only after a restart: suspect persisted state first (config files, caches, lock files, serialized state).
- A workaround that needs a paragraph of comment to justify it means the code is wrong. Fix the code, not the comment.
- When the deciding fact took a deep dig to find, propose the cheap, always-on signal that would have shown it at first look.
- Record the ingestion point in the run's decisions.

You skipped this when the fix filters bad values that something earlier keeps producing.
