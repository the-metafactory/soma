# Private Source Guard V0

Soma separates the public code repo from private installed context.

- `~/work/mf/soma` should stay generic and releasable.
- `~/.soma` is private by design: identity, telos, imported PAI context, memory,
  and work state live there.
- substrate projections such as `~/.codex/memories/soma/` and
  `~/.pi/agent/soma/` are also private projections.

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

## Protected Path Modify vs Delete

The path guard distinguishes the `modify` and `delete` actions:

- `delete` blocks any destructive operation against any descendant of a
  protected root. `rm -rf ~/.soma`, `rm -rf ~/.soma/memory`, `rm -rf ~/.claude`
  are all denied. There is no escape hatch for delete.
- `modify` blocks overwrites of the protected root by default, but a
  `SomaProtectedPath` may declare `allowedSubpaths` — relative subpaths under
  the root where modify is permitted because the substrate is expected to
  write there.

The default protected paths declare these allowed modify subpaths:

| Root         | Allowed modify subpaths                | Rationale                                            |
| ------------ | -------------------------------------- | ---------------------------------------------------- |
| `~/.soma`    | `isa/`, `memory/`                      | ISA edits and memory writes are the assistant's job  |
| `~/.claude`  | `memory/`, `memories/`, `PAI/MEMORY/`  | Claude Code and PAI write working memory under these |
| `~/.pi`      | `agent/memory/`                        | Pi.dev agent memory                                  |

Writes to a protected root that fall outside its `allowedSubpaths` remain
denied. `~/.soma/profile/identity.md` and `~/.soma/secret.md` are blocked for
modify even though `~/.soma/isa/draft.md` is allowed. This keeps private roots
(profile, identity, telos) safe while letting the assistant manage its own
memory and ISA artifacts. See issue #79 (Pi.dev) and #48 (Codex) for the
matching substrate-hook refinements.

## Pi.dev Projection

The Pi.dev home projection renders a `tool_call` extension
(`agent/extensions/soma-path-guard.ts`) that reuses the portable
`evaluatePathGuard` runtime with the explicit Soma home appended to
`SOMA_DEFAULT_PROTECTED_PATHS`. The same `allowedSubpaths` apply to the
explicit Soma home (`isa/`, `memory/`), so Pi.dev `write` and `edit` tool
calls into `~/.soma/isa/*.md` and `~/.soma/memory/*/` pass while
`rm -rf ~/.soma` and writes to `~/.soma/profile/` stay blocked (#79).

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

This is not ShadowRelease. It does not run TruffleHog, validate dashboards, or
prove full public artifact cleanliness.

Soma does include a narrow release-time privacy check:

```bash
bun run check-release-privacy
```

That script scans tracked text files, flags absolute private PAI/Soma source
roots, and matches configured forbidden phrase hashes without storing raw private
phrases in the repository. It is a deterministic fail-fast guard for known leak
classes, not a comprehensive secret scanner.
