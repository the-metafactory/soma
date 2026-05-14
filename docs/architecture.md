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
voice metadata. Identity is loaded into substrate context but is not owned by
the substrate.

### Telos

Telos stores goals, principles, commitments, strategies, and desired state. It
is the steering context for assistant recommendations and prioritization.

### ISA

Ideal State Artifacts define work. An ISA is both the articulation of done and
the verification contract. Project ISAs live with projects. Task ISAs live under
Soma memory.

### Algorithm Harness

The Algorithm harness is the deterministic execution layer around ISA. PAI used
TheAlgorithm mostly as doctrine inside Claude context; Soma keeps that doctrine
as a portable skill, but also exposes typed run state and phase gates that a
substrate or daemon can call directly.

An Algorithm run moves in one direction only:

```text
OBSERVE -> THINK -> PLAN -> BUILD -> EXECUTE -> VERIFY -> LEARN -> COMPLETE
```

Each transition has a gate. For example, PLAN requires selected capabilities,
BUILD requires a criterion-mapped plan, VERIFY requires every plan step to be
done or blocked, and LEARN requires every criterion to be passed or dropped.
This is the part that adds determinism: the LLM can propose content, but Soma
decides whether the process is allowed to advance.

The harness is driven through explicit mutations rather than substrate-specific
conversation tricks. The portable command surface covers `new`, `list`, `show`,
`capabilities`, `plan`, `decision`, `change`, `step`, `verify`, `learn`, and
`advance`. This adapts the useful part of PAI's Algorithm tool while leaving
Claude-only PRD parsing, prompt curls, and loop execution outside the kernel.

### Skills

Skills are portable capability folders. A skill may contain a `SKILL.md`,
workflow files, tools, examples, and references. The core only defines discovery
and routing contracts. A substrate adapter decides how to load and execute them.

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

### Policy

Policy covers security, privacy, permission, and verification. Policies should
be executable where possible. Prompt-only policy is acceptable as a fallback,
but deterministic enforcement is the target.

## Adapters

Adapters translate Soma into substrate-native primitives.

```ts
interface SomaAdapter {
  name: string;
  detect(): Promise<boolean>;
  buildContext(input: SomaContextInput): Promise<SomaContextBundle>;
  run(task: SomaTask): Promise<SomaRunResult>;
}
```

Examples:

- Codex adapter writes instructions into a Codex-friendly context package.
- Pi.dev adapter exposes tools through Pi extensions.
- Claude Code adapter maps Soma into system prompt, CLAUDE.md, hooks, and skills.
- Cortex adapter registers Soma as a daemon or in-process agent consuming Myelin envelopes.

## Runtime Modes

### Home Install Mode

Used to make Soma available by default in a substrate. Soma writes or updates
user-level substrate projections from `~/.soma/` into homes such as `~/.codex/`,
`~/.claude/`, Pi.dev's extension home, or Cortex's agent registry. This is the
primary install path.

### Library Mode

Used by a substrate CLI. Soma builds context and exposes tools, but the substrate
owns the process.

### Daemon Mode

Used by Cortex/Myelin. Soma runs as a long-lived process, subscribes to work
subjects, owns state, and publishes envelopes.

### Export Mode

Used to generate substrate-specific configuration without running anything.

### Workspace Overlay Mode

Used to add project-local context to a workspace. Workspace overlays complement
the home install; they are not the primary way Soma becomes available.

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

Default availability is specified in [default-availability.md](./default-availability.md).
Soma should follow PAI's lesson that the assistant needs a durable substrate
home, while avoiding PAI's Claude-only coupling.

## Lifecycle Harness

PAI's Claude implementation gets much of its value from hooks. Soma ports that
idea as a substrate-neutral lifecycle harness instead of copying Claude hook
files.

The V0 lifecycle surface has three events:

| Event | Purpose |
|-------|---------|
| `session_start` | Build startup context from identity, active Algorithm runs, learning, and relationship notes. |
| `algorithm_updated` | Write the canonical Algorithm work index under `memory/STATE/`. |
| `session_end` | Refresh the work index and capture completed Algorithm runs into `memory/LEARNING/`. |

Substrates can call these events through the CLI or library. Cortex can later
subscribe to the same lifecycle surface as bus-visible work state.
