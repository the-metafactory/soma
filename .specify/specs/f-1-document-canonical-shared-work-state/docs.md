# Documentation Updates — F-1: Document canonical shared work state

Generated: 2026-05-26

## CHANGELOG

Entry added to `CHANGELOG.md`:

- Added canonical PAI-aligned shared work state for lifecycle writeback and
  learning harvest defaults: `work.json`, `session-names.json`,
  `current-work-<session-id>.json`, and metadata-only writeback events.

## User-Facing Changes

### CLI Changes

- `soma learning harvest` now defaults to canonical work registry state.
- `--session-dir` remains the explicit raw transcript JSONL source.

### Other Changes

- `docs/learning-contracts.md` documents default and explicit harvest sources.
- `docs/substrate-adapters.md` documents adapter writeback expectations.
- `CONTEXT.md` and `design/design-decisions.md` record the canonical state
  vocabulary and decision.

## README Update

No README usage block currently describes learning harvest, so the user-facing
contract lives in `docs/learning-contracts.md` and `docs/substrate-adapters.md`.
