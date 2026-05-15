# Memory And Policy V0

Soma should not solve rich memory and cross-substrate enforcement at the same
time. Version 0 uses a small file-based memory contract and explicit policy
projection.

## Memory V0

Memory is a directory layout, not a database:

```text
MEMORY/
  WORK/
  KNOWLEDGE/
  LEARNING/
  RELATIONSHIP/
  STATE/
```

The initial portable operations are:

- read named files
- search text with deterministic tooling
- summarize selected files into substrate context
- append substrate events to `memory/STATE/events.jsonl`
- append learning notes through explicit tools or patches

The first implemented recall surface is `soma memory search --query <text>`.
It searches profile/import files plus WORK, KNOWLEDGE, LEARNING, RELATIONSHIP,
and selected STATE files, then returns cited path/line/snippet matches. This is
not semantic memory yet; it is the portable file-backed retrieval floor that
substrates can call before answering.

The first implemented promotion surface is
`soma memory promote --from-run <id> --store <learning|knowledge|relationship|work> --substrate <substrate>`.
It writes a concise Markdown note under `memory/<STORE>/PROMOTED/` and appends a
`memory.promotion` event to `memory/STATE/events.jsonl`. Promotion is explicit
because durable memory stores are source-of-truth material, not scratch space.
Promotion requires verified source work: at least one verification entry or
passed criterion must exist on the source Algorithm run.

The first implemented feedback surface is
`soma feedback capture --text <text> --substrate <substrate>`. It detects likely
corrections, preferences, missed surfaces, relationship notes, and task
learning, then appends a `feedback.candidate` event to
`memory/STATE/events.jsonl`. Feedback capture never writes durable memory
directly. Candidate events must be reviewed or promoted by a later explicit
workflow.

`PROMOTED/` has V0 merge semantics. Promoted notes are immutable additive
records, keyed by sanitized title plus source run id. Creation is atomic and a
duplicate promotion is refused rather than merged or overwritten. These notes do
not merge into canonical store files automatically; later consolidation must read
the source note and `memory.promotion` event explicitly.

`memory/STATE/events.jsonl` is the first writeback contract. Substrates append
one JSON object per line with `id`, `timestamp`, `substrate`, `kind`, `summary`,
and optional artifact paths or metadata. Consolidation into `KNOWLEDGE`,
`LEARNING`, or other durable stores is a later step.

Durable memory writes outside the append-only `PROMOTED/` subspace are
intentionally blocked until each store has explicit merge semantics. See
[writeback-and-policy.md](./writeback-and-policy.md).
Promotion from events into durable stores is a future design decision, not an
automatic background behavior.

Vector search, long-running recall daemons, and automatic consolidation are
later layers. They must preserve the file contract.

## Policy V0

Policy has two layers:

1. Deterministic checks where the substrate exposes controls.
2. Rendered instructions where deterministic enforcement is not available.

Adapters must state which policies are enforceable and which are advisory. A
substrate with weaker controls is allowed, but the bundle must make that
weakness visible.

Uniform enforcement across substrates is not currently implemented. Policy
projection is data; enforcement is substrate-specific until adapter hooks,
sandboxes, or daemon controls exist.

## Verification V0

Every task-facing ISA should include verification criteria. Adapters can add
substrate-native verification commands, but they must not replace the ISA as
the source of truth for done.
