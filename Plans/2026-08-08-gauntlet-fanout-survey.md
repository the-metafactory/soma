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

Almost nothing portable, and what exists is in the wrong place.

`src/skills/the-algorithm/SKILL.md:18` instructs the agent to "Read
`references/capabilities.md` before selecting thinking or delegation
capabilities." **That file is not in the repo.** The bundled skill is `SKILL.md`
plus `Workflows/RunAlgorithm.md`; nothing else. (Same for the other three
references it names — see the packaging-cost findings.)

The file does exist in the principal's home
(`~/.soma/skills/the-algorithm/references/capabilities.md`, PAI-era), and its
"Delegation & Infrastructure Capabilities" table is **entirely Claude-shaped**:
`Agent(subagent_type=…)`, `isolation: "worktree"`, Agent Teams, Custom Agents,
`Skill("Delegation")`, slash commands, `{{PRINCIPAL_NAME}}` placeholders. It is
a PAI artifact, not a portable contract.

That is the current state: Soma's only written delegation vocabulary is
Claude-specific, unshipped, and reachable only on machines that carry the PAI
import. Meanwhile `src/skills/the-algorithm/SKILL.md:21` tells the agent to
"Treat Claude-specific hooks, voice curls, and Claude Code sub-agents as source
history, not portable requirements" — i.e. the doctrine already refuses to make
sub-agents portable, and the one doc that would define an alternative is missing
from the bundle.

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

## Loose end worth its own node

`the-algorithm`'s four dangling reference pointers are a shipped defect
independent of this map — a fresh Soma install gets a skill instructing the agent
to read files that do not exist. Flagged here, not fixed.
