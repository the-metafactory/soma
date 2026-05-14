# Substrate Adapters

Soma treats execution environments as adapters. Each adapter maps the same
assistant core into different host primitives.

## Codex

Codex is a coding-agent substrate. The adapter should package:

- system/developer instruction fragments
- Soma identity and telos context
- active ISA summary
- relevant skills as local instructions
- memory readback
- verification policy

Open question: whether Codex plugins should carry the adapter or whether Soma
should generate a workspace-local instruction bundle consumed by Codex.

Initial answer: start with workspace-local context generation. `buildCodexContext`
returns deterministic files under `.codex/soma/` plus an instruction string.
Codex execution and plugins come later, after the same input can be projected
into at least one second substrate.

Next answer: add a home projection for `~/.codex/` so Soma is available by
default. Workspace-local `.codex/soma/` files should become project overlays,
not the main install surface.

## Pi.dev

Pi.dev is model-agnostic and supports extensions and skills. The adapter should
follow the reduced PAI-on-Pi pattern:

- one core extension
- registered tools for ISA, memory, learning, and notifications
- skill directories with `SKILL.md`
- settings and model provider config

The first useful Pi adapter can be a `soma-core` extension with:

- `isa_create`
- `isa_update`
- `memory_search`
- `capture_learning`
- `policy_check`

Initial implementation: `buildPiDevContext` generates a workspace-shaped
`soma-core` extension projection under `.pi/extensions/soma-core/`. It includes
an extension manifest, portable context, tool contract, memory layout, skills,
and policy projection. The tools are named as the adapter contract; execution is
not wired yet.

Home implementation: `buildPiDevHomeContext` projects into `~/.pi/agent/`:
`agent/extensions/soma.ts` registers the `soma_context` tool, while
`agent/soma/` holds generated context snapshots. The tool can read projected
profile/context files and detailed imported PAI source files under `~/.soma`.

## Claude Code

Claude Code has the richest native surface:

- system prompt append
- `CLAUDE.md`
- hooks
- skills
- agents
- slash commands
- statusline

The Claude adapter can be the highest-fidelity implementation, but the core must
not depend on Claude-only primitives. Hooks should improve behavior; they should
not be required for the storage contract to function.

Initial implementation: `buildClaudeCodeContext` generates a Claude-shaped
projection with `CLAUDE.md` plus `.claude/soma/` context files. Hooks are
documented as optional enhancements, not requirements for the portable core.

The Claude Code adapter should support a home projection into `~/.claude/`.
This is how PAI is deeply integrated: global `CLAUDE.md`, settings, hooks,
skills, agents, commands, user identity, memory, and daemon support are available
at every Claude Code startup. Soma should project into that shape without making
Claude Code the source of truth.

## Cortex / Myelin

Cortex is the Meta Factory collaboration surface. Myelin is the protocol stack.
Soma can integrate in two ways:

1. **In-process assistant profile**: Cortex uses Soma context when spawning a
   substrate session.
2. **Standalone daemon**: Soma subscribes to Myelin subjects, claims personal
   assistant tasks, updates its own memory, and publishes envelopes.

The daemon shape should follow the existing standalone agent pattern:

- `type: agent`
- `targets: [cortex, darwin-launchd]`
- identity fragment in `~/.config/cortex/agents.d/`
- NATS credentials issued by Cortex
- capabilities registered on startup

## Adapter Contract

Adapters should be thin. They do not own identity, memory, ISA, skill schemas, or
policy semantics. They only translate those contracts into a substrate's native
mechanisms.

The first portability proof is documented in
[portability-proof.md](./portability-proof.md). Memory and policy v0 are
documented in [memory-policy-v0.md](./memory-policy-v0.md).
