# Runtime Model-Backed Inspectors

Model-backed runtime policy inspectors are an optional extension to Soma's
deterministic runtime policy core. They evaluate principal-authored runtime
policy rules when deterministic rules are not expressive enough.

They are disabled by default. Enabling them requires explicit Soma policy
config and an injected inference backend.

## Runtime Policy Rules

Rules are Soma-owned runtime policy rules, not PAI `SECURITY_RULES.md` files.
They live in `RuntimePolicyConfig.model.rules`:

```json
{
  "model": {
    "enabled": true,
    "level": "fast",
    "timeoutMs": 3000,
    "rules": [
      {
        "id": "human-review-destructive-cleanup",
        "description": "Ask before deleting project or memory notes.",
        "surfaces": ["prompt", "tool_call"],
        "decision": "ask",
        "severity": "medium"
      }
    ]
  }
}
```

Fields:

- `id`: stable rule id used by model findings.
- `description`: natural-language rule text.
- `surfaces`: optional runtime surfaces where the rule applies.
- `decision`: optional maximum response decision, `alert` or `ask`.
- `severity`: optional default severity for findings.

Model-backed rules cannot produce `deny`. Initial model-backed findings are
limited to `alert` and `ask`; deterministic inspectors own deny decisions.

## Inspector API

The core API stays separated from deterministic inspectors:

- deterministic inspectors run first
- deterministic `deny` short-circuits model inspection
- model inspection runs only when `runtimePolicy.model.enabled === true`
- model inspection requires `RuntimePolicyInspectOptions.modelInspectorBackend`
- backend invocation uses the existing `InferenceBackend` contract

The runtime policy core does not shell out to Claude Code, Anthropic, or any
substrate-specific inference command. Substrate adapters or callers must inject
a backend when they explicitly want model-backed inspection.

## Failure Semantics

Model-backed inspection is fail-explicit, not fail-open:

- missing backend: `model-inspector-unavailable`, `alert`
- timeout-like backend error: `model-inspector-timeout`, `alert`
- unparsable model output: `model-inspector-parse-error`, `alert`
- malformed JSON shape: `model-inspector-malformed-response`, `alert`
- other inference errors: `model-inspector-error`, `alert`

These findings do not override deterministic findings. If deterministic policy
already says `ask`, the final decision remains `ask`; if deterministic policy
already says `deny`, the model backend is not invoked.

## Difference From PAI RulesInspector

PAI v5.0.0 `RulesInspector.ts` loaded
`USER/SECURITY/SECURITY_RULES.md`, sent a Claude-specific inference prompt,
asked for `ALLOW` or `BLOCK`, cached results by tool input, and failed open on
parse or inference errors.

Soma deliberately changes that contract:

- rules are typed Soma policy config, not a canonical PAI markdown file
- inference is injected through the portable `InferenceBackend` interface
- model output cannot deny in this slice
- deterministic deny takes precedence and skips inference
- missing or broken inference emits explicit alert findings
- audit traces still store findings and input references, not raw model prompts
  or raw runtime input by default

## Non-Goals

- no default model-backed enforcement
- no substrate-specific shell-out from core runtime policy
- no model override of deterministic deny
- no model-only deny decisions in this slice
- no persistence of raw model prompts in security traces by default
