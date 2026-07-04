# Recall Workflow

Retrieve what durable memory holds about a topic BEFORE answering from your own
recollection or writing a new note. Recall is READ-ONLY.

## When to invoke

- Before asserting a remembered fact ("we decided X", "the stack is Y").
- Before a durable write, to avoid creating a near-duplicate.
- Principal says: "what do we know about …", "have we noted …", "recall …".

## Command

```
soma memory recall "<query>" [--limit <n>]
```

What it does (deterministic, no LLM):
- Term-scores whole durable notes (semantic + procedural) against the query.
- Returns the top matches (default limit 3) plus their 1-hop linked notes.
- EXCLUDES superseded notes (those with a `valid_until`).
- Attaches a verification banner to each hit: age since `last_verified`, trust,
  provenance, and the `source_of_truth` to check against.

## Reading the result

- Treat a note as a POINTER, not gospel. The banner says how stale it is and
  what the ground-truth source is — verify against that source before relying on
  a load-bearing fact.
- A `QUARANTINED` note is untrusted; surface it as such, never as fact.
- Nothing returned ≠ nothing true. Say memory has no note on it, then proceed.

## Do not

- Do not verify or edit as part of recall — verifying is a separate,
  authority-gated act (`soma memory verify`).
- Do not paraphrase a note as your own knowledge without the banner's caveat when
  it is stale.
