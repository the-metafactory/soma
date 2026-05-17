<!--
  Soma
-->

<p align="center">
  <img src="docs/diagrams/2026-05-16-soma-nautilus.jpg" alt="Soma, chambered nautilus, the durable portable self" width="320" />
</p>

<h1 align="center">Soma</h1>

<p align="center">
  <strong>Your AI assistant's identity, memory, and skills.<br />
  Kept in one place. Portable across Claude Code, OpenAI Codex, and Pi.dev.</strong>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.2.0-2A3F6A?labelColor=0E1726" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-2A3F6A?labelColor=0E1726" />
  <img alt="Runs in" src="https://img.shields.io/badge/runs%20in-Codex%20%C2%B7%20Pi.dev%20%C2%B7%20Claude%20Code-2A3F6A?labelColor=0E1726" />
</p>

<p align="center">
  Join the Meta Factory community on <a href="https://discord.gg/Z8CThhFukF">Discord</a>.
</p>

---

## Install

Install the package with Arc:

```bash
arc install @metafactory/soma
```

Or run it from a source checkout:

```bash
git clone https://github.com/the-metafactory/soma.git
cd soma
bun install
bun run soma --help
```

Then project Soma into the coding agent you use:

```bash
bun run soma install codex --apply
bun run soma install pi-dev --apply
bun run soma install claude-code --apply
```

> `soma adopt claude` still works as a legacy alias; new prose uses the
> unified `soma install claude-code` verb.

---

## What you get in 30 seconds

- **One assistant, many coding agents.** Your principal profile, goals, memory, skills, and learning live on your machine in `<soma-home>/`. Move between Claude Code, OpenAI Codex, and Pi.dev. Your assistant keeps remembering, keeps learning, and keeps you.
- **Filesystem-native by design.** Plain folders. Plain Markdown. You can read, edit, version, back up, and audit your assistant's brain with the same tools you use for everything else. No proprietary database. No vendor lock-in.
- **Ideal state built in.** Soma stores project and task ISAs, keeps one active ISA available to adapters, and gives the Algorithm a verification contract.

---

## Why Soma exists

The valuable part of a personal AI assistant is not one model and not one CLI. It is the operating system around the model. Who the assistant is, who *you* are, what you want, what good work looks like, what was learned last time, how work is verified.

Most AI tools today couple all of that to themselves. Change tools and you lose the assistant.

Soma decouples the durable parts from the tool that happens to run them. The tool becomes replaceable. The assistant keeps going.

---

## Architecture

<p align="center">
  <img src="docs/diagrams/2026-05-16-soma-nervous-system.jpg" alt="FIG. 0.1 — Soma at the centre of its adapters, with the Myelin spine running through" />
</p>

Soma owns the durable parts of your assistant.

| Layer | What lives there |
| --- | --- |
| **Identity** | Principal profile, assistant profile, voice and personality |
| **Telos** | Goals, principles, active commitments, desired state |
| **ISA** | Ideal-state artefacts for the projects and tasks you are running |
| **Skills** | Portable capability folders with instructions, workflows, and tools |
| **Memory** | Work, knowledge, learning, relationship, and state stores |
| **Policy** | Privacy, permission, and verification rules |
| **Adapters** | Thin bridges into the coding agents where Soma runs |

Soma deliberately does not own model selection, chat UI, tool runtimes, agent routing, or package distribution. Those belong to the coding agent you happen to be using, or to the surrounding tools that install and host Soma.

See [docs/boundaries.md](docs/boundaries.md) for the exact split.

---

## Your first session

Once installed, point Soma at the coding agent you want it to run in. Each adapter writes a small set of hooks and memory files into that agent's home so Soma activates on startup.

```bash
soma install codex --apply
soma install pi-dev --apply
soma install claude-code --apply
```

Then start a session and watch Soma surface its context.

Claude Code uses its native rules directory as the home projection so Claude
can auto-discover the Soma projection without depending on fragile
home-directory imports. `soma uninstall claude-code` removes only the
generated Soma projection.

<!--
  Demo recording brief (replace this whole block with the rendered asset).

  Goal: a ~30-second animated demo that drops into the README as a GIF and
  shows Soma surfacing context, switching agents, and searching memory.

  Recommended tooling: charmbracelet/vhs (https://github.com/charmbracelet/vhs).
  Write the script as docs/demos/2026-05-16-soma-first-session.tape and render
  to docs/demos/2026-05-16-soma-first-session.gif. vhs is deterministic, so
  the same .tape file can be re-rendered every release for a refreshed GIF.

  Alternative: asciinema if a terminal-text recording is preferred over a GIF.
  Output to docs/demos/2026-05-16-soma-first-session.cast and embed via the
  asciinema SVG link.

  Shot list (~30 seconds, six beats):

    1. Title beat (2s)
       # Soma — same self, any coding agent.

    2. Start a session in Codex (4s)
       $ soma lifecycle session-start --substrate codex
       → startup-context block: principal, active commitments, recent learning

    3. Switch to Pi.dev — same identity, different agent (4s)
       $ soma lifecycle session-start --substrate pi-dev
       → same identity surfaces, agent-specific projection

    4. Search memory (6s)
       $ soma memory search --query "client sovereignty"
       → matches across WORK, KNOWLEDGE, LEARNING with line numbers

    5. Promote a verified run to durable learning (5s)
       $ soma memory promote --from-run <run-id> --store learning \
           --title "Client sovereignty matters"
       → promoted with source link

    6. Capture in-session feedback as a candidate event (4s)
       $ soma feedback capture --text "Forgot the arc-manifest check" \
           --substrate codex
       → classified and recorded

    Closing card (2s)
       soma install codex --apply
-->

> [!NOTE]
> **Demo · first session in 30 seconds** *(animated GIF in production)*
>
> A six-beat run starting a Soma session in OpenAI Codex, switching to Pi.dev with the same identity intact, searching memory, promoting a verified run to durable learning, and capturing in-session feedback. Recorded with [`vhs`](https://github.com/charmbracelet/vhs) so it can be re-rendered every release. Full shot list in the HTML comment above this callout.

<!-- asset-slot: docs/demos/2026-05-16-soma-first-session.gif -->
<!-- replace with: ![Soma · first session in 30 seconds](docs/demos/2026-05-16-soma-first-session.gif) -->

> [!NOTE]
> **What you see when a session starts** *(screenshot in production)*
>
> The assistant identity card produced by `soma lifecycle session-start`. Principal, telos, active commitments, recent learning. Concrete, scannable, the same in every coding agent.

<!-- asset-slot: docs/screenshots/2026-05-16-session-start.png -->
<!-- replace with: ![Session-start output](docs/screenshots/2026-05-16-session-start.png) -->

---

## Bringing in your existing assistant

If you already run an assistant inside [Daniel Miessler's Personal AI Infrastructure (PAI)](https://github.com/danielmiessler/Personal_AI_Infrastructure), Soma can import the durable parts so you do not start from scratch.

```bash
soma migrate pai
soma migrate pai --apply
```

The migration orchestrator plans or applies identity, Algorithm, and PAI pack
imports in one pass, then writes a readable migration manifest under the Soma
profile import area.

The lower-level import commands are still available when you want to move one
category at a time:

```bash
soma import pai --dry-run
soma import pai --apply
```

This pulls your principal profile, assistant identity, and Telos summary into
`<soma-home>/profile/`. Source snapshots are kept under
`<soma-home>/profile/imports/claude/` so you can always trace what came from
where.

To port over the Algorithm (a small decision and verification harness that wraps AI work in a one-way phase machine):

```bash
soma import algorithm --apply
```

And to bring across a PAI skill pack. Soma converts portable workflows and tools, marks the rest as references, and refuses to copy anything that looks like a secret.

```bash
soma import pai-pack --pai-pack-dir <path-to-pack>
soma import pai-pack --apply --pai-pack-dir <path-to-pack>
```

See [docs/pai-pack-importer.md](docs/pai-pack-importer.md) for the rules.

---

## ISA: ideal state you can verify

Soma treats an ISA as the durable definition of "done" for a project, task, or
work session. ISAs live in the Soma home, and the active ISA is projected into
Codex, Pi.dev, and Claude Code so every substrate sees the same goal, criteria,
and verification contract.

```bash
soma isa scaffold --slug launch-plan --effort E2 --goal "Ship the launch plan with evidence"
soma isa use launch-plan
soma isa active
soma isa check launch-plan
```

The `soma isa` CLI can list, show, activate, scaffold, check, archive, and
upgrade the bundled ISA skill. Its library layer exposes the same behavior for
adapters and future daemons.

For parallel feature work, Soma can deterministically reconcile a derived
feature ISA back into its master by stable ISC IDs. Reconcile appends
verification, decisions, and changelog entries without treating feature files as
the source of truth. See [docs/isa-reconcile.md](docs/isa-reconcile.md).

---

## The Algorithm in one breath

Soma ships a small deterministic harness for non-trivial work. It walks every task through eight phases:

```text
OBSERVE → THINK → PLAN → BUILD → EXECUTE → VERIFY → LEARN → COMPLETE
```

Your AI assistant proposes the state, the criteria, the plan, the decisions, the changes, and the evidence. Soma decides whether the run is allowed to advance. Nothing moves forward without verifiable evidence.

```bash
soma algorithm classify --prompt "..."
soma algorithm new --prompt "..." --intent "..." --current-state "..." --goal "..." --criterion "C1:..."
soma algorithm plan --id <run-id> --step "P1:C1:Implement the harness"
soma algorithm verify --id <run-id> --criterion-id C1 --status passed --evidence "bun test"
soma algorithm advance --id <run-id>
```

Effort scales automatically (E1 through E5) based on the prompt. Generated run IDs are date-first (`YYYYMMDD_alg_<suffix>`) so chronology is the default sort.

When an active ISA exists, Algorithm decisions, changes, and verification can
flow through the ISA lifecycle path. When no active ISA exists, Soma stays
non-blocking: substantial E3+ work receives an advisory scaffold hint, but
ordinary Algorithm runs can still complete without being forced into an ISA.

---

## Memory you can actually read

Soma keeps memory as plain files in five stores: **WORK**, **KNOWLEDGE**, **LEARNING**, **RELATIONSHIP**, and **STATE**. Search and promotion are deterministic.

```bash
soma memory search --query "client sovereignty agency"
soma memory promote --from-run <run-id> --store learning --title "Reusable lesson"
soma feedback capture --text "you missed the arc-manifest"
```

Feedback capture is intentionally weaker than promotion. It classifies what looks like a correction, a preference, a relationship note, or a learning, and appends a *candidate* event for later review. Prompt excerpts are not stored by default. The `--store-excerpt` flag is explicit opt-in.

---

## Privacy and policy

A deterministic privacy guard ships in V0.

```bash
soma policy check --action write --destination ./README.md --content "..."
```

The guard blocks obvious movement of private Soma or projection source material
into public destinations and records every check as an event. It allows normal
memory writes under Soma's own memory tree while still guarding destructive
root-level paths. See [docs/private-source-guard-v0.md](docs/private-source-guard-v0.md)
for the matcher rules.

---

## What runs Soma today

| Coding agent | Status |
| --- | --- |
| **OpenAI Codex** (the command-line coding agent) | ✅ Shipping |
| **Pi.dev** (the Pi developer harness) | ✅ Shipping |
| **Claude Code** (Anthropic's terminal-and-IDE coding agent) | ✅ Shipping |
| **Cortex** (operator collaboration surface) | 🛠 Planned |

The adapter contract is small enough to write in an afternoon. If you want Soma in an agent that is not on this list, see [docs/substrate-adapters.md](docs/substrate-adapters.md).

---

## Documentation

- [CONTEXT.md](CONTEXT.md), the shared Soma vocabulary used by docs, CLI, and ISA
- [docs/boundaries.md](docs/boundaries.md), exactly what Soma owns and does not own
- [docs/default-availability.md](docs/default-availability.md), home install versus workspace overlay
- [docs/isa-reconcile.md](docs/isa-reconcile.md), deterministic ISA feature-file reconciliation
- [docs/progressive-skill-loading.md](docs/progressive-skill-loading.md), the skill registry and just-in-time loading
- [docs/writeback-and-policy.md](docs/writeback-and-policy.md), projection, writeback, conflict, and policy semantics
- [docs/pai-pack-importer.md](docs/pai-pack-importer.md), what a PAI pack import does and refuses
- [docs/private-source-guard-v0.md](docs/private-source-guard-v0.md), the V0 privacy guard rules
- [docs/portability-proof.md](docs/portability-proof.md), the first portability proof and what counts as evidence

---

## Origins and inspiration

Soma stands on the shoulders of [Daniel Miessler](https://github.com/danielmiessler) and his [Personal AI Infrastructure (PAI)](https://github.com/danielmiessler/Personal_AI_Infrastructure) project. Many of the core ideas Soma builds on — the principal profile, Telos as a first-class structure for goals and principles, the assistant as an operating system rather than a single CLI, the Algorithm as a deterministic harness around AI work, and the conviction that the durable parts of a personal assistant should live in your filesystem and belong to you — come directly from PAI.

What Soma adds is the **portability layer**, and a few deliberate departures from how PAI organises the durable parts. PAI lives inside one coding agent at a time and bundles the assistant's operating system into one integrated tree. Soma extracts the durable parts, gives them a stable file format and a small adapter contract, and lets the same assistant move between agents without losing itself. Where PAI is the operating system, Soma is the body that can move between hosts.

Soma also takes the concepts further:

- **More modular than monolithic.** Skills, memory stores, and policies are first-class folders that can be installed, upgraded, audited, and removed independently. The assistant is composed, not bundled.
- **Lightweight by default.** The runtime is a small typed CLI with deterministic mutations. Light enough to drop into any coding agent without dragging a framework behind it.
- **Built for distributed agentic workloads.** The adapter contract and memory layout are designed for agent teams and swarms running in parallel, not just one principal on one laptop talking to one agent.

Soma also includes a dedicated importer for existing PAI installations, so the work you have already put into your assistant inside PAI travels with you.

---

## Status

Soma is now a typed CLI and library with shipping home projections for Codex,
Pi.dev, and Claude Code. The current center of gravity is the filesystem
contract: profile, telos, memory, policy, skills, Algorithm runs, and ISAs stay
portable in the Soma home, while adapters project that same core into each
substrate's native shape. The daemon and richer Cortex/Myelin integration come
after the file format, writeback gates, and adapter behavior are stable.

---

## License

MIT. See [LICENSE](LICENSE).

---

<p align="center">
  <sub>Built by <a href="https://github.com/jcfischer">Jens-Christian Fischer</a>.</sub><br />
  <sub>Built on the shoulders of <a href="https://github.com/danielmiessler/Personal_AI_Infrastructure">Daniel Miessler's PAI</a>.</sub>
</p>
