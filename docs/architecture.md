# Soma Architecture

Soma separates the portable assistant core from the substrate that executes it.

## Core

The core is filesystem-native and substrate-neutral.

```text
SomaCore
  Identity
  Purpose
  VSA
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

### Purpose

Purpose stores goals, principles, commitments, strategies, and desired state. It
is the steering source for assistant recommendations and prioritization.

### VSA

Verification State Artifacts define work. A VSA is both the articulation of done and
the verification contract. Project VSAs live with projects. Task VSAs live under
Soma memory.

### Algorithm Harness

The Algorithm harness is the deterministic execution layer around VSA. PAI used
TheAlgorithm mostly as doctrine projected into Claude; Soma keeps that doctrine
as a portable skill, but also exposes typed run state and phase gates that a
substrate or daemon can call directly.

An Algorithm run moves in one direction only:

```text
OBSERVE -> THINK -> PLAN -> BUILD -> EXECUTE -> VERIFY -> LEARN -> COMPLETE
```

Each transition has a gate. For example, THINK requires at least one recorded
current-state probe (an observation whose evidence kind is `probed` or `tested`,
not a `specified` spec-restatement), PLAN requires selected capabilities,
BUILD requires a criterion-mapped plan, VERIFY requires every plan step to be
done or blocked, LEARN requires every criterion to be passed, dropped, or
deferred-probe and refuses a `passed` criterion whose evidence kind is
explicitly `specified` (it must claim probed/tested, or be marked deferred-probe;
legacy criteria with no recorded evidence kind are grandfathered), and COMPLETE
rejects structured capability selections that were not invoked or removed. This is the part that adds determinism: the LLM can propose content,
but Soma decides whether the process is allowed to advance.

The harness is driven through explicit mutations rather than substrate-specific
conversation tricks. The portable command surface covers `new`, `list`, `show`,
`classify`, `capabilities`, `invoke`, `remove-capability`, `plan`, `observe`,
`decision`, `change`, `step`, `verify`, `learn`, `reflect`, `reflections`,
`advance`, and `resume`. `reflect` records a per-run meta-reflection (deterministic
gate-flags + the model's "a smarter run would have…" signals); `reflections --digest`
ranks the cross-run improvement backlog. `resume` accepts
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
memory, VSA, Algorithm, and identity context. The server remains a core/library
access surface; adapters only configure substrate-native MCP clients.

Team-shared skills use **team overlays** rather than multi-principal Soma
homes. A team overlay can supplement skill routing with team-provenanced skill
registries, while the personal Soma home remains owned by one principal. See
[docs/team-overlays.md](./team-overlays.md).

### Memory

Memory is structured as files first, under a single lowercase `memory/` root
(one canonical root — the layout never relies on distinguishing `memory` from
`MEMORY`, which case-insensitive filesystems collapse):

```text
memory/
  WORK/            # legacy free-form stores (searched by `soma memory search`)
  KNOWLEDGE/
  LEARNING/
  RELATIONSHIP/
  STATE/           # events.jsonl lives here
  semantic/<id>.md   # memory-note subsystem (M0–M7): durable facts   (dedup-gated)
  procedural/<id>.md #   playbooks / how-to                            (dedup-gated)
  episodic/…         #   session digests + action log (M5)
  INDEX.md           #   earned-inclusion index (M3)
```

The initial version should avoid requiring a vector database. Search can start
with filenames, frontmatter, ripgrep, and small deterministic indexes.

The uppercase-named legacy stores (`WORK`, `KNOWLEDGE`, …) hold free-form
markdown; the **memory-note subsystem** (plan v2, milestones M0–M8) is a
*separate*, schema-governed durable store whose lowercase-named directories
(`semantic`, `procedural`, `episodic`) sit as siblings under the same `memory/`
root. Both are sub-stores within the single Memory compartment, not peer Soma
compartments. `soma memory backfill` (M8) bridges the two for a migrating
principal: it walks the legacy category dirs and writes each markdown file
(READMEs excluded) as a `quarantined` note — as a **batch caller of the governed
`write` path** (below), not a distinct governed path of its own — mapping the
category to a note type (`LEARNING`→procedural, `KNOWLEDGE`→semantic). It is
deterministic (bodies verbatim, `created` from the source mtime, no LLM) and
idempotent via a SHA manifest at `memory/STATE/imports/backfill/.manifest.json`,
and rebuilds the INDEX after writing so the store stays audit-clean. Imports stay
recall-discoverable (with a ⚠ untrusted banner) but out of the always-loaded
INDEX until the principal re-authors them at higher trust (the admission filter
excludes quarantined unconditionally, so `verify` alone — which only bumps
freshness — cannot promote them; `principal-correction`/`supersede` can).

Each note is one file: strict frontmatter (id, type, trust, provenance,
bi-temporal `valid_until`, `last_verified`, `resurface_count`, links) plus a
markdown body. `soma memory write|verify` (M1) is the primary *governed* write path
(a convention, not a filesystem-enforced guarantee — nothing stops out-of-band
edits to the markdown, which is why every recalled note carries a verification
banner). Through it, trust is derived from the write trigger, writes are
dedup-gated (recall-first refusal),
and each mutation appends one event to the **existing** `memory/STATE/events.jsonl`
stream (the same journal the Observability section reads — note mutations do not
fork a second event stream). The write/event rollback coupling above is specific to the single-note
`write|verify` path. One other governed path exists: `soma memory consolidate`
(M6), the deterministic maintenance pass — it archives aged episodic notes (moved
out of the active tree, under `memory/archive/`; relocated, never deleted — the
move itself is the invalidation, no `valid_until` field is stamped), marks
aged-unverified semantic
notes `review: stale`, and (only under an explicit `--gc-state`) GCs old
`current-work-*` state. It is governed (deterministic, event-emitting, no LLM) but
does NOT re-derive trust — it never mints or elevates a note, only ages/relocates
existing ones. A mutating pass appends one `memory.consolidate` event as its FINAL
step — a post-hoc RECORD, NOT rollback-coupled. The **#428 auto-merge sub-op** is the
one exception to that post-hoc shape: because collapsing two near-duplicate
`assistant`-trust notes is a CONTENT-level mutation (not an age/relocate), each
merged pair goes through the same governed atomic write primitive as `write`
(`resolveMutationGovernance` + `writeNotesAtomically`) and appends its OWN
rollback-coupled `memory.consolidate.merge` event per pair (the M1
one-mutation-one-event discipline), emitted as the pass runs rather than as a
post-hoc aggregate; principal-trust pairs are never auto-merged (report-only). The
aging/relocating ops otherwise still record via the single final event. The pass is idempotent and safe to
repeat, so the guarantee is repeatability, not atomicity: if the pass throws
part-way, OR the event append itself fails, mutations may already be applied WITHOUT
the event — so an absent event does NOT prove no mutation happened. A re-run
reconciles the STATE (it re-does nothing already done — idempotent), but it does NOT
back-fill the missing journal record: a subsequent no-op run writes no event, so the
gap persists. A third governed path — and the second that MINTS trust — is
`soma memory promote`: it takes a verified Algorithm run and writes a
`principal`-trust durable note (the `PROMOTED/` verbatim record plus a
`principal-correction`-trigger note pointing back at it as its `source_of_truth`).
Promotion is the deliberate-escalation surface for durable memory, NOT a path that
proves the principal initiated it: soma has no cryptographic principal
authentication (the same recorded limitation the `principalAuthority` JSDoc calls
out for `soma memory write --principal-authority`). `hasPromotionVerification`
(≥1 verification entry or a passed criterion) is a PRECONDITION that refuses to
promote unverified work — it is NOT the source of principal authority; the
authority is the deliberate `principalAuthority: true` opt-in the caller passes at
every in-repo surface (CLI `--principal-authority`, the SDK option, and algorithm
`sync-from-isa --principal-authority`, forwarded to promote-on-complete). What IS
fail-closed is the promote-API layer itself: an omitted `--principal-authority`
refuses the promotion outright — never a silent downgrade to a lower-trust write.
The `syncAlgorithmRunFromVsa` promote-on-complete hook is a narrower, best-effort
CALLER of that API, not an equally fail-closed surface: a `--promote-on-complete`
without `--principal-authority` is refused up front (a caller-configuration
error), but once past that gate the hook wraps promotion in failure isolation so a
bad VSA never breaks it — and that isolation SWALLOWS any PRE-durable promotion
error (unverified run, EEXIST, run-not-found) as a no-op. Only a POST-durable
failure — the PROMOTED file and note already landed, but a later bookkeeping step
(the `memory.promotion` event append or the run-provenance write) then threw — is
re-thrown, because by then the caller must know the promotion is durable but
unrecorded. So the fail-closed refusal itself is guaranteed by the promote API and
the CLI; the sync hook's own contract stays narrower and deliberately best-effort
for everything short of that authority precondition. A fourth governed path —
the second that does NOT mint or elevate trust — is `soma memory used <id>`
(`resurfaceMemoryNote`, #427): a low-friction "this recalled note helped" signal
that bumps an already-existing `assistant`-trust note's `resurface_count += 1` /
`last_verified` through the same governance + atomicity path, so recalled-and-useful
notes cross the INDEX admission threshold (`resurface_count ≥ 2`). It is
trust-scoped — `assistant` bumped freely (the `used` act self-authorizes this one
decay-signal field, reachable from the public CLI unlike `verify`'s SDK-only
`consolidationAuthority`), `principal` a no-op (already admitted), `quarantined`
refused — moves no body content or trust tier, and appends one `memory.resurface`
event that #425's `verify-follows-recall` metric counts. `soma memory backfill`'s
source walk skips `PROMOTED/` subtrees owned by a promotion store dir (its
`include` hook, `isPromotionOwnedPromotedSubtree`), so backfill's forward source
walk no longer creates a `quarantined` clone that would shadow the lesson's own
principal-trust note in recall. This closes the forward import path only — it does
not detect or remove a clone already imported (e.g. before promotion, or by an
earlier backfill); surfacing such a pre-existing shadow is `soma memory audit`'s job,
not backfill's. `soma memory audit` (M7) — a deterministic, read-only health check
that reads the FILES directly for its three GATING probes (the event stream feeds
only informational probes) — is the ground-truth check: it has three
health-gating probes — root-integrity (every note root is a real directory),
schema validity, and INDEX freshness — plus four informational drift signals —
episodic note/digest COUNTS (a coverage indicator, not a verified note↔digest
mapping), archived notes missing from their created-month digest, the event/note
ratio, and (#425) retrieval quality (recall volume, empty-recall rate, and
verify-follows-recall rate, computed purely from the `memory.recall`/
`memory.verify` journal entries — measure only, gates nothing) — and EXITS
NON-ZERO on any gating failure (so it can gate CI). A no-op pass writes no event.
The write/event coupling is best-effort, not crash-atomic: an event-append
*failure* rolls the file mutation back, but a hard process crash in the window
between the two can still orphan a file from its event (soma has no WAL/2PC). The
M7 audit does NOT reconcile note↔event linkage — its event-ratio probe is a
COARSE count (event lines over notes), not per-note orphan detection; a missing
event can be masked by unrelated lines. Recall itself now appends exactly one
`memory.recall` event per call (#425) — query terms, returned note ids, result
count, unresolved-link count — without touching any note's frontmatter; recall's
non-mutating contract (bumping `last_verified`/`resurface_count` remains the
separate, authority-gated `verify` act) is unchanged. This
taxonomy is intentionally distinct from the `MEMORY/*` stores: those stores hold
curated free-form material; the note store holds single-fact, governed,
decay-tracked notes.

Cross-machine Soma state uses **Home replication**, not projection refresh or
substrate writeback. The design is Git-backed first, policy-gated per scope,
and only auto-merges stores with deterministic merge semantics. See
[docs/home-replication.md](./home-replication.md).

Team `KNOWLEDGE`, `WORK`, and VSA material can be read through a team overlay,
but it stays namespaced and cited separately from personal memory. Team
overlays are read-only in the first slice and must not expose personal Identity,
Purpose, Relationship, raw transcript, or security-trace compartments.

### Policy

Policy covers security, privacy, permission, and verification. Policies should
be executable where possible. Prompt-only policy is acceptable as a fallback,
but deterministic enforcement is the target.

## Adapters

Adapters project Soma into substrate-native primitives. One adapter per
substrate. See [CONTEXT.md](../CONTEXT.md) for glossary.

Issue- or PR-scoped experimental scaffolds may reserve a vendor-prefixed
substrate id only when the PR artifact documents the exception and its limits.
They must stay below the normal adapter bar, avoid editing unverified app state,
and keep policy advisory until the native surface is proven. They are
scaffolds, not evidence that the substrate can load the projection.

```ts
interface SomaAdapter {
  name: string;
  detect(): Promise<boolean>;
  project(input: ProjectionInput): Promise<Projection>;
}

interface SubstrateExecutor {
  substrate: ProjectionSubstrate;
  probe(options?: ExecutionProbeOptions): Promise<ExecutionCapabilities>;
  prepare(request: SomaExecutionRequest): Promise<PreparedExecution>;
  execute(prepared: PreparedExecution, options?: ExecuteOptions): AsyncIterable<SomaExecutionEvent>;
  cancel(executionId: string): Promise<void>;
}
```

Projection and execution are separate contracts. A substrate can be fully
supported for projection without having an executor. Executors own optional
host invocation and normalized evidence; core owns orchestration and canonical
state transitions; Spawn owns isolation; Cortex/Myelin own distributed routing
and transport.

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
