# GitHub Copilot CLI Adapter Spec

Status: proposed
Target substrate id: `copilot`
Primary mode: home
Secondary modes: workspace, export
Last reviewed against GitHub Copilot docs: 2026-06-24

## Purpose

The Copilot CLI adapter projects the Soma assistant core into GitHub Copilot
CLI's local, user-level customization surface. Its job is to make the same
Soma identity, purpose, skills, VSA, Algorithm method, memory routing, and
runtime policy available when a principal works through Copilot CLI.

The adapter is for local Copilot CLI first. Copilot cloud agent has related
surfaces, but its execution environment is ephemeral and GitHub-hosted. Cloud
agent support should be a separate follow-up slice that only projects
public-safe repository artifacts and optional MCP configuration.

## Native Surfaces

Copilot CLI stores user-level customization under `~/.copilot/`. The adapter
should target only user-editable surfaces:

| Copilot CLI surface | Soma projection |
| --- | --- |
| `copilot-instructions.md` | Eager assistant operating context and pointer to generated Soma files. |
| `instructions/*.instructions.md` | Additional topic-specific Soma rules, especially policy, VSA, and memory routing. |
| `skills/<name>/SKILL.md` | Portable Soma skills, including `soma` and `the-algorithm`. |
| `agents/*.agent.md` | Optional custom agent profiles for Soma-aware planning, review, or Algorithm execution. |
| `hooks/` and `settings.json` hooks | Lifecycle refresh, prompt classification, tool-call policy, and metadata writeback. |
| `mcp-config.json` | Optional Soma MCP server configuration for on-demand context and tools. |
| `settings.json` | Marker-guarded Soma-owned settings patches only. |

The adapter must not edit Copilot-managed state such as session databases,
logs, auth state, installed plugin metadata, OAuth fallback storage, or saved
permissions.

## Projection Shape

The home projection should materialize this bundle under the Copilot home:

```text
~/.copilot/
  copilot-instructions.md
  instructions/
    soma.instructions.md
    soma-policy.instructions.md
    soma-memory.instructions.md
  skills/
    soma/SKILL.md
    the-algorithm/SKILL.md
    VSA/SKILL.md
  agents/
    soma.agent.md
    soma-algorithm.agent.md
  hooks/
    soma/
      soma-copilot-hook.mjs
      soma-copilot-hook.config.json
      copilot-policy-targets.mjs
  mcp-config.json
  settings.json
```

The projection should also write a compact generated context bundle under a
single Soma-owned directory:

```text
~/.copilot/soma/
  context.md
  profile.md
  purpose.md
  memory-layout.md
  skills.md
  policy.md
  startup-context.md
  active-vsa.md
  soma-repo.txt
```

`~/.soma` remains the source of truth. Files under `~/.copilot` are generated
snapshots and must say so in their headers. Re-running `soma install copilot
--apply` should be idempotent.

## Instruction Contract

`copilot-instructions.md` should stay short. It should:

- identify Soma as the portable personal assistant core
- point Copilot CLI at `~/.copilot/soma/context.md`
- require reading `startup-context.md` before claiming active work state
- require reading `memory-layout.md` before making durable memory claims
- require using `skills/the-algorithm/SKILL.md` when Algorithm mode is selected
- state that `~/.soma` is authoritative and `~/.copilot` is a projection

Topic-specific files under `instructions/` should carry the longer rules so the
top-level instruction file does not become the whole assistant.

## Skill Projection

The adapter should project portable Soma skills into Copilot CLI's skill
layout:

- `skills/soma/SKILL.md` is the entrypoint for identity, purpose, memory,
  policy, and shared-state behavior.
- `skills/the-algorithm/SKILL.md` carries the seven-phase rendering contract
  and the harness CLI commands with `--substrate copilot`.
- `skills/VSA/SKILL.md` carries the VSA workflow until the repository has a
  substrate-neutral way to project VSA under a different skill name.

Skill bodies should be generated from Soma's portable skill registry. The
adapter may rewrite only substrate references and local file paths. It must not
change skill semantics.

## Custom Agent Profiles

The first custom agent profiles should be small and explicit:

- `soma.agent.md`: general Soma-aware work agent with access to read, search,
  edit, shell, and selected Soma MCP tools when configured.
- `soma-algorithm.agent.md`: Algorithm-oriented agent that is instructed to
  create or resume a run, obey phase gates, and verify criteria before summary.

Profiles should prefer bounded tool lists. If the profile enables MCP tools,
it should include only the default read-oriented Soma MCP tools in the first
slice.

## Lifecycle Hooks

The adapter should register command hooks through Copilot CLI settings using
the same substrate-neutral lifecycle events as other adapters:

| Copilot hook event | Soma action |
| --- | --- |
| `sessionStart` / `SessionStart` | Run `soma lifecycle session-start --substrate copilot`, refresh `startup-context.md`, and inject bounded startup context when the hook surface allows it. |
| `userPromptSubmitted` / `UserPromptSubmit` | Run `soma policy inspect --surface prompt`; optionally classify Algorithm mode and add concise context. |
| `preToolUse` / `PreToolUse` | Run `soma policy inspect --surface tool_call` and deny or modify tool calls when policy requires it. |
| `postToolUse` / `PostToolUse` | Append metadata-only tool activity when useful; never mirror raw output by default. |
| `postToolUseFailure` / `PostToolUseFailure` | Add bounded recovery context and metadata-only failure events. |
| `sessionEnd` / `SessionEnd` | Run `soma lifecycle session-end --substrate copilot` and update current-work pointers. |

`preToolUse` must be treated as the enforcement gate. Command hooks are the
preferred shape because Copilot CLI documents command `preToolUse` as
fail-closed. HTTP hooks may be useful later for daemon mode, but they must not
be the first security gate if they fail open.

## Runtime Policy

The Copilot adapter should call Soma's runtime policy inspection instead of
embedding policy in prompt text. The first slice should map tool names to Soma
tool-call surfaces:

| Copilot tool class | Soma policy target |
| --- | --- |
| shell execution | command and target paths extracted from shell args |
| read/view | inbound-content scan for untrusted Soma raw-memory paths |
| create/edit | write target paths |
| search | read target paths, advisory only unless searching private roots |
| MCP tool | server name, tool name, and argument summary |

Policy decisions map as follows:

- `allow`: let the action continue
- `alert`: let the action continue and append bounded context if supported
- `ask`: deny in non-interactive contexts; otherwise defer to Copilot's normal
  approval flow if one is available
- `deny`: block the action and provide the policy reason

The hook must not store raw prompts, raw shell commands, raw tool outputs, or
full transcripts in shared memory by default. Private security traces belong
under Soma's security trace store when enabled.

## MCP Configuration

Copilot CLI can load user-level MCP servers from `mcp-config.json`. The adapter
may install or advertise the Soma MCP server, but the MCP server remains a
shared core/library surface, not Copilot-specific code.

The default MCP tools for this adapter should be read-oriented:

- `soma_identity_context`
- `soma_skill_registry`
- `soma_skill_route`
- `soma_skill_load`
- `soma_isa_active`
- `soma_isa_check`
- `soma_algorithm_classify`
- `soma_memory_search`
- `soma_memory_read`

Deferred mutating tools such as `soma_memory_promote`,
`soma_algorithm_new`, and `soma_algorithm_advance` should stay disabled until
the MCP confirmation-token model is implemented and proven in Copilot CLI.

The adapter should patch `mcp-config.json` with a marker-guarded `soma` server
entry and preserve all foreign servers. If `mcp-config.json` contains invalid
JSON, install should fail with repair guidance rather than replacing it.

## Install Spec

Implementation should add `copilot` to:

- `SubstrateId`
- `InstallSubstrate`
- `installSpecFor`
- `allInstallSpecs`
- the CLI substrate parser
- install, reproject, export, doctor, and uninstall dispatch where supported

The install spec should own:

- default home: `.copilot`
- projected file list
- obsolete file list for future renames
- lifecycle projection paths
- private projection roots
- optional doctor checks
- marker-guarded post-projection config patches
- uninstall targets

`soma install copilot` should dry-run by default. `--apply` should bootstrap or
load `~/.soma`, refresh lifecycle startup context, write projection files, and
patch config files. It must not require a running Copilot CLI process.

## Workspace Overlay

Workspace support should be separate from the home install. A workspace
projection may write:

```text
<workspace>/
  .github/copilot-instructions.md
  .github/instructions/soma.instructions.md
  .github/agents/soma.agent.md
```

Workspace files must be public-safe by default. They may point to project-local
Soma rules and VSA context, but they must not include private principal
profile, relationship notes, private memory, credentials, or machine-local
paths. A private workspace overlay may be added later behind an explicit flag.

## Copilot Cloud Agent Boundary

Copilot cloud agent is not the first implementation target. It runs in a
GitHub-hosted or runner-backed ephemeral environment and cannot assume access
to the principal's local `~/.soma` home.

Cloud support should therefore begin as a repository-safe projection:

- repository instructions
- path-specific instructions
- custom agent profile
- optional setup workflow guidance
- optional MCP configuration guidance

Any private Soma context for cloud agent must arrive through an explicit,
reviewed channel: a configured MCP server, a replicated Soma home scope, or
repository/organization agent secrets. The adapter must never commit private
identity or memory into `.github/`.

## Uninstall

`soma uninstall copilot` should remove only marker-owned files and marker-owned
config blocks. It should preserve:

- user-authored Copilot instructions
- non-Soma skills
- non-Soma agents
- non-Soma hooks
- foreign MCP servers
- Copilot session state, logs, auth, plugins, and saved permissions

When a file may contain both user content and a Soma block, uninstall should
remove only the block. If a generated file was modified without a marker or
manifest match, uninstall should leave it in place and report the conflict.

## Doctor Checks

`soma doctor --substrate copilot` should report:

- missing `~/.copilot/soma/context.md`
- stale projection version marker
- missing or unreadable `soma-repo.txt`
- missing `skills/soma/SKILL.md`
- missing `skills/the-algorithm/SKILL.md`
- hook runner missing from settings
- hook config points at a missing Soma home or repo
- invalid `mcp-config.json`
- unsupported or unverified Copilot CLI version when a version probe is
  available

Doctor should not launch Copilot CLI unless a later verified version probe
requires it. Static file inspection is enough for the first slice.

## Verification

The first implementation PR should include:

- projection unit test from a minimal `ProjectionInput`
- install dry-run file list parity with apply result
- idempotent re-install test
- marker-preserving `settings.json` patch test
- marker-preserving `mcp-config.json` patch test
- uninstall removes only Soma-owned files and blocks
- private-root aggregation test
- active VSA projection path test
- runtime policy hook command shape test
- doctor finding tests for missing and stale projection files
- docs update in `docs/substrate-adapters.md`

Repository verification should run:

```bash
bun test
bun run typecheck
```

If the implementation touches linted source, run the repository lint command as
well.

## First Implementation Slice

The smallest useful slice is:

1. Add `copilot` as an installable substrate id.
2. Implement a pure `projectCopilotCliHome(input, somaHome, options)`.
3. Install `copilot-instructions.md`, `~/.copilot/soma/*`, and the three core
   skills.
4. Patch `settings.json` with marker-owned lifecycle hooks.
5. Patch `mcp-config.json` only when `--with-mcp` is passed.
6. Add uninstall and static doctor support.
7. Document cloud agent as deferred and public-safe only.

This gives Copilot CLI default Soma availability without solving cloud
replication, write-capable MCP, or Copilot plugin distribution in the same
slice.

## References

- GitHub Copilot CLI configuration directory:
  https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
- GitHub Copilot hooks reference:
  https://docs.github.com/en/copilot/reference/hooks-reference
- GitHub Copilot custom agents configuration:
  https://docs.github.com/en/copilot/reference/custom-agents-configuration
- GitHub Copilot MCP configuration:
  https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
- Soma adapter contract:
  [substrate-adapters.md](./substrate-adapters.md)
- Soma MCP server:
  [mcp-server.md](./mcp-server.md)
- Soma runtime policy inspection:
  [runtime-policy-inspection.md](./runtime-policy-inspection.md)
