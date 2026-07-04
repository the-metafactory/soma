# Consolidate Workflow

Run deterministic memory maintenance: prune aged episodic notes into the archive
(regenerating monthly digests), mark aged-unverified semantic notes `review:stale`,
list lexical near-duplicate pairs for review, and rebuild the INDEX. No LLM;
nothing is auto-merged.

## When to invoke

- Periodic housekeeping (the memory tree has grown; digests/INDEX may lag).
- The audit reported orphaned-archive drift or a stale INDEX.
- Principal says: "consolidate memory", "tidy up memory", "run memory maintenance".

## Preview first (always)

```
soma memory consolidate --dry-run
```

`--dry-run` prints the exact file OPERATIONS the real run would apply (archive
moves, stale marks, digest regenerations, similar pairs) and touches nothing.
Read it before running for real.

## Apply

```
soma memory consolidate
```

Operations, in order:
1. Prune aged episodic — sessions >90d, actions >180d (by `created`) → regenerate
   the month's digest from the archive, then move the note under `memory/archive/`.
2. Mark aged-unverified semantic notes (>180d, never resurfaced) `review:stale` —
   the principal reviews them; nothing is auto-archived.
3. List the top lexical near-duplicate pairs (Jaccard ≥ 0.6) for review. This is a
   LISTING only — no semantic contradiction check, and nothing is merged.
4. Rebuild `INDEX.md` and append one `memory.consolidate` event — ONLY when the
   pass actually changed something.

## Destructive state GC (opt-in)

```
soma memory consolidate --gc-state
```

Additionally DELETES `current-work-*.json` state older than 7 days. This is the
pass's only deletion and needs the explicit flag — omit it unless you intend to
GC protected state.

## Report

Return the CLI summary verbatim. If it lists `unreadable` note files, surface
them — they were skipped, and the audit should be run to investigate.
