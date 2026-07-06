# Claude Cowork Adapter Spec

Status: proposed
Target substrate id: `anthropic-cowork` (vendor-prefixed — "Cowork" alone is
ambiguous now that Microsoft ships a similarly named agent product)
Primary mode: home (host-side surfaces) with a workspace-style working-folder bundle
Secondary modes: export
Last reviewed against public Cowork sources: 2026-07-07
Surface verification status: UNVERIFIED — every path marked `[S1]` below must be
confirmed by the live-install probe before implementation begins.

## Purpose

The Cowork adapter projects the Soma assistant core into Claude Cowork,
Anthropic's desktop agent for general knowledge work. Cowork reuses Claude
Code's engine (skills, plugins, MCP) but runs the agent inside an isolated
virtual machine with only explicitly granted folders mounted. The adapter's job
is to make the same Soma identity, purpose, skills, VSA, Algorithm method,
memory routing, and runtime policy available in Cowork sessions — within the
constraints of that sandbox.

Cowork is a consumer/enterprise desktop app, not a CLI. Two consequences drive
this whole spec:

1. **No hook surface.** Cowork exposes no documented lifecycle or pre-tool-use
   hook points. Everything Soma's Claude Code adapter does with hooks (mode
   classification, deterministic policy enforcement, session lifecycle refresh)
   must degrade to prompt-level guidance, skill instructions, or host-side
   commands run outside Cowork. This is a recorded adapter limitation, per the
   enforceable/advisory split in [memory-policy-v0.md](./memory-policy-v0.md).
2. **The session cannot reach `~/.soma`.** Cowork mounts granted folders into a
   VM (`/sessions/<id>/mnt/<folder>`). The private Soma home is not mounted and
   must never be. Memory readback therefore works by projecting curated
   snapshots *into* the working folder, and memory writes work through a
   capture inbox that a host-side governed command ingests *after* the session.

## Native Surfaces

All rows marked `[S1]` are candidate paths from public sources and must be
verified by the probe issue before code is written.

| Cowork surface | Candidate location | Soma projection | Verified |
| --- | --- | --- | --- |
| Skills | shared Claude skills dir (`~/.claude/skills/` or app-support dir) | Portable Soma skills: `soma`, `the-algorithm`, `VSA` | `[S1]` |
| Global instructions | UI setting; on-disk persistence unknown | Short Soma operating pointer (only if file-backed) | `[S1]` |
| Working folder | user-chosen folder mounted into the session | `soma/` context bundle + `soma/capture/` inbox | `[S1]` auto-read behavior |
| MCP servers | `claude_desktop_config.json` (Claude Desktop config dir) | Optional Soma MCP server entry — deferred, blocked by soma#153 | `[S1]` reachability from Cowork |
| Plugins | Cowork plugin bundles (skills + MCP + commands) | Optional distribution vehicle for the whole projection | `[S1]` format |
| Hooks | none documented | none — recorded limitation | `[S1]` confirm absence |

The adapter must not edit Cowork-managed state: session databases, VM images,
auth state, or app preferences beyond marker-guarded config blocks.

## Projection Shape

The projection has two halves.

**Host half** (real substrate home, exact dir pending `[S1]`):

```text
<cowork-skills-home>/
  soma/SKILL.md
  the-algorithm/SKILL.md
  VSA/SKILL.md
```

**Working-folder half** (inside the folder the principal grants to Cowork):

```text
<working-folder>/
  SOMA.md                    # short instruction contract (entrypoint)
  soma/
    context.md               # assistant identity + operating rules
    profile.md               # assistant + principal profile (public-safe subset)
    purpose.md               # telos snapshot
    skills.md                # projected skill registry
    policy.md                # advisory policy projection
    startup-context.md       # active work / Algorithm run snapshot
    active-vsa.md            # active VSA summary (when set)
    memory-snapshot.md       # curated memory readback (see Memory section)
    capture/                 # session-output inbox (Cowork writes here)
      README.md              # what belongs here and how it gets ingested
```

`~/.soma` remains the source of truth. Every generated file states in its
header that it is a projection and that edits will be overwritten. Re-running
`soma install anthropic-cowork --apply` is idempotent.

Unlike other adapters there is **no** `memory-layout.md` of host paths: host
paths are unreachable from the VM and would only mislead the agent. The bundle
carries content snapshots, not pointers.

## Instruction Contract

`SOMA.md` in the working folder stays short. It should:

- identify Soma as the portable personal assistant core and name the assistant
- point the session at `soma/context.md` and `soma/startup-context.md`
- require reading `soma/memory-snapshot.md` before making durable memory claims
- require using the `the-algorithm` skill when Algorithm-mode work is selected
- instruct the session to write durable observations, decisions, and session
  digests into `soma/capture/` using the capture format — never to claim it has
  "saved to memory" (it cannot; ingestion happens host-side)
- state that `~/.soma` is authoritative, unreachable from this session, and
  that everything under `soma/` is a generated snapshot

## Skill Projection

The adapter projects portable Soma skills into Cowork's skill layout using the
existing skill projection primitives (`skillsLoaderDir`, `vsaSkillProjection`
from the install spec). Cowork consumes the same `SKILL.md` + YAML frontmatter
format as Claude Code, so the claude-code skill rendering is the starting
point. The adapter may rewrite only substrate references and local paths
(`--substrate anthropic-cowork` in harness commands); it must not change skill
semantics.

The `the-algorithm` skill needs one Cowork-specific rendering note: harness CLI
commands (`soma algorithm …`) are not runnable inside the VM. The projected
skill must carry the rendering contract (phases, gates, ISC discipline) as
prompt doctrine, and record run state into `soma/capture/` for host-side
`soma algorithm` reconciliation, rather than instructing the agent to call an
unavailable CLI.

## Memory

This is the section that differs most from every existing adapter, and the one
an enterprise trial depends on.

### Readback: projected snapshots

`memory-snapshot.md` is a curated, bounded projection generated at install /
reproject time. Compartment rules:

| Compartment | Projected? | Rationale |
| --- | --- | --- |
| KNOWLEDGE (curated) | yes, summarized | primary value for knowledge work |
| WORK / STATE (active runs) | yes, via `startup-context.md` | continuity |
| LEARNING | selective — applicable lessons only | quality |
| RELATIONSHIP | no | private compartment, never leaves home |
| Identity/Purpose | persona + telos summary only | operating context |
| SECURITY, raw transcripts | never | private by design |
| memory notes (`semantic/`, `procedural/`) | INDEX-admitted notes only | earned-inclusion index is exactly the "safe to always load" set |

The INDEX-admitted rule reuses the memory-note subsystem's own admission
discipline: if a note has not earned INDEX inclusion, it does not ship into a
substrate the principal shares with an employer-managed app.

### Writeback: capture inbox, quarantined trust

Cowork sessions write candidate memory as markdown files into
`soma/capture/`. A host-side ingestion command (reusing the `soma memory
backfill` machinery: deterministic, idempotent via SHA manifest, bodies
verbatim) imports captures as **`quarantined`-trust notes**. This is exactly
the existing contract for content that did not arrive through the governed
write path: recall-discoverable with an untrusted banner, excluded from INDEX
until the principal re-authors at higher trust. No new trust semantics are
invented for Cowork; the sandbox boundary maps onto the quarantine boundary.

The ingestion command is part of the adapter slice:
`soma anthropic-cowork ingest [--working-folder <dir>]` (final name at
implementation time), emitting standard `memory/STATE/events.jsonl` events.

### Inbound content security

Files inside the working folder that the *principal's organization* put there
(mounted enterprise documents) are inbound content. The
[inbound-content-security](./inbound-content-security.md) posture applies at
ingestion time: captures derived from untrusted enterprise content stay
quarantined and carry provenance.

## Enterprise Trial Posture

The adapter must be usable in an organization-managed Cowork deployment
(enterprise plan, admin-managed settings, possibly a private plugin
marketplace) without leaking the principal's private Soma home. This section
is generic by design; organization-specific governance mappings belong in the
principal's own compliance notes, not this repo.

### Separate Soma home per trust domain

For an enterprise trial, run the projection from a **dedicated Soma home**
(e.g. `SOMA_HOME=~/.soma-work` / `--soma-home`), seeded with work-appropriate
identity, purpose, knowledge, and skills only. Personal `~/.soma` (private
relationships, personal telos, personal memory) never projects into an
employer-visible surface. The adapter must support `--soma-home` the same way
existing adapters do, and doctor should report which home a projection came
from.

This gives a clean data-boundary story:

- **What the org's Cowork sees:** the working-folder bundle + skills, all
  generated from the work home — reviewable as plain files before any session.
- **What flows back:** only capture files, ingested as quarantined notes into
  the work home.
- **What never crosses:** the personal home, RELATIONSHIP compartment,
  security traces, raw transcripts, credentials, machine-local private paths.

### Data flow disclosure

Anything projected into the working folder is processed by the Cowork session
and therefore by the vendor's cloud service under the organization's Claude
enterprise agreement. The projection content must be written assuming it is
org-visible. `soma install anthropic-cowork` (dry-run default) doubles as the review
surface: the exact bytes that will be exposed are listable before apply.

### Team sharing

Multi-user trials should use [team overlays](./team-overlays.md) (read-only
team KNOWLEDGE/WORK/skills, namespaced provenance) rather than sharing a Soma
home, and a private plugin marketplace as the distribution channel once the
plugin packaging slice exists. Both are follow-up slices, not v1.

### Policy

Deterministic policy enforcement is **not available** in Cowork (no hooks).
The projection carries advisory policy in `soma/policy.md`, and the org's own
Cowork admin controls remain the enforcement layer. The adapter must record
this in `policy.md` itself so the model does not claim enforcement it lacks.
Runtime policy inspection (`soma policy inspect`) still applies host-side at
ingestion time.

## MCP Configuration (deferred)

Blocked by soma#153 (MCP server not yet implemented). When it lands:

- marker-guarded `soma` server entry in `claude_desktop_config.json`,
  preserving foreign servers; invalid JSON fails install with repair guidance
- read-oriented default toolset only (`soma_identity_context`,
  `soma_skill_registry`, `soma_skill_route`, `soma_skill_load`,
  `soma_isa_active`, `soma_memory_search`, `soma_memory_read`)
- mutating tools stay disabled until the confirmation-token model exists
- `[S1]` must first confirm Cowork sessions can reach Desktop-configured local
  MCP servers at all (the VM boundary may proxy or block them)

MCP would eventually replace much of the snapshot projection with on-demand
context, which is why the snapshot format should stay boring and regenerable.

## Install Spec

Implementation adds `anthropic-cowork` to:

- `SubstrateId` (`src/types.ts`)
- `InstallSubstrate` (`src/install-spec.ts`)
- `installSpecFor` / `allInstallSpecs` (`src/install-spec-registry.ts`)
- `INSTALL_SUBSTRATES` + plan dispatch (`src/cli/substrate-lifecycle.ts`)
- CLI usage strings (`src/cli/onboarding.ts`, `src/cli/skill-projection-cli.ts`)
- install, reproject, export, doctor, and uninstall dispatch

The install spec owns:

- default home: pending `[S1]` (skills dir parent)
- a working-folder target option (`--working-folder <dir>`), since the bundle
  half does not live under the substrate home
- projected file list, `ownedSubtrees` for `soma/` bundle and skills
- lifecycle projection paths (startup context regenerated host-side)
- private projection roots
- doctor checks
- uninstall targets

`soma install anthropic-cowork` dry-runs by default. `--apply` bootstraps or loads the
(possibly dedicated) Soma home, refreshes startup context, and writes both
halves. It must not require Cowork to be running. The Cursor adapter
(`src/adapters/cursor/install.ts`) is the structural template: hook-less,
marker-guarded, `ownedSubtrees`, guarded uninstall.

## Uninstall

`soma uninstall anthropic-cowork` removes only marker-owned files: the `soma/` bundle,
`SOMA.md` (only when marker-matched), projected skills, and any marker-owned
config blocks. It preserves user files in the working folder, non-Soma skills,
foreign MCP servers, and all Cowork app state. Capture files under
`soma/capture/` that have not been ingested are reported, not deleted.

## Doctor Checks

`soma doctor --substrate anthropic-cowork` reports:

- missing or stale `soma/context.md` / `memory-snapshot.md` in the configured
  working folder
- stale projection version marker
- missing projected skills
- un-ingested capture files older than a threshold
- which Soma home the projection was generated from (trust-domain check)
- invalid `claude_desktop_config.json` (once the MCP slice exists)

Static file inspection only; doctor never launches Cowork.

## Verification

First implementation PR includes:

- projection unit test from minimal `ProjectionInput`
- dry-run / apply file-list parity
- idempotent re-install test
- snapshot compartment-exclusion test (RELATIONSHIP and non-INDEX notes never
  appear in `memory-snapshot.md`)
- capture ingestion test: capture file → quarantined note + event, idempotent
- uninstall preserves user files and un-ingested captures
- doctor finding tests
- docs update in `substrate-adapters.md`

```bash
bun test
bun run typecheck
```

## First Implementation Slice

1. Live-install probe fills every `[S1]` in this doc (issue S1).
2. Add `anthropic-cowork` substrate id + install spec + CLI wiring,
   Cursor-shaped.
3. Pure `projectAnthropicCoworkHome(input, somaHome, options)`: working-folder
   bundle
   including `memory-snapshot.md` with compartment rules above.
4. Skill projection for `soma`, `the-algorithm`, `VSA`.
5. Capture inbox + host-side ingestion (quarantined trust, evented).
6. Uninstall + static doctor.
7. Defer: MCP (soma#153), plugin packaging, team overlays, global-instructions
   projection (pending `[S1]` file-backing).

## References

- Soma adapter contract: [substrate-adapters.md](./substrate-adapters.md)
- Sibling spec precedent: [copilot-cli-adapter.md](./copilot-cli-adapter.md)
- Memory policy: [memory-policy-v0.md](./memory-policy-v0.md)
- Team overlays: [team-overlays.md](./team-overlays.md)
- Inbound content security: [inbound-content-security.md](./inbound-content-security.md)
- Private source guard: [private-source-guard-v0.md](./private-source-guard-v0.md)
- MCP server (blocked dependency): soma#153, [mcp-server.md](./mcp-server.md)
- Public Cowork sources (paths unverified): Anthropic product page
  (anthropic.com/product/claude-cowork); S. Willison, "First impressions of
  Claude Cowork" (VM + mount architecture); community MCP/skills setup guides
