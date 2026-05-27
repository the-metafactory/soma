# Home Projection Defaults

Soma must be available by default, not only inside individual project
repositories. This doc describes the **home** mode (the primary projection
target) and the **workspace** overlay. See [CONTEXT.md](../CONTEXT.md) for
glossary; modes are `home`, `workspace`, `library`, `daemon`, `export`.

PAI proves the pattern in Claude Code: it installs into `~/.claude/` so the
assistant is present whenever Claude starts. Project-local `CLAUDE.md` files are
overlays; they do not carry the whole assistant.

## Principle

Soma supports two projection placements relevant to default availability:

1. **home** mode: the projection is installed into the substrate's user-level
   configuration directory. This makes the assistant available by default.
2. **workspace** mode: the projection is installed into a project directory.
   This adds project-specific ISA, skills, and policy overlays.

The home projection is the primary install target. The workspace projection is
a secondary overlay that takes precedence inside that workspace.

A projection is a generated snapshot, not a symlink, live overlay, or
authoritative copy. The Identity compartment projects eagerly; Skills project
as an indexed registry; Memory archives are on-demand. Refresh is on demand
through `soma install` / `soma reproject`; substrate startup does not
auto-refresh projections in V0. See [writeback-and-policy.md](./writeback-and-policy.md)
for writeback semantics.

## PAI Reference Shape

PAI's Claude integration uses:

- `~/.claude/CLAUDE.md` for the eagerly-loaded routing and operating rules.
- `~/.claude/settings.json` for environment, permissions, hooks, and statusline.
- `~/.claude/hooks/` for lifecycle integration.
- `~/.claude/skills/` for globally available Claude Code skills.
- `~/.claude/agents/` for globally available Claude Code sub-agents.
- `~/.claude/commands/` for slash commands.
- `~/.claude/PAI/USER/` for principal identity, assistant identity, and TELOS.
- `~/.claude/PAI/MEMORY/` for protected memory.
- `~/.claude/PAI/PULSE/` for daemon behavior, notifications, and dashboards.

That shape is Claude-specific, but the design lesson is portable: the assistant
has a protected home, and project-local files only specialize it.

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

The implemented bootstrap slice is `bootstrapSomaHome`, which creates the
starter profile files, memory directories, skill/policy directories, projection
directories, and returns a `ProjectionInput` loaded from those files.

## Substrate Home Projections

### Codex

Observed Codex user-level surfaces include `~/.codex/config.toml`,
`~/.codex/rules/`, `~/.codex/skills/`, and `~/.codex/memories/`.

Codex `*.rules` files are parsed as Starlark permission rules, not Markdown
assistant instructions. Soma therefore keeps `rules/soma.rules` comment-only as
a parse-safe projection marker. The eager Soma content lives in the projected
Codex instruction and memory files.

Initial Soma projection target:

```text
~/.codex/
  rules/soma.rules
  skills/soma/SKILL.md
  memories/soma/profile.md
  memories/soma/memory-layout.md
  memories/soma/skills.md
  memories/soma/policy.md
```

Codex workspace overlays may still write `.codex/soma/` into a workspace.

The implemented first slice is `buildCodexHomeProjection`, which resolves
`~/.soma` and `~/.codex`, builds the Codex home projection, and can materialize
it with `installCodexHomeProjection`.

The first end-to-end install function is `installSomaForCodex`. It bootstraps
`~/.soma`, loads that source, then projects it into `~/.codex`.

### Claude Code

Current Soma projection target:

```text
<claude-home>/
  settings.json
  rules/soma/
  skills/ISA/
  hooks/soma/soma-claude-code-hook.mjs
  hooks/soma/soma-claude-code-hook.config.json
```

This projection patches existing user config instead of replacing it. The
settings patch adds Soma-owned lifecycle/writeback hook entries and leaves
non-Soma hook entries intact. Uninstall removes only generated Soma files and
matching Soma hook entries.

### Pi.dev

Pi.dev receives a user-level extension projection under the observed Pi.dev
home layout:

```text
~/.pi/
  agent/extensions/soma.ts
  agent/soma/context.md
  agent/soma/profile.md
  agent/soma/memory-layout.md
  agent/soma/pai-imports.md
  agent/soma/tools.md
  agent/soma/skills.md
  agent/soma/policy.md
  agent/skills/soma/SKILL.md
```

The extension registers a `soma_context` tool for reading the projected
profile, memory layout, PAI import index, and selected source files under
`~/.soma`. It also appends Soma identity to Pi.dev's system prompt during
`before_agent_start`, because tools alone are not enough for default identity
behaviour. The projection files remain generated snapshots; `~/.soma` is still
authoritative.

### Cortex / Myelin

Cortex default availability should be Cortex agent registration, not copied
prompt files:

```text
~/.config/cortex/agents.d/soma.json
~/.soma/
```

The Cortex agent daemon consumes Myelin envelopes and reads the same
`~/.soma/` source data.

## Install Commands

The CLI should reflect the home/workspace split:

```bash
soma install codex
soma install claude-code
soma install pi-dev
soma install cortex

soma install codex --workspace
```

`install` targets the substrate home by default. `--workspace` targets the
current workspace overlay. (CLI alignment tracked in #54.)

## Safety Rules

- Never overwrite an existing substrate home file without a backup or merge
  strategy.
- Keep `~/.soma/` as source of truth; generated substrate files are projections.
- Mark generated files clearly.
- Workspace overlays must not duplicate private identity unless explicitly
  requested.
- Every projection must declare which behavior is deterministic and which is
  advisory.
