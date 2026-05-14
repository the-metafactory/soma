# Private Source Guard V0

Soma separates the public code repo from private installed context.

- `~/work/mf/soma` should stay generic and releasable.
- `~/.soma` is private by design: identity, telos, imported PAI context, memory,
  and work state live there.
- substrate projections such as `~/.codex/memories/soma/` and
  `~/.pi/agent/soma/` are also private context surfaces.

V0 protects the narrow mistake class that matters first: moving private Soma
source material into a public destination.

## CLI

```bash
bun run soma policy check --action write --destination ./README.md --content "..."
```

The checker returns `decision: allow` or `decision: deny` and appends a
`policy.check` event to `~/.soma/memory/STATE/events.jsonl` by default. Use
`--record deny` for write hooks that should audit denials only, or
`--record none` for pure evaluation. Use `--json` when another process depends
on the result.

## Deny Conditions

A write is denied when the destination is outside private Soma/projection roots
and either:

- `--source` points under a private Soma/projection root, or
- the proposed content contains a private Soma/projection root marker.

Private roots include:

- `~/.soma/profile`
- `~/.soma/memory`
- `~/.codex/memories/soma`
- `~/.codex/skills/soma`
- `~/.pi/agent/soma`
- `~/.pi/agent/skills/soma`

Writes inside those roots are allowed. This avoids blocking normal memory,
profile, and projection maintenance.

## Codex Projection

The Codex home projection installs a `PreToolUse` hook for `Write`, `Edit`,
`MultiEdit`, and `apply_patch`. The hook calls:

```bash
bun run soma policy check --soma-home <home> --substrate codex --action write --destination <path> --content-env SOMA_POLICY_CONTENT
```

The hook first performs a cheap in-process marker precheck. If the proposed
write does not mention private Soma/projection roots, it does not start the CLI
or write an audit event. If a private marker is present, it calls the checker in
JSON mode with `--record deny`. Denials and checker failures both return a Codex
`PreToolUse` `permissionDecision: deny`.

## Non-Goals

This is not ShadowRelease. It does not scan staged releases, run TruffleHog,
validate dashboards, or prove public artifact cleanliness. Those retrospective
release gates can be built later on top of the same policy model.
