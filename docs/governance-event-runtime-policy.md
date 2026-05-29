# Governance Event Runtime Policy

Governance events are the runtime policy surface for assistant-work control
events. They model task requests, skill invocations, and qualified
substrate-assistant delegations without making Claude Code, PAI, or any bare
`agent` concept canonical in Soma.

This document is a design artifact for #255. It does not implement enforcement.

## Canonical Vocabulary

- `governance_event`: the runtime policy surface.
- `assistant-work event`: the input family for work coordination events.
- `task_request`: a proposed unit of work.
- `soma_skill_invocation`: invocation of a portable Soma skill.
- `substrate_skill_invocation`: invocation of a substrate-native skill.
- `substrate_assistant_delegation`: delegation to a qualified substrate
  assistant surface, such as a Claude Code sub-agent or Cortex agent.

Do not use bare `agent` in Soma core. Use qualified substrate terms when the
substrate primitive is itself named agent.

## Event Shape For Later Implementation

A later implementation should add a governance-event payload under the existing
runtime policy inspection model:

```ts
interface RuntimePolicyGovernanceEvent {
  kind:
    | "task_request"
    | "soma_skill_invocation"
    | "substrate_skill_invocation"
    | "substrate_assistant_delegation";
  substrate: SubstrateId;
  summary: string;
  actor?: "principal" | "assistant" | "substrate";
  target?: string;
  metadata?: Record<string, unknown>;
}
```

The `summary` must be bounded and metadata-only. Raw prompts, transcripts,
skill outputs, tool outputs, and full delegated task bodies should not be
stored in normalized events by default.

## Decision Semantics

Governance events can produce all runtime policy decisions, but most v0 checks
should start advisory:

| Behavior | Default decision | Rationale |
| --- | --- | --- |
| Vague or underspecified task request | `alert` | Helpful nudge; not a security block. |
| Excessive task creation rate | `ask` | Principal approval may be needed before spawning more work. |
| False-positive skill invocation | `alert` or `ask` | Depends on whether the substrate can ask synchronously. |
| Background-execution nudge | `alert` | Usually projection UX, not a core deny. |
| Delegation to untrusted/unknown qualified substrate-assistant surface | `ask` | Approval before delegating work outside the current substrate session. |
| Governance payload malformed at an enforceable pre-action gate | `deny` | Fail closed only when a substrate can enforce before the work starts. |

`deny` should be rare in the first implementation. Use it for malformed
pre-action payloads, explicit policy violations, or deterministic delegation
risks, not for ordinary quality nudges.

## Event And Trace Placement

Use the same runtime policy split:

- `memory/STATE/events.jsonl`: normalized `runtime_policy.inspect` event with
  surface `governance_event`, decision, finding kinds, and trace pointer.
- `memory/SECURITY/runtime-policy/`: detailed private security trace when the
  event is security-relevant or enforcement-affecting.
- `memory/OBSERVABILITY/`: optional future home for pure quality/recovery
  telemetry that is not security-relevant.

Do not introduce a separate governance log as a source of truth. If an event is
policy, it belongs under runtime policy. If it is pure product telemetry, route
it as observability.

## PAI Governance Hook Classification

| PAI behavior | Soma classification | Later implementation scope |
| --- | --- | --- |
| `TaskGovernance.hook.ts` task quality checks | `governance_event` policy, mostly advisory | Model `task_request` events; emit `alert` for vague tasks and `ask` for excessive task creation if enforceable. |
| `TaskGovernance.hook.ts` rate governance | `governance_event` policy | Add bounded counters in runtime policy config or state; do not hardcode PAI thresholds. |
| `SkillGuard.hook.ts` false-positive skill guard | `governance_event` policy | Model `soma_skill_invocation` and `substrate_skill_invocation`; start with `alert`, use `ask` where the substrate can ask. |
| `AgentExecutionGuard.hook.ts` background-execution nudge | substrate projection behavior with optional governance alert | Keep Claude Code sub-agent wording in the Claude projection. Core receives `substrate_assistant_delegation` only if a portable decision is needed. |
| Claude Code sub-agent start/stop metadata | observability/writeback | Continue metadata-only events; not a policy gate unless paired with an enforceable pre-start check. |

## Substrate Enforcement Map

| Substrate | Enforceable governance events | Advisory governance events |
| --- | --- | --- |
| Codex | None until Codex exposes a task/delegation hook beyond generic tool calls. | Prompt/tool-call text may mention delegation, but governance is advisory only. |
| Claude Code | Skill and sub-agent hook surfaces where settings hooks expose pre-action events. | Background-execution nudges and post-start sub-agent metadata. |
| Pi.dev | Extension-visible tool/session events where the extension can block or ask. | Session lifecycle quality nudges. |
| Cursor | Advisory rules/projection only unless a reliable hook/MCP gate is available. | Most governance events. |
| Cortex/Myelin | Dispatch gates before claiming or publishing work envelopes. | Post-dispatch observability and work-registry updates. |

## Implementation-Ready Scope

The later implementation slice should:

1. Extend `RuntimePolicyInspectOptions` with a `governanceEvent` payload.
2. Add deterministic governance inspectors for task vagueness, excessive task
   creation rate, false-positive skill invocation, and unknown delegation
   target.
3. Keep first implementation metadata-only: no raw delegated task body, no raw
   transcripts, no full skill output.
4. Add `soma policy inspect --surface governance_event` CLI parsing.
5. Project only to substrates with reliable pre-action or advisory surfaces.
6. Record `runtime_policy.inspect` events and private runtime-policy traces
   using the existing event/trace split.

Non-goals for that slice:

- no Claude hook file port as-is
- no bare `agent` core term
- no claim of equal enforcement across substrates
- no model-backed governance judgment before #256
