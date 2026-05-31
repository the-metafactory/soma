# Progressive Skill Loading

Progressive skill loading keeps Soma's capability surface broad without putting
every capability into every model context. See [CONTEXT.md](../CONTEXT.md) for
glossary; this document uses the eager / indexed / on-demand loading tiers.

## Problem

PAI already selects skills and capabilities during work. The failure mode is not
missing selection. The failure mode is that selection can happen after a large
amount of routing doctrine, capability descriptions, and skill material has
already entered the LLM context.

That is especially costly in Claude Code, where global instructions, hooks,
skills, commands, agents, and project context all compete for the same context
window. A large always-loaded capability surface reduces task focus and makes
irrelevant material more likely to influence the answer.

Soma should preserve PAI's capability breadth while changing the loading model:

```text
small kernel -> skill registry -> route -> selected manifest -> selected body
```

## Goals

- Keep identity, telos, active work state, memory routing, and policy available
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

## Architecture

Progressive loading has four layers.

```text
Soma home
  skills/<skill>/...
      |
      v
Skill registry
  compact metadata for every skill
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
- telos summary
- active Algorithm run or active ISA summary
- memory search instructions
- policy and verification rules
- skill registry location and loading protocol

The kernel must not include full skill bodies unless the substrate has a native
on-demand skill mechanism that guarantees those bodies are not inserted into
the LLM context until invoked.

### Skill Registry

The registry is a deterministic index built from the Soma skill home and
optional workspace overlays. It is safe to project into substrate homes because
it is small and descriptive.

Each registry entry should contain:

```ts
interface SomaSkillManifest {
  name: string;
  path: string;
  description: string;
  triggers: string[];
  antiTriggers: string[];
  tags: string[];
  phases: string[];
  substrateSupport: string[];
  estimatedTokens: number;
  defaultLoad: "never" | "manifest" | "body";
  entrypoint: string;
  references: {
    path: string;
    description: string;
    triggers: string[];
    estimatedTokens: number;
  }[];
  tools: {
    name: string;
    description: string;
    substrateSupport: string[];
  }[];
  algorithmCapability?: {
    kind: "skill" | "inline" | "agent" | "command" | "adapter";
    phases: string[];
    triggerSignals: string[];
  };
}
```

`defaultLoad: "body"` is reserved for tiny kernel skills whose complete body is
part of startup behavior. Most skills should be `manifest`; high-volume or
narrow skills should be `never` until a router selects them.

### Skill Router

The router chooses candidate skills before their full bodies are loaded. Inputs:

- current user prompt
- active Algorithm run or active ISA
- current workspace overlay
- substrate id and known context budget
- available tool surface
- skill manifests

The router returns:

```ts
interface SkillRoute {
  selected: {
    name: string;
    reason: string;
    load: "manifest" | "body" | "references";
    referencePaths: string[];
  }[];
  rejected: {
    name: string;
    reason: string;
  }[];
  contextBudget: {
    maxTokens: number;
    estimatedKernelTokens: number;
    estimatedSkillTokens: number;
    remainingTokens: number;
  };
}
```

Selection is conservative. If the manifest is enough, the router should not load
the body. If the skill body is needed, the loader should include only the
entrypoint first. References and examples are loaded only when their triggers
match the task.

### Skill Loader

The loader materializes the selected context for the current substrate. It
should support three load levels:

| Level | Loaded content | Use when |
| --- | --- | --- |
| Registry | Names, descriptions, triggers, budgets | Startup and broad discovery |
| Entrypoint | `SKILL.md` or equivalent entry file | A skill is selected for the task |
| Reference | Specific workflow, example, or tool docs | The entrypoint routes to more detail |

The loader must keep provenance. Every loaded section should be traceable to a
source path under the Soma skill home or a workspace overlay.

## Routing Algorithm

The first implementation can be deterministic and file-backed:

1. Build or refresh the skill registry from frontmatter and optional
   `soma-skill.json` files.
2. Score manifests against the prompt using trigger matches, anti-trigger
   matches, tags, active phase, and substrate support.
3. Apply hard gates for substrate compatibility and policy.
4. Keep the top candidates that fit the context budget.
5. Load only selected entrypoints.
6. Re-score references from the selected entrypoints if more detail is needed.
7. Record the selected skills and loaded paths in the Algorithm run or substrate
   session state.

This is intentionally simpler than semantic search. A later implementation can
add embeddings or BM25-style indexing without changing the contract.

## Adapter Behavior

Adapters project the same route into substrate-native behavior.

### Codex

Codex should project:

- the Soma kernel skill
- the compact skill registry
- a command or hook path for route-time loading
- selected skill entrypoints only when a task requires them

Codex rules should remain a parse-safe marker. Natural-language routing belongs
in the projected Soma skill and memory files.

### Pi.dev

Pi.dev should expose progressive loading through the `soma_context` extension
tool. The tool should support actions such as:

- `skill_registry`
- `skill_route`
- `skill_entrypoint`
- `skill_reference`

The Pi system prompt should receive only identity/kernel context plus routing
instructions. Detailed PAI imports and skill bodies remain tool-readable.

### Claude Code

Claude Code may keep native skills installed globally, but Soma should treat the
installed skill directories as an availability mechanism, not permission to paste
all skill text into global prompt context.

The Claude projection should keep the global assistant file small: kernel,
registry pointer, and loading protocol. Hooks can refresh the registry or record
selected skills, but hooks must remain optional enhancements.

### Cortex / Myelin

In daemon mode, Cortex/Myelin should route before spawning or addressing a
substrate session. The daemon can send a Myelin envelope containing the selected
skill manifests and source paths, then let the substrate adapter materialize the
right context shape.

The ownership and safety contract for this runtime lives in
[daemon-mode.md](./daemon-mode.md). Soma owns route decisions and selected
context provenance; Myelin owns the wire protocol and envelope semantics.

## Context Budget Rules

- Every projection should report estimated token cost for kernel, registry, and
  selected skills.
- A selected skill should have a reason and a budget estimate.
- If selected skills exceed budget, the router should prefer entrypoints over
  references and references over examples.
- If a task needs more skill context than the budget allows, the adapter should
  ask the model to use a tool/read path instead of pasting the content.

## State And Learning

Each task should be able to record:

- skill manifests considered
- selected skills
- loaded paths
- rejected high-scoring skills and reasons
- whether the selected skills were sufficient
- lessons for trigger, anti-trigger, or budget tuning

For Algorithm work, this belongs in the run's decisions, verification, and
learning logs. Outside Algorithm work, it can be captured as append-only state
events.

## Decisions

### Skill-Owned Manifests

Each skill should own a `soma-skill.json` alongside `SKILL.md`. Soma should
generate a registry from those manifests. The skill-local manifest is the source
of truth for routing metadata; the registry is an index.

```text
skills/<skill>/
  SKILL.md
  soma-skill.json
  references/
  tools/
```

Importers should create `soma-skill.json` during import. For imported PAI packs,
the importer can derive the first version from pack metadata, `SKILL.md`
frontmatter, copied reference files, and safe defaults:

- `name`: normalized skill name
- `description`: pack or skill description
- `triggers`: imported frontmatter triggers or conservative keyword defaults
- `antiTriggers`: empty until curated
- `tags`: source and pack tags such as `pai-pack`
- `phases`: empty or inferred from known Algorithm capability metadata
- `substrateSupport`: `["codex", "pi-dev", "claude-code", "cortex"]` unless the
  import marks files as substrate-specific
- `estimatedTokens`: deterministic estimate from the entrypoint and selected
  references
- `defaultLoad`: `manifest`
- `entrypoint`: `SKILL.md`
- `references`: copied reference files with descriptions when available
- `tools`: copied portable tools when available
- `algorithmCapability`: optional run-scoped Algorithm capability metadata when
  the skill should be selectable inside Algorithm runs. It describes routing
  signals, not substrate execution bindings; adapters or the registry derive
  invocation contract and target.

This is distinct from `soma-pack.json`. `soma-pack.json` records import
provenance and file classification. `soma-skill.json` records runtime routing
metadata.

### Router Placement

Routing belongs in the core library. Lifecycle hooks may call the router at
session or prompt boundaries, but the routing contract must not be owned by any
one adapter.

Adapters materialize route results into substrate-specific context. They do not
own skill semantics.

### Substrates Without Native File Loading

If a substrate cannot read selected files on demand, the adapter should
materialize a route projection before the task starts. The projection contains
the kernel, registry entry subset, and selected entrypoints or references. This
preserves progressive loading even on static substrates.

```text
tool-capable substrate -> read selected skill files on demand
static substrate -> pre-materialize a selected route bundle
daemon substrate -> route centrally, then spawn with selected context
```

### V0 Token Estimation

V0 should use deterministic rough token estimates rather than provider-specific
tokenizers:

```ts
estimatedTokens = Math.ceil(characterCount / 4);
```

The estimate only needs to support budget pressure and relative comparisons.
Provider-specific tokenization can be added later without changing the manifest
or route contracts.

## Migration Plan

1. Add `SomaSkillManifest` and `SkillRoute` types.
2. Add a registry builder that reads the Soma skill home and workspace overlays.
3. Extend skill importers to emit `soma-skill.json` alongside imported
   `SKILL.md` files.
4. Add a deterministic router with lexical trigger scoring and budget gates.
5. Change home projections to project registry data instead of every portable
   skill body by default.
6. Add adapter-specific loading surfaces for Codex, Pi.dev, Claude Code, and
   Cortex/Myelin.
7. Record selected skills and loaded paths in Algorithm/session state.

## Verification Criteria

- A substrate startup projection can be generated without including full bodies
  for unrelated skills.
- A task that names or clearly triggers a skill loads that skill entrypoint.
- A task with no matching skill keeps only the kernel and registry context.
- Anti-triggers prevent irrelevant but lexically similar skills from loading.
- Loaded skill paths are recorded with provenance.
- Context budget estimates are visible in route output.
- Existing PAI-style capability selection still works after selected skills are
  loaded.
- The source of truth remains Soma home; substrate projections remain generated
  snapshots.

## Deferred Questions

- Which fields should be mandatory in hand-written `soma-skill.json` files
  versus backfilled by the registry builder?
- How aggressively should imported triggers be inferred from source text before
  a human curates them?
- Which route decisions should become durable learning automatically, and which
  should remain session-local telemetry?
