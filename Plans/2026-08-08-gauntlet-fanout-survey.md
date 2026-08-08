# Agent fan-out across Soma's substrates — what a portable skill may assume

Findings for node #568 on map #565. Survey only; the decision on whether Soma
states a portable fan-out expectation is downstream.

Read out of the working tree at `main` and the live soma-home on 2026-08-08.
Confidence is marked per row: **verified** = probed in this repo or on this
machine; **documented** = stated in Soma's own adapter docs, which record live
probes; **unstated** = Soma's docs are silent, so this survey does not know.

## Why the Gauntlet Loop needs this

Three of the method's mechanics need a worker that is not the current agent:

1. **Split the work** — N builders, ideally concurrent.
2. **Fresh context** — the critic must not inherit the builder's history. This is
   the load-bearing one: a critic that shares context is a self-grader wearing a
   hat.
3. **Isolation** — parallel builders that write files collide without it.

Only (2) is strictly required by the method. (1) and (3) are throughput and
safety.

## The survey

Installable substrates are `codex`, `pi-dev`, `claude-code`, `cursor`, `grok`
(`src/types.ts:15`), plus `anthropic-cowork` as an experimental scaffold.

| Substrate | Spawn primitive | Fresh context | Parallel | Isolation | Confidence |
|---|---|---|---|---|---|
| **claude-code** | sub-agents — a first-class surface Soma already hooks (`SubagentStart` / `SubagentStop` in `settings.json`, `src/adapters/claude-code/install.ts`; markers `agent_id`/`agent_type` in `hook-runner.mjs:97`) | yes | yes | worktree isolation available | verified (hooks + markers in repo) |
| **grok** | `spawn_subagent`, reading `personas/*.toml`, `roles/*.toml`, `agents/*.md`. Soma **already projects onto it**: `personas/soma.toml`, `roles/soma-algorithm.toml`, `agents/soma-explore.md` | yes | unstated | git worktrees — Soma's own guidance, since `--sandbox` is Landlock/Seatbelt-only and absent on Windows | documented (`docs/substrate-adapters.md:299-303`) |
| **opencode** | primary agents **and** subagents, natively; the proposed projection defines `soma-review.md` as a read-only review subagent | yes | unstated | unstated | documented, **adapter not implemented** (`docs/substrate-adapters.md:263-276`, `docs/opencode-projection.md:124-131`) |
| **copilot-cli** | "custom agent profiles" named in the proposed projection | likely | unstated | unstated | documented, **adapter not implemented** (`docs/substrate-adapters.md:223-236`) |
| **codex** | nothing in Soma's adapter surface. The projection carries instruction fragments, context files, and hooks; no agent-spawn primitive is named | unstated | unstated | unstated | unstated (`docs/substrate-adapters.md:7-40`) |
| **pi-dev** | extensions + registered tools (`isa_create`, `memory_search`, `policy_check`, …). No spawn tool in the contract | unstated | unstated | unstated | unstated (`docs/substrate-adapters.md:89-120`) |
| **cursor** | filesystem-first projection only; execution and MCP runtime wiring explicitly **deferred** | n/a | n/a | n/a | verified-absent (`docs/substrate-adapters.md:199-222`) |
| **anthropic-cowork** | experimental scaffold; consumption is "manual/experimental until a future probe proves a Cowork-loaded surface" | n/a | n/a | n/a | verified-absent (`docs/substrate-adapters.md:237-262`) |

**The honest count: two substrates have a probed spawn primitive (claude-code,
grok), two more have one on paper behind unimplemented adapters (opencode,
copilot-cli), and four have nothing Soma can name.**

Note the asymmetry that matters for the loop: grok's subagent surface is one
Soma *already writes to*. If a portable fan-out expectation is ever stated,
grok and claude-code are the two substrates where it is real today.

## What Soma says about delegation today

> **Correction (2026-08-08).** This section first said
> `references/capabilities.md` was missing from the repo bundle. That was read
> off a stale local `main` (`337e2b9`); `db2ec92` (#462) had already landed on
> `origin/main` and ships all eight reference files. The file **is** shipped —
> which makes the finding stronger, not weaker.

Soma's delegation vocabulary is Claude-shaped, and it ships to every adopter.

`references/capabilities.md` is not prose. `loadSomaHomeAlgorithmCapabilityRegistry`
(`src/algorithm-capabilities.ts:395-466`) parses its table into the capability
registry a run selects from. Loading the shipped bundle as a soma home yields
**11 definitions and 33 unsupported rows**. Among the 11 that register:

| Capability | Kind | Target |
|---|---|---|
| `Forge` | agent | `Agent(subagent_type="Forge")` |
| `Anvil` | agent | `Agent(subagent_type="Anvil")` |
| `Claude Code Guide` | agent | `Agent(subagent_type="claude-code-guide")` |
| `Advisor` | command | `bun ~/.claude/PAI/TOOLS/Inference.ts --mode advisor …` |
| `FeedbackMemoryConsult` | command | `Bash('rg -l "KEYWORDS" ~/.claude/projects/…')` |

Three bind a capability to Claude Code sub-agents; two shell into paths under
`~/.claude/`. The other 33 rows — `Skill("RedTeam")`, `Skill("Research")`,
`Skill("SystemsThinking")`, Agent Teams, Background Agents, Mass Parallelism,
Session Branching, Worktree Isolation, and a set of slash commands — resolve to
nothing on a machine that is not the author's, and **`unsupported` is never
surfaced by any CLI verb**. A fresh adopter gets a registry two-thirds inert
with no signal that anything was dropped.

Meanwhile `src/skills/the-algorithm/SKILL.md` tells the agent to "Treat
Claude-specific hooks, voice curls, and Claude Code sub-agents as source
history, not portable requirements." The doctrine refuses to make sub-agents
portable; the shipped table makes three of them selectable capabilities anyway.

The same table also carried the pre-#329 `ISA Skill` row — dead because the
parser was migrated (`stripCapabilityLabel` special-cases `"VSA Skill" → "VSA"`)
and the file it parses was not. Fixed on `fix/vsa-canonical-pointers`.

## The one portable hook that already exists

The VSA has a `parallelizable` boolean on features — used throughout the shipped
examples (`src/skills/VSA/Examples/canonical-vsa.md:191`,
`e5-album.md:197-245`) and asked for explicitly in the interview: "What can run
in parallel? What blocks the critical path?"
(`src/skills/VSA/Workflows/Interview.md:49`).

This is Soma's existing, substrate-neutral way of saying *which pieces are
independently workable* — which is exactly what the Gauntlet's "split the work"
produces. It declares independence without assuming any spawn primitive, so it
degrades cleanly: a substrate that can fan out runs them concurrently, one that
cannot runs them in sequence, and the decomposition is identical either way.

The orienteer/work-graph layer says the same thing in a second vocabulary:
blocking edges make the frontier, and the frontier is by construction the set of
independently takeable work.

## What a portable skill may assume — the recommendation

**Assume nothing about concurrency. Require only separation.**

- **Mandatory, portable:** the critic must not share the builder's context. Every
  substrate can satisfy this without a spawn primitive — a fresh session, a
  separate invocation, even a second pass told to read only the artifact. What
  cannot be satisfied portably is *proving* it, which is why this belongs in the
  skill's contract rather than in a runtime check.
- **Stated as an optimisation, not a requirement:** parallel builders. Name the
  primitive per substrate where Soma knows one (claude-code sub-agents, grok
  `spawn_subagent`) and let the rest run sequentially. Sequential fan-out
  produces the same result more slowly; it does not produce a worse result.
- **Stated as a caution:** worktree isolation is needed only when builders write
  to the same tree, and Soma's own guidance already reaches for git worktrees
  where a substrate has no sandbox.
- **Decompose in the existing vocabulary**, not a new one: `parallelizable`
  features on the VSA, or blocking edges on the work graph. Both already exist,
  both are substrate-neutral, and neither implies a spawn primitive.

The degradation story is the whole point: a loop whose only hard requirement is
"the judge did not write the work" runs on all eight substrates. A loop that
requires concurrent isolated builders runs on two.

## Loose end worth its own issue

**Superseded.** This section originally reported `the-algorithm`'s four dangling
reference pointers. They do not exist on real `main` — see the correction above;
#573 was filed off the same stale checkout and is closed as invalid.

What stands in its place is the real loose end: the shipped capability table
declares Claude-only agents and `~/.claude/` command paths as portable
capabilities, and two-thirds of its rows silently drop to `unsupported` on any
machine but the author's, with no verb that reports it. That is a portability
question for the map's contract node, and a candidate issue in its own right.
