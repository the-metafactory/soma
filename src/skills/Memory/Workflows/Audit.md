# Audit Workflow

Run the deterministic, read-only health check over the memory tree. No LLM: each
probe reports a deterministic filesystem observation (the event-ratio count is
best-effort — an unreadable/symlinked events file counts 0). It is a SMOKE check
that surfaces
detectable drift — a passing audit means no drift was DETECTED, not that every
invariant is proven. Use it to catch obvious breakage, or to gate CI / a
pre-consolidation check.

## When to invoke

- Before trusting recall on a load-bearing question.
- After a manual touch of the `memory/` tree, or a crashed consolidation.
- As a CI gate — it EXITS NON-ZERO when the tree is unhealthy.
- Principal says: "audit memory", "is memory healthy", "check the memory tree".

## Command

```
soma memory audit
```

## Probes

| Probe | Gates health? | What it checks |
|-------|---------------|----------------|
| root-integrity | YES | Every expected note root is absent or a REAL directory (not a symlink/non-dir). |
| schema | YES | Every note file parses against the schema. |
| index-freshness | YES | INDEX.md is at least as new as every durable note (else run `soma memory reindex`). |
| digest-coverage | no (info) | Counts session/action notes and monthly digest files. |
| orphaned-archive | no (info) | Archived episodic notes missing from a digest (run `soma memory consolidate`). |
| event-ratio | no (info) | Event-stream lines over valid-note count. |

## Exit code

- HEALTHY → exit 0.
- UNHEALTHY → exit NON-ZERO. Cause is one of the THREE health-gating probes:
  root-integrity, schema, or index-freshness. The full report is still printed;
  read each probe's `gatesHealth`/`ok` rather than assuming the cause.

## Acting on failures

- root-integrity FAIL: a note root (e.g. `memory/semantic`) exists but is a symlink
  or non-directory — the corpus is inaccessible/redirected. Restore it to a real
  directory before trusting recall.
- schema FAIL: a listed note file does not parse. Inspect it; fix or remove it
  (never leave a corrupt note — it is invisible to recall and dedup).
- index-freshness FAIL: run `soma memory reindex` (a durable write landed after
  the last index build, or INDEX.md is missing/abnormal).
- orphaned-archive (info): run `soma memory consolidate` to regenerate digests.

## Report

Return the report verbatim, then state the single next command to run for any
failing gated probe. Do not claim "memory is healthy" unless the audit exited 0.
