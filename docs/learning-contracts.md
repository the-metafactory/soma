# Soma Learning Contracts

Soma learning tools read and write through `createPaths()`. Portable tools must not address `~/.claude/PAI` directly.

## Session Harvest Sources

`soma learning harvest` has two source modes:

- **Default mode:** first discovers retained current-work snapshots at
  `<soma-home>/memory/STATE/current-work-*.json` with
  `schema: "soma-current-work-v1"`. Valid snapshots become metadata-only
  learning candidates that cite the pointer path, artifact pointers, and event
  ids from declared learning-source files. If no valid snapshot is available,
  harvest falls back to canonical shared work state from
  `<soma-home>/memory/STATE/work.json`.
- **Explicit transcript mode:** reads raw transcript JSONL files only when the
  caller passes `--session-dir <dir>`.

Soma does not treat `<soma-home>/memory/STATE/sessions/*.jsonl` as a default
source. Raw transcript sources are substrate-local unless an adapter explicitly
declares and policy-gates them. A current-work pointer may declare a raw
transcript source, but default harvest does not read it. Default harvest output
must not mirror full private prompts, results, transcripts, or current-work
pointer payloads.

## Ratings JSONL

Path: `<soma-home>/memory/LEARNING/SIGNALS/ratings.jsonl`

Each non-empty line is one JSON object:

```json
{
  "timestamp": "2026-05-19T12:00:00.000Z",
  "rating": 7,
  "session_id": "session-id",
  "source": "user",
  "sentiment_summary": "quick clean implementation",
  "confidence": 0.85,
  "comment": "optional detail"
}
```

Required fields:

- `timestamp`: ISO-8601 timestamp.
- `rating`: numeric 1-10 score.
- `sentiment_summary`: short natural-language summary used for pattern detection.

Optional fields:

- `session_id`: source session identifier.
- `source`: producer identifier, such as `user`, `explicit`, or `implicit`.
- `confidence`: 0-1 confidence from the producer.
- `comment`: additional context.

Consumers should ignore malformed lines only when they are explicitly best-effort tools. Contract tests should use strict JSONL fixtures.

## Opinions Markdown

Path: `<soma-home>/identity/opinions.md`

The file is human-readable Markdown with a fenced JSON block as the machine source of truth:

```json
{
  "schema": "soma-opinions-v1",
  "opinions": [
    {
      "statement": "The principal prefers small direct PRs",
      "confidence": 0.5,
      "category": "technical",
      "evidence": [],
      "created": "2026-05-19",
      "lastUpdated": "2026-05-19"
    }
  ]
}
```

Opinion categories are `communication`, `technical`, `relationship`, and `work_style`.

Evidence updates adjust confidence asymmetrically:

- `supporting`: `+0.02`
- `counter`: `-0.05`
- `confirmation`: `+0.10`
- `contradiction`: `-0.20`

Confidence is clamped to `0.01..0.99`. Changes of `0.15` or more are notification-worthy.

## Failure Capture Inference

`soma learning capture-failure` writes structured local failure records under
`<soma-home>/memory/LEARNING/FAILURES/`. By default, failure descriptions are
derived deterministically from the sentiment summary so transcript text stays
local. Callers that explicitly accept remote inference can pass
`--allow-remote-inference`; library callers can provide an injected inference
backend or set `allowRemoteInference: true`.
