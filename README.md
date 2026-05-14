# Soma

Substrate-portable Personal AI Assistant core.

Soma extracts the durable idea behind an agentic personal AI assistant from any
single coding harness. It is the portable body of the assistant: identity,
memory, ideal-state work tracking, skills, learning, and adapters for the
substrates that can execute work.

The first target substrates are:

- Codex
- Pi.dev
- Claude Code
- Cortex / Myelin as a daemon or bus-connected agent

## Why This Exists

PAI shows that the valuable part of a personal assistant is not one model or one
CLI. The valuable part is the surrounding operating system:

- who the assistant is
- who the principal is
- what the principal wants
- what good work looks like
- which skills and tools are available
- what happened before
- what was learned
- how work is verified

Soma makes those parts explicit and portable. A substrate should be replaceable.
The personal assistant core should remain.

Soma is meant to be installed into a substrate's user-level home so it is
available by default. Project-local context is an overlay, not the main install
path.

The PAI importer migrates durable identity material from an existing Claude PAI
home into Soma:

```bash
bun run soma import pai --dry-run
bun run soma import pai --apply
```

It imports the principal profile, Ivy assistant identity, and TELOS summary into
`~/.soma/profile/`, while keeping source snapshots under
`~/.soma/profile/imports/claude/`.

The Algorithm importer ports PAI's Algorithm doctrine into a portable Soma skill:

```bash
bun run soma import algorithm --dry-run
bun run soma import algorithm --apply
```

Soma also exposes a deterministic Algorithm harness. The harness wraps ISA work
in a one-way phase machine:

```text
OBSERVE -> THINK -> PLAN -> BUILD -> EXECUTE -> VERIFY -> LEARN -> COMPLETE
```

Substrates can create persisted runs with:

```bash
bun run soma algorithm new --prompt "..." --intent "..." --current-state "..." --goal "..." --criterion "C1:..."
```

The LLM can propose state, criteria, plans, decisions, changes, and evidence;
Soma decides whether the run is allowed to advance. PAI's original tool has many
Claude-specific commands and PRD conveniences; Soma keeps the portable part as a
typed mutation surface:

```bash
bun run soma algorithm capabilities --id <run-id> --capability FeedbackMemoryConsult
bun run soma algorithm plan --id <run-id> --step "P1:C1:Implement the harness."
bun run soma algorithm advance --id <run-id>
bun run soma algorithm change --id <run-id> --text "Added the deterministic CLI."
bun run soma algorithm step --id <run-id> --step-id P1 --status done --evidence "Tests pass."
bun run soma algorithm verify --id <run-id> --criterion-id C1 --status passed --evidence "bun test"
bun run soma algorithm learn --id <run-id> --text "Harness gates should be explicit."
```

Lifecycle commands provide the substrate-neutral version of PAI's hooks:

```bash
bun run soma lifecycle session-start --substrate codex
bun run soma lifecycle algorithm-updated --substrate codex
bun run soma lifecycle session-end --substrate codex
```

`session-start` emits a startup context block from Soma identity, active
Algorithm runs, recent learning, and relationship notes. `algorithm-updated`
writes `~/.soma/memory/STATE/algorithm-work-index.json`. `session-end` refreshes
the index and captures completed Algorithm runs into `~/.soma/memory/LEARNING/`.

## What Soma Is

Soma is a small runtime-independent kernel for personal AI assistants.

It owns:

- **Identity**: principal profile, assistant profile, voice/personality metadata
- **Telos**: goals, principles, active commitments, desired state
- **ISA**: ideal-state artifacts for projects and tasks
- **Skills**: portable capability folders with instructions, workflows, and tools
- **Memory**: work, knowledge, learning, relationship, and state stores
- **Policy**: security, privacy, permission, and verification rules
- **Adapters**: thin bridges into Codex, Pi.dev, Claude Code, and Cortex

It does not own:

- model selection
- chat UI
- substrate-specific tool implementations
- organization-wide agent routing
- marketplace distribution

Those belong to the substrate or to Meta Factory components such as Cortex,
Myelin, Arc, Signal, Spawn, and Compass.

See [docs/boundaries.md](docs/boundaries.md) for the source-of-truth split across
Soma, Compass, Cortex/Myelin, Arc, Signal, Spawn, and substrate adapters.
See [docs/default-availability.md](docs/default-availability.md) for the home
install versus workspace overlay model.
See [docs/writeback-and-policy.md](docs/writeback-and-policy.md) for the current
projection, writeback, conflict, and policy enforcement semantics.

## Architecture Sketch

```text
                Principal
                    |
                    v
             +-------------+
             |    Soma     |
             | identity    |
             | telos       |
             | ISA         |
             | skills      |
             | memory      |
             | policy      |
             +------+------+ 
                    |
          substrate adapters
                    |
   +----------------+----------------+
   |                |                |
 Codex            Pi.dev         Claude Code
   |
 Cortex/Myelin daemon mode
```

## Repository Layout

```text
soma/
  README.md
  ISA.md
  arc-manifest.yaml
  package.json
  docs/
    architecture.md
    substrate-adapters.md
    naming.md
  skill/
    SKILL.md
    Workflows/
      DesignAssistantCore.md
  src/
    adapters/
    index.ts
    types.ts
  test/
```

## Initial Position

Soma should start as a design-first project, then grow into a library and daemon.
The first useful implementation is not a full assistant. It is a stable file
format and adapter contract that lets the same personal assistant context run
inside several substrates without rewriting the assistant each time.

The first portability proof is intentionally narrow: generate equivalent context
from the same profile, telos, memory layout, skills, and ISA for Codex and then a
second substrate. See [docs/portability-proof.md](docs/portability-proof.md).
