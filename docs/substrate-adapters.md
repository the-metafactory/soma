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

Inbound security: Codex is the first enforceable context-entry projection for
Soma inbound-content security. The home projection writes inbound security
config beside the lifecycle hook and registers `Read` in `PreToolUse`; reads
from `<soma-home>/memory/RAW/untrusted/` call `soma policy scan`. `BLOCKED` and
`HUMAN_REVIEW` decisions deny the read. Acquisition routing is still advisory
until Codex exposes a reliable external-content ingress surface.

Runtime policy: the same lifecycle hook now calls `soma policy inspect` for
`UserPromptSubmit` and `PreToolUse`. Prompt and tool-call decisions of `deny`
or `ask` block the substrate action; `allow` and `alert` continue. Runtime
policy is documented in
[runtime-policy-inspection.md](./runtime-policy-inspection.md) and remains
separate from both private-source path guarding and inbound-content scanning.

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

Current home install behavior:

- `soma install claude-code --apply` writes context under
  `<claude-home>/rules/soma/` and the ISA skill under
  `<claude-home>/skills/ISA/`.
- It installs a Soma-owned hook runner at
  `<claude-home>/hooks/soma/soma-claude-code-hook.mjs` with colocated runtime
  config.
- It patches `<claude-home>/settings.json` with Soma-owned hook entries for
  `SessionStart`, `SessionEnd`, `PostToolUse`, `SubagentStart`, and
  `SubagentStop`. Re-running install is idempotent and preserves existing
  user, project, PAI, and non-Soma hook entries.
- `soma install claude-code --mode-classifier --apply` additionally installs
  an opt-in `UserPromptSubmit` mode-classifier hook. The hook calls
  `soma algorithm classify --json`, injects a concise MODE context block, and
  temporarily disables any detected PAI `ModeClassifier.hook.*` entry. Uninstall
  removes Soma's classifier hook and restores the disabled PAI entry.
- Lifecycle hooks call Soma lifecycle APIs with `--substrate claude-code`.
  Tool and subagent hooks emit metadata-only events through the Soma writeback
  gate; they do not mirror full raw transcripts or prompt text.
- `soma uninstall claude-code` removes only the generated `rules/soma/`
  projection, `skills/ISA/`, the Soma-owned hook runner/config, and matching
  Soma hook entries in `settings.json`.

Context projection, PAI Native Mode memory, and Soma shared memory remain
distinct. Claude Code may keep rich substrate-local PAI artifacts, while Soma
shared memory records portable lifecycle events, work-registry pointers, and
policy-gated writeback metadata in `<soma-home>/memory/STATE/events.jsonl`.

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
context projection first. The portable MCP server contract is specified in
[mcp-server.md](./mcp-server.md); Cursor adapter work should configure that
server rather than defining a Cursor-only tool vocabulary.

## Grok

Grok is xAI's coding-agent CLI. Its config home is `~/.grok/`. The adapter is a
first-class home projection: `soma install grok --apply` makes Soma available at
every Grok startup, and `soma install grok --workspace --apply` overlays the
current project's auto-discovered `.grok/rules/`.

Context delivery routes only through binary-verified auto-load surfaces.
A live `grok inspect --json` probe confirmed that `~/.grok/AGENTS.md`
and `~/.grok/skills/<name>/SKILL.md` auto-load, while home `~/.grok/rules/` and
`~/AGENTS.md` do not. The adapter therefore delivers context as:

- `skills/soma/SKILL.md` — the auto-loaded entry skill carrying the portable
  assistant core, with `context.md`, `memory-layout.md`, `skills.md`,
  `policy.md`, `startup-context.md`, and (when an ISA is active)
  `active-isa.md` colocated beside it.
- `skills/the-algorithm/SKILL.md` — the shared seven-phase Algorithm rendering
  contract plus a Grok-native verification-gates section (see below).
- `AGENTS.md` — a marked pointer block (appended idempotently, foreign content
  preserved) that points Grok at `skills/soma/SKILL.md` and the Soma home.
- `config.toml` — a marked block for Soma-owned config patches.

Native subagent surfaces project Soma onto Grok's own primitives, read by
`spawn_subagent`: `personas/soma.toml` (a Soma voice/instruction block),
`roles/soma-algorithm.toml` (an Algorithm capability preset), and
`agents/soma-explore.md` (a Soma-aware exploration subagent). The schema is
limited to fields observed in `~/.grok/bundled/`; the unconfirmed agent
`skills:` key is never emitted.

Hooks live in `~/.grok/hooks/*.json`. Grok's hook platform is fail-open — a tool
runs if its hook errors — so the lifecycle/security hook denies on every error
in the chain. A `PreToolUse` hook's stdout-deny IS honored (the deny gate
proved fail-closed denial of a shell command), but passive lifecycle hooks'
stdout is ignored, so `SessionStart`/`SessionEnd` only run side effects. Those
lifecycle hooks fire per-session, not per-leader, which is why per-session
refresh lives there. On Windows the hook runner is bare-exec'd against the
resolved Bun runtime with absolute paths and explicit `"utf8"` on every read and
write — NTFS ignores `chmod`, Windows ignores shebangs, and cp1252 default
decoding would otherwise corrupt non-ASCII bytes.

`installSomaForGrok` refuses runtimes below `0.2.38`, read from
`~/.grok/version.json` with no live `grok` exec; a missing manifest is
treated as an unversioned dev runtime and does not block. The adapter's
empirical tool-name matchers (`Shell`, `Read`, `Write`, `StrReplace`, `Grep`,
`Glob`) were re-probed byte-identical on `0.2.39`.

Algorithm rendering is honestly scoped to what Grok offers: text banners plus
the native todo list. There is no Pi-style widget API, so the Algorithm skill
instructs the in-substrate agent to mirror plan steps and active-ISA criteria
into `todo_write`, and to run verification-heavy work headless with
`--todo-gate` (a turn cannot end with open todos) and `--check` (Grok's
self-verification loop). The active ISA's open criteria seed the todo list.
Grok also has no sandbox on Windows (`--sandbox` is Landlock/Seatbelt-only) and
no statusline surface; isolation guidance uses git worktrees.

`soma uninstall grok` removes only marker-guarded Soma artifacts: the
`skills/soma/` and `skills/the-algorithm/` projections, the persona/role/agent
subagent files, the hook assets, the recorded portable-skill files, and the
Soma blocks in `AGENTS.md`/`config.toml`. A user-authored file that merely
shares a Soma name or directory is preserved.

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

Daemon ownership and Myelin contract boundaries are documented in
[daemon-mode.md](./daemon-mode.md). The adapter may consume Myelin-owned
contracts, but it must not make Soma the owner of bus protocol details.

When a Cortex/Myelin agent drives a Soma Algorithm run, capability names must
come from Soma's registry or the run's adapter-provided capability definitions.
Agents can register startup capabilities on the run with
`registerAlgorithmCapabilityDefinition(run, definition)` or
`registerAlgorithmCapabilityDefinitions(run, definitions)`. A selected
capability is a binding commitment until the agent either records invocation
evidence or removes the selection with a reason; COMPLETE is rejected while
structured selections remain unresolved.

## Adapter Contract

Adapters should be thin. They do not own identity, memory, ISA, skill schemas, or
policy semantics. They only project those contracts into a substrate's native
mechanisms, and write back substrate-side events through the writeback gate.

Shared work state is a core contract, not a substrate convention. Adapters that
can identify a session should update:

- `<soma-home>/memory/STATE/work.json`
- `<soma-home>/memory/STATE/session-names.json`
- `<soma-home>/memory/STATE/current-work-<safe-session-token>-<session-id-hash>.json`
- `<soma-home>/memory/WORK/<slug>/` artifacts when they produce durable work

Adapters should treat `somaWorkRegistryPaths(..., sessionId).currentWork` as the
canonical resolver for the current-work pointer. The safe token is bounded and
human-readable; the hash suffix is part of the filesystem contract so distinct
raw session IDs that sanitize to the same token cannot overwrite each other.

The registry stores metadata and artifact pointers. It must not mirror full
private prompts, results, or raw transcripts by default. Session-end writeback
also appends a metadata-only `lifecycle.session_end` event to
`<soma-home>/memory/STATE/events.jsonl` with pointers to the shared state files
it updated. Soma's V0 observability surface reads the same append-only event
log through `soma telemetry list`, `soma telemetry stats`, and `soma stats`.
Full tool activity and tool failure capture remain adapter-specific event
extensions; Signal remains the telemetry-system owner.

Adapters own their substrate-native install facts: default home, projected file
paths, substrate-specific skill destinations, lifecycle projection paths,
validators, cleanup hooks, private projection roots, MCP client configuration,
and uninstall targets. The installer owns orchestration: bootstrapping Soma
home, loading active ISA, running lifecycle updates, writing projections, and
applying the install, reproject, upgrade, and uninstall verbs.

The optional MCP server is a shared library/daemon surface, not an adapter.
Adapters may install or advertise substrate-native MCP client configuration, but
the tool inventory, schema budget, confirmation model, and read/write semantics
belong to Soma core. See [mcp-server.md](./mcp-server.md).

The first portability proof is documented in
[portability-proof.md](./portability-proof.md). Memory and policy v0 are
documented in [memory-policy-v0.md](./memory-policy-v0.md).
