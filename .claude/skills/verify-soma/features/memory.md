# Memory

The principal records durable notes with `soma memory write`, finds them with `recall`/`search`, and sees them projected into the substrate's memory index (`rules/soma/MEMORY.md` for claude-code). `audit` is the read-only health check.

## Sub-features

- `mem-write` creates a principal-trust note from a correction.
- `mem-recall` returns the note with its verification banner.
- `mem-audit` fails while `INDEX.md` is stale, passes after reindex.
- `mem-reproject` rebuilds `INDEX.md` and the substrate's `MEMORY.md`.

## How to get to it (user POV)

- `soma memory write --trigger principal-correction --principal-authority --id <slug> --type semantic --body <text> [--recall-trigger <text>]`
- `soma memory recall <query>` / `soma memory search <query>`
- `soma memory audit`, `soma memory reindex`, `soma memory reproject --substrate claude-code`

## Driving it with verify-soma.sh

Preconditions:

- `$V launch "$RUN"` done; no note `verify-probe-note` exists.

- **Write.** `$V soma "$RUN" memory write --trigger principal-correction --principal-authority --id verify-probe-note --type semantic --body "Probe note: the scratch kettle whistles in B flat." --recall-trigger "kettle pitch"`. Prints `trust: principal` and `path: …/memory/semantic/verify-probe-note.md`, exit 0.
- **Recall.** `$V soma "$RUN" memory recall "kettle pitch"`. Shows `verify-probe-note [semantic] · 2 terms matched` and the body.
- **Audit stale.** `$V soma "$RUN" memory audit`. `[FAIL] index-freshness`, exit 1.
- **Reproject.** `$V soma "$RUN" memory reproject --substrate claude-code`. Prints `reindexed: yes`; `grep verify-probe-note "$RUN/home/.claude/rules/soma/MEMORY.md"` matches.
- **Audit clean.** `$V soma "$RUN" memory audit` exits 0.
- **Proof.** `cp "$RUN/home/.soma/memory/semantic/verify-probe-note.md" "$RUN/home/.claude/rules/soma/MEMORY.md" "$RUN/evidence/"`.

## Gotchas

- `principal-correction` without `--principal-authority` is refused (fail-closed by design).
- A near-duplicate body is refused by recall-first; `--upsert` merges instead. Use a distinctive body.
- `recall` appends a `memory.recall` event; it is not side-effect free on the event log.
