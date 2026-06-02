# Algorithm Execution Modes

Issue #133 is a gap-fill, not a full Algorithm port. Soma already owns the
core Algorithm run schema, phase gates, criteria state, audit logs, and ISA
bridge. The missing PAI capabilities are modeled here as substrate-neutral
contracts so Codex, Pi.dev, Claude Code, Cortex, or a daemon can execute them
without moving process spawning into Soma core.

## Loop State

`AlgorithmRun.loop` records the portable loop state:

- `status`: `running`, `paused`, `blocked`, or `completed`
- `iterationCount`: total completed loop iterations
- `plateauCounter`: consecutive iterations with no progress
- `iterations`: append-only iteration summaries with progress before/after

`detectPlateau(run, threshold)` returns `true` when either the stored
`plateauCounter` reaches the threshold or the last `threshold` iteration
records show no progress. The default threshold is `3`, matching the PAI loop
behavior.

## Parallel Criteria Partitioning

`partitionCriteriaByDomain()` extracts domains from criterion IDs such as
`ISC-UI-1` and `ISC-PERF-2`. Criteria without a domain land in `general`.
When the caller requests fewer partitions than discovered domains, Soma uses
greedy load balancing by criterion count.

Soma core only provides the partitioning algorithm. Worker spawning, process
isolation, and result consolidation remain substrate or orchestration concerns.

## Run Identity And Provenance

New Algorithm runs created without an explicit `--id` use date-prefixed ids.
This keeps repeated same-day tasks sortable and avoids collisions when several
substrates start similar work. Existing explicit run ids are preserved. ISA
files written back from substrate OBSERVE hooks are normalized through the
same date-prefixing helper so bare ISA slugs do not bypass run identity rules.

Algorithm mutations can also record per-hop substrate provenance. CLI paths
such as phase advance, criterion verification, capability invocation, and
learning promotion accept a substrate when the caller knows it. The run keeps
that provenance as structured metadata, and `soma algorithm show --id <run-id>`
surfaces a compact `touched by:` summary for handoff across Codex, Claude Code,
Pi.dev, Cursor, Cortex, or daemon-driven work.

Cross-substrate relays should use `soma algorithm resume --until-phase <phase>`
when a hop owns only part of the run. `resume` repeatedly applies the normal
phase gates, stops exactly at the requested phase, and leaves later phases for
the next substrate.

## Ideate And Optimize Parameters

Soma defines portable parameter schemas and presets:

- Ideate: `dream`, `explore`, `balanced`, `directed`, `surgical`
- Optimize: `cautious`, `standard-optimize`, `aggressive`

The schemas are plain TypeScript data contracts with validation helpers. They
can be stored in `isa.frontmatter.algorithm_config` or passed directly to a
substrate executor.

## Loop Executor Contract

`AlgorithmLoopExecutor` is an interface:

```ts
interface AlgorithmLoopExecutor {
  executeIteration(context: AlgorithmLoopExecutionContext): Promise<AlgorithmLoopIterationResult>;
}
```

Soma does not spawn agents from this interface. A substrate adapter provides
the executor and returns a new `AlgorithmRun` plus progress evidence after
each iteration. After the executor returns, `recordAlgorithmLoopIterationResult`
copies the progress summary into `AlgorithmRun.loop`, increments
`iterationCount`, and updates `plateauCounter` without knowing how the
substrate invoked the model or worker. Recorded iteration history is bounded
by `DEFAULT_ALGORITHM_LOOP_ITERATION_HISTORY_LIMIT` so long-running loops keep
recent progress evidence without unbounded array growth.

## Capability Invocation Semantics

Algorithm capabilities are a registry-backed binding, not freeform labels.
`AlgorithmRun.capabilities` remains the compatibility list of selected names,
while `AlgorithmRun.capabilitySelections[]` records the portable selection
contract:

- `name`: registered capability name, for example `ReReadCheck` or an
  adapter-provided skill such as `FirstPrinciples`
- `phase`: the phase where the capability was selected
- `reason`: why the capability is needed for this run
- `status`: `selected`, `invoked`, `removed`, or `failed`
- `invocation`: substrate, contract, target, timestamp, and evidence once used

The built-in registry includes inline checks that are always available. Before
the CLI writes a Soma-home backed run, it registers portable skills as
run-scoped capability definitions. The preferred source is
`skills/<skill>/soma-skill.json` with optional `algorithmCapability` metadata:

```json
{
  "algorithmCapability": {
    "kind": "skill",
    "phases": ["think", "plan"],
    "triggerSignals": ["assumption", "root cause"]
  }
}
```

When explicit manifest metadata is absent, Soma falls back to the imported
Algorithm capability reference at
`skills/the-algorithm/references/capabilities.md`. `Skill("Name")` entries are
registered only when the corresponding Soma skill exists in the same home;
`Agent(...)`, inline, and command entries become agent, inline, or command
capability definitions. Remaining loaded skills receive broad skill-backed
defaults. Manifest metadata describes when the skill-backed capability is
relevant; concrete invocation binding remains registry- or adapter-derived.
Manifest substrate support is honored when the run declares a substrate.
Missing skill targets remain unsupported so the selection fails loudly instead
of pretending a capability can be invoked.

Adapters can add startup capabilities to the run with
`registerAlgorithmCapabilityDefinition(run, definition)` or
`registerAlgorithmCapabilityDefinitions(run, definitions)`. Adapter
definitions are run-scoped so one substrate's startup contracts do not leak to
other hosts in the same process. Unknown names are rejected so substrates do not
silently invent capability contracts. Selecting a capability creates a
commitment: before COMPLETE, every structured selection must be invoked with
evidence or explicitly removed with a reason. Legacy schema-2 runs that only
contain the string list still load safely; the completion gate applies to
structured selections.

## Notification Events

Algorithm notifications are typed events:

- `algorithm.phase.entered`
- `algorithm.loop.state_changed`
- `algorithm.loop.blocked`

Soma emits data contracts only. Voice, UI, chat, or observability delivery is
owned by the host substrate.

## FeatureRegistry

PAI's FeatureRegistry is not migrated as a standalone Soma tool. No `soma feature-registry`
command or JSON registry should be added unless a future design decision
explicitly reverses this rule. Soma already has the same work-tracking
semantics in typed Algorithm structures:

- `init`: create an Algorithm run with criteria, then establish the first
  tracked work items through `setAlgorithmPlan`.
- `add`: add features as criterion-mapped `planSteps[]`; priority is expressed
  by criteria and plan-step order.
- `update`: change feature status through `updateAlgorithmPlanStep`, using
  `open`, `done`, or `blocked` plus evidence.
- `verify`: record acceptance through `verifyAlgorithmCriterion` and keep the
  linked plan step evidence in the same run.
- `next`: read the next open or blocked `planSteps[]` item from the Algorithm
  run state instead of maintaining a separate queue.

This preserves a single source of truth for plan state, criterion status,
verification evidence, blockers, and handoff context. If future work needs
richer feature metadata such as explicit dependency edges or owner fields,
extend `AlgorithmPlanStep` and the Algorithm CLI surface rather than adding a
parallel registry.
