# Runtime Permission-Request Policy

`permission_request` is the runtime policy surface for substrate permission
prompts. It lets adapters ask Soma for a portable decision before allowing a
read, write, delete, execute, network, or unknown action.

This slice is conservative by default:

- requests are `ask` unless an explicit Soma policy trust rule or approval
  cache entry allows them
- sensitive or private paths stay approval-required even when a broad trusted
  root would otherwise match
- substrates that cannot synchronously ask degrade to `alert`, with audit
  evidence, instead of pretending approval was collected
- there is no default trust for Downloads, temp directories, or broad project
  prefixes
- there is no mandatory model-backed read/write classifier

## Difference From PAI SmartApprover

PAI v5.0.0 `SmartApprover.hook.ts` is a Claude Code `PermissionRequest` hook.
It uses trusted path prefixes such as Claude config, Projects, LocalProjects,
Downloads, and temp directories as fast-path allow rules. For non-trusted
requests it classifies known read tools as read, known mutating tools as write,
uses heuristic Bash read patterns, auto-approves reads, and lets writes fall
through to Claude's user prompt. It also keeps a local allow/ask cache keyed by
tool and path or command.

Soma keeps the portable ideas and drops the PAI assumptions:

- trust is explicit Soma policy data, not inherited hard-coded local prefixes
- trusted roots are action-scoped, for example read-only documentation paths
- approval cache entries are explicit, action-scoped, and may expire
- sensitive paths override trust and cache allow paths
- model-backed or heuristic read/write classification is optional future work
- the output is a Soma runtime policy decision, not Claude hook JSON

## Request Shape

Adapters pass `RuntimePolicyPermissionRequest` through
`RuntimePolicyInspectOptions.permissionRequest`:

```json
{
  "requestId": "read-doc",
  "action": "read",
  "targetPath": "/repo/docs/guide.md",
  "toolName": "Read",
  "cacheKey": "read:/repo/docs/guide.md",
  "substrateSupportsAsk": true
}
```

`targetPath`, `toolName`, and `cacheKey` are optional because substrates expose
different permission metadata. Missing `targetPath` prevents trusted-root and
path-sensitive allows; the request falls back to approval.

## Trusted Roots

`RuntimePolicyConfig.permission.trustedRoots` contains explicit policy roots:

```json
{
  "permission": {
    "trustedRoots": [
      {
        "path": "/repo/docs",
        "actions": ["read"],
        "description": "project documentation"
      }
    ]
  }
}
```

A trusted root allows only matching actions inside that root. A read-only root
does not allow writes. Broad roots that include private Soma memory, credential
files, SSH keys, or environment files do not suppress sensitive-path findings.

## Approval Cache

`RuntimePolicyConfig.permission.approvalCache` records bounded approvals:

```json
{
  "permission": {
    "approvalCache": [
      {
        "cacheKey": "read:/repo/src/index.ts",
        "action": "read",
        "targetPath": "/repo/src/index.ts",
        "expiresAt": "2026-06-01T00:00:00.000Z"
      }
    ]
  }
}
```

The cache matches `cacheKey` and action. When `targetPath` is present on the
cache entry, it must match the request target path after `~/` expansion and
path normalization. Expired entries do not allow. Sensitive paths still require
approval.

## Substrate Capability Inventory

| Substrate | Permission-request capability | Soma behavior |
| --- | --- | --- |
| Codex | Current projection can run hooks and policy inspection, but has no portable user prompt primitive in Soma core. | Use `permission_request` where an enforceable hook or approval bridge exists; otherwise set `substrateSupportsAsk: false` and audit `alert`. |
| Claude Code | Native `PermissionRequest` hooks can ask or allow before tool execution. | Adapter can map hook payloads into `permission_request` and enforce `allow`, `ask`, `deny`, or `alert` through Claude hook output. |
| Pi.dev | Extension/tool-call guards can mediate some permission decisions. | Use explicit capability detection; unsupported asks degrade to `alert`. |
| Cursor | Rules and MCP/tool integrations may be advisory rather than a uniform synchronous permission gate. | Treat as advisory unless a specific integration can block and ask. |
| Cortex/Myelin | Dispatch gates can ask before accepting work envelopes or tool routes, but they are not Claude permission prompts. | Map dispatch approval events into the same surface without inheriting Claude tool names. |
| Custom | Unknown until adapter declares capability. | Default conservative approval requirement; degrade to `alert` when ask is unavailable. |

## CLI

```bash
SOMA_PERMISSION_REQUEST='{"requestId":"read-doc","action":"read","targetPath":"/repo/docs/guide.md","substrateSupportsAsk":true}' \
  bun run soma policy inspect \
    --surface permission_request \
    --permission-request-env SOMA_PERMISSION_REQUEST \
    --record deny \
    --json
```

Events and traces follow the runtime policy audit split. Traces include the
request id, action, cache key, and a target path hash; they do not store raw
target paths by default.

## Non-Goals

- no hard-coded local trusted prefixes
- no broad default trust for Downloads, temp directories, or project folders
- no mandatory model-backed classification
- no guarantee that every substrate can synchronously ask the principal
- no replacement for protected-path or private-source policy
