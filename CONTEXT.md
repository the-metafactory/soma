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

## inbound security decision

A [[Policy]] decision about whether externally sourced content may enter substrate context from an [[untrusted root]].

Allowed decisions are `ALLOWED`, `BLOCKED`, and `HUMAN_REVIEW`. Content scanners may provide evidence, but Policy owns the decision and its audit semantics. Override, human approval, and human rejection are workflow events around the decision, not additional decision values.

**Not synonyms:** Do not use `filter result` to mean the Policy decision. A filter result is scanner evidence; an inbound security decision is Soma's authorization outcome.

**Why:** Soma integrates scanners without letting scanner-specific vocabulary become the core policy model. The same decision must project into substrates with different enforcement capabilities.

---

## inbound content scanner

A replaceable scanner that evaluates externally sourced content and returns evidence for an [[inbound security decision]].

An inbound content scanner does not decide Policy, write audit events as the source of truth, or define substrate enforcement semantics. Those remain Soma responsibilities.

**Not synonyms:** Do not call this the `content-filter` layer. `@metafactory/content-filter` may implement the scanner interface, but the interface is Soma-owned.

**Why:** Keeps PAI-shaped library vocabulary out of Soma's core policy model while still allowing a public scanner package to do the detection work.

---

## policy enforcement level

An adapter-declared statement of how strongly a substrate can apply a Soma [[Policy]] rule at runtime.

Allowed levels are `enforced`, `advisory`, and `ingress-gated`. `enforced` means the substrate can synchronously block the action. `advisory` means Soma can project rules or instructions but cannot reliably block. `ingress-gated` means Soma can block content before it becomes a routed artifact, even if it cannot control every editor or tool read.

**Not synonyms:** Do not use `supported` to imply enforcement. A supported policy may still be advisory on a substrate.

**Why:** Soma has one policy model, but substrate enforcement varies. Naming the enforcement level prevents projection docs from overclaiming uniform behavior.

---

## security trace

A detailed private [[Memory]] artifact for security review, override workflow, and incident reconstruction.

Security traces live under `memory/SECURITY/`. They may expand on an [[observability event]], but the normalized cross-substrate event stream remains `memory/STATE/events.jsonl`.

**Not synonyms:** Do not call a security trace a transcript. Do not use `SECURITY/` as the canonical event stream.

**Why:** Security work needs richer review material than a minimal event, but Soma's cross-substrate continuation contract depends on bounded append-only events in `STATE/events.jsonl`.

---

## allowed content reference

A Soma-owned reference that lets externally sourced content enter context after an [[inbound security decision]] allows a specific content hash.

The source file may remain in an [[untrusted root]]. Trust attaches to the referenced content hash, origin metadata, scanner evidence, and decision record; it does not attach permanently to the mutable source path.

**Not synonyms:** Do not say the original file is "trusted" after it passes. Say Soma created an allowed content reference for a specific version of that content.

**Why:** Inbound security must preserve provenance across substrates and prevent "allowed once" from becoming "trusted forever" after source mutation.

---

## acquisition gate

A [[Policy]] gate that routes externally sourced content into an [[untrusted root]] where the substrate can enforce or encourage that routing.

The acquisition gate applies before content becomes a local file or routed artifact. It is separate from the [[context-entry gate]] because acquisition routing does not prove the content is safe to read.

## context-entry gate

A [[Policy]] gate that evaluates externally sourced content before it enters substrate context.

The context-entry gate uses scanner evidence to produce an [[inbound security decision]] and, when allowed, an [[allowed content reference]]. It applies even when content already exists in an [[untrusted root]].

**Why:** Inbound security has two different jobs: keep external bytes in a known place, and decide whether specific bytes may enter context. Collapsing them hides bypass paths.

---

## inbound security config

The Soma [[Policy]] configuration that names [[untrusted root|untrusted roots]], scanner settings, and substrate projection inputs for inbound-content security.

Adapters render substrate-native hook, extension, rules, or ingress settings from inbound security config. Scanner package config paths and environment variables are implementation details, not the canonical Soma configuration surface.

**Why:** Policy must stay Soma-owned even when a scanner or substrate hook has its own config format.

---

## inbound security failure

A failure while applying an [[acquisition gate]], [[context-entry gate]], or [[inbound content scanner]].

At the context-entry gate, inbound security failures are `BLOCKED` decisions with explicit reasons such as `scanner_error`. At the acquisition gate, malformed enforceable configuration blocks; unavailable enforcement must be declared in the adapter's [[policy enforcement level]] instead of silently pretending to enforce.

**Not synonyms:** Do not describe failure as "allow by default" for content inside an [[untrusted root]]. Fail-open behavior must be a substrate limitation stated by enforcement level, not hidden inside the policy model.

**Why:** Security failures must be observable and conservative without overclaiming uniform substrate enforcement.

---

## runtime policy inspection

A Soma [[Policy]] evaluation of runtime substrate activity before, during, or after that activity is allowed to affect the session.

Runtime policy inspection may evaluate prompts, tool calls, permission requests, configuration changes, or task/assistant-work events. Substrate hooks, extensions, MCP gates, or daemon dispatchers may invoke it, but they are projection mechanisms, not the core concept.

Runtime policy inspection surfaces are `prompt`, `tool_call`, `permission_request`, `config_change`, and `governance_event`.

**Not synonyms:** Do not call the Soma core concept a `hook`. Hooks are substrate-native projection mechanisms.

**Why:** Soma needs one policy vocabulary that can project into Claude Code hooks, Codex hooks, Pi.dev extensions, Cursor rules, and Cortex/Myelin gates without making Claude's hook model canonical.

---

## tool_call

A [[runtime policy inspection]] surface for a proposed or observed tool invocation, including bounded metadata such as tool name, command shape, target paths, and substrate-provided arguments.

Tool-call inspection is for concrete tool activity. Use [[governance event|governance events]] for task requests, skill invocations, and qualified assistant-work delegation unless the substrate exposes only a generic tool surface.

**Why:** Runtime policy needs to distinguish concrete tool execution from assistant-work coordination so governance rules do not become fragile command parsers.

---

## governance event

A [[runtime policy inspection]] surface for proposed, started, or completed assistant-work control events: task requests, skill invocations, and qualified substrate-assistant delegations.

Governance events describe control-plane activity around work, not the content of the work itself. A governance event may ask whether a task request is too vague, whether a skill invocation appears false-positive, whether a Claude Code sub-agent launch should be nudged to background execution, or whether a Cortex agent dispatch should be observable before it starts.

**Not synonyms:** Do not use bare `agent event`. Do not collapse governance events into [[tool call|tool_call]] unless the substrate exposes only a generic tool surface. Do not use `governance_event` for config auditing; that is `config_change`.

**Why:** PAI's governance hooks mixed task quality, skill invocation, and Claude sub-agent execution behavior. Soma needs a portable policy surface that can classify those behaviors without importing Claude-only nouns.

---

## assistant-work event

A substrate-neutral event about work being requested, delegated, started, stopped, or bounded for the [[assistant]].

Assistant-work events include task requests, Soma skill invocations, substrate skill invocations, and qualified substrate-assistant delegations such as a Claude Code sub-agent run or Cortex agent dispatch. They are the input family for [[governance event]] inspection.

**Not synonyms:** Do not shorten this to `agent event`. Use qualified terms such as `Claude Code sub-agent` or `Cortex agent` when naming substrate-native primitives.

**Why:** Governance needs to talk about work coordination without turning the overloaded word `agent` into a Soma core noun.

---

## principal prompt inspection

A [[runtime policy inspection]] of a prompt submitted by the [[principal]].

Principal prompt inspection may detect security-disable requests, exfiltration intent, encoded payloads, or instruction-override patterns in the submitted prompt. It is not [[inbound security decision|inbound security]] unless the prompt causes externally sourced content to be acquired or read.

**Not synonyms:** Do not classify the principal's prompt itself as content from an [[untrusted root]]. If the prompt references an external artifact, that artifact is governed by inbound security when acquired or read.

**Why:** PAI's `PromptGuard` protected the live prompt boundary. Soma keeps that protection, but separates it from the external-content model introduced for #250.

---

## inspector

A check that contributes findings to a [[runtime policy inspection]].

An inspector may be deterministic or model-backed. It does not own the final policy decision, audit contract, or substrate enforcement semantics.

**Not synonyms:** Do not use `inspector` to mean the substrate wrapper that invokes Policy. The wrapper is an adapter projection; the inspector is the check inside Soma Policy.

**Why:** PAI's security pipeline had useful inspector decomposition, but Soma keeps the decision and projection boundaries explicit.

---

## runtime policy decision

The outcome of a [[runtime policy inspection]].

Allowed decisions are `allow`, `deny`, `ask`, and `alert`. `allow` means no policy objection. `deny` means block where the substrate can enforce. `ask` means require principal approval where the substrate supports approval. `alert` means allow while recording or surfacing a warning. Alert handling is surface-specific: some alerts should enter model context, while audit and config alerts may only write events or traces.

When a substrate cannot ask the principal synchronously, `ask` degrades by [[policy enforcement level]]: enforceable surfaces without approval support treat it as `deny`; advisory surfaces treat it as `alert` and record that approval was unavailable.

**Not synonyms:** Do not use `require_approval` as the Soma term. That is PAI and Claude Code hook vocabulary. Do not use the uppercase [[inbound security decision]] values for runtime policy inspections.

**Why:** Runtime policy needs an advisory path and a principal-approval path in addition to allow/deny, but the terms must stay substrate-neutral.

---

## runtime policy failure

A failure while performing a [[runtime policy inspection]].

Runtime policy failures are interpreted by surface. Enforceable pre-action gates fail closed when the core evaluator cannot produce a trustworthy decision. Advisory, audit, and recovery surfaces fail soft by recording the failure where possible and allowing the substrate activity to continue.

**Not synonyms:** Do not say "security always fails closed" without naming the surface. Do not hide fail-open behavior inside an inspector.

**Why:** A broken pre-tool gate can permit unsafe action, while a broken audit trace should not freeze normal work. Soma needs explicit failure semantics per runtime surface.

---

## runtime policy config

The Soma [[Policy]] configuration that defines deterministic rules for [[runtime policy inspection]].

Runtime policy config may describe command, path, prompt, permission, config-change, or governance-event rules. It is Soma-owned; PAI file names such as `PATTERNS.yaml` are source material, not canonical Soma vocabulary.

**Why:** Soma should preserve the useful PAI rule capability without importing PAI's file layout or names as the policy model.

---

## runtime policy rules

Principal-authored natural-language rules used by explicitly enabled model-backed [[inspector|inspectors]].

Runtime policy rules complement deterministic [[runtime policy config]]. They do not override deterministic denies and are not enabled implicitly just because a rules file exists.

**Not synonyms:** Do not call these `SECURITY_RULES.md` in Soma core. That is a possible imported source name, not the canonical term.

**Why:** Natural-language rules are useful for principal intent, but model-backed policy must be clearly separated from deterministic policy.

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
- `republish`, `bump` → `upgrade`
- `rehydrate`, `wake`, `rebind`, `activate` → `load`
- `remove`, `detach`, `purge` → `uninstall`

**Why:** Without these verbs, the glossary was silent on the lifecycle and prose was inconsistent. `reproject` composes naturally with [[project]]. `upgrade` is user-familiar. `load` is passive because the substrate does it, not Soma — preserves the agency direction. `uninstall` is symmetric to `install`.

---

## migrate (system-to-system orchestration)

Distinct from [[upgrade]] (same system, new version). **`migrate`** is the orchestration verb for moving ownership of an existing personal-AI installation from one system-of-record into Soma. The canonical case today is `soma migrate pai` — wrapping `importPaiIdentity` + `importAlgorithm` + per-pack `importPaiPack` + (forthcoming) memory import + doc import into one principal-facing command.

| Term | Direction | Scope |
| --- | --- | --- |
| **[[import]]** (verb, existing) | external source → Soma | one artifact (one pack, one identity file, one algorithm) |
| **migrate** | external system → Soma | full orchestration: multiple imports + structural alignment + manifest |
| **[[upgrade]]** | Soma → Soma (or adapter → adapter) | new version of same thing |

**Why both `import` and `migrate`:** import is the unit; migrate is the orchestration. A user running `soma import pai-pack ...` brings one skill in. A user running `soma migrate pai` brings their whole PAI installation in. Conflating them loses the principal-facing simplicity of "I want to move from PAI to Soma" as one verb.

**Why `migrate` is no longer killed:** an earlier glossary lock killed `migrate` as a synonym for `upgrade`, on the principle that "one canonical term per concept". After Soma adopted the [[Soma|new-canonical-home]] stance — Soma is the canonical home of personal AI state, PAI is the source system being moved out of — the verb describes a real, distinct operation that `upgrade` cannot. Reinstated with the sharper meaning above.

**Not synonyms — still killed:**
- `transfer`, `move`, `port`, `convert` → `migrate`

**Naming for future migrations:** `soma migrate <source-system>` where the source-system is the system being moved out of (e.g., `migrate pai`, future: `migrate cortex`, `migrate <other-personal-ai>`).

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

## home replication

The cross-machine exchange of eligible Soma home state between two local Soma
homes through an explicit remote transport.

Home replication is not [[project|projection]] and not [[writeback]]. Projection
makes Soma present inside a substrate. Writeback accepts a substrate-originated
mutation into Soma. Home replication exchanges already-Soma-owned files between
machines after scope checks, Policy checks, snapshots, and merge/conflict
rules.

The first transport is Git-backed, but Git is transport and audit history only.
Soma core owns path eligibility, privacy gates, append-only event merge,
session-keyed work-state merge, and durable-file conflict reporting.

**Not synonyms:** Do not call the core model `sync`, `bidirectional sync`, or
`live sync`. Use `replicate` / `home replication`.

**Why:** Issue #146 needs the same assistant to travel between machines without
turning a remote repository into the source of truth or weakening writeback
gates. A separate term keeps cross-machine exchange distinct from both
substrate projection and substrate writeback.

---

## work registry

The canonical Soma state that records active and historical work across substrates.

The work registry is Soma-native. It is not a PAI compatibility shim.

## session name registry

The canonical Soma state that maps substrate session identifiers to human-readable work names.

The session name registry is Soma-native. It is not a PAI compatibility shim.

## current-work pointer

The session-scoped Soma state file that points to the work currently being continued.

The current-work pointer is live continuation state, not a shutdown summary. It gives another substrate enough metadata to identify the active task, owning session, substrate, phase, progress, durable artifacts, and learning sources without reading a raw transcript.

The current-work pointer routes learning; it does not contain learning material directly.

## raw transcript source

A substrate-local directory or file set containing full session transcripts that Soma may harvest only when explicitly requested or adapter-declared.

Raw transcript sources are not default Soma state.

## observability event

A bounded structured event that records substrate activity for monitoring and continuation without storing full transcripts by default.

### Relationship

- A **work registry** entry may reference one or more substrate sessions.
- The **session name registry** gives those substrate sessions stable human-readable names.
- Durable work artifacts belong in the **Memory** compartment, not in substrate-local transcript stores.
- A **raw transcript source** may feed learning harvest, but only when the principal passes it explicitly or an adapter declares it as a policy-governed source.
- An **observability event** may point to work registry entries and artifacts, but it is not a transcript.

**Not synonyms:** Do not use `progress registry`, `session registry`, or `transcript registry` for the work registry. Do not use `session map` for the session name registry. Do not use `session directory` to mean raw transcript source unless the content is specifically full substrate transcripts. Do not use `event log` to imply full observability coverage; #165 only needs the minimal writeback event contract.

**Why:** Cross-substrate continuation needs one shared state model. PAI proved the work-registry shape; Soma adopts it as canonical state so Codex, Claude Code, Pi.dev, and Cortex can converge on the same continuation surface.

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
- **untrusted root** — filesystem root containing externally sourced content that [[Policy]] treats as untrusted until inbound security allows it into context. The default home-level untrusted root is `<soma-home>/memory/RAW/untrusted/`; workspace-level untrusted roots must be explicit [[inbound security config]]. Do not call this a sandbox unless the substrate-native enforcement actually isolates or routes access to the content.

**Not synonyms — killed from glossary:**
- `principal-only` → `private`.
- `durable` (used as a privacy/protection adjective) → say `protected` for non-destructibility, or "source of truth" for authoritativeness.
- "private context surface" → "private projection".

**Why:** Five overlapping adjectives (`private`, `protected`, `principal-only`, `durable`, `generated`) had drifted across three doc files. Each was doing slightly different work but readers couldn't tell which. Locking three orthogonal adjectives (visibility / destructibility / authoritativeness) makes every policy statement falsifiable.
