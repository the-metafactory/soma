# Algorithm Capabilities Reference

Loaded by OBSERVE on demand during capability selection.

**This file is parsed, not just read.** `loadSomaHomeAlgorithmCapabilityRegistry`
reads it out of the soma home and turns each table row into a capability
definition. A missing file, or a malformed row, degrades **silently** to a
thinner registry. Edit it as a data file: a broken row is a dropped capability,
not an error.

## Where capability names come from

Four sources, merged in this order, the first definition of a name winning:

1. **Skills declaring `algorithmCapability` in their manifest** — phases and
   trigger signals come from that metadata.
2. **`capabilities.local.md`, the adopter's own table** (see below).
3. **The table in this file.**
4. **Every remaining skill under `<soma-home>/skills`, automatically** —
   registered under its own name, admissible in all seven phases, with trigger
   signals from its `## Triggers` bullets, falling back to its description.

Because of (4), **you do not need to list a skill here to select it.** A row
exists to *narrow* a capability — to say which phases it belongs to and what
signal should trigger it — or to register something that is not a skill at all.

Two capabilities are compiled in and need no declaration anywhere: `ReReadCheck`
(inline; verify, learn) and `sequential-analysis` (inline; think, plan).

## The adopter's table: `capabilities.local.md`

`soma install` rewrites every bundled file in this skill on each run, but leaves
principal-added files alone. So a row you add **to this file will be overwritten**,
and a row you add to a sibling `capabilities.local.md` will not. That file is
where your own capabilities live — the ones bound to your models, your
Claude Code sub-agents or Grok subagents, your commands, your skill library.

It uses exactly the format below and is read **before** this table, so a local
row of the same name wins. Retarget `Advisor` at your own second-opinion tool,
or narrow `VSA` to fewer phases, without editing a file that will be replaced
under you.

Nothing generates it. If it does not exist, only the shipped table applies.

## The row format

The parser looks for any markdown table whose **first header cell is
`Capability`** (case-insensitive) and reads rows until the table ends. Every such
table in the file is parsed, not just the first. Two shapes are accepted:

```
| Capability | Phase | Trigger Signal | Invoke | Typical Cost |   ← 5+ columns
| Capability | Trigger Signal | Invoke |                         ← 3 columns
```

- **Phase** — substring-matched against `observe`, `think`, `plan`, `build`,
  `execute`, `verify`, `learn`, `complete`. The literal `any` expands to all
  seven core phases. Several phases in one cell all match. An unrecognised cell
  falls back to `think` in the 5-column shape, `plan` in the 3-column shape.
- **Trigger Signal** — free text, stored verbatim (emphasis stripped).
- **Invoke** — decides the capability's *kind*, checked in this order:

  | Cell contains | Kind | Notes |
  |---|---|---|
  | `Skill("Name")` | `skill` | Must resolve to a skill under `<soma-home>/skills`, matched case- and punctuation-insensitively against its frontmatter name **or** its directory name. If it does not resolve, the row is dropped as unsupported. |
  | `Adapter("<contract>")` | `adapter` | Declares a capability by its **contract** instead of an invocation. Checked first, so a contract mentioning a sub-agent is not misread as an `Agent(` row. See "Capabilities no substrate can express" below. |
  | `Agent(…)` | `agent` (the `AlgorithmCapabilityKind` literal — qualified everywhere else per CONTEXT.md) | Target is `subagent_type="…"` when present, else the capability's own name. Substrate-specific — see below. |
  | `inline doctrine` or `no external tool` | `inline` | The whole cell becomes the instruction. |
  | `Bash(…)` or a leading `bun ` | `command` | The whole cell becomes the command. |
  | anything else | — | Dropped as unsupported. |

- **Typical Cost** — not read by the parser. The lowest effort tier at which the
  capability usually fits the budget. Information, not a restriction.

A row that cannot be turned into a capability is dropped and its name recorded
in the registry's `unsupported` list. That is deliberate: a capability that
cannot be invoked should not be selectable. It is also quiet, so check
`unsupported` when a capability you expected is not being offered.

## Portability

Keep the **shipped** table portable, and put anything substrate-bound in your
`capabilities.local.md`:

- `Skill("…")` rows are portable when they target a **bundled** skill (`VSA`,
  `Memory`, `orienteer`, `the-algorithm`) — those exist wherever Soma is
  installed. A row targeting a principal-authored skill resolves only on
  machines that have it.
- `inline doctrine` rows are portable by construction: they name a discipline,
  not a tool.
- `Agent(…)` rows bind to a substrate that can spawn a short-lived worker of
  its own — a Claude Code sub-agent, a Grok subagent via `spawn_subagent`. Two can; the
  rest either cannot or have no adapter that says so. `SKILL.md` is explicit
  that Claude Code sub-agents are source history, **not** a portable
  requirement — so a shipped row must not depend on one.
- `Bash(…)` / `bun …` rows bind to a filesystem layout. Local table only.

## Capabilities no substrate can express: the `adapter` kind

Some capabilities are doctrine everywhere and invocable nowhere in particular. A
second opinion at a commitment boundary, a coder from a different model family,
an audit by a model that did not write the work — the *discipline* is portable,
the *mechanism* is whatever you happen to have.

Shipping them as `Agent(…)` or `Bash(…)` binds Soma to one person's toolchain.
Dropping them loses real doctrine. `Adapter("<contract>")` is the third option:
declare the capability by what it must achieve, and let whoever can satisfy it
bind the mechanism.

```
| CrossFamilyAudit | VERIFY | … | `Adapter("audit by a model outside the family that produced the work")` | E4+ |
```

**Binding one.** Add a row of the same name to `capabilities.local.md` with a
concrete `Agent(…)`, `Skill("…")`, or `Bash(…)` cell. The local table is read
first, so your binding replaces the declaration.

**Unbound, an adapter capability is still selectable, and that is deliberate.**
It cannot be invoked, and `algorithm advance` refuses COMPLETE for any selected
capability that was never invoked — so an unbound adapter fails the run at the
gate, loudly, naming itself. The alternative (hiding it) would let a tier floor
be satisfied by a capability that does nothing, which is the phantom this
doctrine exists to prevent. If you cannot satisfy the contract, do not select
it: record in `## Decisions` that the capability was unavailable. An absent
second opinion is a fact worth keeping, not an inconvenience to route around.

`<prefix> algorithm capabilities --list` marks every adapter row that still
needs a binding on this machine.

## Capability table

| Capability | Phase | Trigger Signal | Invoke | Typical Cost |
|------------|-------|----------------|--------|--------------|
| **VSA Skill** | **OBSERVE, PLAN, EXECUTE, VERIFY, LEARN** | **MANDATORY at E2+ for VSA scaffolding (`Skill("VSA", "scaffold from prompt at tier T")`), tier completeness checks (`Skill("VSA", "check completeness")`), ephemeral feature extraction at PLAN, canonical Decisions/Changelog/Verification entries via Append at any phase, and Reconcile after ephemeral feature work at LEARN. E1 may inline-write the minimal Goal+Criteria VSA to preserve the <90s budget. The skill owns the canonical twelve-section template and refuses to write partial Deutsch C/R/L Changelog entries.** | `Skill("VSA", "<verb> <args>")` | E1+ |
| RecallPriorWork | OBSERVE | Cold start, "we did this before", a topic with likely prior art. Recall before conjecturing — and prefer the verb over grepping the tree, because recall is note-aware and leaves a trace the retrieval-quality probe can read. | `Skill("Memory")` | E1+ |
| MapTheWork | PLAN | More work than one session can hold, and the route to the destination is unclear — not merely the work. Produces decision nodes on the work graph, resolved one at a time. | `Skill("orienteer")` | E3+ |
| ReproduceFirst | OBSERVE, VERIFY | A bug report, a regression, "it broke". Reproduce the failure before diagnosing it; a fix for a failure you never saw is a conjecture. | *(inline doctrine — no external tool)* | E1+ |
| IntentEcho | OBSERVE | Every run, before anything else. Restate the request in one sentence; if you cannot restate it accurately, re-read it rather than proceed. | *(inline doctrine — no external tool)* | E1+ |
| Advisor | THINK, VERIFY | Commitment boundaries on multi-step work: before committing to an approach, when the same problem resists two distinct attempts, and once after a durable deliverable before declaring done. Ask a specific question, not "review this". | `Adapter("a second opinion from something that did not produce the work")` | E3+ |
| CrossFamilyCoder | EXECUTE | Substantial implementation where same-family blind spots compound — E3+ coding routed through one model family only. Family diversity is the point, not a particular vendor. | `Adapter("a code-producing capability from a different model family")` | E3+ |
| CrossFamilyAudit | VERIFY | Deep and Comprehensive work, before completion: compare the artifacts against the criteria and surface what a same-family reviewer shares with the author. Cannot be satisfied by a reviewer of the same family — that is the blind spot, not the check. | `Adapter("an audit by a model outside the family that produced the work")` | E4+ |

## Binding Commitment

Selecting a capability is a binding commitment to invoke it via tool. Naming one
and not invoking it is a phantom capability: it does not count toward a tier
floor, and it is dishonest in the response. If you realise mid-execution that a
selected capability is unneeded, remove it with a reason rather than leaving it
listed.

## Proactive Skill Scan

This table covers what ships. For domain-specific work, check the skill catalog
for specialised skills — every one of them is already registered as a capability
under its own name, so selecting it needs no row here. Match skill triggers to
the task domain.

## Output Format

```
🏹 CAPABILITIES SELECTED:
 🏹 [Each capability, target phase, 8-word reason]
🏹 [12-24 words on selection rationale]
```
