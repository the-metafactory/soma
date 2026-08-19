# How the assistant talks, and what it may do

Two principal-authored files govern conduct. They are deliberately separate,
they live in different compartments, and they reach a substrate by different
mechanisms. Both paths below are relative to the Soma home.

| | Communication contract | Behavioral policy |
|---|---|---|
| File | `profile/communication.md` | `policy/behavior.md` |
| Compartment | Identity (owns "voice, personality") | Policy (security, permission, evidence rules) |
| Governs | How the assistant *talks* | What the assistant *may do* |
| Created by `soma init` | Yes, a generic starter | **No** — principal-authored only |
| How it projects | Verbatim, as its own file | Parsed into each substrate's advisory policy list |
| Parsed by Soma | Nothing | `## Heading` sections → advisory lines |

One rule, one home: an operational boundary goes in `policy/behavior.md`, a
habit of speech goes in `profile/communication.md`. Neither file is invented for
you — an absent file projects nothing rather than a default.

---

## The communication contract

The contract is the highest-leverage place to change how an assistant
communicates, because it is present on every turn of every session. Editing it
beats re-tuning individual prompts, which is one task's worth of leverage at a
time.

`soma init` writes a starter with these sections. They are a starting point, not
a finished product — the structure is what transfers between models; only the
word lists change.

| Section | What it does |
|---|---|
| Positive patterns | Behaviours to replicate. |
| Negative patterns | Behaviours to avoid. |
| Banned phrases | Model-specific verbal tics. Expected to churn; owned by you. |
| Reference codes | The letters used to label findings, options, risks, questions, actions, decisions. |
| Aliases | Short tokens that expand into full instructions when typed alone. |
| Examples | Authored do/don't pairs. A model matches an example harder than it follows a rule. |

### Soma parses nothing out of it

The file projects **verbatim** — no provenance header, no re-render. Every
section does its work by *being read*: aliases work because the model sees them,
banned phrases work because the model sees them. There is nothing for Soma to
extract, so nothing is extracted.

This is also a safety property. The contract sits on the path every command
takes to load the Soma home, so a parse would let a typo in a prose file fail
`install`, `reproject`, or a hook. It cannot: the file is read, not interpreted.

### Where it lands

| Substrate | Home path | Workspace path |
|---|---|---|
| claude-code | `rules/soma/COMMUNICATION.md` | `.claude/soma/communication.md` |
| codex | `memories/soma/communication.md` | `.codex/soma/communication.md` |
| grok | `skills/soma/communication.md` | `.grok/rules/soma/communication.md` |
| pi-dev | `agent/soma/communication.md` | `.pi/extensions/soma-core/communication.md` |
| cursor | `.cursor/rules/soma/COMMUNICATION.md` | — |
| anthropic-cowork | `soma/communication.md` | — |

How it *arrives* differs by substrate, and the difference matters:

- **Pi.dev** injects it into the system prompt itself — the native equivalent of
  an appended system-prompt file. Read once per session and cached, so it costs
  no file read on the message path. The cache is process-scoped and cleared at
  `session_start`; a resumed process that never fires `session_start` holds its
  first read until it restarts.
- **Auto-discovered rules directories** (claude-code, cursor) load it as session
  context with no instruction needed.
- **Everywhere else** the substrate's own instruction file carries a "read this
  when present" line. A projected file that nothing is told to open is the
  failure this whole rail exists to fix, so a test derives its list of surfaces
  from the projection itself: a new surface fails until its reader is wired.

---

## The behavioral policy

`policy/behavior.md` holds cross-substrate rules for conduct: verification,
scope discipline, permission boundaries, external-content handling. Its
`## Heading` sections become `<Heading>: <rule>` advisory lines in every
substrate's policy projection, ahead of the shipped SelfHealing doctrine.

`soma init` does **not** create this file. Homes migrated from PAI have one; a
fresh home does not, and the rail simply projects nothing until you write it.
Soma never invents conduct rules.

### Authoring rules

The parser is built for hand-written prose, not a strict format:

- **Wrapped bullets fold.** A rule spanning several source lines arrives whole.
  (`sectionBullets`, the older identity-file scanner, keeps only lines starting
  with `- ` — a rule that lost its second half would be worse than one that
  never projected.)
- **Prose counts as rules.** Whether you write a bullet or a paragraph is
  formatting, not meaning. Both project.
- **Source order is preserved.** A section that opens with a paragraph and then
  lists bullets projects in that order.
- **Numbered lists** (`1.`, `1)`) are bullets.
- **Fenced blocks are dropped**, markers and contents both, so a command example
  never becomes an advisory rule and a `#` inside one cannot close the section.
  If the file's fences are unbalanced, fence handling is disabled for the whole
  file: one stray fence would otherwise swallow every section below it, and
  losing rules to a typo is worse than projecting a stray code line, because
  only the second is visible in the projection.
- **Sub-headings** (`###`) are structure. Their text is dropped; their rules stay
  attached to the parent `##` section.
- **Everything before the first `## `** is preamble and is dropped. No section
  is ever discarded for its *name*.

### One source, N projections

`policy/behavior.md` is authoritative and `src/policy/behavior-policy.ts` only
reads it. That is the mirror image of `src/policy/self-healing-doctrine.ts`,
where the module is authoritative and the markdown mirrors it — because that
doctrine ships with Soma, while behavioural rules belong to you.

No adapter restates a rule. Each renders from
`behaviorPolicyAdvisory(input.behavior)` and nothing else, and a drift test
uppercases every rule at the source, then asserts each projection carries the
mutated form and neither the original rendered line nor its bare text.

---

## Reference codes

When presenting three or more findings, options, risks, questions, actions, or
decisions, the assistant labels each with a short code, stable for the whole
conversation:

```
F1 findings · O1 options · R1 risks · Q1 questions · A1 actions · D1 decisions
```

Your reply collapses to `keep D1, reject O2, answer Q1` — no re-quoting, no
re-explaining. You and the assistant share an index into the conversation.

### C and P are reserved

`C1` is a VSA criterion and `P1` an Algorithm plan step. Recording a code under
either letter is **refused**, because `keep C1` must never be ambiguous between
a criterion and a chat finding.

The refusal lives at the write path only. Declaring `C` in your contract is
harmless — a collision can only happen when a code is actually recorded, and a
prose file on the home-load path must never be able to fail `install`.

### Making a code durable

A code typed in chat is shorthand until it is written to a run. There is no
implicit "active run":

```bash
soma algorithm ref     --id <run-id> --code F1 --text "The parser truncates wrapped rules."
soma algorithm ref     --id <run-id> --code D1 --text "Drop the co-author rule."
soma algorithm resolve --id <run-id> --code D1 --verdict kept --note "Applied in the starter."
```

Batch form:

```bash
soma algorithm batch --id <run-id> \
  --op "ref:F1:The parser truncates wrapped rules." \
  --op "resolve:D1:kept:Applied in the starter."
```

Verdicts are `kept`, `rejected`, `answered`, `done`, `dropped`. Re-resolving
overwrites — a decision revisited later is a real event, and refusing it would
push the correction back into prose where nothing can read it.

`soma algorithm show --id <run-id>` prints a **References** block when the run
has any; runs without references show none.

A reference verdict is **not** a checkpoint verdict: it is an ungated
conversational disposition with no required evidence and no completion gate, and
`soma algorithm resolve` is not `soma graph close`. See
[CONTEXT.md](../CONTEXT.md) for the full vocabulary.

### D codes mirror into decisions

Recording or resolving a `D` code also appends to the run's `decisions` log.
Decisions already have a durable home; a parallel one would let
`soma algorithm show` disagree with itself about what was decided.

`AlgorithmRun.references` is additive and store-defaulted, so runs written
before this shipped load with an empty list.

---

## Provenance

The contract's section structure — positive/negative patterns, banned phrases,
reference codes, aliases, authored examples — and several of the banned phrases
are adapted from [disler/fixing-smartass-opus-5](https://github.com/disler/fixing-smartass-opus-5)
(MIT). Adapted, not copied. Four deliberate divergences:

1. That project's "never add a co-author to a commit message" rule is **absent**;
   it contradicts this repo's trailer convention.
2. Its "no decorative headings" rule is **relaxed** — the VSA and Algorithm
   rendering contracts are heading-dense by design.
3. `C` and `P` are **reserved** out of the reference-code space, and `D` maps
   onto the Algorithm's existing decisions log rather than a parallel record.
4. Its side-by-side compare loop (`just` + `herdr` panes) is **not** ported: it
   is a two-pane terminal comparison you eyeball, not a metric, and neither tool
   can become a Soma dependency.
