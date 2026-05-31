# Ownership Boundaries

Soma is the portable personal assistant kernel. It should reference nearby Meta
Factory systems without absorbing their responsibilities. Glossary lives in
[CONTEXT.md](../CONTEXT.md).

## Source Of Truth

| Concept | Source of truth | Soma role |
| --- | --- | --- |
| Personal assistant identity | Soma | Owns portable identity schema and projection. |
| Principal profile | Soma | Owns personal profile shape and its projection (scrubbed so private data does not leak between substrates). |
| Telos | Soma | Owns personal goals, principles, commitments, and prioritization. |
| Project ISA | Project repository | Reads and summarizes local `ISA.md`; does not centralize every project task. |
| Personal/task ISA | Soma memory | Owns personal assistant tasks that do not belong to one project repo. |
| Skills as portable capability folders | Soma | Owns portable skill metadata and discovery contract. |
| Team skill distribution | Arc | Soma can mount Arc-installed skill packs as team overlays; Arc owns package lifecycle and version resolution. |
| Team SOPs and governance | Compass | Soma can reference Compass ids in team overlays; Compass remains the governance authority. |
| Claude Code skills | Claude Code adapter | A Soma skill's Claude Code projection. |
| Codex instructions | Codex adapter | A Soma skill's Codex projection (Codex instruction). |
| SOPs and governance | Compass | Soma references Compass rules; it does not redefine org process. |
| Daemon, bus, and envelopes | Cortex / Myelin | Soma can run as a Cortex agent, but Myelin owns protocol semantics. |
| Installation and distribution | Arc | Soma ships manifests; Arc owns package lifecycle. |
| Observability | Signal | Soma emits events; Signal owns telemetry systems. |
| Isolated execution | Spawn | Soma requests execution; Spawn owns sandbox lifecycle. |

## Boundary Rules

- Soma owns portable personal assistant concepts.
- Adapters own substrate projection only. One adapter per substrate.
- Nearby systems own ecosystem-level mechanics.
- A duplicated concept must declare one source of truth and one or more
  projections.
- A projection can cache, summarize, or project source data, but it must not
  become an independent editing surface without a writeback contract.
- Substrate → Soma flow is **writeback** only, gated by Policy
  (see [writeback-and-policy.md](./writeback-and-policy.md)). Substrate-side
  state Soma does not author is **mirrored** into `MEMORY/STATE/`.
- Team overlays supplement personal Soma state. They must not become a shared
  personal home, and they must not contain personal Identity, Telos,
  Relationship, raw transcript, or security-trace compartments.
- Daemon mode is a Soma runtime mode, not a new bus contract. Soma may route and
  publish assistant work as a Cortex agent, while detailed Myelin ownership
  terms stay canonical in [daemon-mode.md](./daemon-mode.md).

## Naming Rules

Use `skill` in Soma only for portable capability folders. When referring to a
substrate-specific capability primitive, qualify it:

- `Soma skill` (or bare `skill` in Soma docs — unqualified always means Soma)
- `Claude Code skill` (the substrate's native capability primitive)
- `Pi.dev skill`
- `Codex instruction` (Codex has no native skill primitive)
- `Compass SOP`

To name the projected output, use the possessive: "the skill's Claude Code
projection" — not "Claude Code skill projection", which is ambiguous.

If a capability is only meaningful inside one substrate, it belongs in that
adapter and should not be named a Soma skill.
