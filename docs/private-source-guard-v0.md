# Private Source Guard V0

Soma separates the public code repo from private installed context.

- `~/work/mf/soma` should stay generic and releasable.
- `~/.soma` is private by design: identity, telos, imported PAI context, memory,
  and work state live there.
- substrate projections such as `~/.codex/memories/soma/` and
  `~/.pi/agent/soma/` are also private context surfaces.

V0 protects the mistake classes that matter first:

- moving private Soma/source material into a public destination
- destructively deleting or moving private memory/configuration roots

Memory roots are protected assets, not forbidden destinations. Normal memory
writes stay allowed.

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

A write is denied when the destination is outside private Soma/projection/memory
roots and either:

- `--source` points under a private Soma/projection root, or
- the proposed content contains a private Soma/projection root marker.

Private roots include:

- `~/.soma/profile`
- `~/.soma/memory`
- `<codex-home>/memories`
- `~/.codex/memories/soma`
- `~/.codex/skills/soma`
- Claude memory roots such as `<claude-home>/memory`,
  `<claude-home>/memories`, and `<claude-home>/PAI/MEMORY`
- `~/.pi/agent/soma`
- `~/.pi/agent/skills/soma`

Writes inside those roots are allowed. This avoids blocking normal memory,
profile, and projection maintenance.

Delete and destructive move operations are stricter. The path guard blocks
destructive operations that target protected memory/configuration roots, such as
removing the Codex memory directory, removing the Soma home, or a patch
`Delete File` inside a protected memory root. This is separate from ordinary
write checks so memory can remain writable without allowing directory-removal
accidents.

## Codex Projection

The Codex home projection installs a `PreToolUse` hook for `Write`, `Edit`,
`MultiEdit`, `apply_patch`, and shell tools. The hook calls:

```bash
SOMA_POLICY_TARGETS='[{"filePath":"<path>","content":"<content>","action":"write"}]' \
  bun run soma policy check --soma-home <home> --substrate codex --action write --targets-env SOMA_POLICY_TARGETS --private-root <adapter-memory-root> --record deny --json
```

The hook first performs a cheap in-process precheck. If the proposed write does
not mention private Soma/projection roots and is not a destructive protected-path
operation, it does not start the CLI or write an audit event. If a private marker
or protected destructive operation is present, it calls the checker in JSON mode
with `--record deny`. Denials and checker failures both return a Codex
`PreToolUse` `permissionDecision: deny`.

## Non-Goals

This is not ShadowRelease. It does not scan staged releases, run TruffleHog,
validate dashboards, or prove public artifact cleanliness. Those retrospective
release gates can be built later on top of the same policy model.
