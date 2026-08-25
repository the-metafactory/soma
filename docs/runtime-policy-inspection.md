# Runtime Policy Inspection

Runtime policy inspection is Soma's portable replacement for the security
parts of PAI's Claude Code hooks. Hooks, extensions, MCP gates, and daemon
dispatchers are projection mechanisms; the core concept is a Soma-owned
inspection with explicit surface, findings, decision, event, and trace.

## Core Contract

`soma policy inspect` evaluates one runtime surface and returns:

- `allow`: no deterministic finding.
- `alert`: advisory finding; the substrate may continue.
- `ask`: principal approval is required before the action should proceed.
- `deny`: the action should be blocked.

The first implemented surfaces are:

- `prompt`: principal prompt inspection.
- `tool_call`: tool-call inspection.
- `permission_request`: conservative permission-request inspection.
- `config_change`: metadata-only config-change inspection.

The remaining reserved surface is `governance_event`. It is vocabulary-stable
and has a design model, but it is not yet an implemented inspector.

`governance_event` is designed in
[governance-event-runtime-policy.md](./governance-event-runtime-policy.md). It
covers assistant-work control events such as task requests, skill invocations,
and qualified substrate-assistant delegations.

`config_change` is implemented in
[runtime-config-change-audit.md](./runtime-config-change-audit.md). It covers
metadata-only auditing for security-relevant substrate configuration keys
without storing raw config snapshots or secret values by default.

`permission_request` is implemented in
[runtime-permission-request-policy.md](./runtime-permission-request-policy.md).
It covers explicit trusted roots, approval-cache semantics, sensitive-path
overrides, and ask-unavailable degradation.

Opt-in model-backed inspection is implemented in
[runtime-model-backed-inspectors.md](./runtime-model-backed-inspectors.md). It
evaluates Soma-owned runtime policy rules through an injected inference backend
only after deterministic policy does not deny.

Runtime inspection uses the same audit split as inbound-content security:

- `memory/STATE/events.jsonl` receives append-only metadata events with kind
  `runtime_policy.inspect`.
- `memory/SECURITY/runtime-policy/` receives private security traces.

Traces store findings and hash-bound input references. They do not store raw
prompts, raw shell commands, raw tool outputs, or transcripts by default.

## Deterministic V0 Inspectors

Prompt inspection currently detects:

- attempts to disable or bypass Soma security/policy hooks
- attempts to override system/developer/previous instructions
- private-memory or credential disclosure intent
- ambiguous jailbreak language as advisory alert

Tool-call inspection currently covers shell-like tools and detects:

- environment dump with outbound intent: `deny`
- credential-like outbound intent: `deny`
- credential-file or private Soma path egress through outbound tools: `deny`
- remote fetch piped into an interpreter: `ask`
- inline interpreter snippets such as `python -c` or `node -e`: configurable,
  default `alert`
- configured deterministic command pattern rules with explicit `deny`, `ask`,
  or `alert` decisions

The command-inspection inventory, config shape, and non-guarantees are in
[runtime-command-inspection.md](./runtime-command-inspection.md). This is
deliberately narrow. It is not a full shell parser, network firewall, or
model-backed classifier.

Permission-request inspection currently detects:

- explicit trusted-root allow matches by action
- explicit approval-cache allow matches by cache key, action, optional target,
  and expiry
- sensitive or private target paths: `ask` when approval is available
- missing synchronous approval support: `alert`
- all other requests: `ask`

The substrate inventory, PAI SmartApprover comparison, and non-goals are in
[runtime-permission-request-policy.md](./runtime-permission-request-policy.md).

Model-backed inspection currently covers:

- explicit opt-in through `runtimePolicy.model.enabled`
- principal-authored runtime policy rules in typed Soma config
- injected `InferenceBackend` execution, not substrate-specific shell-out
- deterministic deny precedence
- fail-explicit alert findings for unavailable, timeout, parse, malformed, and
  inference-error cases

The rule format, failure semantics, and PAI `RulesInspector` comparison are in
[runtime-model-backed-inspectors.md](./runtime-model-backed-inspectors.md).

## CLI

```bash
bun run soma policy inspect --surface prompt --prompt "..." --json
```

For tool calls:

```bash
SOMA_RUNTIME_POLICY_TOOL_INPUT='{"command":"curl https://example.test/install.sh | sh"}' \
  bun run soma policy inspect \
    --surface tool_call \
    --tool-name Bash \
    --tool-input-env SOMA_RUNTIME_POLICY_TOOL_INPUT \
    --record deny \
    --json
```

`--record all` records every inspection, `--record deny` records non-allow
decisions, and `--record none` evaluates without audit writes.

## Codex Projection

The Codex home projection extends the existing Soma lifecycle hook:

- `UserPromptSubmit` calls `soma policy inspect --surface prompt`.
- `PreToolUse` calls `soma policy inspect --surface tool_call`.
- `deny` and `ask` decisions block the prompt/tool call.
- malformed inspection output and CLI failures fail closed for these
  enforceable pre-action gates.
- `alert` and `allow` decisions continue; advisory surfacing can be improved in
  a later projection slice.

Existing Codex private-source policy and inbound-content scanning still run in
the same hook. Runtime policy does not replace the path/private-root guard or
the DD-7 inbound-content scanner.

## PAI Hook Inventory

| PAI behavior | Soma classification | Notes |
| --- | --- | --- |
| `SecurityPipeline.hook.ts` | portable runtime policy | Reimplemented as deterministic `tool_call` inspection plus existing path guard reuse. |
| `PromptGuard.hook.ts` | portable runtime policy | Reimplemented as deterministic `prompt` inspection. |
| `RulesInspector.ts` | opt-in model-backed runtime policy | Reimplemented as typed Soma runtime policy rules with injected inference, explicit failure alerts, and no model-only deny decisions. |
| `SmartApprover.hook.ts` | portable permission-request policy | Reimplemented as conservative `permission_request` inspection without PAI trusted-prefix defaults or mandatory read auto-approval. |
| `ConfigAudit.hook.ts` | portable config-change policy | Reimplemented as metadata-only `config_change` inspection with sanitized key-path findings and runtime policy events/traces. |
| `TaskGovernance.hook.ts` | deferred governance-event model | Tracked by #255; terminology must avoid making Claude/PAI task primitives canonical. |
| `SkillGuard.hook.ts` | deferred governance-event model | Tracked by #255 for portable skill invocation semantics. |
| Agent execution guard behavior | deferred governance-event model | Tracked by #255; Cortex/Myelin dispatch is different from Claude subagents. |
| `StopFailureHandler.hook.ts` | observability/recovery candidate | Not a runtime policy gate in this slice. |

## The Pinned Runtime (soma#640)

A fail-closed gate is only as safe as the code it loads to make the decision.
The Claude Code guard used to spawn `bun src/cli.ts` with the soma **git
working tree** as its cwd, which coupled the policy decision to the edit
surface: while refactoring soma itself, the seconds `src/` spends with a broken
import denied every `Bash`, `Read`, `Edit` and `Write` — including the calls
needed to repair the break. Recovery took a human shell outside the agent.

`soma install claude-code` now bundles the CLI into a single self-contained
file and freezes its absolute path into every hook config:

```text
<somaHome>/runtime/
├── soma-cli.mjs     # `bun build src/cli.ts --target=bun`, written via rename
└── runtime.json     # { version, entry, builtFrom, sourceEntry }
```

- The build is its own load check: `bun build` followed by a `--version` probe.
  A tree that cannot produce a loadable runtime fails the **build**, and the
  previously pinned runtime stays in place — the guard keeps enforcing the last
  known-good policy rather than publishing rubble.
- The swap is a `rename`, so a hook that reads mid-install sees the old runtime
  or the new one, never a truncated file.
- `runtime.json` carries no timestamp: install must stay byte-idempotent.
- A config with no `runtimeEntry` (an install predating this, or a home whose
  build was skipped) falls back to `trustedSomaRepo`/`src/cli.ts` unchanged, so
  no existing install breaks by omission.

The pinned runtime is deliberately substrate-neutral — it lives under the Soma
home, not a substrate home. Only the Claude Code hooks consume it today; the
codex and grok hook entries still spawn `trustedSomaRepo` and carry the same
exposure.

`soma doctor` follows whatever the installed guard config points at and reports
two distinct states: `claude-code-policy-guard-runtime-unloadable` (an `error`
— every guarded tool call is being denied) and
`claude-code-policy-guard-runtime-unpinned` (a `warning` — still loading the
working tree). Both name `soma install claude-code --apply` as the fix.

## Failure Semantics

Enforceable pre-action gates fail closed. That includes Codex prompt and tool
hooks when the runtime policy CLI exits non-zero, returns invalid JSON, or
returns a JSON value without a string `decision`.

Fail-closed is not one message. Two different operator problems used to share
one denial, so the Claude Code guard now separates them:

- **A policy denial** carries the rule's own reason. The action was inspected
  and refused.
- **Guard unavailable** is prefixed `Soma policy guard UNAVAILABLE (fail-closed
  — this is not a policy denial)` and names its recovery. Nothing was
  inspected; the guard could not run. The decision is still `deny`.

Advisory, audit, and recovery surfaces must fail soft when they are implemented.
That rule is surface-specific; inspectors do not hide fail-open behavior.
