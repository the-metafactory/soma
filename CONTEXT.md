# Soma — Context

Glossary of the domain language. One canonical term per concept. No implementation details.

---

## substrate

The host runtime that Soma projects into. Examples: Claude Code, OpenAI Codex, Pi.dev, Cortex/Myelin.

Each substrate exposes its own primitives (system prompt, hooks, extensions, instruction files, tool surfaces). Soma is substrate-neutral; adapters translate Soma into substrate-native shape.

**Not synonyms:** Do not use `harness`, `host`, `runtime`, `platform`, `agent runtime` in Soma docs or code. `substrate` is the only word.

**Why:** Coheres with the biological metaphor (Soma = cell body, substrate = medium it lives in). Already entrenched in `docs/architecture.md`, `docs/boundaries.md`, `docs/substrate-adapters.md`, and TypeScript types (`SomaAdapter`, `buildClaudeCodeContext`). `harness` implies strap-in/constraint; `substrate` implies host/medium — matches Soma's stance of projecting into the host, not being strapped to a rig.

---

## project (verb) / projection (noun)

The canonical act of mapping Soma state into substrate-native shape, and the artifact that results.

A **projection** is what a [[adapter]] writes into a substrate so Soma is present there. Examples: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.pi/agent/extensions/soma.ts`, plus their accompanying context files.

**Not synonyms:** Do not use `translate`, `render`, `build context`, `emit`, `compile`, `serialize` as glossary terms for this act. `project` / `projection` is the only pair.

**Internal function naming:** `buildCodexContext`, `buildClaudeCodeContext`, `buildPiDevContext` are acceptable internal function names but should be read as "build the projection for X". Future renames may align them to `projectInto*`.

**Why:** Already the most-used verb in `docs/naming.md`, `docs/boundaries.md`, `docs/substrate-adapters.md`. Other verbs (`render`, `translate`, `build`) leaked in over time and create fuzzy synonyms. One verb keeps reasoning about projection lifecycle clean.

---

## install (verb)

The user-facing CLI action that makes Soma available by default in a substrate. Triggers a [[project|projection]] into the substrate's home directory.

```bash
soma install codex --apply
soma install pi-dev --apply
soma install claude-code --apply
```

**Distinct from `project`:** `install` is the one-time setup event the user runs from the terminal. `project` is the recurring act of mapping Soma state into substrate-native shape — it happens during install, on update, and (optionally) on Soma state change.

**Not synonyms:** Do not use `setup`, `bootstrap`, `attach`, `bind`, `register` for the CLI command. `install` is the only word.

**Why:** Users already say "install" for adding software to a system. README and CLI already use it. Splitting the install-event abstraction from the project-mapping abstraction keeps the user surface familiar while letting the engine talk about projection cleanly.

---

## Soma (whole-system noun)

The durable, portable assistant body. The thing that gets [[project|projected]] into a [[substrate]].

When you want to speak about "the whole assistant" — its identity, telos, ISA, skills, memory, policy, and learning together — the noun is **Soma**, not `identity`, not `assistant`, not `context`.

Examples of correct usage:
- "Soma projects into substrates."
- "Soma is filesystem-native at `~/.soma/`."
- "The user installs Soma into Codex."

**Distinct from:** the [[Identity]] layer (one narrow component inside Soma — profile, voice, personality), and from the named [[assistant]] persona that Soma carries (Ivy, Cedar, etc.).

---

## Identity (layer, narrow)

The one Soma layer that stores **who the principal is and who the assistant is**: profile facts, communication preferences, personality metadata, and optional voice metadata.

Use capital `I` and the qualifier `Identity layer` when ambiguity is possible. Never use `identity` to mean the whole [[Soma]].

**Why narrow:** Already specified this way in `docs/architecture.md` and `src/` types. Widening it would force renames across code and create a synonym fight with `Soma`.

---

## presence

Soma's **living existence inside a session** of a substrate. Distinct from [[project|projection]], which is the static artifact on disk.

- **Projection** = the files an [[adapter]] writes (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, etc.). Static. Inspectable with `ls` and `cat`.
- **Presence** = what the running agent experiences when those files are loaded into its context. Dynamic. Visible only at runtime.

Use this term when reasoning about runtime behavior (e.g., "Soma's presence in Claude Code includes the system prompt append and the loaded statusline; in Codex it is the AGENTS.md content surfaced into the developer instruction.").

**Why introduce it:** Without `presence`, "projection" gets stretched to cover both the static artifact and the runtime experience, which produces fuzzy reasoning about what changes when (re-project on file change vs re-load on session start).

---

## compartment

One of the seven named subdivisions of [[Soma]]. Each compartment holds a coherent slice of the assistant body.

The seven compartments:

1. **Identity** — principal profile, assistant profile, voice, personality
2. **Telos** — goals, principles, commitments, strategies, desired state
3. **ISA** — ideal-state artifacts (the articulation and verification of work)
4. **Skills** — portable capability folders
5. **Memory** — work, knowledge, learning, relationship, state stores
6. **Policy** — security, privacy, permission, verification rules
7. **Learning** — captured learnings, signals, performance feedback

**Not synonyms:** Do not use `layer`, `store`, `domain`, `component`, `module`, `section`, `part` as glossary terms for these. `compartment` is the only word.

**Why:** Coheres with the cellular metaphor (a cell body has compartments — nucleus, mitochondria, etc., each doing its own job, not stacked or ordered). Captures the right shape: seven peer subdivisions, each with its own contract, no implied ordering. `layer` implies a stack (wrong); `store` implies storage and breaks for Policy and Learning; `domain` collides with DDD vocabulary already in use across the codebase.

---

## assistant

The named being that [[Soma]] makes portable. Examples: Ivy, Cedar, Sage, Fern, Alpha, Gorse.

The substrate sees an `assistant`, not "Soma". Soma is the body; the assistant is the named entity that lives in that body and shows up in a [[substrate]].

> "Ivy is the assistant. Soma is what makes Ivy portable."

**Decomposing the user's phrase "agentic identity":** the assistant's [[Identity]] compartment, projected into a substrate.

**Not synonyms:**
- `agent` — reserved for substrate-level concepts (Codex Agent, Cortex agent daemon, OpenAI Agent). Do not use `agent` to mean the named being Soma defines.
- `persona` — theatrical, suggests mask/costume. The assistant is the real entity, not a role.
- `bot` — banned. Trivializing.
- `DA` / `Digital Assistant` — PAI-internal jargon. Not portable.
- `identity` — already taken by the [[Identity]] compartment.

**Why:** Already used in user-facing README ("your AI assistant"). Distinct from heavily-overloaded `agent`. Allows "agentic identity" to decompose into precise glossary terms instead of standing as a fuzzy compound noun.

---

## principal

The human [[Soma]] serves. Owner of the [[assistant]], owner of the local Soma installation, root of the trust and policy model.

Pairs with [[assistant]]: principal ↔ assistant = the human and the named being that serves them.

**Where used:** Docs, code, glossary, `Identity` compartment definitions, security/policy contexts.

**Not synonyms in those contexts:** Do not use `user`, `owner`, `human`, `operator` in glossary or formal docs. `principal` is the only word.

**`user` (informal):** Acceptable in README copy, install prompts, CLI error messages, onboarding text — anywhere a casual reader expects the word "user". Never in `docs/`, `src/`, or this glossary.

**Why:** Already in `docs/architecture.md` and the `Identity` compartment. Inherited from PAI (`PRINCIPAL_IDENTITY.md`). Carries the right connotation (cryptographic principal, security principal) — implies authority and ownership rather than tenant or consumer. `user` is too generic and collides with "user of the substrate".

---

## adapter

The actor that performs a [[project|projection]]. One adapter per [[substrate]]: Codex adapter, Pi.dev adapter, Claude Code adapter, Cortex adapter.

An adapter:
- Detects whether its substrate is present on the principal's machine.
- Projects [[Soma]] into substrate-native shape (files, hooks, extensions, manifests).
- Optionally runs the substrate's executor against a Soma task.

**Hard rule — one adapter per substrate.** No multi-substrate adapters. No adapter-of-adapters. If a host runtime is genuinely distinct (different primitives, different install surface), it gets its own adapter.

**Not synonyms:** Do not use `projector`, `bridge`, `translator`, `membrane`, `binding`, `driver` as glossary terms. `adapter` is the only word.

**Why:** Already entrenched (`SomaAdapter` interface, `docs/substrate-adapters.md`, README copy). GoF Adapter pattern is genuinely accurate — same Soma interface, different substrate implementations. Pairs naturally with [[substrate]] as a noun pair. Renaming would be expensive and gain only metaphor cohesion; Soma already mixes biological and engineering vocabulary without harm.

---

## context

Bytes that enter the LLM's context window during a session. Nothing else.

> "At session start, the substrate loads the relevant parts of the [[projection]] into the LLM's **context**. Soma now has [[presence]] in the substrate."

**Not synonyms in this glossary:**
- Do not use `context` to mean Soma source data → say [[Soma]].
- Do not use `context` to mean an adapter's output artifact → say [[projection]].
- Do not use `context` to mean the on-disk projection files → say "projection files".

**Cleanup mapping (old fuzzy term → new canonical):**

| Old | New |
| --- | --- |
| `SomaContextBundle` | `Projection` |
| `SomaContextInput` | `ProjectionInput` |
| `buildContext`, `buildCodexContext`, `buildClaudeCodeContext`, `buildPiDevContext` | `project`, `projectCodex`, `projectClaudeCode`, `projectPiDev` |
| "Soma context" (as source) | "Soma" or "Soma source" |
| "context rendering" | "projection" |
| "context files" (on disk) | "projection files" |
| "context window" / "loaded context" | "context" (kept) |

**The clean chain:** [[Soma]] → [[project|projection]] → context → [[presence]].

Source on disk projects into a projection artifact. The substrate loads the projection into the LLM's context. Soma now has presence in a running session.

**Why:** `context` was the most-overloaded word in the codebase (three meanings: Soma source, projection artifact, LLM context window). Reserving it for the LLM-window sense aligns Soma with industry usage (everyone calls the model's working memory "context") and frees [[projection]] to own the artifact sense without competition.

---

## portable, substrate-neutral, substrate-native

Three adjectives, three distinct meanings. Each answers a different question.

| Adjective | Applies to | Meaning | Question it answers |
| --- | --- | --- | --- |
| **portable** | [[Soma]] source | Same bytes work for every [[adapter]] | "Can it move?" |
| **substrate-neutral** | Kernel, types, core code | Depends on no substrate primitive | "Does it depend on anything substrate-specific?" |
| **substrate-native** | [[project|projection]] output, adapter outputs | Shaped to one specific substrate's primitives | "Is it shaped for one substrate?" |

The clean sentence:
> Soma is **portable**. The kernel is **substrate-neutral**. A projection is **substrate-native**.

**Not synonyms — killed from glossary:**
- `substrate-portable` → just `portable`
- `substrate-safe` → say what it means explicitly ("does not leak between substrates", "scrubs principal-only data")

**Adjacent but distinct (kept):**
- `filesystem-native` — about storage shape (plain files vs database), not portability. Independent axis.

**Why:** Three real concepts had collapsed across five words across docs. Locking one adjective per concept makes claims falsifiable ("this code depends on Claude Code's hooks → not substrate-neutral").

---

## Lifecycle verbs: install, reproject, upgrade, load, uninstall

Five verbs for five distinct lifecycle events. No overlap.

| Verb | Who triggers | What happens |
| --- | --- | --- |
| **[[install]]** | Principal (CLI) | First-time setup. Adapter projects Soma into substrate home. |
| **reproject** | Soma (on source change) or Principal (CLI) | Re-emits the projection because Soma source changed. Adapter projects again over the existing projection. |
| **upgrade** | Principal (CLI) | New Soma or adapter version. Migrates and reprojects. |
| **load** | Substrate (at session start) | Substrate reads the projection into the LLM's [[context]]. Soma now has [[presence]]. |
| **uninstall** | Principal (CLI) | Adapter removes its projection from the substrate. |

The lifecycle reads:
> Principal **installs** Soma into Codex → [[adapter]] **projects** → projection exists on disk. Principal edits Telos → Soma **reprojects** → updated projection on disk. Codex session restarts → substrate **loads** the projection → Soma has fresh presence. New Soma version released → principal runs `soma upgrade codex` → adapter **upgrades** and reprojects. Principal runs `soma uninstall codex` → adapter removes the projection.

**Not synonyms — killed from glossary:**
- `sync`, `rebuild`, `refresh`, `regenerate` → `reproject`
- `migrate`, `republish`, `bump` → `upgrade`
- `rehydrate`, `wake`, `rebind`, `activate` → `load`
- `remove`, `detach`, `purge` → `uninstall`

**Why:** Without these verbs, the glossary was silent on the lifecycle and prose was inconsistent. `reproject` composes naturally with [[project]]. `upgrade` is user-familiar. `load` is passive because the substrate does it, not Soma — preserves the agency direction. `uninstall` is symmetric to `install`.

---

## skill

A Soma capability [[compartment]] entry. Portable folder containing `SKILL.md`, workflows, tools, examples, references. Lives under `~/.soma/skills/<name>/`.

**Soma's canonical, unqualified term.** Whenever `skill` appears in Soma docs or code without a qualifier, it means a Soma skill.

### Substrate-native equivalents (always qualified)

A Soma skill projects into a substrate's own capability primitive. Each is a distinct concept and must carry the substrate qualifier:

| Soma | Substrate-native projection target | Qualified term |
| --- | --- | --- |
| skill | Claude Code's `~/.claude/skills/` entries | **Claude Code skill** |
| skill | Pi.dev's extension-advertised `SKILL.md` | **Pi.dev skill** |
| skill | Codex's AGENTS.md / plugin instruction fragments | **Codex instruction** (Codex has no native skill primitive) |
| skill | Compass governance entries | **Compass SOP** |

### Naming the projected output

A [[project|projection]] of the Skills compartment is a **skill projection**.

To talk about a specific skill in a specific substrate's projected shape, use a possessive: **"the skill's Claude Code projection"** (not "Claude Code skill projection" — ambiguous).

**Hard rule:** Never use `skill` for anything other than a Soma skill. If you mean a substrate-native one, qualify it. Always.

**Why:** Three different substrates call their capability primitive "skill" (or near-equivalent), and Soma also calls its capability primitive "skill". Without a hard rule, prose drifts and readers can't tell which "skill" the writer means. Locking unqualified `skill` to Soma — and forcing qualifiers everywhere else — makes every reference unambiguous on first read.

---

## Runtime modes: home, workspace, library, daemon, export

Where Soma's [[project|projection]] lives or runs from. Five modes, one-word names, no "Mode" suffix in glossary.

| Mode | What it means | Who invokes |
| --- | --- | --- |
| **home** | Projection lives in substrate's home dir (`~/.claude/`, `~/.codex/`, `~/.pi/`). Available by default in every session in that substrate. **Primary mode.** | Principal via `soma install <substrate>` |
| **workspace** | Projection lives in the current workspace (`./.claude/soma/`, `./.codex/soma/`). Only present when principal is in that workspace. **Overlays** the home projection if both exist. | Principal via `soma install <substrate> --workspace` |
| **library** | Soma loaded as code by a substrate CLI; no projection on disk. Substrate owns the process. | Other code |
| **daemon** | Soma runs as a long-lived process subscribing to Myelin subjects. No substrate involved. | Principal via `soma daemon` |
| **export** | Generate projection bytes to stdout or a tarball without writing them anywhere or running anything. Dry-run/inspection shape. | Principal via `soma export <substrate>` |

**Precedence rule:** workspace overlays home. If both projections exist, workspace files take precedence inside that workspace.

**Why one-word names:** "Home Install Mode" collided with the locked [[install]] verb. Short one-word nouns (`home`, `workspace`, `library`, `daemon`, `export`) read as flags or commands directly and avoid suffix noise. The "Mode" suffix is allowed in prose only when ambiguity would arise (rare).

---

## agent (always qualified, never bare)

`agent` is **banned bare** in Soma docs and code. It already carries at least three distinct meanings across nearby systems; adding a fourth from Soma would make every reference ambiguous.

| Qualified phrase | Means |
| --- | --- |
| **Codex agent** | The OpenAI Codex coding-agent surface — the substrate's user-facing process |
| **Claude Code sub-agent** | Short-lived task spawned via Claude Code's `Agent` tool |
| **Cortex agent** | Long-lived daemon subscribing to Myelin subjects |
| **AI agent** | Loose industry term — allowed in README hero copy only, banned in `docs/` and `src/` |
| bare `agent` | **Banned.** Always qualify. |

### Layer split: assistant ↔ agent

The two nouns name different layers, both required.

- **[[assistant]]** — the persistent-across-substrates named being defined by Soma (e.g., Ivy). Lives in Soma, not in any one substrate.
- **agent** (qualified) — the substrate-bound process or surface that hosts a session.

> "An assistant (e.g., Ivy) is a named being defined by Soma. It can run inside any substrate's agent surface (Codex agent, Claude Code, Pi.dev). It can also run as its own Cortex agent (daemon mode). Same assistant, different agent surfaces."

**Why:** `agent` is the single most-overloaded word in the agentic-systems ecosystem. Locking it as always-qualified, never-bare, prevents Soma from adding to the confusion and forces every reference to name *which* agent surface is meant. The assistant↔agent layer split makes it possible to talk about "the same assistant in a different substrate" without contradiction.

---

## writeback, write back, writeback gate, mirror

The reverse direction: [[substrate]] → [[Soma]]. Symmetric to [[project|projection]].

| Term | Part of speech | Meaning |
| --- | --- | --- |
| **writeback** | noun (one word) | A substrate-originated mutation that lands in Soma. |
| **write back** | verb (two words) | To perform a writeback. The [[adapter]] writes back. |
| **writeback gate** | noun | The [[Policy]] check the adapter applies before letting a substrate-side change touch Soma source. |
| **mirror** | verb | Passively reflect substrate-side state into Soma (e.g., Cortex task state in `MEMORY/STATE/`) without authority to mutate the substrate. Distinct from writeback because mirror is passive read-only reflection. |

### The closed loop

> Soma **projects** into the substrate (one-way). The adapter performs the projection. The substrate **loads** the projection into [[context]]. The [[assistant]] gains [[presence]]. During the session, the assistant captures learnings and updates ISA; the adapter **writes back** through the **writeback gate** into Soma. On the next session, Soma reprojects with the new state. Substrate-side state Soma doesn't author is **mirrored** into `MEMORY/STATE/`.

This makes Soma a closed loop, not a one-way pipe.

**Not synonyms — killed from glossary:**
- `sync` — bidirectional and fuzzy; replace with `project` (one-way) plus `writeback` (one-way).
- `push back`, `flush`, `commit` (when used for substrate → Soma) → `writeback`.
- `pull`, `fetch` (when used for substrate-state reflection) → `mirror`.

**Why:** Without symmetric vocabulary, the bidirectional reality leaked through `sync`, `update`, `flush`, `push` — none precise. `writeback` already appears in `docs/writeback-and-policy.md` so the term has prior art in the vault. The writeback gate makes Policy's role explicit: trust governs what may flow back from where. `mirror` separates passive reflection from authored mutation — different trust models apply to each.

---

## eager, indexed, on-demand (loading tiers)

Three adjectives describing how a piece of a [[project|projection]] enters the LLM's [[context]] window at session start.

| Tier | Adjective | Behaviour | Typical use |
| --- | --- | --- | --- |
| 1 | **eager** | Loaded into context at every session start. | Identity profile, active Telos, current ISA. Cheap, small, identity-defining. |
| 2 | **indexed** | A compact **registry** is eager; **bodies** load on demand when invoked. | Skills compartment by default. |
| 3 | **on-demand** | Nothing loads until the assistant explicitly retrieves it (search, read, query). | Memory archives, past learnings. |

### Structural nouns

- **registry** — the eager index entry that names what is available without loading the body. (Used in `docs/progressive-skill-loading.md` already.)
- **body** — the full content of an indexed item, fetched on demand. Examples: "skill body", "ISA body".
- **resident** — informal: a piece of the projection currently in the LLM context for this session. Used for runtime talk only; not a tier name.

### Sentence shape

> The Identity compartment projects **eagerly**. Skills project as an **indexed** registry; skill bodies are **on-demand**. Memory projects as an eager index with **on-demand** retrieval for store contents.

**Not synonyms — killed from glossary:**
- `default availability` (currently a doc title) → use `eager` when meaning "loaded by default", or `indexed` when meaning "named in the registry".
- `lazy` — banned to avoid the `lazy` / `on-demand` synonym fight.
- `progressive loading` — keep as document title (familiar engineering phrase) but in prose say "indexed with on-demand bodies".
- `available` — too vague; pick the precise tier.

**Why:** Without these adjectives, the projection sounded monolithic ("everything gets projected") when reality is layered. The three tiers are observable (you can check what is in context at session start) and falsifiable (a file that loaded eagerly when its glossary tier says on-demand is a bug). Locking them prevents the slide back into "default availability" hand-waving.

---

## private, protected, generated (data adjectives)

Three adjectives that classify a piece of Soma or [[project|projection]] data. Each answers a different question.

| Adjective | Locked meaning | Question it answers |
| --- | --- | --- |
| **private** | Belongs to the [[principal]]. Never appears in the public Soma repo. Never appears in a projection unless [[Policy]] clears it. | "Who is allowed to see this?" |
| **protected** | Cannot be destructively mutated (delete, move, overwrite) without explicit override. | "Who is allowed to destroy this?" |
| **generated** | Derived from Soma source. Safe to overwrite on [[reproject]]. Not authoritative. | "Is this authoritative, or derivable?" |

### Locked sentences

- "Identity is **private** and **protected**."
- "A projection is **generated**."
- "Memory stores are **private** and **protected**."
- "`events.jsonl` is **private**, **protected**, and append-only."

### Filesystem roots

- **private root** — filesystem root containing private content. Examples: `~/.soma/profile`, `~/.soma/memory`, `~/.codex/memories/soma/`, `~/.pi/agent/soma/`, Claude memory roots under `<claude-home>/memory` / `memories` / `PAI/MEMORY`. Listed in `docs/private-source-guard-v0.md`.
- **protected root** — filesystem root containing protected content. Largely overlaps with private roots; the distinction matters for the path guard (`policy-path-guard.ts`), which permits writes inside protected roots but blocks destructive operations against them.
- **public root** — any filesystem path that is neither private nor protected. Safe destination for non-private derivative content (e.g., `./README.md` of a public repo).

**Not synonyms — killed from glossary:**
- `principal-only` → `private`.
- `durable` (used as a privacy/protection adjective) → say `protected` for non-destructibility, or "source of truth" for authoritativeness.
- "private context surface" → "private projection".

**Why:** Five overlapping adjectives (`private`, `protected`, `principal-only`, `durable`, `generated`) had drifted across three doc files. Each was doing slightly different work but readers couldn't tell which. Locking three orthogonal adjectives (visibility / destructibility / authoritativeness) makes every policy statement falsifiable.
