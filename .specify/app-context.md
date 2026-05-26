# App Context: Soma Work Registry Alignment

## Problem Statement

Soma currently has an implicit learning-harvest default at
`SOMA_HOME/memory/STATE/sessions/*.jsonl`. That path is not produced by current
PAI or by installed Soma, so it creates a false interoperability contract.
Soma needs canonical shared session state that aligns with the PAI work registry
model and remains safe across substrates.

## Users & Stakeholders

The primary users are Soma substrate adapters and agents that need to resume or
continue work across hosts. Maintainers need deterministic TypeScript contracts,
CLI-visible behavior, and documentation that keeps private transcript data out
of public templates.

## Current State

Soma writes lifecycle events and learning artifacts, and `soma learning harvest`
can harvest explicit transcript directories. It does not currently write
PAI-compatible `memory/STATE/work.json`, `memory/STATE/session-names.json`, or
`memory/STATE/current-work-<session-id>.json`. The learning harvester silently
defaults to `memory/STATE/sessions`, which is not a canonical source.

## Constraints & Requirements

Keep Soma filesystem-native, substrate-portable, and model-provider-neutral.
Use Bun and TypeScript. Avoid storing full private prompts, results, or raw
transcripts by default. Raw transcript harvesting must be explicit or
adapter-policy-gated. Shared state should be minimal, deterministic, and
compatible with PAI's live work registry concepts.

## User Experience

`soma learning harvest` should no longer imply that a non-existent raw transcript
directory is the default source. Default behavior should use canonical work
state when present, and raw transcript harvesting should require `--session-dir`.
Lifecycle writeback should leave enough metadata for another substrate to see
active or recently completed work and follow pointers to updated artifacts.

## Edge Cases & Error Handling

Missing work state should produce an empty harvest result rather than create
fake transcript paths. Malformed registry files should fail with actionable
errors. Session IDs without names should still produce registry entries with a
stable fallback name. Event writes should be append-only and should not block
core work if unrelated optional metadata is absent.

## Success Criteria

Soma documents the canonical work registry, implements PAI-aligned shared state
files, removes the orphan `STATE/sessions` default, writes a session-end event
that points to updated shared state, and verifies default behavior through tests.

## Scope

### In Scope

- Canonical Soma work registry and session-name registry files.
- Lifecycle writeback of minimal work/session metadata.
- Learning-harvest default behavior that uses work state or requires
  `--session-dir` for raw transcript harvesting.
- Minimal observability event linking session-end writeback to state artifacts.
- Public docs and design decision updates.

### Explicitly Out of Scope

- Full raw transcript mirroring.
- Full PAI tool activity and tool failure telemetry.
- Complete observability analytics for all skill usage and algorithm phases.
- Migration of all imported legacy skill path references.
