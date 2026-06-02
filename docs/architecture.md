# Soma Architecture

Soma separates the portable assistant core from the substrate that executes it.

## Core

The core is filesystem-native and substrate-neutral.

```text
SomaCore
  Identity
  Telos
  ISA
  Skills
  Memory
  Policy
  Learning
```

### Identity

Identity stores who the principal is and who the assistant is. It includes
profile facts, communication preferences, personality metadata, and optional
voice metadata. Identity is projected into the substrate but is not owned by
the substrate.

### Telos

Telos stores goals, principles, commitments, strategies, and desired state. It
is the steering source for assistant recommendations and prioritization.

### ISA

Ideal State Artifacts define work. An ISA is both the articulation of done and
the verification contract. Project ISAs live with projects. Task ISAs live under
Soma memory.

### Algorithm Harness

The Algorithm harness is the deterministic execution layer around ISA. PAI used
TheAlgorithm mostly as doctrine projected into Claude; Soma keeps that doctrine
as a portable skill, but also exposes typed run state and phase gates that a
substrate or daemon can call directly.

An Algorithm run moves in one direction only:

```text
OBSERVE -> THINK -> PLAN -> BUILD -> EXECUTE -> VERIFY -> LEARN -> COMPLETE
```

Each transition has a gate. For example, PLAN requires selected capabilities,
BUILD requires a criterion-mapped plan, VERIFY requires every plan step to be
done or blocked, LEARN requires every criterion to be passed or dropped, and
COMPLETE rejects structured capability selections that were not invoked or
removed. This is the part that adds determinism: the LLM can propose content,
but Soma decides whether the process is allowed to advance.

The harness is driven through explicit mutations rather than substrate-specific
conversation tricks. The portable command surface covers `new`, `list`, `show`,
`classify`, `capabilities`, `invoke`, `remove-capability`, `plan`, `decision`,
`change`, `step`, `verify`, `learn`, `advance`, and `resume`. `resume` accepts
an explicit `--until-phase` handoff boundary so a relay substrate can stop
before consuming downstream phases. `classify` is Soma's
UserPromptSubmit mode classifier: it chooses MINIMAL, NATIVE, or ALGORITHM and
maps Algorithm prompts to E1-E5 before a run is created. This adapts the useful
part of PAI's Algorithm tool while leaving Claude-only PRD parsing, prompt
curls, and loop execution outside the kernel.

Execution-mode gap-fills from PAI are specified in
[algorithm-execution-modes.md](./algorithm-execution-modes.md). Soma core owns
loop state, plateau detection, criteria partitioning, ideate/optimize
parameter presets, executor interfaces, and notification event contracts. The
actual worker spawn remains a substrate or orchestration responsibility.

### Skills

Skills are portable capability folders. A skill may contain a `SKILL.md`,
workflow files, tools, examples, and references. The core only defines discovery
and routing contracts. A substrate adapter decides how to load and execute them.
The progressive loading contract is specified in
[progressive-skill-loading.md](./progressive-skill-loading.md): Soma should
project a compact skill registry by default and load skill bodies only after a
task route selects them.

MCP-capable substrates may use the optional
[MCP server](./mcp-server.md) as the on-demand loading surface for skills,
memory, ISA, Algorithm, and identity context. The server remains a core/library
access surface; adapters only configure substrate-native MCP clients.

Team-shared skills use **team overlays** rather than multi-principal Soma
homes. A team overlay can supplement skill routing with team-provenanced skill
registries, while the personal Soma home remains owned by one principal. See
[docs/team-overlays.md](./team-overlays.md).

### Memory

Memory is structured as files first:

```text
MEMORY/
  WORK/
  KNOWLEDGE/
  LEARNING/
  RELATIONSHIP/
  STATE/
```

The initial version should avoid requiring a vector database. Search can start
with filenames, frontmatter, ripgrep, and small deterministic indexes.

Cross-machine Soma state uses **Home replication**, not projection refresh or
substrate writeback. The design is Git-backed first, policy-gated per scope,
and only auto-merges stores with deterministic merge semantics. See
[docs/home-replication.md](./home-replication.md).

Team `KNOWLEDGE`, `WORK`, and ISA material can be read through a team overlay,
but it stays namespaced and cited separately from personal memory. Team
overlays are read-only in the first slice and must not expose personal Identity,
Telos, Relationship, raw transcript, or security-trace compartments.

### Policy

Policy covers security, privacy, permission, and verification. Policies should
be executable where possible. Prompt-only policy is acceptable as a fallback,
but deterministic enforcement is the target.

## Adapters

Adapters project Soma into substrate-native primitives. One adapter per
substrate. See [CONTEXT.md](../CONTEXT.md) for glossary.

```ts
interface SomaAdapter {
  name: string;
  detect(): Promise<boolean>;
  project(input: ProjectionInput): Promise<Projection>;
  run(task: SomaTask): Promise<SomaRunResult>;
}
```

Examples:

- Codex adapter projects Soma into Codex-readable instruction files.
- Pi.dev adapter exposes tools through Pi extensions.
- Claude Code adapter projects Soma into system prompt, CLAUDE.md, hooks, and skills.
- Cortex adapter registers Soma as a Cortex agent daemon consuming Myelin envelopes.

## Runtime Modes

Five modes name where the projection lives or runs from. One-word names; the
`Mode` suffix is omitted in glossary use.

### home

Primary mode. Soma writes its projection into the substrate's home directory:
`~/.codex/`, `~/.claude/`, Pi.dev's extension home, or Cortex's agent registry.
Available by default in every session.

### workspace

Workspace mode projects into the current workspace (`./.codex/soma/`,
`./.claude/soma/`). Only present when the principal is in that workspace.
Overlays the home projection if both exist.

### library

A substrate CLI loads Soma as code and exposes tools. No projection on disk.
The substrate owns the process.

The optional MCP server is a library/daemon-compatible tool surface. It can
serve read-only context to MCP-capable substrates without replacing home and
workspace projections.

### daemon

Soma runs as a long-lived process, subscribes to Myelin subjects, owns state,
and publishes envelopes. No substrate involved.

Daemon mode consumes Cortex/Myelin contracts rather than defining bus semantics
inside Soma. It should start with dry-run and health surfaces, then add live
subscription only after Myelin subject and envelope contracts are imported from
their owning packages. See [docs/daemon-mode.md](./daemon-mode.md).

### export

Generate projection bytes (stdout or a tarball) without writing anywhere or
running anything. Dry-run / inspection shape.

## Relationship To Meta Factory

Soma should integrate with Meta Factory, not duplicate it:

- **Cortex** remains the collaboration surface.
- **Myelin** remains the bus/protocol stack.
- **Arc** remains package installation and distribution.
- **Signal** remains observability.
- **Spawn** remains isolated execution.
- **Compass** remains governance.

Soma owns the personal assistant core that can run inside or alongside those
components.

The detailed source-of-truth contract lives in [boundaries.md](./boundaries.md).
When a concept appears in more than one repo or substrate, the other copy must
be treated as a projection unless a sync contract says otherwise.

Eager-projection behaviour for the home mode is specified in
[default-availability.md](./default-availability.md). Soma should follow PAI's
lesson that the assistant needs a protected substrate home, while avoiding
PAI's Claude-only coupling.

## Lifecycle Harness

PAI's Claude implementation gets much of its value from hooks. Soma ports that
idea as a substrate-neutral lifecycle harness instead of copying Claude hook
files.

The V0 lifecycle surface has four events:

| Event | Purpose |
|-------|---------|
| `session_start` | Build startup context from identity, active Algorithm runs, learning, and relationship notes. |
| `algorithm_updated` | Write the canonical Algorithm work index under `memory/STATE/`. |
| `algorithm_observed` | Record explicit substrate observation provenance on the active Algorithm run, then refresh the canonical work index. |
| `session_end` | Refresh the work index and capture completed Algorithm runs into `memory/LEARNING/`. |

Substrates can call these events through the CLI or library. Cortex can later
subscribe to the same lifecycle surface as bus-visible work state.

## Observability

Observability V0 is a filesystem-native read model over
`memory/STATE/events.jsonl`. `soma telemetry list` queries recent events and
`soma telemetry stats` / `soma stats` summarizes event counts, lifecycle
sessions, writeback failures, Algorithm event phases when present, and skipped
malformed rows. This gives Soma a local inspection surface without adding a
database, daemon, dashboard, or Signal dependency.

Signal still owns telemetry systems. Soma emits and summarizes local events;
future Signal export should consume the same read model. See
[observability.md](./observability.md).
