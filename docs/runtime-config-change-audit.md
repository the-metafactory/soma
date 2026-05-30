# Runtime Config-Change Audit

`config_change` is the runtime policy surface for security-relevant substrate
configuration changes. It is metadata-only: Soma records changed key paths,
decisions, findings, and trace pointers, but it does not mirror raw config
snapshots or secret values by default.

## Difference From PAI

PAI `ConfigAudit.hook.ts` is Claude-specific. It reads Claude settings,
maintains a temporary settings snapshot, diffs top-level keys, and appends
events to PAI observability memory.

Soma keeps the portable parts and drops the Claude assumptions:

- the policy surface is `config_change`
- substrate adapters provide a bounded before/after key-value object or an
  `unreadable` / `malformed` error
- Soma computes sanitized changed-key findings in the runtime policy core
- normalized events go to `memory/STATE/events.jsonl`
- detailed policy traces go to `memory/SECURITY/runtime-policy/`
- raw config values are not stored in events or traces
- snapshot persistence is not part of this slice

## Security-Relevant Keys

Common security-relevant key families:

- `hooks`
- `permissions`
- `env`
- `mcpServers`
- `runtimePolicy`
- `policy`
- `tools`
- `extensions`

Substrate-specific starting points:

| Substrate | Security-relevant config surfaces and keys |
| --- | --- |
| Codex | config files, hook config, tool availability, sandbox/network/approval policy |
| Claude Code | `settings.json`, hooks, permissions, MCP servers, environment entries |
| Pi.dev | extension settings, tool-call guard config, policy-check extension settings |
| Cursor | projected rules, MCP servers, tool configuration |
| Cortex/Myelin | dispatcher config, artifact ingress, task routing, capabilities |

Adapters can pass additional key families through
`configChange.securityRelevantKeys` when a substrate has more precise local
knowledge.

## Decisions

Config-change inspection is advisory by default:

- security-relevant key added, removed, or changed: `alert`
- unreadable config: `alert`
- malformed config: `alert`
- no relevant change: `allow`

This slice does not deny config changes. Future substrate-specific gates may
ask or deny when the substrate can enforce before a dangerous setting takes
effect.

## CLI

```bash
SOMA_CONFIG_CHANGE='{"configSurface":"codex.config","before":{"hooks":{"PreToolUse":true}},"after":{"hooks":{"PreToolUse":false}}}' \
  bun run soma policy inspect \
    --surface config_change \
    --config-change-env SOMA_CONFIG_CHANGE \
    --record deny \
    --json
```

`before` and `after` values are compared structurally, but only key paths and
finding summaries are retained. For read/parse failures:

```json
{
  "configSurface": "claude-code.settings",
  "error": { "kind": "malformed", "detail": "invalid JSON" }
}
```

## Non-Goals

- no full config synchronization system
- no raw config snapshot storage by default
- no secret-value mirroring
- no claim that every substrate exposes an enforceable config-change hook
- no replacement for substrate-native configuration validation
