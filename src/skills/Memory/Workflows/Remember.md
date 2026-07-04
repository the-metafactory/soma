# Remember Workflow

Persist something worth keeping: a durable fact/SOP (a note), a session digest,
or a planned-action log. Pick the sub-path by DURABILITY and KIND.

## When to invoke

- User: "remember that …", "note that …", "log this decision", "record the outcome".
- End of a work session: write the one session digest.
- After an approved/executed action worth an audit trail.

## Decision

| What you're keeping | Command |
|---------------------|---------|
| A durable FACT | `soma memory write --type semantic …` |
| A durable HOW-TO / procedure | `soma memory write --type procedural …` |
| The ONE digest for this session | `soma memory digest --session <id> --body <text>` |
| A planned-action → approval → outcome entry | `soma memory action --slug <slug> …` |

## Durable write

```
soma memory write \
  --trigger <principal-correction|import> \
  --id <slug> --type <semantic|procedural> \
  --body "<the fact, one idea per note>" \
  [--principal-authority] [--source-of-truth <ref>] [--links a,b] \
  [--recall-trigger "<when this should resurface>"] [--provenance <import|tool:name>]
```

Rules:
- Trust is DERIVED from `--trigger`. `principal-correction` (a fact the principal
  asserts) REQUIRES `--principal-authority`. `import` is for lower-trust intake.
- One idea per note. Do not restate what the repo/code already records — capture
  what was non-obvious.
- To revise an existing note, use `--merge <id>` or `--supersede <id>`; never
  hand-edit the file.
- If a near-duplicate exists, the write is refused — recall first, then merge.

## Session digest

```
soma memory digest --session <session-id> --body "<8–15 non-empty lines>"
```

- Exactly ONE digest per session. A second call for the same session no-ops
  (and logs an event) — it never overwrites the first.
- The body must be 8–15 non-empty lines; anything outside that is rejected.

## Action log

```
soma memory action --slug <slug> \
  --planned-action "<what was planned>" \
  --approval <proposed|approved|rejected|auto> \
  [--outcome "<what happened>"] [--session <id>]
```

- The id is `YYYYMMDD-<slug>`; a same-day collision is refused (never overwrites).
- The session id goes in the body, not the `project` field.

## Report

Return the CLI's confirmation verbatim (id + path, or the no-op/refusal line).
Do not claim a write that the CLI did not confirm.
