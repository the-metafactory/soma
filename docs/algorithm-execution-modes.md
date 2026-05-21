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
each iteration.

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

The built-in registry includes inline checks that are always available. When a
Soma home contains an imported Algorithm capability reference at
`skills/the-algorithm/references/capabilities.md`, the CLI registers matching
PAI-style capabilities onto each run before mutating it. `Skill("Name")`
entries are registered only when the corresponding Soma skill exists in the
same home; `Agent(...)`, inline, and command entries become agent, inline, or
command capability definitions. Missing skill targets remain unsupported so the
selection fails loudly instead of pretending a capability can be invoked.

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

PAI's FeatureRegistry is intentionally not migrated. Soma already has the same
work-tracking semantics in typed Algorithm structures:

- Features map to `planSteps[]`.
- Priority maps to criteria and plan-step order.
- Status maps to criterion and plan-step status enums.
- Blockers map to blocked plan steps with evidence.

Adding a second feature tracker would create two sources of truth. If future
work needs richer feature metadata, extend `planSteps[]` rather than adding a
parallel registry.
