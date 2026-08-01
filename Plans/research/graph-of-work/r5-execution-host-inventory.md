# R5 — Execution-host inventory: graph-execution machinery already in the MetaFactory stack

## TLDR

The stack already contains **five distinct execution substrates plus the harness itself**, and none of them needs inventing — the #486 decision is genuinely a pick. **Soma core** owns typed graph *state* (plan steps, criteria, loop state, capability commitments, provenance) but deliberately executes nothing — its `AlgorithmLoopExecutor` is an interface a host must implement. **Cortex** is the heavyweight distributed option: signed envelopes, capability-routed dispatch with claim/exactly-once semantics, dead-letter escalation, lifecycle receipts, and a principal-facing Mission Control — but no dependency edges between dispatches. **Pilot** is the only component with a working *human-on-the-autonomy-line* story end-to-end (60s Discord veto window, two-of-two merge gate, audit-log-as-truth replay). **Blackboard** is the only component with **native `--depends-on` DAG edges plus claims plus an append-only event log** in one local SQLite tool — the closest existing shape to an AFK task graph, but single-machine and PAI-legacy. **Claude Code's harness** provides orchestration primitives (subagents, Task tools, workflow scripts with structured outputs, cron, monitors, worktrees) that already run wayfinder research tickets today — this very ticket is proof. **Wayfinder itself** stores its graph in the issue tracker: tickets as nodes, native blocking as edges, assignee as claim, resolution comment as receipt, HITL/AFK as a per-ticket type. The gaps: no single host today has *all four* of (dependency edges, claim semantics, tamper-resistant receipts, a HITL gate the agent can't forge). Cortex+pilot have receipts and gates but no edges; blackboard has edges and claims but weak gates; the tracker (wayfinder) has edges and human-legible state but no executor. Soma's own `autonomy-hitl-design.md` supplies the gate criteria any pick must satisfy.

---

## 1. Soma core — typed graph state, deliberately no runner

Soma's Algorithm subsystem is the portable *data contract* layer. Key primitives:

**Nodes.** `AlgorithmPlanStep` (`src/types.ts:223-229`) is `{ id, text, criteriaIds[], status: "open" | "done" | "blocked", evidence? }`. Per `docs/algorithm-execution-modes.md:149-168`, plan steps are the sanctioned work-tracking primitive (PAI's FeatureRegistry was explicitly *not* migrated), and the doc pre-authorizes the extension path relevant to #486: *"If future work needs richer feature metadata such as explicit dependency edges or owner fields, extend `AlgorithmPlanStep` and the Algorithm CLI surface rather than adding a parallel registry"* (`docs/algorithm-execution-modes.md:165-168`). **Today plan steps have no edges** — only a `blocked` status and criterion links. Mutation surface: `setAlgorithmPlan` (`src/algorithm.ts:206`), `updateAlgorithmPlanStep` (`src/algorithm.ts:605`), `verifyAlgorithmCriterion` (`src/algorithm.ts:404`).

**Parallel partitioning.** `partitionCriteriaByDomain` (`src/algorithm-execution-modes.ts:187-224`) groups criteria by the domain segment of IDs like `ISC-UI-1`, with greedy load-balancing when `maxPartitions` is smaller than the domain count. Explicit division of labor: *"Soma core only provides the partitioning algorithm. Worker spawning, process isolation, and result consolidation remain substrate or orchestration concerns"* (`docs/algorithm-execution-modes.md:30-31`).

**Loop execution contract.** `AlgorithmLoopExecutor` (`src/types.ts:168-170`) is a one-method interface — `executeIteration(context) → AlgorithmLoopIterationResult` — with `AlgorithmLoopExecutionContext` carrying `{ run, iteration, partition? }` (`src/types.ts:155-159`). `AlgorithmRun.loop` (`AlgorithmLoopState`, `src/types.ts:91-96`) tracks `status/iterationCount/plateauCounter/iterations`; `detectPlateau` (`src/algorithm-execution-modes.ts:145`, default threshold 3) and `recordAlgorithmLoopIterationResult` (`src/algorithm-execution-modes.ts:152`) are the state-advancing helpers. *"Soma does not spawn agents from this interface. A substrate adapter provides the executor"* (`docs/algorithm-execution-modes.md:74-76`).

**A real executor bridge already exists.** `SubstrateExecutionAlgorithmLoopExecutor` (`src/execution/algorithm-loop-executor.ts:22-59`) connects a validated substrate execution to the loop: it builds a `SomaExecutionRequest`, runs it through the execution kernel, records a change on the run, and writes back typed `execution.{status}` memory events. Its doc comment is the safety contract: *"It records only normalized, bounded result facts; it never verifies criteria or advances phases"* (`src/execution/algorithm-loop-executor.ts:17-20`). The kernel (`src/execution/kernel.ts:12-19`) enforces an `authorizedWorkspaceRoot` (a request cannot broaden its own filesystem scope) and normalizes failures into a closed code set including `policy-denied`, `approval-required`, `timeout` (`src/execution/kernel.ts:32-40`) — i.e. **HITL refusal is already a first-class failure code**. Concrete executors exist for `claude-code` and `codex` (`src/execution/claude-code-executor.ts`, `src/execution/codex-executor.ts`), plus a mock and a conformance suite (`src/execution/conformance.ts`). `SomaExecutionRequest` (`src/execution/types.ts:4-15`) carries `taskId`, `substrate`, `prompt`, `cwd`, `algorithmRunId?`, `projectionFingerprint`, `requiredCapabilities[]`, `expectedArtifacts?`, `timeoutMs?` — a per-node execution envelope in all but name.

**Capability registry.** `AlgorithmRun.capabilitySelections[]` records selection→invocation as a *commitment*: `registerAlgorithmCapabilityDefinition(s)` (`src/algorithm-capabilities.ts:510,518`), `selectAlgorithmCapability` (`:554`), `recordAlgorithmCapabilityInvocation` (`:636`), `removeAlgorithmCapabilitySelection` (`:684`). Unknown names are rejected; before COMPLETE every selection must be invoked-with-evidence or removed-with-reason (`docs/algorithm-execution-modes.md:129-133`).

**Receipts/audit.** Run-level: append-only `AlgorithmLogEntry` log, per-hop substrate provenance surfaced as `touched by:` in `soma algorithm show` (`docs/algorithm-execution-modes.md:41-46`), typed notification events `algorithm.phase.entered` / `algorithm.loop.state_changed` / `algorithm.loop.blocked` (`src/types.ts:128-148`) with delivery explicitly host-owned. Evidence is **caller-asserted** — the OBSERVE gate forces a probed/tested claim and makes hollow observations auditable, "it does not verify the probe actually happened" (`src/types.ts:237-245`).

**HITL doctrine.** `docs/autonomy-hitl-design.md` is the criteria sheet for #486: autonomy is a *line* (reversibility × blast radius → auto/propose/approve, `:11-15`); a real gate reads what happened not what the agent says, runs where the agent has no hands, and its setting sits outside agent reach (`:19-23`); "Don't make an LLM the gate" (`:25-29`); the build list names a machine-checkable receipt per gated action and an append-only audit log (`:33-37`).

**Gap to (a) HITL decision graph:** no edges, no claim semantics (runs are single-agent-at-a-time with provenance, not competing consumers), no gate enforcement point (evidence is caller-asserted). **Gap to (b) AFK task graph:** no scheduler/daemon; `resume --until-phase` is a relay convention, not a dispatcher. What it *does* give any host: the node schema, per-node execution request/result contract, plateau detection, and the audit vocabulary.

## 2. Cortex — bus-native dispatch with claims, receipts, and a cockpit

Cortex (`/Users/fischer/work/mf/cortex`, v6.12.0-beta per `README.md`) is the M7 collaboration surface: "consumes the bus, runs agents, dispatches work, and presents activity to the principal through Mission Control and chat adapters" (`CONTEXT.md:3`).

**Node semantics.** The unit is a **dispatch** — one envelope routed to an assistant. Three modes (`CONTEXT.md`, §Dispatch): **Offer** (published to a capability subject, "any capable assistant *claims* it (competing consumers, exactly-one delivery)"), **Direct** (named assistant), **Delegate** (named assistant orchestrates via the `agent-team` substrate harness). Unclaimed work escalates to **dead-letter**. Above dispatches sits the **slice** — the issue-scoped sequence implement→review→merge, grouped by issue, projected as one Discord thread / one Mission Control card (`CONTEXT.md`, §Slice). The **orchestrator** role (instance-named, e.g. `vega`) mints every dispatch in a slice; capability-workers are mutually anonymous (§Orchestrator).

**Claim semantics.** JetStream consumer groups give exactly-once claim on Offer subjects `local.{principal}.{stack}.tasks.{capability}.{subcapability}` (`myelin/specs/namespace.md:178-196`); an agent's consumer filters by capability. Capability *offering* is default-deny with per-scope accept policies, and public accept-predicates are "evaluated deterministically, in code, at the tap … never via an LLM" (`CONTEXT.md`, §Capability offering, ADR-0010).

**Receipts.** Every message is a **signed envelope** (stack NKey, M4) with three provenance fields (`source`/`originator`/`signed_by[]`). Lifecycle receipts flow on `dispatch.task.{started|completed|failed|aborted}` joined by `correlation_id`; dispatch-scoped liveness is `system.agent.heartbeat` (distinct from agent presence, `CONTEXT.md`, §Domains). The **`request_id`** pattern (signed verdict→request binding inside the payload, defeating replay-rebind; compass#95/cortex#1366) is exactly the "machine-checkable receipt per gated action" the HITL doc asks for.

**HITL affordances.** **Mission Control** — "one pane over plans, work items, sessions, and the attention queue" (`CONTEXT.md:167`) — is the principal cockpit and dispatch sink; session *interiors* stay local-scope by wire grammar. There is no generic approve/deny gate primitive in cortex itself; the human sits at surfaces (Discord, MC) and at pilot's veto window (below).

**Gap to (a):** no decision-node type, no dependency edges between dispatches (a slice's ordering lives in the orchestrator's head/loop, not on the wire); the attention queue is a notification surface, not a blocking gate contract. **Gap to (b):** the pieces exist (claims, receipts, dead-letter, harness enum including `claude-code`/`agent-team`, `CONTEXT.md` §Substrate harness) but graph topology — "run node C when A and B complete" — would live entirely in whatever orchestrator drives it; cortex ships routing, not a DAG scheduler.

## 3. Pilot — the working autonomy-line story

Pilot (`/Users/fischer/work/mf/pilot`) is the reviewee-side PR-cycle agent, "Rung 0.5 … scripts-with-state. Errand DB + deterministic parsing" (`README.md:5`). State: `~/.metafactory/agents/pilot/` (errands.sqlite) and `~/.config/grove/agents/pilot/{state.sqlite, events.log}` (`README.md:18,152`).

**Node semantics.** An **errand** per PR; a **work item** per claimed feature; a state machine per finding (fix/defer/pushback) driven by `pilot fetch/triage/auto-triage/apply/dispatch` (`README.md:20-58`).

**Claim + HITL.** `pilot tick` scans repos for ready features, posts a claim announcement to Discord, and holds a **60-second operator veto window** resolved via 👎 reactions before flipping the blueprint to in-progress (`README.md:148-166`); a UNIQUE-active-claim index makes concurrent ticks safe (`README.md:243`). The **two-of-two merge gate** requires reviewer identity ≠ merge-approver bot identity, validated at install *and* every tick (`README.md:251`). Terminal states (`vetoed/blocked/blocked-no-approver`) never auto-resume — operator verbs `pilot release`/`replay` only (`README.md:268-281`). Verdict waiting is `pilot request-review --wait` asserting the signed `payload.request_id` (`README.md:24-27`; cortex `CONTEXT.md` §request_id).

**Receipts.** Append-only audit events (`claim.announced`, `claim.approved`, `vetoed`, `defensively_vetoed`, … `README.md:301`), and — notably — `replay` **reconciles state from the audit log when the row is stale** ("surfaces the audit-log state instead of trusting the stale row", `README.md:264`). Audit-log-as-truth is the pattern the HITL design note demands.

**Gap:** pilot is single-purpose (PR review loop), linear (no graph), and its human gate is time-boxed veto rather than affirmative approval. But it's the only component where claim→gate→execute→receipt→human-override exists end-to-end in production, so it's the reference *story* even if not the host.

## 4. Blackboard — local DAG + claims + event log in one SQLite

`~/bin/blackboard` — "Local Agent Blackboard — SQLite-based multi-agent coordination" (CLI `--help`). Skill doc: `~/.claude/skills/Blackboard/SKILL.md` (DB `~/.pai/blackboard/local.db`, dashboard `blackboard serve` at :3141).

**Node/edge/claim semantics.** Work items with lifecycle `available → claimed → completed | blocked`, priorities, and — uniquely in the stack — **native dependency edges: `blackboard work create --depends-on <ids>` ("Comma-separated list of work item IDs this item depends on"**, from `work create --help`). Claims are explicit (`work claim --id --session`), with `release`, `reset` (labeled *operator action*), `block/unblock`, `update-metadata`, `append-event` (`blackboard work --help`). Agent sessions register, heartbeat, deregister; `sweep` reaps stale agents.

**Receipts.** "Immutable audit log entry for every state change" (SKILL.md §Core Concepts); `blackboard observe --since/--filter` queries it; `export` snapshots state.

**HITL.** Thin: the `serve` dashboard and operator-only `reset`. The SpecFlow integration (via `ivy-heartbeat specflow-queue` + `dispatch`) already does phase-chained autonomous execution — worktree isolation, quality gates at 80%, chain-to-next-phase, PR creation (SKILL.md §SpecFlow Integration) — i.e. **an AFK pipeline over blackboard items already ran in the PAI era**.

**Gap to (a):** no decision-node semantics, no approval gate, no signing — the agent can write anywhere in the DB, failing all three gate-reality properties of `autonomy-hitl-design.md:19-23`. **Gap to (b):** closest existing shape (edges + claims + events + a dispatcher precedent), but single-machine, PAI-legacy (`~/.pai/` path, `~/work/ivy-blackboard` project), and outside soma's typed-contract governance.

## 5. Myelin — the wire grammar a distributed host would ride

Myelin (`/Users/fischer/work/mf/myelin`) is M2–M6: "transport, envelope, identity, discovery, composition. One schema for all signals; sovereignty travels with the message" (`CONTEXT.md:3`). It contributes no execution, but fixes the vocabulary any bus-hosted graph inherits: the **Tasks Domain** subject grammar (`specs/namespace.md:178-263`) — Offer subjects, Direct `tasks.@{assistant}.{capability}`, dead-letter `tasks.dead-letter.{capability}` (`:248-255`), federated variants (`:262-263`) — plus Ed25519 identities and the `signed_by` **stamp** chain ("a stamp is a signature *plus* attester + method + role", `CONTEXT.md` §Stamp). If the host decision lands on cortex, node claims and receipts come for free in this grammar; if it lands local-first, myelin is the later federation path, not a day-one dependency.

## 6. Claude Code harness — orchestration surfaces already in hand

From harness knowledge (no file anchors — these are runtime surfaces):

- **Agent/subagent dispatch**: skills and tasks can run in subagents; this very R5 ticket is a subagent "spawned by a workflow orchestration script" whose contract is a typed `StructuredOutput` call — i.e. **node-as-subagent with a machine-readable result envelope already works today** (wayfinder's research tickets use exactly this).
- **Task tools** (`TaskCreate/TaskGet/TaskList/TaskUpdate/TaskStop`): harness-level task records with status transitions — a lightweight claim/board inside one session context.
- **Background execution + Monitor**: `run_in_background` Bash that re-invokes the agent on exit; `Monitor` for until-loop waits — the AFK wait primitive.
- **Cron and scheduled routines** (`CronCreate`, the `schedule`/`loop` skills): recurring ticks without a bespoke daemon.
- **Worktrees** (`EnterWorktree/ExitWorktree`): per-node isolation, same pattern blackboard's dispatcher and pilot's apply step use.
- **Hooks + permission system**: the only *enforcement point outside the model* the harness offers locally — relevant because `autonomy-hitl-design.md:22` requires gates to "run where the agent has no hands," and Claude Code hooks partially qualify (with the known caveat from the trust-boundary audit that hook config writability is itself the top gate).

**Gap:** session-scoped and single-principal; no cross-session graph store (tasks don't persist as a shared claimable board), no signed receipts. The harness is a strong *executor* for nodes, a weak *owner* of the graph.

## 7. Wayfinder — the graph semantics that need a host

`~/.soma/skills/wayfinder/SKILL.md` (identical copy at `~/.claude/skills/wayfinder/`): the map is one tracker issue labelled `wayfinder:map`; **tickets are child issues** (nodes) sized to one 100K-token session (`SKILL.md:57`); **edges are the tracker's native blocking relationship**, chosen "because it renders the frontier *visually* in the tracker's own UI" (`SKILL.md:69`); a **claim is the assignee** ("that assignee _is_ the claim", `SKILL.md:67`); the **frontier** is open ∧ unblocked ∧ unclaimed (`SKILL.md:69`); **receipts are resolution comments** + close + a one-line index entry on the map (`SKILL.md:125`). The HITL/AFK split is a **per-ticket type attribute**: Research is AFK-by-subagent, Prototype/Grilling are HITL ("the agent never stands in for the human's side", `SKILL.md:75-80`), Task is either. Fog-of-war defers un-specifiable nodes (`SKILL.md:82-93`); "never resolve more than one ticket per session — with the exception of research tickets" (`SKILL.md:105`); concurrency is expected ("expect other sessions to be editing the tracker concurrently", `SKILL.md:128`). The `agents/openai.yaml` file shows per-substrate agent config already piggybacks on the skill dir.

## Comparison

| Host | Node | Edge | Claim | Receipt/audit | HITL gate |
|---|---|---|---|---|---|
| **Soma core** | `AlgorithmPlanStep`, `SomaExecutionRequest` | none (extension pre-authorized) | none (provenance only) | run log, typed events, capability commitments; caller-asserted evidence | `approval-required` failure code; doctrine only |
| **Cortex** | dispatch (envelope) / slice | none on wire | JetStream competing-consumer, exactly-once | signed envelopes, lifecycle subjects, `request_id` binding | Mission Control attention queue; surfaces, no gate primitive |
| **Pilot** | errand / work item | none (linear loop) | UNIQUE-active-claim + Discord announce | append-only events.log, replay-from-audit | **60s veto window, two-of-two merge gate, operator-only release** |
| **Blackboard** | work item | **`--depends-on` DAG** | `work claim --session` | immutable event log, `observe` | dashboard + operator `reset` only; agent-writable DB |
| **Claude Code** | subagent/Task | none persistent | n/a (single principal) | StructuredOutput, transcripts | permission prompts + hooks |
| **Wayfinder (tracker)** | child issue | **native blocking** | assignee | resolution comment + map index | ticket *type* (HITL vs AFK) — human-enforced by convention |

## What the #486 pick actually has to add

For **(a) a wayfinder-style HITL decision graph**: the tracker already *is* the graph (nodes, edges, claims, receipts, human-legible frontier). The missing machinery is an executor that walks the frontier, spawns AFK nodes (soma execution kernel or harness subagents both qualify), and **stops at HITL nodes with a gate that satisfies `autonomy-hitl-design.md`** — today the HITL/AFK distinction is a label the agent itself honors, which is exactly the forgeable-gate anti-pattern (`docs/autonomy-hitl-design.md:7`). Pilot's veto-window + audit-truth pattern is the proven template to port.

For **(b) an AFK task graph**: nothing needs inventing at the node level (`SomaExecutionRequest` + claude-code/codex executors + conformance suite exist in soma; worktrees + background tasks exist in the harness; blackboard demonstrated phase-chained dispatch). What no component provides is the **combination** of dependency-edge scheduling + multi-session claims + tamper-resistant receipts under soma's typed-contract governance. The shortest paths visible in the code: (i) extend `AlgorithmPlanStep` with edges per the doc's own invitation and drive it with a thin frontier-walker over the existing execution kernel; (ii) adopt the tracker as the graph store (wayfinder-style) and treat soma runs as per-node receipts; (iii) go cortex-native and put topology in an orchestrator. Blackboard argues by existence proof that (i)/(ii)-scale local hosting is enough to start.

## Sources

- `/Users/fischer/work/mf/soma/docs/algorithm-execution-modes.md:9-31,41-51,64-133,145-168` — loop state, partitioning, executor contract, capabilities, FeatureRegistry ruling
- `/Users/fischer/work/mf/soma/src/types.ts:91-96,128-170,223-245` — loop/plan/observation/notification types
- `/Users/fischer/work/mf/soma/src/algorithm.ts:206,404,605` — plan/criterion mutation surface
- `/Users/fischer/work/mf/soma/src/algorithm-execution-modes.ts:145,152,187-224` — detectPlateau, recordAlgorithmLoopIterationResult, partitionCriteriaByDomain
- `/Users/fischer/work/mf/soma/src/execution/algorithm-loop-executor.ts:16-59`; `src/execution/kernel.ts:12-40`; `src/execution/types.ts:4-15`; `src/execution/{claude-code,codex,mock}-executor.ts`, `conformance.ts`
- `/Users/fischer/work/mf/soma/src/algorithm-capabilities.ts:510,518,554,636,684`
- `/Users/fischer/work/mf/soma/docs/autonomy-hitl-design.md:7-46` — gate criteria
- `/Users/fischer/work/mf/cortex/CONTEXT.md:3,167` + §Dispatch, §Capability, §Capability offering, §Slice, §Orchestrator, §request_id, §Substrate harness, §Session interior
- `/Users/fischer/work/mf/pilot/README.md:5,18-58,148-166,243-301,352-380`
- `/Users/fischer/work/mf/myelin/CONTEXT.md:3` + §Stamp; `/Users/fischer/work/mf/myelin/specs/namespace.md:178-263`
- `~/bin/blackboard --help`, `blackboard work --help`, `blackboard work create --help` (`--depends-on`), `blackboard observe --help` (CLI output, 2026-08-01)
- `/Users/fischer/.claude/skills/Blackboard/SKILL.md` §Core Concepts, §Coordination Flow, §SpecFlow Integration
- `/Users/fischer/.soma/skills/wayfinder/SKILL.md:57,67-69,75-80,82-93,105,125,128`
- soma issue #486 (`gh issue view 486`) — the question this inventory feeds; blocked by #484, #482
- Claude Code harness surfaces (Agent/Task tools, background Bash, Monitor, Cron, worktrees, hooks): harness runtime knowledge, no file anchor
