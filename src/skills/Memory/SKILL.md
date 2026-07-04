---
name: Memory
description: "Files-first assistant memory: durable notes (semantic/procedural), episodic session digests and action logs, a generated INDEX, deterministic consolidation, and a health audit. Use to remember a durable fact, recall what is known about a topic, log a session or action, run maintenance, or check memory-tree health. No LLM; every operation is a `soma memory` CLI call over markdown notes."
effort: low
version: 1.0.0
pack-id: soma-memory-v0.1.0
---

# Memory

Soma memory is a files-first store of markdown notes under the `memory/` tree.
Every note carries frontmatter (id, type, created, last_verified, provenance,
trust, source_of_truth, links, resurface_count). There is NO model in the loop:
each operation is a deterministic `soma memory` CLI subcommand. This skill routes
a memory request to the right subcommand and reads back its result — it never
edits note files by hand.

## Note model (what lives where)

| Type | Dir | What it holds | Trust |
|------|-----|---------------|-------|
| semantic | `memory/semantic/` | durable facts | principal or assistant |
| procedural | `memory/procedural/` | durable how-to / SOPs | principal or assistant |
| episodic | `memory/episodic/sessions,actions/` | session digests + planned-action logs | assistant |
| (generated) | `memory/INDEX.md` | the earned-inclusion index over durable notes | — |
| (archive) | `memory/archive/` | pruned episodic notes + monthly digests | — |

Trust is DERIVED from how a note was written, never set by a flag. A
`principal-correction` write needs `--principal-authority`; `import` writes are
lower trust. Episodic notes (session digests, action logs) are written at
`assistant` trust by the assistant itself. Consolidation NEVER mints or elevates
trust — it only ages or relocates existing notes.

## Fast Path

1. Identify the requested operation from the routing table.
2. Load ONLY that workflow file from `Workflows/`.
3. Run the single `soma memory` command it specifies; report its output verbatim.
4. Never hand-edit files under `memory/` — the CLI owns the schema, INDEX, and
   event log. Hand edits desync the INDEX (the audit will flag them).

## Routing

| Intent | Workflow | Command |
|--------|----------|---------|
| Save a durable fact / SOP | `Workflows/Remember.md` | `soma memory write …` |
| Retrieve what is known about X | `Workflows/Recall.md` | `soma memory recall <query>` |
| Log a session digest or a planned action | `Workflows/Remember.md` | `soma memory digest` / `soma memory action` |
| Run maintenance (prune, digest, stale-mark, dedup) | `Workflows/Consolidate.md` | `soma memory consolidate` |
| Check memory-tree health | `Workflows/Audit.md` | `soma memory audit` |

## When To Use

Use when the prompt is about REMEMBERING a durable fact, RECALLING what memory
holds on a topic, LOGGING a session or an approved/executed action, running
memory MAINTENANCE, or checking memory HEALTH.

Do not use for: the pre-note line-grep `soma memory search` over the legacy
`WORK/KNOWLEDGE` tree (that is a different, path-based tool); Algorithm run
recall (`soma algorithm`); or any non-memory Soma command.

## Invariants (why the audit exists)

- Notes always parse against the schema (M0).
- A durable write updates the INDEX admission ladder (M1/M3).
- Recall is READ-ONLY — it never verifies or mutates (M2).
- Consolidation is idempotent, event-logged, and never auto-merges notes (M6).
- `soma memory audit` (M7) is a smoke check, not a proof: it verifies notes PARSE
  (schema) and that INDEX.md is at least as NEW as every durable note (mtime
  freshness — NOT a check of INDEX contents), plus informational drift signals. It
  exits non-zero on a schema-invalid note or a stale-by-mtime INDEX, so it can gate
  CI. A content-correct INDEX is not proven; `soma memory reindex` rebuilds it.
