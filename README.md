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
