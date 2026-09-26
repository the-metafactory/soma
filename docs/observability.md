# Observability V0

Soma observability starts as a filesystem-native read model over the existing
append-only event history:

```text
<soma-home>/memory/STATE/events.jsonl
<soma-home>/memory/STATE/events-index.json
<soma-home>/memory/STATE/events-archive/events-000001.jsonl
<soma-home>/memory/STATE/events-archive/events-000001.jsonl.gz
```

Each line is a `SomaMemoryEvent`. Soma rotates the live file before an append
would take it past 16 MiB. One cross-process lock covers all substrate writers,
rotation, and reader snapshots. Closed plain segments are numbered in order and
never appended again. An untracked high water mark detects loss of the last
closed segment. Private Soma-home git stores gzip mirrors; live, index, and
plain files remain gitignored. The pre-2026-08-24 archive becomes segment 1
without changing its bytes. Readers also accept its old name before import.

`streamEventRecords` in `src/event-log.ts` enumerates segments and live exactly
once, pins handles and the live byte bound under the writer lock, then streams
after releasing it. A missing segment or conflicting plain/gzip copy is an
error, not a partial success. Gzip is used when a plain segment is absent.
Daily live snapshots remain in place during the migration.

V0 does not add a database, daemon, dashboard,
or Signal dependency. It also does not harvest raw transcripts, prompts, or full
tool payloads.

## CLI

List recent events:

```bash
soma telemetry list
soma telemetry list --substrate codex --limit 10
soma telemetry list --kind lifecycle.session_end --json
```

Summarize the event log:

```bash
soma telemetry stats
soma stats --json
```

The summary includes:

- total parsed events
- malformed JSONL rows skipped
- event counts by substrate
- event counts by kind
- lifecycle session starts and ends, including per-substrate counts
- observed session durations when start/end events share a `metadata.sessionId`
- Algorithm event counts and phase counts when events carry `metadata.phase`
- skill event counts and skill-name frequencies when events carry
  `metadata.skill`, `metadata.skillName`, or `metadata.skillId`
- writeback/failure event counts

Malformed lines are counted and skipped so one corrupt row does not hide the
rest of the log.

## Boundary

Soma owns the local event vocabulary and the filesystem-native query surface.
Signal remains the owner of telemetry systems, dashboards, alerting, and longer
term observability pipelines. A future Signal export should consume this V0
read model instead of re-parsing event files independently.
