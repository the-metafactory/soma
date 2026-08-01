# R1 — Survey: Graph-Based Agent Orchestration Practice (2025–2026)

## TLDR

Across current practice, the graph is where determinism lives and the model is deliberately quarantined into node interiors. Five families dominate: (1) **compiled state-graph orchestrators** (LangGraph and kin) where the runtime owns a fixed topology and the model only picks among pre-declared edges; (2) **plan-and-execute / DAG-compiler patterns** (Plan-and-Execute, ReWOO, LLMCompiler, ATG) where the model *authors* a task DAG once and a deterministic scheduler executes it, with replanning as an explicit, gated event; (3) **orchestrator-worker swarms** (Anthropic's research system, OpenAI Agents SDK) where the graph is implicit and mostly model-driven, at a measured 3–15× token cost and with well-documented coordination failures; (4) **issue-tracker-as-graph practice** where GitHub issues/sub-issues serve as a persistent, human-auditable task graph that agents work as a queue — durable but with weak edge semantics (hierarchy, not blocking); (5) **academic task-graph autonomy work** converging on the same split: LLM as semantic parser producing the graph, deterministic runtime executing it, graph history used for localized repair. The consistent lesson for a deterministic kernel: *let the model propose graph mutations; let the runtime validate, apply, and gate them* — every system that lets the model mutate execution state directly reports duplicate work, runaway fan-out, or hollow verification.

---

## 1. The framing taxonomy: workflows vs. agents (Anthropic)

Anthropic's ["Building Effective Agents"](https://www.anthropic.com/engineering/building-effective-agents) supplies the vocabulary the whole field now uses:

- **Workflows**: "LLMs and tools are orchestrated through predefined code paths" — the *code path* (the graph) is deterministic; the model fills in node interiors.
- **Agents**: "LLMs dynamically direct their own processes and tool usage, maintaining control over how they accomplish tasks" — the graph is implicit and model-driven.

The five named workflow patterns sit on a determinism gradient:

| Pattern | Graph shape | Deterministic part | Model-driven part |
|---|---|---|---|
| Prompt chaining | Linear chain with programmatic "gates" | Sequence + gate checks | Each step's content |
| Routing | 1→N branch | Branch table, downstream paths | Classification choice |
| Parallelization | Fan-out/fan-in | Task division, aggregation | Subtask content, votes |
| Orchestrator-workers | Dynamic star | The pattern itself, worker harness | Decomposition + delegation |
| Evaluator-optimizer | Loop | Iteration structure, stop rule | Generation + critique |

Anthropic's explicit recommendation: use workflows for tasks with "fixed subtasks" or "distinct categories"; reserve agents for open-ended tasks, and accept "higher costs and potential for compounding errors" plus the need for sandboxing and "clear stopping conditions" ([source](https://www.anthropic.com/engineering/building-effective-agents)).

**Who mutates the graph:** in all five workflow patterns, only the developer (at design time). The model chooses *among* edges (routing, orchestrator delegation) but cannot add or remove them. Edges gate execution via code-level checks (gates in chaining, aggregation barriers in parallelization).

## 2. Compiled state-graph orchestrators: LangGraph

LangGraph (v1.0 Oct 2025, v1.1 Dec 2025) is the reference implementation of the workflow end of the spectrum ([LangGraph Graph API docs](https://docs.langchain.com/oss/python/langgraph/graph-api); [Latenode architecture guide](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-ai-framework-2025-complete-architecture-guide-multi-agent-orchestration-analysis)).

- **What the graph encodes:** computation steps (nodes = functions, possibly LLM calls) and transitions (edges), over a single typed **state object** that flows through the graph. The graph encodes *control flow and state schema*, not tasks or decisions per se.
- **Who mutates the graph:** nobody at runtime. Topology is **fixed at `.compile()` time**; the docs are explicit that structure is validated before execution. The model's influence is confined to three sanctioned channels: (a) **conditional edges** — a routing function inspects state (which may contain model output) and picks among pre-declared successors; (b) the **Send API** — a conditional edge returns `Send` objects to dynamically fan out N copies of a *pre-declared* node (map-reduce where N is unknown at compile time); (c) **Command** — a node returns `{update, goto}`, combining a state write with a jump, again to declared targets ([docs](https://docs.langchain.com/oss/python/langgraph/graph-api)).
- **How edges gate execution:** normal edges are unconditional; conditional edges are predicate functions over state ("do not mix normal edges and dynamic routing from the same node, because both paths can execute"). State merging is itself deterministic via per-key **reducers**.
- **Failure modes:** mostly operational rather than semantic — hence v1.1's retry middleware with exponential backoff and content-moderation middleware ([Latenode](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-multi-agent-orchestration-complete-framework-guide-architecture-analysis-2025)). Production writeups pair LangGraph with durable-execution engines (Temporal) because in-process graphs don't survive crashes; checkpointers exist for resumption ([AI Workflow Lab](https://aiworkflowlab.dev/article/ai-workflow-orchestration-in-production-building-durable-agent-pipelines-with-langgraph-and-temporal)).

The design stance is crisp: *the runtime owns topology; the model owns only choices the topology already anticipates.*

## 3. Plan-and-execute and DAG-compiler patterns

This family flips the authorship: the model **writes** the graph, then a deterministic engine runs it. The canonical progression is documented in LangChain's ["Plan-and-Execute Agents"](https://www.langchain.com/blog/planning-agents) post:

- **Basic Plan-and-Execute** (after Plan-and-Solve/BabyAGI): the LLM planner emits a step list; steps run serially; after execution the planner sees results and either finishes or replans. Graph = a linear task list; mutation = wholesale replan by the LLM at a fixed checkpoint; gating = serial order. Benefit over ReAct: forces upfront thinking, fewer planner calls.
- **ReWOO**: the plan interleaves reasoning steps with executable tasks using **variable syntax** (`#E2` referencing earlier outputs) — dependencies become explicit data edges. A worker executes and substitutes variables; a solver synthesizes. Mutation: essentially none after planning. Gating: sequential with data-dependency substitution. Benefit: decouples planning from observations, cutting LLM calls.
- **LLMCompiler** ([Kim et al., arXiv:2312.04511](https://arxiv.org/abs/2312.04511)): the planner **streams** a DAG of tasks (tool + args + dependency list); a deterministic **Task Fetching Unit** dispatches any task whose dependencies are resolved, in parallel; a **joiner** LLM decides replan-vs-finish from execution history. Reported: up to 3.7× latency reduction, 6× cost savings, ~9% accuracy gain over ReAct. Mutation is two-tier: LLM authors and (on joiner request) re-authors the DAG; the runtime alone advances it.
- **Atomic Task Graph** ([arXiv:2607.01942](https://arxiv.org/html/2607.01942)) extends this to 2026 practice: the LLM recursively decomposes a task into a *sequence* of DAGs (the evolution history is kept); independent branches run in parallel; on failure, the runtime uses graph history to "localize the error source and repair only the affected region, preserving validated regions unchanged." Related work in the same vein: GAP (graph-based agent planning with parallel tool use, [OpenReview](https://openreview.net/pdf?id=7bJIVHEvLm)), Task-Decoupled Planning (supervisor builds dependency graph, planner-executor pair sees only the current subtask's context, [arXiv:2601.07577](https://arxiv.org/html/2601.07577v1)), DAG-Plan ("LLM as a powerful semantic parser" translating NL into a structured DAG, [arXiv:2406.09953](https://arxiv.org/pdf/2406.09953)), and a scheduler-theoretic framing that lifts implicit agent-loop control flow into an explicit static DAG dispatched by a scheduler ([arXiv:2604.11378](https://arxiv.org/html/2604.11378v1)).

- **Failure modes reported for the family:** stale plans when the world changes mid-execution (hence the joiner/replan escape hatch); serial bottlenecks in the non-DAG variants; and planning quality bounded by the model's one-shot decomposition. ATG's contribution is precisely making *repair* graph-local instead of restart-global.

## 4. Orchestrator-worker swarms and fan-out architectures

### Anthropic's multi-agent research system
The [engineering writeup](https://www.anthropic.com/engineering/multi-agent-research-system) is the most detailed production account:

- **What the graph encodes:** nothing explicit — the "graph" is an emergent star: lead agent (Opus) → 3–5 parallel subagents (Sonnet) → synthesis → separate CitationAgent pass.
- **Who mutates it:** the **lead model** decides decomposition and spawn count; the runtime supplies guardrails (scaling heuristics in prompts: simple query = 1 agent/3–10 calls; complex = 10+ subagents), parallel dispatch, retry logic, and context checkpointing near 200K tokens.
- **How edges gate:** synchronously — the lead waits for all subagents (a stated bottleneck; async steering is future work). Subagents write structured artifacts to the filesystem to avoid "game of telephone" loss.
- **Failure modes (explicitly reported):** spawning 50+ subagents for simple queries; duplicate work from vague delegations ("research the semiconductor shortage"); endless searching for nonexistent sources; verbose queries; preferring SEO content farms. Fixes were largely *prompt-encoded determinism*: every delegation must carry objective, output format, tool guidance, and task boundaries.
- **Economics:** ~15× chat tokens; token spend explains 80% of performance variance; 90.2% improvement over single-agent Opus on internal evals — viable only for high-value, parallelizable tasks.

Anthropic's follow-up guidance ([claude.com blog](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)) adds the decomposition doctrine: split by **context boundaries**, not work phases — "planning/implementation/testing as separate agents" creates telephone-game handoffs; a feature's implementer should also write its tests. Verification subagents work *because* they need minimal context transfer, but need explicit anti-hollow-pass instructions.

### OpenAI Swarm → Agents SDK
Swarm reduced coordination to one primitive — **handoff**: an agent returns another agent from a tool call, transferring control with context ([github.com/openai/swarm](https://github.com/openai/swarm)). The production successor, the [Agents SDK](https://openai.github.io/openai-agents-python/multi_agent/), makes the graph semi-explicit: each agent declares its allowed handoff targets (a static adjacency list), and the docs explicitly recommend **orchestrating via code** where possible — e.g., structured-output classification feeding a code-level `switch` — because "orchestrating via code makes tasks more deterministic and predictable, in terms of speed, cost and performance." Guardrails (input/output validation) are the runtime-owned gates. Failure mode of the pure-handoff style: routing loops and control-flow opacity, which is exactly what the "prefer code orchestration" guidance responds to.

### Failure evidence at the family level
MAST ("Why Do Multi-Agent LLM Systems Fail?", [arXiv:2503.13657](https://arxiv.org/abs/2503.13657)) analyzed 1,600+ traces across 7 frameworks and validated (κ=0.88) a taxonomy of **14 failure modes in 3 categories: system-design/specification issues, inter-agent misalignment, and task-verification failures** — noting that multi-agent "performance gains on popular benchmarks are often minimal." Notably, two of the three categories (specification, verification) are things a deterministic contract layer can address; only misalignment is intrinsically model-side.

## 5. Issue-tracker-as-graph practice

The pragmatic branch: use an issue tracker as the persistent task graph and let agents work it as a queue.

- **GitHub sub-issues** ([docs](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)): parent/child hierarchy up to 8 levels deep, 100 sub-issues per parent, progress rollups in Projects, full API/CLI access (`gh issue create --parent`). Crucially, the edges encode **containment, not blocking** — GitHub sub-issues have no dependency/prerequisite semantics; they are organizational, not workflow-enforcing. Teams that need blocking edges encode them in issue bodies or Projects fields by convention.
- **Agent practice on top:** GitHub functions as "the task queue, where issues are Claude's to-do list" with acceptance criteria as the node contract; the agent conversation is ephemeral while "everything that must survive across pull requests lives in repo files or GitHub itself" ([saulius.io](https://saulius.io/blog/claude-code-github-native-agent-issue-to-merge-loop); [dev.to Part 6](https://dev.to/gde03/claude-code-beyond-the-prompt-part-6-github-as-claudes-task-queue-issues-prs-the-5cjj)). Spec-driven flows turn PRDs → epics → issues → PRs with traceability, and let the AI write sub-tickets as work is taken on ([dominiksnotebook](https://dominiksnotebook.substack.com/p/how-i-use-claude-code-github-for)). CCPM-style systems pair GitHub Issues with git worktrees for parallel agent execution ([ccpm](https://github.com/Ninegd/ccpm)).
- **Who mutates:** both human and model, symmetrically, via ordinary API calls — the tracker is a shared blackboard. Gating is *social/CI*, not runtime: an issue is "done" when its PR merges and CI passes; nothing in the tracker itself prevents an agent from working a blocked ticket.
- **Failure modes:** weak edge semantics (no native blocking), state drift between tracker and reality, and total dependence on the tracker's availability (the Feb 2026 GitHub outage stranding AI coding pipelines was widely noted, [serenitiesai](https://serenitiesai.com/articles/github-down-ai-coding-tools-dependency-2026)).

This is precisely the pattern Soma's own wayfinder/to-tickets skills instantiate — decision tickets with declared blocking edges — which layers the missing dependency semantics on by convention.

## 6. Comparative table

| System / pattern | Graph encodes | Who mutates the graph | How edges gate execution | Reported failure modes |
|---|---|---|---|---|
| **Anthropic workflows** (chaining, routing, parallelization…) | Control flow between LLM calls | Developer only (design time); model picks among declared edges | Code gates, branch tables, fan-in barriers | Compounding errors when pushed toward agent territory |
| **LangGraph** | Nodes = functions, edges = transitions over typed shared state | Runtime topology fixed at compile; model influences routing via conditional edges / Send / Command to declared targets | State-predicate routing; reducers merge state deterministically | Operational (crash durability → Temporal pairing; retries added in v1.1) |
| **Plan-and-Execute (basic)** | Ordered task list | LLM authors; LLM replans wholesale at checkpoint | Serial order | Stale plans; serial latency |
| **ReWOO** | Task list + data-dependency variables (#E2) | LLM authors once; near-zero mutation | Variable substitution, sequential | No mid-course correction |
| **LLMCompiler** | Task DAG (tool, args, deps) | LLM plans/replans; **runtime (Task Fetching Unit) alone advances** | Dispatch when deps resolved; parallel | Replan cost; planner one-shot quality |
| **ATG (2026)** | DAG of atomic tool-use units + evolution history | LLM decomposes recursively; runtime localizes repair to affected region | Dependency satisfaction; parallel branches | Addressed: global restarts; residual: decomposition quality |
| **Anthropic research system** | Implicit star (lead → subagents → synthesis → citation) | **Lead model** decides spawn/decomposition; runtime adds retries, checkpoints, scaling heuristics | Synchronous barrier (lead waits on all) | 50+ subagent blowup, duplicate work, hollow delegation, source-quality drift; 15× tokens |
| **OpenAI Agents SDK / Swarm** | Adjacency list of allowed handoffs + guardrails | Developer declares targets; model chooses handoff at runtime | Handoff = tool-call return; guardrails validate I/O | Routing loops, opacity → official "prefer code orchestration" guidance |
| **GitHub issues/sub-issues as graph** | Task hierarchy (containment), acceptance criteria per node | Human **and** model, symmetric API writes | None native (no blocking semantics); CI/review gate closure | State drift, no enforced dependencies, tracker-availability SPOF |
| **MAST (meta-evidence)** | — | — | — | 14 modes / 3 classes: specification, inter-agent misalignment, verification |

## 7. Implications for a deterministic kernel (Soma)

1. **Separate graph authorship from graph advancement.** The strongest convergent finding: LLMCompiler, ATG, and LangGraph all put a deterministic component in sole charge of *advancing* the graph (dispatch, gating, state merge), even when the model *authors* it. A Soma kernel should treat model-proposed graph mutations as typed transactions the runtime validates and applies — never let the model write execution state directly.
2. **Edges must carry machine-checkable predicates.** LangGraph's conditional edges and LLMCompiler's dependency-resolution gates work because gate evaluation is code. GitHub's sub-issue failure (containment without blocking) shows what happens when edges are decorative: agents can work blocked tickets. Soma's checkpoint primitive (criterion + evidence + verdict + gate) is exactly the edge payload this practice suggests — but the verdict must be probe-backed, since MAST puts verification failures in the top-3 failure classes and Anthropic's verification-subagent guidance warns about premature "pass" declarations.
3. **Bound dynamic fan-out with declared shapes.** The safe dynamism in mature systems is LangGraph's Send API: unknown *N*, but a pre-declared node type. Anthropic's unguarded model-decided spawning produced 50+ subagents for simple queries and needed prompt-level scaling heuristics as a patch. A kernel should make fan-out a runtime-enforced budget (max spawn, per-tier effort), not a prompt convention.
4. **Delegation is a contract, not a sentence.** Anthropic's fix for duplicate/drifting subagents — every delegation carries objective, output format, tool guidance, and boundaries — is a schema. A deterministic kernel can enforce it as one (reject underspecified spawns), converting a prompt-discipline lesson into a type.
5. **Decompose by context boundary, not work phase**, and keep the graph the durable artifact: conversation state is ephemeral; the graph (tracker, VSA, run record) is the system of record ([claude.com](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them); [saulius.io](https://saulius.io/blog/claude-code-github-native-agent-issue-to-merge-loop)). This matches Soma's existing algorithm-run/wayfinder direction; the gap in common practice is native blocking edges plus enforced gate evaluation, which no surveyed off-the-shelf tracker provides.
6. **Keep graph evolution history for localized repair.** ATG's region-local repair (preserve validated regions, re-execute only the affected subgraph) is the emerging answer to the restart-the-world failure mode, and presupposes an append-only record of graph versions — cheap for a kernel that already events state changes.
7. **Budget honestly.** Multi-agent buys thoroughness at 3–15× tokens and only pays off on parallelizable, high-value work; token spend explains 80% of variance. A kernel's effort-tier machinery should gate graph *width* the way it gates everything else.

## Sources

- Anthropic, "Building Effective Agents" — https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, "How we built our multi-agent research system" — https://www.anthropic.com/engineering/multi-agent-research-system
- Anthropic/Claude blog, "When to use multi-agent systems (and when not to)" — https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them
- LangGraph Graph API documentation — https://docs.langchain.com/oss/python/langgraph/graph-api
- LangChain, "Plan-and-Execute Agents" — https://www.langchain.com/blog/planning-agents
- Kim et al., "An LLM Compiler for Parallel Function Calling" — https://arxiv.org/abs/2312.04511
- "Atomic Task Graph: A Unified Framework for Agentic Planning and Execution" — https://arxiv.org/html/2607.01942
- "From Agent Loops to Structured Graphs: A Scheduler-Theoretic Framework for LLM Agent Execution" — https://arxiv.org/html/2604.11378v1
- "Beyond Entangled Planning: Task-Decoupled Planning for Long-Horizon Agents" — https://arxiv.org/html/2601.07577v1
- "DAG-Plan: Generating Directed Acyclic Dependency Graphs for Dual-Arm Cooperative Planning" — https://arxiv.org/pdf/2406.09953
- "GAP: Graph-based Agent Planning with Parallel Tool Use" — https://openreview.net/pdf?id=7bJIVHEvLm
- Cemri et al., "Why Do Multi-Agent LLM Systems Fail?" (MAST) — https://arxiv.org/abs/2503.13657
- OpenAI Agents SDK, "Agent orchestration" — https://openai.github.io/openai-agents-python/multi_agent/
- OpenAI Swarm (archived educational framework) — https://github.com/openai/swarm
- GitHub Docs, "Adding sub-issues" — https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
- Saulius, "Claude Code as a GitHub-Native Agent: The Issue-to-Merge Development Loop" — https://saulius.io/blog/claude-code-github-native-agent-issue-to-merge-loop
- "Claude Code, Beyond the Prompt — Part 6: GitHub as Claude's Task Queue" — https://dev.to/gde03/claude-code-beyond-the-prompt-part-6-github-as-claudes-task-queue-issues-prs-the-5cjj
- Dominik's Notebook, "How I use Claude Code + GitHub for spec-driven development" — https://dominiksnotebook.substack.com/p/how-i-use-claude-code-github-for
- CCPM — Claude Code project management via GitHub Issues + worktrees — https://github.com/Ninegd/ccpm
- Serenities AI, "GitHub Down Feb 9, 2026: What AI Coders Did Instead" — https://serenitiesai.com/articles/github-down-ai-coding-tools-dependency-2026
- Latenode, "LangGraph AI Framework 2025: Complete Architecture Guide" — https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-ai-framework-2025-complete-architecture-guide-multi-agent-orchestration-analysis
- AI Workflow Lab, "Building durable agent pipelines with LangGraph and Temporal" — https://aiworkflowlab.dev/article/ai-workflow-orchestration-in-production-building-durable-agent-pipelines-with-langgraph-and-temporal


---

## Verification appendix

Spot-checked 11 of 22 sources (all the load-bearing ones), fetching each URL and comparing against the document's claims.

### Confirmed

- **Workflows vs. agents definitions, five workflow patterns, "fixed subtasks"/"distinct categories" guidance, compounding-errors/sandboxing/stopping-conditions caveats** — Anthropic, "Building Effective Agents". Quotes match near-verbatim.
- **15× token cost, token spend explains 80% of variance, 90.2% improvement over single-agent Opus, 50-subagent blowup, nonexistent-source searching, scaling heuristics (1 agent/3–10 calls → 10+ subagents), Opus lead + Sonnet subagents + CitationAgent, ~200K-token context handling** — Anthropic, "How we built our multi-agent research system". All seven claims directly supported.
- **Context-boundary (not work-phase) decomposition, telephone-game handoffs, implementer-writes-tests, verification subagents need minimal context + explicit anti-shortcut instructions** — claude.com blog, "When to use multi-agent systems". All present.
- **LLMCompiler: Planner streams DAG, Task Fetching Unit dispatches, up to 3.7× latency speedup and ~9% accuracy gain over ReAct** — arXiv:2312.04511 (Kim et al.), abstract matches.
- **MAST: 1,600+ annotated traces, 7 frameworks, 14 failure modes in 3 categories (specification, inter-agent misalignment, task verification), κ=0.88, "performance gains on popular benchmarks are often minimal"** — arXiv:2503.13657. All figures and the quote check out.
- **LangGraph: topology fixed/validated at compile, conditional edges via routing functions, Send API fan-out, Command {update, goto}, do-not-mix-edge-types warning (quoted verbatim in doc), per-key reducers** — LangGraph Graph API docs. All six mechanics confirmed.
- **GitHub sub-issues: 8 levels deep, 100 sub-issues per parent, Projects rollups, API/CLI access, and — critically — no native dependency/blocking semantics** (the docs describe hierarchy only, supporting the document's "containment, not blocking" claim) — GitHub Docs.
- **OpenAI Agents SDK: "orchestrating via code makes tasks more deterministic and predictable, in terms of speed, cost and performance" (exact quote), structured-output classification feeding code decisions, declared handoff targets** — Agents SDK multi-agent docs.
- **Plan-and-Execute / ReWOO (#E2 variable syntax) / LLMCompiler progression and stated benefits (fewer planner calls, forced upfront planning)** — LangChain "Plan-and-Execute Agents" blog (Feb 2024). Matches.
- **ATG: recursive decomposition into a sequence of DAGs, parallel independent branches, graph-history-based localized repair preserving validated regions** — arXiv:2607.01942 exists (submitted 2026-07-02), title and abstract match the document's characterization.
- **Feb 2026 GitHub outage stranding AI coding pipelines** — serenitiesai.com article exists and describes the Feb 9, 2026 outage and its impact on Claude Code / Codex CLI workflows. (Low-authority blog; fine as the minor color it's used for.)

### Corrected

- **LLMCompiler cost savings: document says "6× cost savings"; the paper's abstract says "up to 6.7×"** — an understatement rather than an inflation, but the figure should read 6.7×. (Only numeric discrepancy found across all checks.)

### Could not verify (treat with caution)

- **arXiv:2604.11378 (scheduler-theoretic framing), arXiv:2601.07577 (Task-Decoupled Planning), arXiv:2406.09953 (DAG-Plan), GAP (OpenReview)** — not fetched (secondary "related work" citations; low load-bearing weight). arXiv IDs are format-plausible for their claimed dates.
- **LangGraph version dates (v1.0 Oct 2025, v1.1 Dec 2025) and v1.1 retry/moderation middleware** — sourced to Latenode (a third-party marketing blog), not fetched; version dates are plausible but rest on a low-authority source.
- **Latenode, AI Workflow Lab (LangGraph+Temporal), saulius.io, dev.to Part 6, dominiksnotebook, CCPM repo, openai/swarm repo** — not fetched; all are used for practice-color claims consistent with the verified primary sources, not for load-bearing figures.

### Verdict

The document's load-bearing claims — the Anthropic taxonomy and quotes, the multi-agent economics (15×, 80%, 90.2%), LLMCompiler and MAST figures, LangGraph compile-time-topology mechanics, GitHub sub-issues' lack of blocking semantics, and the OpenAI "prefer code orchestration" quote — all check out against their primary sources. The single correction is a minor rounding-down (6× → 6.7×). No misattributed or fabricated sources found among those checked.
