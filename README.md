<!--
  Soma
-->

<p align="center">
  <img src="docs/diagrams/2026-05-16-soma-nautilus.jpg" alt="Soma, chambered nautilus, the durable portable self" width="320" />
</p>

<h1 align="center">Soma</h1>

<p align="center">
  <strong>Your AI assistant's identity, memory, skills, and working method.<br />
  Kept in one place. Projected into Claude Code, OpenAI Codex, Pi.dev, Cursor, and future substrates.</strong>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.6.4-2A3F6A?labelColor=0E1726" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-2A3F6A?labelColor=0E1726" />
  <img alt="Runs in" src="https://img.shields.io/badge/runs%20in-Codex%20%C2%B7%20Pi.dev%20%C2%B7%20Claude%20Code%20%C2%B7%20Cursor-2A3F6A?labelColor=0E1726" />
</p>

<p align="center">
  Join the Meta Factory community on <a href="https://discord.gg/32xa5ev6Tq">Discord</a>.
</p>

---

## Why this project?

[Personal AI Infrastructure (PAI)](https://github.com/danielmiessler/Personal_AI_Infrastructure)
and Daniel Miessler's [TELOS](https://github.com/danielmiessler/telos)
project proved a strong idea: a useful AI assistant is not just a model
prompt. It is a portable operating context around the model:

- identity: who the assistant is and who it serves
- telos: goals, principles, commitments, and desired state
- memory: what has been learned across sessions
- skills: reusable procedures and capability folders
- working method: Algorithm, ISA, verification, and learning loops
- policy: privacy, permission, and evidence rules

TELOS provides the deep-context structure for articulating what a person,
team, or organization is about: missions, goals, problems, strategies,
projects, and measures of progress. PAI showed how that kind of context can
become active inside an AI assistant. Soma extracts the durable parts into a
shared assistant core that can be projected into many hosts.

Soma exists to abstract those ideas out of one host and make them usable across
many substrates. The assistant core lives in a filesystem-native Soma home.
Codex, Claude Code, Pi.dev, Cursor, and future hosts receive projections of
that same core instead of each becoming a separate assistant island.

The result is simple: change tools without losing the assistant.

---

## The shape

```text
             +----------------+
             |   Soma home    |
             | identity       |
             | telos          |
             | ISA            |
             | skills         |
             | memory         |
             | policy         |
             | Algorithm runs |
             +--------+-------+
                      |
        +-------------+-------------+
        |             |             |
     Codex      Claude Code      Pi.dev      Cursor      Cortex/Myelin
  projection     projection   projection   projection      planned
```

Soma owns the durable assistant core. Adapters own the substrate-native shape:
instruction files, rules, hooks, skills, extensions, lifecycle writeback, and
cleanup behavior.

Soma deliberately does not own the chat UI, model provider, package manager,
observability stack, bus, or agent orchestration layer. Those stay with the
host substrate and the surrounding Meta Factory stack. See
[docs/boundaries.md](docs/boundaries.md) and
[docs/substrate-adapters.md](docs/substrate-adapters.md).

---

## Migrate from PAI

If you already have a PAI installation, Soma can import the durable parts so
you do not start over.

```bash
soma migrate pai --pai-repo <path-to-pai>
soma migrate pai --pai-repo <path-to-pai> --apply
```

The migration orchestrator plans or applies these phases in order:

- principal and assistant identity
- Telos and profile material
- Algorithm doctrine and harness material
- translated memory
- PAI documentation and templates
- portable PAI packs as Soma skills
- a readable migration manifest for audit and reruns

Migration is designed to be idempotent. Dry-run first, inspect what would be
written, then apply. After migration, the Soma home is the source of truth and
each coding agent gets a projection from it.

See [docs/migration-from-pai.md](docs/migration-from-pai.md) for the complete
walkthrough, flags, verification steps, and troubleshooting.

### Import installed PAI skills

When you want to import the skills your running PAI already exposes through
Claude Code, use the installed-skill path:

```bash
soma migrate claude-skills --from <claude-home>/skills
soma migrate claude-skills --from <claude-home>/skills --apply
```

The migrator classifies each skill as portable, needs adaptation, or
Claude-specific. Add substrate smoke checks when you want proof that imported
skills project cleanly:

```bash
soma migrate claude-skills --from <claude-home>/skills --smoke codex --smoke pi-dev
```

Oversize descriptions can be rewritten for substrate limits:

```bash
soma migrate claude-skills --from <claude-home>/skills --rewrite-descriptions auto --apply
```

For lower-level pack imports, see
[docs/pai-pack-importer.md](docs/pai-pack-importer.md).

---

## One assistant, many substrates

Install Soma once, then project it into the agents you use:

```bash
soma install codex --apply
soma install claude-code --apply
soma install pi-dev --apply
soma install cursor --apply
```

Each adapter writes the same assistant context into the host's native shape:

| Substrate | Projection |
| --- | --- |
| OpenAI Codex | AGENTS instructions, rules, hooks, skills, and memory summaries |
| Claude Code | rules, hooks, settings entries, and generated Soma-owned skill files |
| Pi.dev | extensions, context files, skills, and Algorithm rendering support |
| Cursor | `.cursorrules` and `.cursor/rules/soma/` projection files |
| Cortex/Myelin | planned agent/daemon integration |

The shared experience comes from a single source of truth:

- session startup reads the same identity, telos, active work, and learning
- Algorithm runs and ISA state stay portable
- feedback and lifecycle events write back through Soma's memory and policy gates
- uninstall removes only generated Soma projection files

The home projection is the default assistant context for a substrate: identity,
telos, memory layout, policy, active work, and shared skills. A workspace
projection is an extra project-local layer. Use it when a repository needs its
own ISA, local rules, local skills, or project-specific memory pointers. The
workspace layer adds that context for sessions started in that repository
without forking the assistant or replacing the shared Soma home.

```bash
soma install codex --workspace --apply
soma install claude-code --workspace --apply
soma install cursor --workspace --apply
```

---

## PAI-inspired tools

Soma does not merely copy PAI files. It turns the useful PAI patterns into
typed, substrate-portable tools.

### The Algorithm

The Algorithm is the deterministic work harness around non-trivial AI work.
It turns "help me do this" into a gated run:

```text
OBSERVE -> THINK -> PLAN -> BUILD -> EXECUTE -> VERIFY -> LEARN -> COMPLETE
```

The assistant proposes current state, goal, criteria, plan, changes, evidence,
and learning. Soma stores the run and decides whether phase gates are allowed
to advance.

```bash
soma algorithm classify --prompt "..."
soma algorithm new --prompt "..." --intent "..." --current-state "..." --goal "..." --criterion "C1:..."
soma algorithm plan --id <run-id> --step "P1:C1:Implement the adapter"
soma algorithm verify --id <run-id> --criterion-id C1 --status passed --evidence "bun test"
soma algorithm advance --id <run-id>
```

Capabilities are registry-backed commitments. If a run selects a capability,
it must be invoked with evidence or explicitly removed before completion.

```bash
soma algorithm capabilities --id <run-id> --capability sequential-analysis --reason "Order the migration steps"
soma algorithm invoke --id <run-id> --capability sequential-analysis --evidence "Plan sequenced and recorded"
```

### ISA

An Ideal State Artifact is the definition of done for a project, task, or work
session. It carries criteria and verification evidence across substrates.

```bash
soma isa scaffold --slug launch-plan --effort E2 --goal "Ship the launch plan with evidence"
soma isa use launch-plan
soma isa active
soma isa check launch-plan
```

For parallel feature work, Soma can reconcile feature ISAs back into a master
ISA by stable criterion IDs. See [docs/isa-reconcile.md](docs/isa-reconcile.md).

### Skills

Skills are portable capability folders. A skill can include `SKILL.md`,
workflows, references, examples, tools, and a `soma-skill.json` manifest.
Adapters decide how the skill is projected into each substrate.

Soma supports progressive skill loading: project a compact registry by default,
then load the selected skill body only when a task route needs it. See
[docs/progressive-skill-loading.md](docs/progressive-skill-loading.md).

### Learning patterns

PAI's strongest lesson is that the assistant should improve from verified
work, not vague session vibes. Soma keeps memory as readable files and exposes
explicit learning paths:

```bash
soma memory search --query "client sovereignty agency"
soma memory promote --from-run <run-id> --store learning --title "Reusable lesson"
soma feedback capture --text "you missed the arc-manifest check"
```

Promotion is deliberate: a verified run can become durable learning. Feedback
capture is weaker by design: it records candidate corrections, preferences, or
learning events for review. Prompt excerpts are not stored by default; storing
one requires explicit opt-in.

---

## Install

Install with Arc:

```bash
arc install @metafactory/soma
```

If `arc upgrade soma` resolves the new version but refuses to replace an older
active install, use Arc's remove-then-install recovery path:

```bash
arc remove soma
arc install @metafactory/soma
```

See [docs/arc-install-troubleshooting.md](docs/arc-install-troubleshooting.md)
for the pinned-version variant.

Or run from source:

```bash
git clone https://github.com/the-metafactory/soma.git
cd soma
bun install
bun run soma --help
```

Then project Soma into at least one substrate:

```bash
bun run soma install codex --apply
bun run soma install claude-code --apply
bun run soma install pi-dev --apply
bun run soma install cursor --apply
```

---

## Privacy and policy

Soma's V0 policy guard blocks obvious movement of private Soma or projection
source material into public destinations and records checks as events.

```bash
soma policy check --action write --destination ./README.md --content "..."
```

The guard allows normal writes under Soma's memory tree while protecting
public files and destructive root-level paths. See
[docs/private-source-guard-v0.md](docs/private-source-guard-v0.md).

---

## Status

Soma is a typed CLI and library with shipping home projections for Codex,
Claude Code, Pi.dev, and Cursor. The current center of gravity is the portable
filesystem contract: profile, telos, memory, policy, skills, Algorithm runs,
and ISAs stay in the Soma home while adapters project that core into each
substrate's native shape.

Daemon mode and deeper Cortex/Myelin integration come after the file format,
writeback gates, and adapter behavior are stable.

---

## Documentation

- [CONTEXT.md](CONTEXT.md), the shared Soma vocabulary used by docs, CLI, and ISA
- [docs/architecture.md](docs/architecture.md), the core/adapters/runtime model
- [docs/boundaries.md](docs/boundaries.md), exactly what Soma owns and does not own
- [docs/substrate-adapters.md](docs/substrate-adapters.md), adapter behavior by host
- [docs/migration-from-pai.md](docs/migration-from-pai.md), PAI migration walkthrough
- [docs/pai-pack-importer.md](docs/pai-pack-importer.md), PAI pack import rules
- [docs/progressive-skill-loading.md](docs/progressive-skill-loading.md), skill registry and just-in-time loading
- [docs/writeback-and-policy.md](docs/writeback-and-policy.md), projection, writeback, conflict, and policy semantics
- [docs/portability-proof.md](docs/portability-proof.md), the first portability proof and evidence contract

---

## License

MIT.

---

<p align="center">
  <sub>Built by <a href="https://github.com/jcfischer">Jens-Christian Fischer</a>.</sub><br />
  <sub>Built on the shoulders of <a href="https://github.com/danielmiessler/Personal_AI_Infrastructure">Daniel Miessler's PAI</a> and <a href="https://github.com/danielmiessler/telos">TELOS</a>.</sub>
</p>
