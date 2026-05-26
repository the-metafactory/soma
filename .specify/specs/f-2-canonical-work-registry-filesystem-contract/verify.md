# Verification: Canonical Work Registry Filesystem Contract

Verified: 2026-05-26

## Evidence

- `bun test test/work-registry.test.ts`
- `bun test --timeout 30000`
- `bun run typecheck`

## Result

The registry helper creates `work.json`, `session-names.json`, and
resolver-backed current-work pointer files; lists entries through the public API; and does
not require or store prompt/result transcript text.
