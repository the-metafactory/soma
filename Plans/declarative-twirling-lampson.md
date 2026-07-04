# Plan: `soma memory backfill` — bulk legacy-content importer (M8)

## Context

The note-based Memory subsystem (M0–M7) shipped, but on a freshly-migrated store
the **durable corpus is empty**: `memory/` has no `semantic/` or `procedural/`
directory — only auto-generated `episodic/` digests plus **legacy pre-M0
content** in free-form category dirs (`LEARNING/`, `KNOWLEDGE/`, `WORK/`, …).
Legacy files can even carry a stopgap banner: *"re-promote via `soma memory
write` once M1 ships."*

For **shipping Soma to other users**, we need a first-class, reusable command
that takes a principal's existing markdown memory and turns it into schema-valid,
governed notes — deterministically, no LLM (subsystem invariant), respecting the
M1 trust-governance model. This is milestone **M8 — backfill**.

**Key design facts established during exploration:**
- The `import` write trigger is the sanctioned bulk path: `SOMA_MEMORY_TRIGGER_TRUST.import → "quarantined"`, needs **no authority signal** (`memory-write.ts:30`, MINJA defense). Backfilled content lands untrusted by design.
- Lifecycle is correct, not a dead end: **recall INCLUDES quarantined notes** with a ⚠ untrusted banner (`memory-recall.ts:136,162` — only `valid_until===null` is filtered, not trust), while **INDEX EXCLUDES quarantined** (`memory-index.ts:17`). So imports are pull-discoverable immediately and earn always-on INDEX only after the principal verifies/elevates them.
- `writeMemoryNote({mode:"create", trigger:"import", …})` (`memory-write.ts:779`) already does schema serialization, per-note dedup (recall-first refusal, Jaccard ≥0.6 / exact-body), and event journaling. Backfill is a **batch importer over this existing path**, not a new writer.
- Idempotency pattern to mirror: `src/pai-memory-migrator.ts` (SHA manifest, skip-unchanged, byte-stable no-op rerun, symlink refusal).

## Approach

New subcommand:

```
soma memory backfill [--from <dir>] [--type semantic|procedural]
                     [--project <key>] [--dry-run]
                     [--soma-home <dir>] [--home-dir <dir>]
```

- **`--from`** (default `<somaHome>/memory`): source root walked recursively.
- **`--type`**: force ALL notes to one type, overriding the category map.
- **`--project`**: set note `project` field (default `null`).
- **`--dry-run`**: print the plan table, touch nothing.

### Category → type mapping (the chosen model)

Map by the **top-level category dir** (first path segment under the source root):

| Category dir | Note type |
|---|---|
| `LEARNING` (incl. `ALGORITHM/`, `PROMOTED/`, `REFLECTIONS/`) | `procedural` (how-to / behavioral lessons) |
| `KNOWLEDGE` (incl. `PROMOTED/`, `Research/`) | `semantic` (facts) |
| any other category | `semantic` (fallback) |

`--type` overrides the map entirely. Trust is **always `quarantined`** (derived
from the `import` trigger — the map affects *type*, never trust; elevating trust
deterministically would blow open the MINJA hole for anyone who can drop a file
in the source dir).

**Skipped, never imported:** reserved dirs `STATE`, `episodic`, `semantic`,
`procedural`, `archive`, `imports`; any `README.md` (case-insensitive);
non-markdown files; symlinks anywhere (loud refusal, matching the migrator's
stance). Files sitting directly under the root are skipped **only for the
default `<somaHome>/memory` root** (README/`INDEX.md` territory); a custom
`--from <dir>` imports its top-level markdown (category `""` → semantic).

### Per-file note synthesis (deterministic)

For each eligible source file at relative path `rel`:
- **id** = `slugify("<category>-<stem>")`, ≤64 chars, collision-suffixed (`-2`, `-3`) against both the in-run set and the existing corpus. Must satisfy the note SLUG shape (the write path binds `id` → `<type>/<id>.md` filename).
- **type** = category map (or `--type`).
- **created / last_verified** = file **mtime** → `YYYY-MM-DD` UTC (injected via `writeMemoryNote`'s `now` option, set per-file to `new Date(mtimeMs)`).
- **provenance** = `import`; **trust** = `quarantined` (derived).
- **source_of_truth** = absolute path of the original file (so the principal can verify against the archived original).
- **project** = `--project` or `null`; **links** = `[]`; **resurface_count** = 0.
- **hook** = short humanized recall phrase from the stem (optional; aids recall matching).
- **body** = original file content **verbatim** — no injected preamble (a shared preamble inflates token overlap and makes the recall-first dedup over-fire on short files; origin lives in frontmatter instead). Only `.md`/`.markdown` files are imported.

### Dedup & idempotency

- Files processed **sequentially** (not concurrent) so later files see earlier-written ones and the recall-first refusal dedups within the batch deterministically.
- A per-file **recall-first refusal** (exact/near-dup already in corpus) is caught and counted as `skipped-duplicate`, not a batch abort (`memory-write.ts:618` builds the refusal — implementation inspects that surface to classify).
- Manifest `<somaHome>/memory/STATE/imports/backfill/.manifest.json` (schema `soma.memory-backfill.v1`, entries `{relativePath, noteId, type, sha256, mtimeMs}`) — inside the Memory compartment, under the reserved STATE dir the source walk never re-imports. Rerun skips a file only when its source SHA matches, its resolved type matches the prior import, AND its target note still exists; the prior entry is re-emitted verbatim → byte-stable no-op (even across a `touch`). An edited source (new SHA) is re-processed through the write path — written as a *new* note, OR classified `skipped-duplicate` if the edited body still trips the recall-first refusal against an existing note (no auto-supersede in v1).

### Result / reporting

`runMemoryBackfill` returns `{ somaHome, from, dryRun, writtenCount, skippedManifestCount, skippedDuplicateCount, errorCount, manifestPath, entries }` (each `entries[]` item carries `relativePath`, `noteId`, `type`, `created`, `target`, and a per-file `status`); CLI prints a summary table. `--dry-run` prints the plan without writing or touching the manifest.

## Files to create / modify

1. **`src/memory-backfill.ts`** (new, ~250 LOC) — `planMemoryBackfill()` + `runMemoryBackfill()`; category map, markdown-only file walk (skip/symlink rules), id derivation + collision handling, mtime→date, verbatim body, manifest read/render, sequential loop calling `writeMemoryNote`. Reuses the write path (serialization, dedup, events) rather than re-implementing note I/O.
2. **`src/types.ts`** — add `SomaMemoryBackfillOptions`, `SomaMemoryBackfillPlanEntry`, `SomaMemoryBackfillResult`, manifest types, and `SOMA_MEMORY_BACKFILL_TYPE_MAP` constant (near the other memory-subsystem types).
3. **`src/cli/memory.ts`** — add `"backfill"` to `MEMORY_ACTIONS`; `ParsedMemoryBackfillArgs` + union member; `parseMemoryBackfillArgs`; a `MEMORY_COMMAND_HELP.subcommands.backfill` usage string; dispatch `case "backfill"`; handler calling `runMemoryBackfill` + a `formatMemoryBackfillResult`.
4. **`test/memory-backfill.test.ts`** (new) — mirror `pai-memory-migrator.test.ts` + `memory-write.test.ts` patterns: category→type mapping, id derivation + collision, mtime→created, trust=quarantined, dedup skip, `--dry-run` no-op, idempotent rerun (byte-stable manifest), symlink refusal, reserved-dir skipping.
5. **Docs** — one usage line in `docs/memory-policy-v0.md` (or the M-milestones list) noting M8; short README mention if the Memory section enumerates subcommands.

## Verification

- `bun test test/memory-backfill.test.ts` — unit coverage above.
- `bun test` — full suite green (no regression in `memory-*`, `pai-migration-*`).
- Typecheck + LSP diagnostics clean on the three edited/new source files.
- **Live acceptance against a throwaway `--soma-home` fixture:**
  - `soma memory backfill --dry-run` → shows `KNOWLEDGE/*`→semantic, `LEARNING/*`→procedural, nothing written.
  - Real run: notes land in `semantic/`/`procedural/`, `trust: quarantined`, `provenance: import`, `created` = source mtime.
  - `soma memory audit` passes (schema-valid, INDEX fresh) — backfill rebuilds the INDEX after writing, so index-freshness holds without a separate `reindex` step.
  - `soma memory recall <term>` surfaces a backfilled note **with the ⚠ untrusted banner**; `soma memory reindex` keeps them **out** of INDEX (quarantined) — confirming the intended lifecycle.
  - Rerun `backfill` → 0 written / all skipped, manifest byte-identical.

## Out of scope (v1)

- LLM distillation of legacy content (subsystem is deterministic-only; bodies are wrapped verbatim).
- Auto-supersede on source drift (rerun re-imports changed files as new notes).
- Trust elevation of imports (stays `quarantined`; the principal elevates later via the verify/supersede path — a separate, deliberate step).
- Non-markdown / recall-SQLite sources (SQLite-as-canon explicitly rejected, plan v2 §fatal-flaws).
