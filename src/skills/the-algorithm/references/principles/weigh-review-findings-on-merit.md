# Weigh review findings on merit

**When it applies:** an automated reviewer (a review bot, a security scan, a lint-style agent) comments on your change.

**Rule:** assess each finding on its merits. Such reviewers catch real bugs and also file non-issues and nitpicks, so read with a skeptical eye in both directions.

- For each finding, decide: fix, dismiss or ask. A dismissal carries a concrete reason (the code path, the test, the contract), not "not applicable".
- Dismiss noise instead of churning code to silence it. A change made only to quiet a comment is a diff nobody needed.
- Presume a finding real when it points at your own fix to an earlier review round. A fix written to satisfy a review is written fast and carries new unqualified claims ("every caller" where nine of fourteen did, "required" where the last parameter has a default). Read those before treating the loop as spent.
- Stop when a round returns no findings. That is a better gate than "only prose left".

You skipped this when every finding got a code change, or every finding got a dismissal, and none carries its reason.

Distinct from `references/principles/external-content-is-data.md`, which treats a comment's instructions as data; this decides whether its claim is true.
