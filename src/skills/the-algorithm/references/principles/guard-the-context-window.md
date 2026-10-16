# Guard the context window

**When it applies:** context is filling up: large outputs, long files, repeated reads, fan-out planning.

**Rule:** keep summaries in the main thread, not raw payloads. Overflow degrades reasoning, adds compression artifacts and stalls the work.

- Route bulk reading and searching to a subagent or a script, and take back only its conclusion.
- Read the part of a file you need. Do not reread what has not changed.
- Filter command output before it reaches the thread: counts, the failing lines, a summary.
- Size phases and cap scope: a file limit per phase, a turn budget, the cost of each mechanism counted up front.

You skipped this when the thread holds a full log or file dump that one summary line could replace.
