# Test behavior, not implementation

**When it applies:** you write, change or keep a test.

**Rule:** assert what the code's users can observe through their interface: return values, errors, state they can read back, effects on outside systems (a request sent, a row written, a message emitted). Private helpers, internal call order and intermediate data are implementation.

Judge each test against two imagined edits:

1. Break the behavior: a wrong value, a skipped or doubled effect. A test that still passes proves nothing. Usual causes: an assertion looser than the contract, an expected value computed by the code under test, a restated constant the code never reads, an assertion on data the test built itself.
2. Change the internals and keep every observable result. A test that now fails is pinned to the implementation.

Keep tests that catch the first edit and survive the second. Rewrite or delete the rest.

- Drive the code through its users' interface with a concrete input. Derive the expected value from the requirement, not from a run of the code.
- The contract decides. The payload a mocked external service receives is behavior; a call to an internal helper is not. Pair a "no call happened" assertion with a case where the call does happen.
- The error type callers branch on is contract. Exact message wording usually is not.
- An invariant (a key present in two tables, a compile-time check) is behavior too.
