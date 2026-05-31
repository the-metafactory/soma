# Daemon Mode

Issue #149 asks for `soma daemon`: a long-lived Soma process that can subscribe
to Myelin subjects, keep assistant availability alive without an active
substrate session, and route work before a substrate session is spawned.

Daemon mode does not make Soma the bus, collaboration surface, or process
supervisor. Soma owns the portable personal assistant core and the routing
decisions derived from that core. Cortex owns the collaboration surface, Myelin
owns transport and envelope semantics, and Spawn owns isolated execution.

## Goals

- Keep Soma identity, memory, ISA, policy, and skill routing available without
  requiring Codex, Claude Code, Pi.dev, Cursor, or another substrate session to
  already be active.
- Let Cortex/Myelin address a standalone Soma Cortex agent through approved
  Myelin envelopes.
- Route centrally before spawning or addressing substrate sessions, using the
  same progressive skill registry and policy checks as other runtime modes.
- Publish readiness, health, route decisions, work-state updates, and result
  events with clear provenance.
- Start with a dry-run and health surface before subscribing to live subjects.

## Non-Goals

- Soma daemon mode does not define Myelin protocol semantics, subject names,
  acknowledgements, retries, or credentials.
- Soma daemon mode does not replace Cortex as the collaboration surface.
- Soma daemon mode does not replace Spawn for sandboxed execution.
- Soma daemon mode does not make team overlays writable or multi-principal.
- The first implementation does not execute arbitrary envelopes from the bus.

## Ownership Boundary

| Area | Owner | Soma daemon role |
| --- | --- | --- |
| Assistant identity, Telos, ISA, memory, policy, and skill registry | Soma | Read and update through the normal Soma home contracts. |
| Myelin subject names, envelope schemas, ack/retry semantics, credentials | Myelin | Consume imported contracts; never invent incompatible wire semantics. |
| Collaboration routing, work queues, task assignment | Cortex | Let Cortex address or discover the Soma Cortex agent. |
| Isolated execution lifecycle | Spawn | Request execution when a task needs an isolated runtime. |
| Observability backends | Signal | Emit structured Soma events that Signal can collect. |

This boundary keeps daemon mode as a runtime mode for the same assistant body,
not a new ecosystem coordinator.

## Myelin Contract Shape

Soma should integrate through a narrow contract consumer for Myelin-owned
contracts. The design uses logical subject classes here; exact subject names,
wire versions, credentials, and retry policy must come from Myelin/Cortex
configuration or packages.

| Logical subject class | Direction | Daemon behavior |
| --- | --- | --- |
| Readiness/health | publish | Announce daemon identity, version, enabled scopes, and readiness. |
| Task or route request | subscribe | Validate envelope provenance and decide whether Soma can route or claim it. |
| Skill-route request | subscribe/reply | Return selected skills, source paths, and context budget without loading unrelated bodies. |
| Work-state event | publish | Mirror accepted task state into Soma `memory/STATE/` and publish a bus-visible update. |
| Result or refusal | publish | Report routed result metadata, refusal reason, or handoff target. |

Every inbound envelope is policy-checked before it can affect memory, skills,
ISA state, Algorithm runs, or substrate spawning. Unauthorized or malformed
envelopes fail closed and produce a refusal event instead of partial work.

## Routing Flow

1. Start `soma daemon` with a principal-selected Soma home and Cortex/Myelin
   configuration.
2. Load the Soma kernel: identity summary, active work/ISA, policy, skill
   registry, and team overlays that are enabled for daemon use.
3. Publish readiness and health.
4. Receive a Myelin envelope.
5. Verify envelope provenance, principal/team scope, requested capability, and
   policy.
6. Route against the progressive skill registry and active work state.
7. Either refuse with a structured reason, handle a read-only/library request
   locally, or request a substrate/Spawn execution path with selected context.
8. Record route decisions, loaded paths, policy decisions, and result metadata
   as append-only Soma events.

The daemon must preserve the same writeback gate used by substrate sessions.
Bus-visible events can mirror state, but they do not bypass Soma policy or
write directly into private compartments.

## First Implementation Slice

The first code slice should expose a non-subscribing surface:

- `soma daemon --dry-run` validates Soma home, enabled daemon scopes, and
  Cortex/Myelin configuration availability without connecting to the bus.
- `soma daemon --health` prints daemon readiness as JSON for supervisors.
- The CLI should keep the existing no-argument placeholder until live subscribe
  semantics are implemented.
- Health output should include Soma version, selected home, enabled scopes,
  configured Myelin source, and warnings for missing optional pieces.
- Tests should use a mock Myelin contract; no live bus is required.

The second slice can add read-only subscription to route and health subjects.
Claiming work, spawning substrate sessions, and publishing results should wait
until Myelin envelope contracts and credential handling are imported from the
owning packages.

## Safety Rules

- The daemon never relaxes personal policy; team overlay policy can only add
  restrictions.
- The daemon must not expose Identity, Telos, Relationship, raw transcripts, or
  security traces through team or bus-facing surfaces.
- The daemon records provenance for every accepted envelope and every selected
  skill or ISA.
- A bus envelope cannot become an unreviewed writeback operation.
- Live subscription must be opt-in and visible in health output.
