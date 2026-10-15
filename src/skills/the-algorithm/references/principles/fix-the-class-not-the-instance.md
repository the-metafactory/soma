# Fix the class, not the instance

**When it applies:** a defect found in one place could exist in others, or a claim says "every", "all", "none" or "no longer".

**Rule:** make the claim true by construction: a test that scans every instance, a type that rejects the bad shape, a single code path the instances share.

- Checking the instances you remember proves only those.
- An exhaustive claim in a commit message or a PR body needs an exhaustive probe behind it.

You skipped this when the fix lists the call sites it touched and nothing fails if a new one appears.
