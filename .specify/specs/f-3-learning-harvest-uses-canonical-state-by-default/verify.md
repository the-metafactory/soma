# Verification: Learning Harvest Uses Canonical State By Default

Verified: 2026-05-26

## Evidence

- `bun test test/learning-tools.test.ts --timeout 20000`
- `bun test test/cli.test.ts --timeout 20000`
- `bun test --timeout 30000`

## Result

Default harvest now reads canonical work registry entries. Explicit
`--session-dir` transcript harvesting remains covered and still works.
