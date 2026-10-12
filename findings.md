# Findings: node #782 — what every MetaFactory event producer emits, and what each needs for a run-ledger envelope

Map: the-metafactory/soma, "MetaFactory pursues, from prompted to continuous pursuit". Checkpoint: `cp-mfp-producers-inventoried`.

Researched 2026-10-12 against the local checkouts in `~/work/mf/<repo>`:

- reflex @ 576b62a
- pulse v0.30.0 @ bcfb4e3
- ranger @ 6004cb6
- signal @ ef89413
- soma @ origin/main 6a2cb8a
- cortex, myelin and meta-factory at their working-tree HEAD

Runtime state was only read. Every fact below cites a file. No design choice is made here; that belongs to the Vigil grilling. Paths below are relative to each repo.

"Run-ledger envelope" here means one Myelin envelope per run that carries what ran, the outcome, the duration, and the goal or node the run served.

## Summary table

| Producer | Format today | Where it writes | Outcome recorded? | Goal/node link? | On Myelin bus today? | Change needed | Rough size |
|---|---|---|---|---|---|---|---|
| **reflex** | SQLite: `decisions` (outcome = ignored/matched/blocked/fired/denied/expired) and `fired_events`. Myelin envelopes `reflex.activation.fired` and `reflex.activation.decision.*` (`src/bus/envelopes.ts:57-117`) | `~/.local/state/reflex/reflex.db` (`src/store/paths.ts:9-12`). NATS `local.{p}.{s}.reflex.>`, JetStream stream `REFLEX` (`src/bus/stream.ts:3,12`) | **No**: it records only the decision to fire. It subscribes to `pulse.run.*` terminal types (`src/sources/run-outcome.ts:10-25`), but `onRunCompleted(correlationId, _outcome)` discards the outcome; it only releases the run lock and replays a buffered impulse (`src/pipeline/evaluate.ts:229-258`) | No: the blueprint schema has no goal/node field (`src/activation/schema.ts:120-134`) | **Yes**, via `@the-metafactory/myelin/edge` (`src/bus/index.ts:1-6,87-92`) | At `onRunCompleted`, pass in the run envelope (timestamp, payload). Build a run-completed envelope from the `fired_events` row (start) and the decision row (blueprint, target), and publish it. Add an optional goal/node field to the blueprint schema | **S** inside reflex. **M** in practice, because no runner emits `pulse.run.*` today, so the hook never fires (see pulse) |
| **pulse** | In memory only. `PulseExecution {startedAt, completedAt, status}` (`src/types/pulse.ts:33-39`). `PipelineResult {success, durationMs}` (`src/lib/pipeline.ts:136-156`). `FlowResult {success, failedStage, durationMs, completedAt}`, with no start time (`src/types/flow.ts:72-89`) | Nothing persistent. The only file it ever writes is the optional research transcript JSONL (`src/lib/research.ts:138,153`). Neither `~/.pulse` nor `~/.config/pulse` exists | In memory per run, then lost | No: `FlowDef`, `PipelineDef` and `PulseTreeDef` carry no goal or node | Only to dispatch agent steps on `local.{p}.{s}.tasks.*` (`src/lib/agent-provider.ts:119-160,181-193`). No run or lifecycle events | Emit at the end of `runFlow` (`src/lib/flow.ts:108-225`, 5 return paths), `runPipeline` (`src/lib/pipeline.ts:183-197`) and `PulseRunner.run` (`src/lib/runner.ts:170-185`), reusing `NatsAgentTransport`. Add `startedAt` to `FlowResult`. Add goal/node to the defs or read them from env | **M** (**S** if limited to the flow CLI with goal/node from env) |
| **ranger** | SQLite journal. `workers`: one row per (repo, node), **updated in place** (status, started_at, finished_at, outcome text, lane, phase, generation, substrate) (`src/journal.ts:44-68`). `events`: append-only `{at,node_id,repo,kind,detail}`, 34 kinds (`src/journal.ts:154-188,441-455`). `substrate_sessions`: per session, started/ended, outcome ok\|failed, model (`src/journal.ts:109-120`). Per-worker logs | `~/.config/ranger/state.sqlite`. `~/.config/ranger/logs/walk.stdout.log` holds one JSON report per tick (`src/cli.ts:824-834`). `logs/workers/<repo>-<node>-g<gen>.log` (`src/worker-log.ts:7-38`) | **Partly**. `finish()` writes status (success/released/failed/parked) and finishedAt (`src/worker.ts:422-436`), but each new generation overwrites the row. The worker exit code exists only in memory (`RunNodeOutcome.workerExit`, `src/worker.ts:82-90`). The detached run-node is spawned with `stdio: "ignore"` (`src/spawn.ts:47-53`), so the outcome JSON it prints to stdout is lost. No duration column | Node and map root: yes. Destination/goal: no | **No**. The only NATS use is the `src/remote-test/` sidecar. Escalation goes to Discord only (`src/escalate.ts:41-51`, `src/discord.ts`), driven by frontier state on each tick | Hook into `runRunNode` (`src/cli.ts:238-247`) after `runNode` returns (`try/finally`). Every field except the goal is at hand there. Needs a bus client, and must fail open so a bus outage never blocks a run | **S** for the envelope. **M** with the NATS client, config, auth and fail-open handling |
| **soma event log** | JSONL `SomaMemoryEvent {id,timestamp,substrate,kind,summary,artifactPaths?,metadata?}` (`src/types.ts:2053-2061`), appended via `appendSomaMemoryEvent` (`src/memory.ts:74-95`). Segmented at 16 MiB (`src/event-log.ts:12-19`) | `$SOMA_HOME/memory/STATE/events.jsonl`, plus `events-archive/` and the `events-*-index.json` files. The live log holds 195,773 events in 2 segments (counts index) | See the kind list below. No kind records "run X served goal/node Y with outcome Z" | Algorithm `runId` only. No goal or graph node | **No**. There is no NATS/myelin client in `src/`; the only hits are a path-deny regex in `src/runtime-policy.ts:88-89` | Either a bus bridge that forwards selected kinds, or direct publishing from the emit sites listed below. Both need a myelin client dependency in soma | **M** |
| **cortex** | Myelin envelopes. `system.attention.{opened,resolved}` (`src/surface/mc/attention-notify.ts:4,98-114`), fired on a state delta (absent→open, open→resolved; `:32-46,80-84`). Dispatch lifecycle `dispatch.task.{started,completed,failed,aborted}` (`src/bus/dispatch-events.ts:325,368,511,547`). `completed` carries `started_at`, `completed_at` and `result_summary` (`:371-381`); `failed` carries `reason` (`:387-420`) | The bus, via `runtime.publish` (`src/cortex.ts:4941-4952`). Mission Control SQLite `~/.local/share/metafactory/cortex/mission-control.db` (`src/common/data-path.ts:144`), tables `tasks`, `sessions`, `events`, `observability_events` | **Yes, per dispatch** (completed/failed/aborted plus timestamps), but split across three types | No. Nothing on a dispatch carries a goal or node. The closest hook is slice/issue routing (`CONTEXT.md:156`) | **Yes** | Add one run-ledger builder fired on each terminal `dispatch.task.*`. Those are emitted at `brain-consumer.ts:711`, `dev-consumer.ts:837`, `review-consumer.ts:1182,1213` and `release-consumer.ts:739`; a single subscriber funnel would also work. Thread a goal/node ID through the inbound envelope | **M** (builder S; threading the ID through 4+ consumers M) |
| **signal** | OTel spans from Claude Code hooks (tool, skill, subagent, session). OTLP protobuf on `local.{p}.{s}.trace\|metric\|log.*` (`src/lib/transport/nats-publisher.ts:4-13`). Canonical envelopes `system.signal.{mode}` (`src/lib/system-events/publisher.ts:483`). Layer-0 JSONL | `${PAI_DIR:-~/.claude}/MEMORY/Events/YYYY-MM-DD.jsonl` (`src/lib/events/log.ts:134-137`) and `~/.signal/CRITICAL.log`. **Neither path exists on this machine** | Per tool: success and Bash exit code (`hooks/ToolResultInstrumentation.hook.ts:203-212`). Session end: duration_ms and tool_calls, but **no success/failure**, and tokens are hardcoded to 0 (`hooks/handlers/session-end.ts:85-96`) | No | Designed to publish, but **not installed**: none of the 5 manifest hooks (`arc-manifest.yaml:112-125`) is registered in `~/.claude/settings.json`. No `signal-*` hooks, no launchd agent (the install is a held step: `docs/deploy-launchd.md:7-18`, signal#178), no running process | Install it first. A run envelope built from session-end would cover Claude sessions only, never pulse or reflex runs | **M**, plus the install |

## Per-producer detail

### reflex

- Records:
  - One `decisions` row per impulse (`src/store/schema.ts:8-31`).
  - On fire, also a `fired_events` row (`src/store/schema.ts:74-87`). In that row `envelope_id` is always null and `subject` is the literal `"derived-by-bus"` (`src/pipeline/evaluate.ts:140`).
  - `src/bus/queue.ts` is only an in-memory outage buffer for failed publishes. It persists nothing.
- Live DB: 366 fired and 4 blocked decisions. The reflex error log shows repeated `publish failed, queued: timeout`.
- Activations in `~/.config/reflex/activations/`:
  - 3 files: 2 meeting-sync blueprints with cron triggers, and 1 manual test blueprint.
  - Every scheduled activation is a meeting job, and none uses `run_lock`.
- The activation YAMLs note that their runner (cortex bridge / process runner) emits no `pulse.run.*` outcome. Reflex's outcome path is wired but never fed.

### pulse

- `pulse status` is a stub that always prints "No execution history available." (`src/commands/status.ts:7-8`).
- Why there is no history:
  - `PulseRunner` keeps only `private lastExecution` in memory (`src/lib/runner.ts:24,90,184`).
  - `pulse run` executes nothing: it prints a note and exits 1 (`src/commands/run.ts:28-33`).
  - `RunState` lives one run, in memory (`src/lib/step-options.ts:64-81`).
- Per-step events exist, but only as in-process callbacks, not as a log or a bus emission:
  - `ActionStepEvent` = `step.started {action, started_at}` | `step.completed {action, durationMs, output_fields}` | `step.failed {action, durationMs, error}` (`src/types/pipeline.ts:157-160`), fired via the optional `StepRunnerOptions.onActionStepEvent` (`src/lib/step-runner.ts:98,117`).
  - Primitives have parallel hooks: `onGateEvent`, `onAgentEvent`, `onTribunalEvent`, `onGovernedEvent` (`src/lib/primitive-runner.ts:548-1256`).
  - Only `examples/*/run-*.ts` and tests pass these hooks; no `src/commands/*` CLI does, and no sibling repo under `~/work/mf` does.
  - All are step-level. There is no run-level `run.started`/`run.completed` event type in pulse.
- Side fact: for a failed node, `startedAt` is set after the retries finish (`src/lib/executor.ts:72`), so the real start time is lost.

### ranger

- Neither a "tick" record nor a "run-node" record exists as such:
  - **A tick** leaves a `sweep`-kind row in `events` and one pretty-printed JSON report in `walk.stdout.log` (115 MB).
  - **A run-node** leaves:
    - a `worker-start` event,
    - an in-place update of its `workers` row,
    - `substrate_sessions` rows for each worker, review and fix session.
- Live event counts: reviewed 802, worker-start 666, pushed 356, sweep 257, parked 131, …
- Duration is not stored. It can be derived as `finished_at − started_at`.

### soma event log

Run- and verification-relevant kinds emitted from `src/`:

- `lifecycle.session_start` and `lifecycle.session_end` (`src/lifecycle.ts:992`). Metadata is sessionId and substrate only, with no outcome or duration.
- Algorithm run state, not run outcome:
  - `lifecycle.algorithm_updated` and `lifecycle.algorithm_observed`
  - `algorithm.phase.entered`
  - `algorithm.loop.state_changed` (`src/algorithm-execution-modes.ts:241`: runId, from, to, iterationCount)
  - `algorithm.loop.blocked`
- `verification.gate_violation` (`src/cli/algorithm.ts:890-915`: runId, criterionId, reason, evidenceKind). Only refusals are logged. A passed verify writes no event.
- `feedback.candidate` (`src/feedback.ts:90`). Nothing downstream reads it.
- `result.captured` and `learning.signal|pattern|failure` (`src/types.ts:2160-2164`, `src/result-capture.ts`).
- `execution.{started,progress,completed,failed,cancelled,artifact,policy}` (`src/execution/types.ts:81-86`, `src/execution/claude-code-executor.ts:49,72-73`).
  - This is the closest thing to a run outcome.
  - It is only returned in memory as `SubstrateExecutionRun.events` (`src/execution/kernel.ts:21-24`). Nothing in `src/execution/` calls `appendSomaMemoryEvent`, so these events never reach the log.

Work-graph closes are bound by a receipt comment on the tracker (`src/work-graph.ts:89-94,237`), not by a log entry. No work-graph module appends to the event log.

Live mix, from the most recent ~200 KB of the log:

| Kind | Count |
|---|---|
| writeback.claude_code.subagent_stop | 130 |
| lifecycle.algorithm_updated | 94 |
| lifecycle.session_end | 64 |
| runtime_policy.inspect | 43 |
| memory.projection | 28 |
| lifecycle.session_start | 28 |
| … | |

### cortex

- Other envelope types it publishes:
  - `system.*` (`src/bus/system-events.ts`): adapter, access, admission, gateway.routing-decision, plugin, and `system.dispatch.stage`. The last one is off unless `CORTEX_TRACE_DISPATCH` is set (`:1607-1630`).
  - `review.verdict.<kind>` (`src/bus/review-events.ts:429`)
  - `tasks.*`
  - `agent.presence`
  - `iteration.*`
  - `task.updated`
  - `state.transition`
  - `mc.projection`
- There is no `run.completed` or ledger type.
- No Discord adapter subscribes to `system.attention.*` yet (`src/surface/mc/attention-notify.ts:17-23`). Ranger's Discord cards and cortex's attention envelopes are separate channels.

## Envelope gap (myelin)

What the schema has today:

- `schemas/envelope.schema.json` requires `id, source, type, timestamp, sovereignty, payload` (`:7`).
- `type` is a **pattern, not an enum**: `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,4}$`, i.e. 2-5 segments (`:20-25`).
- `payload` is an unconstrained object.
- `economics.actual` already carries `duration_ms`, tokens, model and `cost_usd` (`:96-110`).

Registered types (`src/subject-vocabulary.ts`):

- `dispatch.task.{received,assigned,started,progress,completed,failed,aborted,rejected}` (`:11-22`)
- bid events (`:24-29`)
- `workflow.{started,…,completed,failed}` (`:31-40`). These have no payload contract.

The nearest fit is `CompletedPayload` (`src/lifecycle/types.ts:21-26,81-88`): task_id, correlation_id, result?, tokens, duration_ms?.

What is missing for a run-ledger envelope:

1. **A single run-level type with one outcome enum.** Today the outcome is split across three types (completed/failed/aborted). Nothing covers succeeded/failed/cancelled/blocked for a run that is not a dispatch.
2. **A goal/node-served field.** None exists.
3. **A "what ran" descriptor** (blueprint, flow or capability). Only `task_id`/`agent_id` exist.
4. **A payload contract for run events.**

Glossaries:

- Myelin's glossary (`CONTEXT.md:11-73`) has no Run, Ledger or Trace term.
- Cortex's glossary defines **Session** as "One run of a substrate" and lists "run" under _Avoid_ (`cortex/CONTEXT.md:75`). Envelope naming has to reckon with that.

## Run Trace (meta-factory `CONTEXT.md`)

- **Definition**, `meta-factory/CONTEXT.md:315-317`: "**Run Trace**: The observed execution record of an **Execution Run**. _Avoid_: Run Output, Run Outcome."
- **Related lines:**
  - "An Execution Run produces a Run Trace" (`:904`)
  - "A Run Trace is the primary input for Miner process knowledge" (`:905`)
  - Execution Run (`:275`)
  - Run Outcome (`:295`), with Succeeded/Failed/Cancelled/Blocked Run (`:299-313`)
- **Not implemented anywhere.**
  - No `RunTrace` type exists in any `~/work/mf/*/src` (excluding `-codex` copies).
  - The only textual hits are miner function names (`miner/src/trace/pipeline.ts:24` `runTracePipeline`, `miner/src/commands/trace.ts`).
  - Miner's `TraceRecord` (`miner/src/trace/types.ts:60-73`: intent, outcome, duration_ms, steps) is the closest shape. It is built from Claude Code capture JSONL, not from Execution Runs, and nothing puts it on the bus.
- **The outcome vocabulary is already shared:** the four Run Outcome values match the terminal types reflex already listens for on `pulse.run.*` (`reflex/src/sources/run-outcome.ts:10-25`). No producer emits them.

## Cross-cutting facts

- **Bus presence:**
  - On the bus today: reflex and cortex.
  - Designed for the bus but not installed: signal.
  - Not on the bus at all: pulse (no run events), ranger, and the soma event log.
- **Goal/node link:** no producer records a goal ID. Only ranger records a graph node and its map root.
- **Outcome plus duration per run is persisted only by:**
  - cortex, per dispatch
  - ranger, overwritten per generation and with no stored duration
- **The outcome path is designed but unfed:** pulse → reflex `pulse.run.*` → reflex run lock.
