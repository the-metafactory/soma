# Audit Workflow

Run the deterministic, read-only health check over the memory tree. No LLM: every
probe reports a filesystem ground-truth fact. It is a SMOKE check that surfaces
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
| schema | YES | Every note file parses against the schema. |
| index-freshness | YES | INDEX.md is at least as new as every durable note (else run `soma memory reindex`). |
| digest-coverage | no (info) | Counts session/action notes and monthly digest files. |
| orphaned-archive | no (info) | Archived episodic notes missing from a digest (run `soma memory consolidate`). |
| event-ratio | no (info) | Event-stream lines over valid-note count. |

## Exit code

- HEALTHY → exit 0.
- UNHEALTHY → exit NON-ZERO. Cause is always a schema-invalid note or a stale
  INDEX (the two health-gating probes). The full report is still printed.

## Acting on failures

- schema FAIL: a listed note file does not parse. Inspect it; fix or remove it
  (never leave a corrupt note — it is invisible to recall and dedup).
- index-freshness FAIL: run `soma memory reindex` (a durable write landed after
  the last index build, or INDEX.md is missing).
- orphaned-archive (info): run `soma memory consolidate` to regenerate digests.

## Report

Return the report verbatim, then state the single next command to run for any
failing gated probe. Do not claim "memory is healthy" unless the audit exited 0.
