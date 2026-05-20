# Substrate Adapters

Soma treats execution environments as substrates. One adapter per substrate
projects the same Soma into different substrate-native primitives. See
[CONTEXT.md](../CONTEXT.md) for glossary.

## Codex

Codex is a coding-agent substrate. The Codex projection should carry:

- system/developer instruction fragments
- Soma identity and telos
- active ISA summary
- relevant skills as local instructions
- memory readback
- verification policy

Open question: whether Codex plugins should carry the adapter or whether Soma
should project a workspace-local instruction set consumed by Codex.

Initial answer: start with a workspace projection. `projectCodex` returns
deterministic files under `.codex/soma/` plus an instruction string. Codex
execution and plugins
come later, after the same input can be projected into at least one second
substrate.

Next answer: add a home projection for `~/.codex/` so Soma is available by
default. Workspace projections under `.codex/soma/` overlay the home projection,
they are not the main install surface.

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

Initial implementation: `projectPiDev` generates a workspace-shaped
`soma-core` extension projection under
`.pi/extensions/soma-core/`. It includes an extension manifest, portable
content, tool contract, memory layout, skills, and policy projection. The tools
are named as the adapter contract; execution is not wired yet.

Home implementation: `projectPiDevHome` projects into `~/.pi/agent/`:
`agent/extensions/soma.ts` registers the
`soma_context` tool, while `agent/soma/` holds the generated projection
snapshot and `agent/skills/soma/SKILL.md` advertises the Soma skill as a Pi.dev
skill. The extension appends Soma identity to the LLM context on
`before_agent_start`; the tool can read projection files and detailed imported
PAI source files under `~/.soma`.

Compatibility: `installSomaForPiDev` probes `~/.pi/agent/package.json` when it
exists and refuses versions older than `0.10.0`. That minimum is the pinned
runtime surface for `ui.setWidget`, `ui.setStatus`, `message_update`, session
entries (`appendEntry`/`readEntries`), and `tool_call` blocking. Prerelease
versions do not satisfy the stable minimum. Missing
`package.json` is treated as an unknown local/dev runtime and does not block
install; explicit old versions fail with upgrade guidance.

Algorithm renderer: `agent/extensions/soma-algorithm.ts` persists active run
snapshots under the `soma-algorithm-run` session entry kind before compaction
and restores the latest unfinished snapshot on `session_start`. During EXECUTE
it calls Soma's policy API for tool-call targets and returns Pi.dev's blocking
shape when Soma denies the action or when a mutating tool call has no parseable
destination. Live RPC end-to-end coverage remains a
runtime-environment test, not a unit-test dependency of this repo.

## Claude Code

Claude Code has the richest native surface:

- system prompt append
- `CLAUDE.md`
- hooks
- Claude Code skills
- Claude Code sub-agents
- slash commands
- statusline

The Claude Code adapter can be the highest-fidelity implementation, but the
core must not depend on Claude-only primitives. Hooks should improve behavior;
they should not be required for the storage contract to function.

Initial implementation: `projectClaudeCode` generates a Claude-shaped
projection with `CLAUDE.md` plus `.claude/soma/`
projection files. Hooks are documented as optional enhancements, not
requirements for the portable core.

The Claude Code adapter should support a home projection into `~/.claude/`.
This is how PAI is deeply integrated: global `CLAUDE.md`, settings, hooks,
Claude Code skills, sub-agents, commands, principal identity, memory, and
daemon support are available at every Claude Code startup. Soma should project
into that shape without making Claude Code the source of truth.

## Cursor

Cursor reads project-level rule files and can use MCP servers for additional
tools. The first Cursor adapter is intentionally filesystem-first:

- `.cursorrules` points Cursor at the generated Soma rule directory
- `.cursor/rules/soma/` carries context, profile, telos, memory layout, skills,
  policy, MCP notes, and the active ISA when present
- `.cursor/rules/soma/skills/ISA/` carries the portable ISA skill source

Initial implementation: `projectCursor` and `projectCursorHome` generate the
same portable Soma context in Cursor's native rules shape. `soma install cursor
--apply` writes into the requested substrate home; `soma install cursor
--workspace --apply` targets the current project workspace. `soma export cursor`
emits the deterministic file bundle without writing files.

`soma uninstall cursor` removes only the generated `.cursor/rules/soma/`
projection and a Soma-owned `.cursorrules` marker file. A pre-existing
workspace `.cursorrules` that does not start with the Soma marker is preserved.
Cursor execution and MCP runtime wiring are deferred; the adapter exposes
context projection first.

## Cortex / Myelin

Cortex is the Meta Factory collaboration surface. Myelin is the protocol stack.
Soma can integrate in two ways:

1. **In-process assistant profile**: Cortex uses Soma when spawning a substrate
   session.
2. **Standalone Cortex agent**: Soma subscribes to Myelin subjects, claims
   personal assistant tasks, updates its own memory, and publishes envelopes.

The daemon shape should follow the existing standalone Cortex agent pattern:

- `type: agent`
- `targets: [cortex, darwin-launchd]`
- identity fragment in `~/.config/cortex/agents.d/`
- NATS credentials issued by Cortex
- capabilities registered on startup

## Adapter Contract

Adapters should be thin. They do not own identity, memory, ISA, skill schemas, or
policy semantics. They only project those contracts into a substrate's native
mechanisms, and write back substrate-side events through the writeback gate.

The first portability proof is documented in
[portability-proof.md](./portability-proof.md). Memory and policy v0 are
documented in [memory-policy-v0.md](./memory-policy-v0.md).
