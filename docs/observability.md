# Observability V0

Soma observability starts as a filesystem-native read model over the existing
append-only event log:

```text
<soma-home>/memory/STATE/events.jsonl
```

Each line is a `SomaMemoryEvent`. V0 does not add a database, daemon, dashboard,
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
