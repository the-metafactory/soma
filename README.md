<!--
  Soma · Metafactory package landing
  Reading this raw? Visit the rendered version at meta-factory.ai or on GitHub.
-->

<p align="center">
  <img src="docs/diagrams/2026-05-16-soma-nautilus.png" alt="Soma — chambered nautilus, the durable portable self" width="280" />
</p>

<h1 align="center">Soma</h1>

<p align="center">
  <strong>Your AI assistant's identity, memory, and skills.<br />
  Kept in one place. At home in any AI tool you use.</strong>
</p>

<p align="center">
  <a href="https://meta-factory.ai/@metafactory/soma"><img alt="Version" src="https://img.shields.io/badge/version-0.1.4-2A3F6A?labelColor=0E1726" /></a>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-2A3F6A?labelColor=0E1726" />
  <img alt="Trust tier" src="https://img.shields.io/badge/%E2%98%85-STEWARD-C4302B?labelColor=0E1726" />
  <img alt="Signed" src="https://img.shields.io/badge/signed-SHA--256%20%C2%B7%20Ed25519%20%C2%B7%20Sigstore-2A3F6A?labelColor=0E1726" />
  <img alt="Runs in" src="https://img.shields.io/badge/runs%20in-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Pi.dev%20%C2%B7%20Cortex-2A3F6A?labelColor=0E1726" />
</p>

---

## Install

```bash
arc install @metafactory/soma
```

That single command pulls a signed package from Metafactory, verifies three independent cryptographic attestations, and installs Soma into your AI assistant's home so it is available by default.

No login required. No tracking. The bytes you install are the same bytes the registry attested to.

---

## What you get in 30 seconds

- **One assistant, many tools.** Your principal profile, goals, memory, skills, and learning live on your machine in `~/.soma/`. Switch between Claude Code, Codex, Pi.dev, or Cortex and your assistant keeps remembering, keeps learning, and keeps you.
- **Filesystem-native by design.** Plain folders. Plain Markdown. You can read, edit, version, back up, and audit your assistant's brain with the same tools you use for everything else. No proprietary database. No vendor lock-in.
- **Cryptographically attested.** Every Soma release is signed three independent ways. Your `arc install` checks the bytes (SHA-256), the registry attestation (Ed25519), and the publisher attestation (Sigstore) before a single file lands on disk.

> [!NOTE]
> **Soma is the first package published on Metafactory.**
> We are using its release as the reference for what every Metafactory package should look like — three-signature verification, declared capabilities, portable across AI tools.

---

## Why Soma exists

The valuable part of a personal AI assistant is not one model and not one CLI. The valuable part is the operating system around the model — who the assistant is, who *you* are, what you want, what good work looks like, what was learned last time, how work is verified.

Most AI tools today couple all of that to themselves. Change tools and you lose the assistant.

Soma decouples the durable parts from the tool that happens to run them. The tool becomes replaceable. The assistant keeps going.

---

## Architecture

> [!NOTE]
> **FIG. 0.1 — Soma in the nervous-system family** *(plate in production)*
>
> A cream-paper blueprint showing Soma at the centre, with adapters fanning out to the AI tools that can run it — Claude Code, Codex, Pi.dev, Cortex — over the Myelin spine that carries messages between them. Drawn in the Metafactory house style.

<!-- asset-slot: docs/diagrams/2026-05-16-soma-nervous-system.png -->
<!-- replace with: ![Soma in the nervous-system family](docs/diagrams/2026-05-16-soma-nervous-system.png) -->

Soma owns the durable parts of your assistant.

| Layer | What lives there |
| --- | --- |
| **Identity** | Principal profile, assistant profile, voice and personality |
| **Telos** | Goals, principles, active commitments, desired state |
| **ISA** | Ideal-state artefacts for the projects and tasks you are running |
| **Skills** | Portable capability folders with instructions, workflows, and tools |
| **Memory** | Work, knowledge, learning, relationship, and state stores |
| **Policy** | Privacy, permission, and verification rules |
| **Adapters** | Thin bridges into Claude Code, Codex, Pi.dev, and Cortex |

Soma deliberately does not own model selection, chat UI, tool runtimes, agent routing, or marketplace distribution. Those belong to the AI tool you happen to be using or to other Metafactory components (Cortex, Myelin, Arc, Signal, Spawn, Compass).

See [docs/boundaries.md](docs/boundaries.md) for the exact split.

---

## Your first session

Once installed, point Soma at the AI tool you want it to run in. Each adapter writes a small set of hooks and memory files into that tool's home so Soma activates on startup.

```bash
soma install codex --apply
soma install pi-dev --apply
soma install claude-code --apply
```

Then start a session and watch Soma surface its context.

> [!NOTE]
> **Demo — first session in 30 seconds** *(recording in production)*
>
> An asciicast of `soma lifecycle session-start` producing the startup context block, followed by `soma memory search` returning real hits across your work, knowledge, and learning stores.

<!-- asset-slot: docs/demos/2026-05-16-soma-first-session.cast -->
<!-- replace with the asciinema embed: [![asciicast](https://asciinema.org/a/XXXXXX.svg)](https://asciinema.org/a/XXXXXX) -->

> [!NOTE]
> **What you see when a session starts** *(screenshot in production)*
>
> The assistant identity card produced by `soma lifecycle session-start`: principal, telos, active commitments, recent learning. Concrete, scannable, the same in every AI tool.

<!-- asset-slot: docs/screenshots/2026-05-16-session-start.png -->
<!-- replace with: ![Session-start output](docs/screenshots/2026-05-16-session-start.png) -->

---

## Bringing in your existing assistant

If you already run an assistant inside Claude PAI, Soma can import the durable parts so you do not start from scratch.

```bash
soma import pai --dry-run
soma import pai --apply
```

This pulls your principal profile, assistant identity, and Telos summary into `~/.soma/profile/`. Source snapshots are kept under `~/.soma/profile/imports/claude/` so you can always trace what came from where.

To port over the Algorithm (a small decision and verification harness that wraps AI work in a one-way phase machine):

```bash
soma import algorithm --apply
```

And to bring across a PAI skill pack — Soma converts portable workflows and tools, marks the rest as references, and refuses to copy anything that looks like a secret.

```bash
soma import pai-pack --pai-pack-dir <path-to-pack>
soma import pai-pack --apply --pai-pack-dir <path-to-pack>
```

See [docs/pai-pack-importer.md](docs/pai-pack-importer.md) for the rules.

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

The guard blocks obvious movement of private Soma or projection source material into public destinations and records every check as an event. See [docs/private-source-guard-v0.md](docs/private-source-guard-v0.md) for the matcher rules.

---

## Trust and signing

Every Soma version published to Metafactory is verified three independent ways before `arc install` lets a single file land on your disk.

| ID | Layer | What it proves |
| --- | --- | --- |
| **A-501 / A-502** | Tarball SHA-256 | The bytes you downloaded are the bytes that were published. |
| **A-504** | Registry Ed25519 over the manifest | The registry attests that this manifest is the one it recorded. Verified with the active registry key (e.g. `mf-reg-2026-04`). |
| **A-503** | Sigstore (cosign) bundle | The publisher attests, via OIDC identity, that they built and pushed these bits. Verified against the expected signer identity. |

`arc install` prints each verification line as it passes. If any of the three fail, the install aborts before extraction.

---

## What runs Soma today

Soma is built to be portable across AI tools. The current adapters target:

- **Claude Code** — Anthropic's terminal-and-IDE coding assistant
- **Codex** — OpenAI's command-line coding agent
- **Pi.dev** — the Pi developer harness
- **Cortex** — Metafactory's operator-facing application surface (daemon or bus mode)

If you want Soma in a tool that is not on this list, the adapter contract is small enough to write in an afternoon. See [docs/substrate-adapters.md](docs/substrate-adapters.md).

---

## Documentation

- [docs/boundaries.md](docs/boundaries.md) — exactly what Soma owns and does not own
- [docs/default-availability.md](docs/default-availability.md) — home install versus workspace overlay
- [docs/progressive-skill-loading.md](docs/progressive-skill-loading.md) — the skill registry and just-in-time loading
- [docs/writeback-and-policy.md](docs/writeback-and-policy.md) — projection, writeback, conflict, and policy semantics
- [docs/pai-pack-importer.md](docs/pai-pack-importer.md) — what a PAI pack import does and refuses
- [docs/private-source-guard-v0.md](docs/private-source-guard-v0.md) — the V0 privacy guard rules
- [docs/portability-proof.md](docs/portability-proof.md) — the first portability proof and what counts as evidence

---

## Status

Soma is a design-first project growing into a library and daemon. The first goal is a stable file format and an adapter contract that lets the same personal assistant context run inside several AI tools without rewriting the assistant each time. The first portability proof is intentionally narrow — produce equivalent context from the same profile, telos, memory, skills, and ISA for two different AI tools.

---

## License

MIT. See [LICENSE](LICENSE).

---

<p align="center">
  <sub>Soma is the first package published on <a href="https://meta-factory.ai">Metafactory</a>.</sub><br />
  <sub>Built by <a href="https://github.com/jcfischer">Jens-Christian Fischer</a> · Sponsored by <a href="https://github.com/mellanon">mellanon</a> · ★ STEWARD</sub>
</p>
