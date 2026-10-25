# Own delegated work

**When it applies:** you hand work to a subagent, read its report, or give a finished subagent its next round.

**Rule:** you own every subagent's work. Its report is a claim, not a result.

- Review the diff and write your own summary. Do not pass through what the subagent said.
- Give new work to a fresh subagent with consolidated scope: the original brief, every later directive, and the prior agent's report and branch. This holds for a fix round, a follow-up, a retry and the next queue item.
- Reuse an existing subagent only when the new work needs state that lives in that agent and is costly to move: its checkout, its uncommitted changes, or a process it still runs (a dev server, a simulator, a watcher). A stop or hold order to a running agent is not reuse.
- A resume chained onto an interrupted agent silently drops directives. Consolidate the scope into a fresh brief instead of trusting a "done" summary.

You skipped this when your reply to the principal repeats a subagent's report and you never read its diff.

Distinct from `references/principles/second-opinion-at-commitment-boundaries.md`, which asks a different reviewer; this keeps you accountable for the one you delegated to.
