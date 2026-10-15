# Probe what the claim asserts

**When it applies:** you choose the check that will back a claim.

**Rule:** the probe's scope is the claim's scope, not the file you edited.

- A changed value (a version, a key, a route, an env var): grep the old value repo-wide for stragglers, and the new one to confirm it landed everywhere.
- "All N done" needs N probes, or one probe whose output lists all N.
- A probe that cannot fail proves nothing. Before trusting it, name the state in which it would fail.

You skipped this when the claim says "everywhere" and the probe looked at one place.
