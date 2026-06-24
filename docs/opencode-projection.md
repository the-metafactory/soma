# OpenCode Projection Spec

Status: proposed
Target substrate id: `opencode`
Primary mode: home
Secondary modes: workspace, export
Last reviewed against OpenCode docs: 2026-06-24

## Purpose

The OpenCode projection makes Soma available inside OpenCode's terminal,
desktop, IDE, and non-interactive CLI workflows. It should project Soma's
identity, purpose, VSA, Algorithm method, skills, memory routing, MCP access,
and runtime policy into OpenCode's native configuration model without making
OpenCode the source of truth.

The first slice is a local home projection into `~/.config/opencode/`.
Repository, GitHub Actions, and GitLab CI projections are separate workspace or
runner surfaces and must stay public-safe by default.

## Native Surfaces

OpenCode already exposes most of the primitives Soma needs:

| OpenCode surface | Soma projection |
| --- | --- |
| `~/.config/opencode/AGENTS.md` | Global eager instructions and pointer to generated Soma context. |
| `AGENTS.md` | Project/workspace overlay for repo-specific instructions. |
| `~/.config/opencode/opencode.json` | Marker-owned config patch for instructions, permissions, MCP, agents, and plugins. |
| `opencode.json` | Project/workspace overlay config. |
| `~/.config/opencode/skills/<name>/SKILL.md` | Global portable Soma skills. |
| `.opencode/skills/<name>/SKILL.md` | Workspace portable Soma skills. |
| `~/.config/opencode/agents/*.md` | Soma-aware primary agents and subagents. |
| `.opencode/agents/*.md` | Workspace-specific agents. |
| `~/.config/opencode/plugins/*.js` | Lifecycle, writeback, and policy plugin. |
| `~/.config/opencode/tools/*.ts` | Optional custom Soma tools if MCP is not enough. |
| `mcp` config object | Optional Soma MCP server. |
| `permission` config object | Baseline allow/ask/deny policy for built-in, custom, skill, task, and MCP tools. |

The projection must not edit OpenCode auth state, provider credentials, logs,
session data, cache directories, theme/user UI preferences, or managed
configuration files.

## Projection Shape

The home projection should materialize this bundle under OpenCode's global
configuration directory:

```text
~/.config/opencode/
  AGENTS.md
  opencode.json
  skills/
    soma/SKILL.md
    the-algorithm/SKILL.md
    vsa/SKILL.md
  agents/
    soma.md
    soma-algorithm.md
    soma-review.md
  plugins/
    soma-lifecycle.js
    soma-lifecycle.config.json
    soma-policy-targets.js
  soma/
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

`~/.soma` remains the source of truth. Files under `~/.config/opencode/` are
generated snapshots and must carry a Soma ownership marker. Re-running
`soma install opencode --apply` must be idempotent and preserve foreign
OpenCode configuration.

## Instruction Contract

`~/.config/opencode/AGENTS.md` should be concise. It should:

- identify Soma as the portable personal assistant core
- point OpenCode at `~/.config/opencode/soma/context.md`
- require reading `startup-context.md` before claiming active work state
- require reading `memory-layout.md` before making durable memory claims
- require loading `the-algorithm` when Algorithm mode is selected
- state that `~/.soma` is authoritative and `~/.config/opencode` is a projection

Longer rules should live in generated context files and in OpenCode's native
skills. Do not place the whole personal profile or memory archive into
`AGENTS.md`.

## Skill Projection

OpenCode natively discovers `SKILL.md` folders from global, project, Claude
Code-compatible, and `.agents`-compatible locations. The adapter should use the
OpenCode-native global path first:

```text
~/.config/opencode/skills/<name>/SKILL.md
```

The first projected skills are:

- `soma`: identity, purpose, memory routing, policy, and shared-state behavior
- `the-algorithm`: seven-phase rendering contract and harness commands with
  `--substrate opencode`
- `vsa`: VSA workflow and verification criteria behavior

OpenCode skill names must be lowercase alphanumeric with single hyphen
separators and match the directory name. The VSA skill should therefore use
`vsa`, not `VSA`, in the OpenCode projection.

Skill descriptions should remain below OpenCode's documented description cap.
The adapter may rewrite substrate references and local file paths, but it must
not change portable skill semantics.

## Agent Projection

OpenCode supports primary agents and subagents. The projection should define
small Markdown agents with frontmatter:

- `soma.md`: primary agent for normal Soma-aware coding work.
- `soma-algorithm.md`: primary or all-mode agent that creates or resumes
  Algorithm runs, mirrors criteria into OpenCode todos where useful, and
  refuses to summarize until criteria are verified or explicitly deferred.
- `soma-review.md`: subagent for read-only review, configured with edit denied
  and selected read/search commands allowed.

Agent permissions should be explicit. The first slice should avoid broad
unprompted mutation by setting `bash`, `edit`, `write`, and `apply_patch`
through OpenCode's permission model, then letting the policy plugin tighten
high-risk cases.

## Config Patch

The adapter should patch `~/.config/opencode/opencode.json` rather than replace
it. The patch should be marker-owned and preserve existing user configuration.

The patch may include:

- `instructions`: generated Soma context files that should be eagerly loaded
- `permission`: conservative baseline permissions for `bash`, `edit`, `read`,
  `grep`, `glob`, `skill`, `task`, and MCP tools
- `agent`: references or overrides for Soma agents
- `mcp.soma`: optional local Soma MCP server entry
- `plugin`: reference to the Soma lifecycle/policy plugin, using OpenCode's
  supported plugin-loading shape after a runtime probe confirms it

If `opencode.json` is missing, install may create it. If it exists with invalid
JSON/JSONC, install should fail with repair guidance rather than overwriting
it.

## Lifecycle And Policy Plugin

OpenCode plugins expose session, file, permission, shell, and tool events. The
Soma plugin should be the adapter's lifecycle and policy bridge:

| OpenCode event | Soma action |
| --- | --- |
| `session.created` | Run `soma lifecycle session-start --substrate opencode`; refresh `startup-context.md`. |
| `message.updated` | Optionally detect Algorithm phase markers for current-work metadata. |
| `tool.execute.before` | Run `soma policy inspect --surface tool_call`; block denies and unresolved asks. |
| `tool.execute.after` | Append bounded metadata-only tool activity when useful. |
| `file.edited` | Record VSA or current-work updates when edits touch Soma-owned work artifacts. |
| `permission.asked` / `permission.replied` | Record metadata-only permission events. |
| `session.idle` | Run `soma lifecycle session-end --substrate opencode`; update current-work pointers. |
| `shell.env` | Inject only non-secret Soma helper environment such as repo/home pointers when safe. |

The plugin must call Soma core policy rather than embedding policy only in
prompt text. Tool-call policy should inspect at least:

- `bash` command strings
- `edit`, `write`, and `apply_patch` target paths
- `read` targets under untrusted or private Soma roots
- MCP tool names and bounded argument summaries
- custom tool names and bounded argument summaries

The implementation must probe OpenCode's actual plugin failure behavior before
claiming fail-closed enforcement. Documentation examples show that throwing
from `tool.execute.before` can block an action, but Soma needs a runtime test
for malformed plugin config, missing Soma repo, plugin exceptions, and
permission-event ordering.

## Runtime Policy Mapping

Soma policy decisions should map to OpenCode behavior as follows:

- `allow`: let the action continue
- `alert`: let the action continue and add bounded advisory context if the
  event supports it
- `ask`: request approval when OpenCode's permission surface can represent it;
  otherwise block in non-interactive contexts
- `deny`: block the action and return a short reason

The plugin and any custom tools must not write raw prompts, raw shell commands,
raw tool outputs, raw file contents, or full transcripts into shared Soma memory
by default. Shared writeback is metadata-only; private security traces belong
under Soma's security trace store when enabled.

## MCP Configuration

OpenCode supports local and remote MCP servers through the `mcp` config object.
The OpenCode adapter may install a local Soma MCP server entry when requested:

```json
{
  "mcp": {
    "soma": {
      "type": "local",
      "command": ["bun", "run", "soma", "mcp", "serve"],
      "enabled": true
    }
  }
}
```

The exact command should use the resolved Soma repo path and Bun executable
captured at install time. The MCP server remains a shared Soma core surface,
not OpenCode-specific code.

The default enabled tools should be read-oriented:

- `soma_identity_context`
- `soma_skill_registry`
- `soma_skill_route`
- `soma_skill_load`
- `soma_isa_active`
- `soma_isa_check`
- `soma_algorithm_classify`
- `soma_memory_search`
- `soma_memory_read`

Deferred mutating tools should remain disabled until Soma's MCP confirmation
token model is implemented and tested through OpenCode.

## Custom Tools

OpenCode supports custom tools through config files and plugins. The first
projection should prefer MCP for Soma tools because MCP is shared across
substrates. Custom tools are reserved for small OpenCode-specific affordances
that cannot be represented through MCP or plugins.

If custom tools are added later, they must:

- use unique names prefixed with `soma_`
- validate all arguments with schemas
- call Soma core APIs rather than reading/writing Soma files ad hoc
- obey the same no-raw-transcript writeback rule
- be covered by permission and policy-plugin tests

## Workspace Overlay

Workspace support is separate from the home projection. A workspace projection
may write:

```text
<workspace>/
  AGENTS.md
  opencode.json
  .opencode/
    skills/
      soma/SKILL.md
      the-algorithm/SKILL.md
      vsa/SKILL.md
    agents/
      soma.md
      soma-review.md
    plugins/
      soma-workspace.js
    soma/
      active-vsa.md
      project-context.md
```

Workspace files must be public-safe by default. They may contain project
instructions, project VSA summaries, and references to generated local context,
but they must not include private identity, relationship notes, private memory,
credentials, customer data, or machine-local personal paths. A private overlay
can be added later only behind an explicit flag.

## GitHub And GitLab Runner Boundary

OpenCode has GitHub and GitLab runner integrations. These are not the first
implementation target for the local projection because runner jobs cannot
assume access to the principal's local `~/.soma` home.

Runner support should start as a public-safe workspace projection:

- `AGENTS.md`
- `opencode.json`
- `.opencode/skills/*`
- optional `.github/workflows/opencode*.yml` or GitLab CI guidance
- optional remote Soma MCP configuration, only when explicitly configured

Private Soma context must enter runner jobs only through an explicit reviewed
channel: replicated allowed scopes, a configured MCP server, or CI secrets.
The adapter must never commit private profile, memory, or local path material
to a repository.

## Install Spec

Implementation should add `opencode` to:

- `SubstrateId`
- `InstallSubstrate`
- `installSpecFor`
- `allInstallSpecs`
- the CLI substrate parser
- install, reproject, export, doctor, and uninstall dispatch where supported

The install spec should own:

- default home: `.config/opencode`
- projected file list
- obsolete file list for future renames
- VSA skill destination using lowercase `vsa`
- lifecycle/plugin projection paths
- private projection roots
- optional runtime validator
- marker-guarded config patches
- uninstall targets

`soma install opencode` should dry-run by default. `--apply` should bootstrap or
load `~/.soma`, refresh startup context, write projection files, and patch
OpenCode config. It must not require a running OpenCode process.

## Uninstall

`soma uninstall opencode` should remove only marker-owned files and marker-owned
config blocks. It should preserve:

- user-authored `AGENTS.md` content outside Soma blocks
- non-Soma skills
- non-Soma agents
- non-Soma plugins
- non-Soma tools
- foreign MCP servers
- provider credentials and auth state
- logs, sessions, caches, themes, keybinds, and TUI preferences

If a generated file was modified and no manifest/hash confirms Soma ownership,
uninstall should leave it in place and report the conflict.

## Doctor Checks

`soma doctor --substrate opencode` should report:

- missing `~/.config/opencode/AGENTS.md` Soma block
- missing `~/.config/opencode/soma/context.md`
- stale projection version marker
- missing or unreadable `soma-repo.txt`
- missing `skills/soma/SKILL.md`
- missing `skills/the-algorithm/SKILL.md`
- missing lowercase `skills/vsa/SKILL.md`
- invalid or unparseable `opencode.json`
- plugin registered in config but missing on disk
- plugin config points at missing Soma home or repo
- MCP server configured but disabled or pointing at a missing command
- unsupported or unverified OpenCode version when a version probe is available

Static file inspection is enough for the first doctor slice. A later doctor may
run `opencode debug config` or an equivalent runtime probe after the adapter
has a verified command contract.

## Verification

The first implementation PR should include:

- projection unit test from a minimal `ProjectionInput`
- install dry-run file list parity with apply result
- idempotent re-install test
- marker-preserving `opencode.json` patch test
- global `AGENTS.md` merge/uninstall tests
- skill projection tests, including lowercase `vsa`
- agent frontmatter and permission tests
- plugin file projection tests
- policy target extraction tests for `bash`, `edit`, `write`, `read`, and
  `apply_patch`
- MCP config patch tests
- uninstall removes only Soma-owned files and blocks
- private-root aggregation test
- active VSA projection path test
- doctor finding tests for missing/stale projection files
- runtime smoke test proving whether `tool.execute.before` blocks on Soma
  policy deny and on plugin failure

Repository verification should run:

```bash
bun test
bun run typecheck
```

If the implementation touches linted source, run the repository lint command as
well.

## First Implementation Slice

The smallest useful slice is:

1. Add `opencode` as an installable substrate id.
2. Implement a pure `projectOpenCodeHome(input, somaHome, options)`.
3. Install global `AGENTS.md`, `soma/*`, and the three core skills.
4. Patch `opencode.json` with marker-owned instructions and conservative
   permissions.
5. Install Soma agents.
6. Install the lifecycle/policy plugin as projected but mark enforcement
   "runtime-unverified" until a local OpenCode probe proves failure behavior.
7. Add uninstall and static doctor support.
8. Document GitHub/GitLab runner support as deferred and public-safe only.

This gives OpenCode default Soma availability without solving runner
replication, write-capable MCP, or hard fail-closed plugin claims in the same
slice.

## References

- OpenCode config:
  https://opencode.ai/docs/config
- OpenCode rules:
  https://opencode.ai/docs/rules/
- OpenCode skills:
  https://opencode.ai/docs/skills/
- OpenCode agents:
  https://opencode.ai/docs/agents/
- OpenCode plugins:
  https://opencode.ai/docs/plugins/
- OpenCode MCP servers:
  https://opencode.ai/docs/mcp-servers/
- OpenCode tools and permissions:
  https://opencode.ai/docs/tools/
  https://opencode.ai/docs/permissions/
- OpenCode GitHub runner integration:
  https://opencode.ai/docs/github/
- Soma adapter contract:
  [substrate-adapters.md](./substrate-adapters.md)
- Soma MCP server:
  [mcp-server.md](./mcp-server.md)
- Soma runtime policy inspection:
  [runtime-policy-inspection.md](./runtime-policy-inspection.md)
