# Default Availability

Soma must be available by default, not only inside individual project
repositories.

PAI proves the pattern in Claude Code: it installs into `~/.claude/` so the
assistant is present whenever Claude starts. Project-local `CLAUDE.md` files are
overlays; they do not carry the whole assistant.

## Principle

Soma has two projection layers:

1. **Home projection**: installed into the substrate's user-level configuration
   directory. This makes the assistant available by default.
2. **Workspace projection**: installed into a project directory. This adds
   project-specific context, ISA, skills, and policy overlays.

The home projection is the primary install target. Workspace projection is a
secondary overlay.

## PAI Reference Shape

PAI's Claude integration uses:

- `~/.claude/CLAUDE.md` for always-loaded context routing and operating rules.
- `~/.claude/settings.json` for environment, permissions, hooks, and statusline.
- `~/.claude/hooks/` for lifecycle integration.
- `~/.claude/skills/` for globally available skills.
- `~/.claude/agents/` for globally available specialists.
- `~/.claude/commands/` for slash commands.
- `~/.claude/PAI/USER/` for principal identity, DA identity, and TELOS.
- `~/.claude/PAI/MEMORY/` for durable memory.
- `~/.claude/PAI/PULSE/` for daemon behavior, notifications, and dashboards.

That shape is Claude-specific, but the design lesson is portable: the assistant
has a durable home, and project-local files only specialize it.

## Soma Home Layout

Soma's substrate-neutral home should be:

```text
~/.soma/
  profile/
    assistant.md
    principal.md
    telos.md
  memory/
    WORK/
    KNOWLEDGE/
    LEARNING/
    RELATIONSHIP/
    STATE/
  skills/
  policy/
  projections/
    codex/
    pi-dev/
    claude-code/
```

`~/.soma/` is the source of truth. Substrate homes receive projections.

## Substrate Home Projections

### Codex

Observed Codex user-level surfaces include `~/.codex/config.toml`,
`~/.codex/rules/`, `~/.codex/skills/`, and `~/.codex/memories/`.

Initial Soma projection target:

```text
~/.codex/
  rules/soma.rules
  skills/soma/
  memories/soma/
```

Codex project overlays may still write `.codex/soma/` into a workspace.

### Claude Code

Initial Soma projection target:

```text
~/.claude/
  CLAUDE.md
  settings.json
  skills/Soma/
  hooks/soma/
  agents/soma/
  commands/soma.md
  soma/
```

This projection should merge or patch existing user config instead of blindly
replacing it. PAI's installer warns and backs up because it owns the whole
Claude home; Soma should be less invasive.

### Pi.dev

Pi.dev should receive a user-level extension projection when its home directory
and extension conventions are confirmed. Until then, Soma can generate a
workspace-shaped `.pi/extensions/soma-core/` bundle and keep the home target as
an adapter-specific open item.

### Cortex / Myelin

Cortex default availability should be daemon registration, not copied prompt
files:

```text
~/.config/cortex/agents.d/soma.json
~/.soma/
```

The daemon consumes Myelin envelopes and reads the same `~/.soma/` source data.

## Install Commands

The CLI should reflect this split:

```bash
soma install --substrate codex
soma install --substrate claude-code
soma install --substrate pi-dev
soma install --substrate cortex

soma project install --substrate codex --root .
```

`install` targets the substrate home. `project install` targets a workspace.

## Safety Rules

- Never overwrite an existing substrate home file without a backup or merge
  strategy.
- Keep `~/.soma/` as source of truth; generated substrate files are projections.
- Mark generated files clearly.
- Workspace overlays must not duplicate private identity unless explicitly
  requested.
- Every projection must declare which behavior is deterministic and which is
  advisory.
