# Progressive Skill Loading

**Status:** Revised spec. Registry tier shipped; router and manifest tiers unbuilt.
**Date:** 2026-08-06

Progressive skill loading keeps Soma's capability surface broad without putting
every capability into every model context. See [CONTEXT.md](../CONTEXT.md) for
glossary; this document uses the registry / entrypoint / reference loading tiers.

This revision supersedes a Pi-specific draft (`~/work/pi/subagents/context-aware-skill-loading.md`)
that proposed a parallel stub format. That draft is folded in here. Its core
insight was correct and its numbers were not; both are addressed below.

## Problem

Selection is not the failure mode. Soma already selects skills during work. The
failure mode is that selection happens *after* routing doctrine, capability
descriptions, and skill bodies have already entered the LLM context.

Measured on this machine, 2026-08-06, against `~/.soma/skills`:

| Quantity | Measured |
| --- | --- |
| Skills in the registry | 114 |
| Total `SKILL.md` lines | 18,644 |
| Total `SKILL.md` bytes | 799,571 |
| Estimated tokens (soma V0 estimator, `bytes / 4`) | **~200,000** |
| Mean skill size | 163 lines |
| Skills over 500 lines | 3 |
| Largest skill (`tana`) | 1,816 lines |
| Smallest cited skill (`the-algorithm`) | 32 lines |

A substrate that loads every body eagerly pays ~200K tokens before the first
user turn. A substrate that loads on demand pays the registry only. Same
registry, same files, different loader.

Two corrections to the Pi draft's arithmetic, because they change the size of
the prize by an order of magnitude:

- It assumed 2,000 lines per skill. The measured mean is **163**. The corpus is
  18,644 lines, not 234,000.
- It cited `calendar` at "2,500+ lines". It is **358**.

The problem is real. It is ~12x smaller than that draft claimed, and the fix is
correspondingly cheaper.

## Goals

- Keep identity, purpose, active work state, memory routing, and policy available
  by default.
- Keep all portable skills discoverable without loading every skill body.
- Select candidate skills from compact metadata before expanding full skill
  instructions.
- Load skill bodies and references only when selected for the current task.
- Make loading decisions explicit enough to verify and learn from.
- Keep the model provider and substrate replaceable.

## Non-Goals

- Removing or shrinking the skill ecosystem.
- Replacing the Algorithm capability-selection doctrine.
- Requiring a vector database in the first implementation.
- Making a substrate adapter own skill semantics.
- Treating generated substrate projections as the source of truth.
- Inventing a second stub format alongside the registry.

## Implementation Status

Grounding the spec in what is actually built, so the migration plan does not
re-specify shipped work:

| Layer | Status | Evidence |
| --- | --- | --- |
| Registry projection | **Shipped** | `renderSkills()`, `src/adapters/shared/index.ts:199` |
| Registry entry format | **Shipped** | `renderSkillRegistryEntry()`, `src/adapters/shared/skill-registry.ts:173` |
| Registry line budget | **Shipped** | `SKILL_REGISTRY_LINE_BUDGET = 300`, `skill-registry.ts:31` |
| Trigger / anti-trigger extraction | **Shipped** | `extractUseWhenTriggers()`, `extractAntiTriggers()`, `skill-registry.ts:85,110` |
| Catalog auto-refresh on projection | **Shipped** | `refreshSkillCatalogs()`, `src/skill-projection.ts:316` |
| Per-substrate loader root | **Shipped** | `skillsLoaderDir()`, `src/install-spec.ts:107`, 6 adapters |
| Body projection | **Shipped as symlink** | `ensureSymlink()`, `src/skill-projection.ts:163` |
| `SomaSkillManifest` | **Typed, not materialized** | `src/types.ts:958`; **0** `soma-skill.json` files on disk |
| `SkillRoute` | **Not built** | 0 occurrences in `src/` |
| `estimatedTokens` / budget reporting | **Not built** | 0 occurrences in `src/` |
| `defaultLoad` tiering | **Not built** | 0 occurrences in `src/` |

The registry tier is done. On this machine it renders 201 lines for 114 skills,
inside the 300-line budget, with name, short description, `triggers:`, `not:`,
and resolve path per entry.

**The stub tier the Pi draft proposed already exists.** It is the registry. Any
new stub format would be a second, competing source of the same data.

## Architecture

Four layers, unchanged from the original spec.

```text
Soma home
  skills/<skill>/...
      |
      v
Skill registry
  compact metadata for every skill        <- SHIPPED
      |
      v
Skill router
  task prompt + active work state + substrate limits
      |
      v
Skill loader
  selected manifests, selected bodies, selected references
```

### Always-On Kernel

The kernel is the maximum context that should be loaded by default:

- assistant and principal identity
- purpose summary
- active Algorithm run or active VSA summary
- memory search instructions
- policy and verification rules
- skill registry location and loading protocol

The kernel must not include full skill bodies unless the substrate has a native
on-demand skill mechanism that guarantees those bodies stay out of the LLM
context until invoked.

### Skill Registry

The registry is a deterministic index built from the Soma skill home and
optional workspace overlays. It is safe to project into substrate homes because
it is small and descriptive.

The registry is **the** stub contract. Substrates consume it; they do not define
their own. Its entry shape is owned by `renderSkillRegistryEntry()`.

`SKILL_REGISTRY_LINE_BUDGET` (300) is a **design target, not a runtime cap**.
`renderSkills()` emits every skill, so the real catalog can cross it as skills
accumulate; the constant is asserted in `test/skill-registry.test.ts` against
synthetic fixtures, not against the shipped catalog. It measured ~122 lines at
~104 skills and 201 lines at 114, so the budget needs watching rather than
assuming.

### Skill Loader

Three load levels:

| Level | Loaded content | Use when |
| --- | --- | --- |
| Registry | Names, short descriptions, triggers, anti-triggers, path | Startup and broad discovery |
| Entrypoint | `SKILL.md` | A skill is selected for the task |
| Reference | Specific workflow, example, or tool docs | The entrypoint routes to more detail |

The loader must keep provenance. Every loaded section should trace to a source
path under the Soma skill home or a workspace overlay.

## Decisions

### DD-A: Loading strategy is a substrate capability, not a skill property

*Tracked as soma#542 (with DD-B and DD-C).*

The Pi draft put a `scope:` field in skill frontmatter. That is the wrong home.
It would encode one substrate's loader limitation into 114 portable files.

Evidence that it is substrate-shaped, not skill-shaped: Claude Code already
loads bodies on demand — its session receives the registry plus a name and
description listing, not 18,644 lines. Pi does not. Same registry, same
symlinks, different loader. Nothing about any skill changed.

Add one field to `SubstrateInstallSpec` (`src/install-spec.ts:79`), beside the
loader root it already owns (`:107`, soma#356):

```ts
interface SubstrateInstallSpec<S extends InstallSubstrate = InstallSubstrate> {
  skillsLoaderDir(substrateHome: string): string;
  skillsLoading: "on-demand" | "eager";   // NEW
}
```

| Substrate | `skillsLoading` | Body projection |
| --- | --- | --- |
| claude-code | `on-demand` | symlink (today) |
| codex | `on-demand` | symlink (today) |
| cursor | `on-demand` | symlink (today) |
| grok | `on-demand` | symlink (today) |
| anthropic-cowork | `on-demand` | symlink (today) |
| pi-dev | `eager` | **generated stub**, body resolved on trigger |

One field fixes every eager substrate at once. No change to any skill file.

### DD-B: An eager substrate gets generated stubs, not symlinks

Bodies project as symlinks today (`ensureSymlink()`, `skill-projection.ts:163`):
one body in `~/.soma/skills/<name>`, N loader entries. A symlink cannot be a
partial view of its target.

So for `skillsLoading: "eager"`, projection must **generate** a stub into the
loader dir instead of linking.

A stub is a **directory**, not a catalog line. An eager substrate's loader scans
`skillsLoaderDir(home)/<name>/` and reads `SKILL.md` from inside it — pi-dev
resolves that to `~/.pi/agent/skills/<name>/` (`skillsLoaderUnder("agent")`,
`src/adapters/pi-dev/install.ts:44`). So the stub is:

```text
<skillsLoaderDir>/<name>/SKILL.md   frontmatter only + a pointer to the body
```

The pointer resolves to the registry path `~/.soma/skills/<name>/SKILL.md`, which
is what trigger-time promotion reads.

Stub and registry entry are two renderers over the same `SomaSkill` frontmatter,
so they cannot drift on content — but they are not the same artifact, and
`renderSkillRegistryEntry()` is not the stub renderer.

This is the concrete form of the original spec's "substrates without native file
loading" rule. It moves from prose to a typed adapter obligation.

### DD-C: Promotion must not invalidate the prompt cache

When an eager substrate promotes a stub to a full body mid-session, it must
deliver the body as a **tool result**, never as an edit to the system prompt.

Editing the system prompt changes the cached prefix and forces a full re-read of
every preceding token. For a session already carrying the kernel and registry,
that costs more than the body being loaded. This constraint is not optional and
is not visible from the skill side, which is a second reason DD-A belongs in the
install spec.

### DD-D: Derive routing metadata from frontmatter; defer `soma-skill.json`

The original spec made `soma-skill.json` the source of truth for routing
metadata. Measured today: **0 such files exist**. The shipped
`SomaSkillManifest` (`src/types.ts:958`) is also not that type — it carries
`source: { kind: "pai-pack" }` and is an import-provenance artifact. It has no
`antiTriggers`, `tags`, `phases`, `estimatedTokens`, or `defaultLoad`.

Meanwhile `extractUseWhenTriggers()` and `extractAntiTriggers()` already parse
triggers and anti-triggers out of the existing description text, and they work
across all 114 skills today with no per-skill authoring.

So: derive routing metadata from frontmatter. Introduce `soma-skill.json` only
when a concrete routing decision needs a field that frontmatter cannot express.
Until then it is 114 files of authoring debt for no measured gain.

### DD-E: Measure Soma-owned context before gating it per skill

The original spec's `scope`-style gating of kernel context (profile, memory,
startup) is genuinely portable, because Soma owns those projections. But size it
first. Measured at `~/.claude/rules/soma/`:

| File | Lines |
| --- | --- |
| SKILLS.md | 201 |
| CONTEXT.md | 62 |
| PROFILE.md | 51 |
| MEMORY.md | 39 |
| README.md | 26 |
| PURPOSE.md | 26 |
| POLICY.md | 13 |
| MEMORY_LAYOUT.md | 9 |
| **Total** | **427** |

The whole always-on Soma projection is 427 lines. Per-skill gating of that
cannot repay a new metadata format across 114 skills. Defer it.

Two cheaper wins are available in the same 427 lines, with no new metadata, no
new format, and no loader change:

1. **Deduplicate the identity projections.** `PROFILE.md` is 51 lines, and 41 of
   them are byte-identical to lines already in `CONTEXT.md`. `CONTEXT.md` also
   embeds the full Purpose block, making `PURPOSE.md` a third copy of mission,
   goals, principles, and commitments. Three files, one payload.
2. **Stop projecting `README.md` into loaded context.** All 26 lines describe how
   the projection directory is generated and warn against hand-editing. That is
   for a human reading the repo. The model reads it every session and can never
   act on it.

Together these cut roughly 90 of 427 lines — about 21% of the always-on Soma
projection — for the cost of a projection change.

### DD-F: Routing accuracy is measured, not asserted

The Pi draft set a success metric of "skill trigger accuracy: 100%". Selection
across 114 overlapping descriptions is a judgment call, and 100% is neither
reachable nor measurable as stated.

Any router lands with a labelled query set: queries that should select a skill,
and queries that should not. Targets are stated separately, because the two
failure modes cost differently — a miss loses a capability, a false positive
burns budget.

### Router Placement

Unchanged: routing belongs in the core library. Lifecycle hooks may call the
router at session or prompt boundaries, but the routing contract must not be
owned by any one adapter. Adapters materialize route results into
substrate-specific context. They do not own skill semantics.

## Adapter Behavior

| Substrate | Shape |
| --- | --- |
| **Claude Code** | Already on-demand. Keep the global assistant file small: kernel, registry, loading protocol. Installed skill directories are an availability mechanism, not permission to paste all skill text into global context. |
| **Codex** | Kernel skill, registry, and a command or hook path for route-time loading. Codex rules stay a parse-safe marker; natural-language routing lives in the projected Soma skill and memory files. |
| **Pi.dev** | The eager case, and the one this revision unblocks. Expose loading through the `soma_context` extension tool: `skill_registry`, `skill_route`, `skill_entrypoint`, `skill_reference`. System prompt receives kernel plus registry only. Bodies stay tool-readable. |
| **Cortex / Myelin** | In daemon mode, route before spawning or addressing a substrate session. The daemon sends an envelope with selected manifests and source paths; the adapter materializes the context shape. Ownership contract in [daemon-mode.md](./daemon-mode.md). |

## Context Budget Rules

- Every projection reports estimated token cost for kernel, registry, and
  selected skills.
- Every selected skill carries a reason and a budget estimate.
- Over budget, the router prefers entrypoints over references, and references
  over examples.
- If a task needs more skill context than budget allows, the adapter asks the
  model to use a tool or read path rather than pasting content.
- V0 token estimation stays deterministic: `Math.ceil(characterCount / 4)`.
  Provider-specific tokenizers can land later without changing the contract.

## Migration Plan

Ordered by cost against measured benefit. Steps 1 and 2 are independent of the
router and ship first.

1. **Deduplicate the kernel projection.** Collapse `PROFILE.md` / `PURPOSE.md`
   into `CONTEXT.md`, and move `README.md` out of the loaded `rules/` path.
   ~21% of always-on context. No new types. (DD-E)
2. **Add `skillsLoading` to `SubstrateInstallSpec`.** Set every current adapter to
   `on-demand` except `pi-dev`. (DD-A)
3. **Generate stubs for eager substrates** from the registry renderer instead of
   symlinking bodies. (DD-B)
4. **Instrument.** Report kernel, registry, and body tokens per substrate
   projection. This is the baseline every later claim is measured against, so it
   precedes the router rather than following it.
5. **Add the deterministic router** — lexical trigger scoring, anti-trigger
   gates, substrate gates, budget gates — with its labelled query set. (DD-F)
6. **Record** selected skills and loaded paths in Algorithm or session state.
7. **Revisit `soma-skill.json` and kernel `scope` gating** only if steps 4–6
   surface a routing decision that frontmatter cannot express. (DD-D, DD-E)

## Verification Criteria

- A substrate startup projection generates without including full bodies for
  unrelated skills.
- An eager substrate's loader dir contains generated stubs, and the registry
  entry resolves to the real body path.
- Promotion of a skill body on an eager substrate does not modify the system
  prompt.
- A task that names or clearly triggers a skill loads that skill entrypoint.
- A task with no matching skill keeps only kernel and registry context.
- Anti-triggers prevent lexically similar but irrelevant skills from loading.
- Loaded skill paths are recorded with provenance.
- Context budget estimates are visible in route output.
- The always-on Soma projection contains no line that appears in two projected
  files.
- Existing Algorithm capability selection still works after selected skills load.
- The source of truth remains Soma home; substrate projections remain generated
  snapshots.

## Deferred Questions

- Does any real routing decision need a field that `SKILL.md` frontmatter cannot
  carry? Until one appears, `soma-skill.json` stays deferred.
- How aggressively should triggers be inferred from source text before a human
  curates them?
- Which route decisions become durable learning automatically, and which stay
  session-local telemetry?
- Should eager substrates support demotion, or accept that a long session
  converges on loading everything?
