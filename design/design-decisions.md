# soma — Design Decisions

**Date:** 2026-05-17
**Authors:** Jens-Christian Fischer
**Status:** Living document — updated as decisions are made
**Format:** metafactory DD (lightweight ADR)

---

## How This Document Works

Each decision is numbered, dated, and linked to the discussion or research that informed it. Decisions are grouped by domain. Status values: **decided**, **superseded**, **open**.

`ISA.md` is the live source of truth for current scope and verification. DDs are the durable rule-record — the *why* behind decisions that future readers would otherwise have to reconstruct.

---

## 1. Boundary & Canonical Home

### DD-1: Soma is the new canonical home of personal AI state

**Status:** Decided (2026-05-17)

**Context:** Soma's mission is "substrate-portable Personal AI Assistant core" (per `ISA.md`, `CONTEXT.md`). A live migration path from PAI to Soma forced a foundational question: where does personal state *live*?

Three candidates surfaced:
- **(a) Soma is the new canonical home.** PAI's `~/.claude/` becomes a *projection* that Soma writes (via `soma install claude-code`). PAI conventions are translated to Soma's shape during import.
- **(b) Soma is a portable wrapper around PAI.** Soma mirrors PAI's structure. PAI conventions win where they conflict. Soma's existing memory/identity taxonomies adjust to match PAI's.
- **(c) Dual-write contract.** Soma and PAI both write to a shared "personal data" location via a write-through layer.

**Decision:** **(a)** — Soma is the canonical home. The `*core*` lives in Soma; substrates (Codex, Pi.dev, Claude Code) are projections of it. PAI becomes one substrate among several, projected into via the existing `soma install claude-code` verb.

**Rejected:**
- (b) would invert the stated mission — Soma would be a packaging tool, not the canonical home.
- (c) is genuinely powerful but introduces coupling that breaks Soma's "filesystem-native, no-daemon-required" principle. Tracked as a possible future direction; not a prerequisite.

**Implications:**
- Migration from PAI to Soma is fundamentally a **translation** (PAI memory taxonomy → Soma taxonomy, PAI skill format → Soma skill format), not a copy.
- Once migrated, PAI continues to work iff the user runs `soma install claude-code --apply` so Soma's projection covers PAI's runtime surface.
- The "perfect world" dual-write (`(c)`) is a deferred follow-on, not a blocker.

**Discussion:** `/grill-with-docs` session 2026-05-17 (Q6).

---

## 2. Memory Taxonomy

### DD-2: Adopt PAI v5.0.0 memory taxonomy wholesale, mark PAI-specific categories

**Status:** Decided (2026-05-17)

**Context:** Soma currently bootstraps 5 memory categories (`WORK`, `KNOWLEDGE`, `LEARNING`, `RELATIONSHIP`, `STATE`). PAI v5.0.0 canonical form has 19 categories — the above 5 plus 12 substrate-neutral (`OBSERVABILITY`, `SECURITY`, `SCRATCHPAD`, `BOOKMARKS`, `RESEARCH`, `PROJECT`, `WISDOM`, `VERIFICATION`, `DATA`, `RAW`, `REFERENCE`, `SKILLS`) plus 2 PAI-specific (`PAISYSTEMUPDATES`, `AUTO`).

PAI's v5.0.0 hooks actively write to several categories Soma does not bootstrap (`OBSERVABILITY`, `SECURITY` are referenced by `ToolActivityTracker.hook.ts`, `ConfigAudit.hook.ts`, `StopFailureHandler.hook.ts`, `TaskGovernance.hook.ts`). Soma's existing 5-category bootstrap is pre-v5.0.0 PAI taxonomy.

Three candidates:
- **(a) Wholesale** — adopt all v5.0.0 categories verbatim including PAI-specific ones.
- **(b) Substrate-neutral subset** — adopt the categories that have substrate-neutral meaning; skip `PAISYSTEMUPDATES`/`AUTO`; allow free-form extension.
- **(c) Wholesale + mark PAI-specific** — adopt all, tag PAI-bound categories in their READMEs.

**Decision:** **(c)** — wholesale adoption of v5.0.0 taxonomy, with READMEs in `PAISYSTEMUPDATES/`, `AUTO/`, and any other PAI-bound categories explicitly marking them as substrate-bound. Soma's canonical taxonomy includes both portable and substrate-bound categories; READMEs do the explanatory work.

**Rejected:**
- (a) wholesale-without-marking weakens Soma's portability claim by smuggling PAI-specific categories in unannotated.
- (b)'s purity is academic — every Soma user today is migrating from PAI; the PAI-specific categories will be populated regardless.

**Implications:**
- `SOMA_BOOTSTRAP_DIRECTORIES` in `src/install.ts` grows from 5 to 19 categories (14 new: 12 substrate-neutral + 2 PAI-bound).
- New entries each ship a `README.md` describing what belongs there. PAI-bound ones additionally state "this category is populated by the PAI substrate; portable Soma cores may leave it empty".
- No backcompat migration needed (pre-release per principal directive).
- The 1:1 alignment with v5.0.0 means PAI hooks writing to `MEMORY/SECURITY/...` resolve to `~/.soma/memory/SECURITY/...` cleanly after `soma install claude-code` projection.

**Discussion:** `/grill-with-docs` session 2026-05-17 (Q5, Q7).

---

## 3. Glossary

### DD-3: `migrate` reinstated for system-to-system orchestration

**Status:** Decided (2026-05-17)

**Context:** An earlier glossary lock (`CONTEXT.md` Q10) killed `migrate` as a synonym for [[upgrade]], on the principle of "one canonical term per concept". This conflicted with the existing CLI verb `soma migrate pai` (PR #67) and with the natural prose for moving an existing PAI installation into Soma.

After [[DD-1]] established Soma as the new canonical home, the verb describes a real, distinct operation that `upgrade` cannot:
- `upgrade` = same system, new version
- `migrate` = move ownership from one system-of-record to another

Three candidates:
- **(a) Rename CLI to `soma import pai`** — drop `migrate` entirely, subsume into existing `import` verb.
- **(b) Un-ban `migrate`** with sharper meaning.
- **(c) Keep `migrate pai` as legacy alias** while building forward under `import`.

**Decision:** **(b)** — `migrate` reinstated with sharper meaning. Glossary updated inline (`CONTEXT.md` new `## migrate (system-to-system orchestration)` section).

| Term | Direction | Scope |
| --- | --- | --- |
| **import** | external source → Soma | one artifact (one pack, one identity file, one algorithm) |
| **migrate** | external system → Soma | full orchestration: multiple imports + structural alignment + manifest |
| **upgrade** | Soma → Soma (or adapter → adapter) | new version of same thing |

**Rejected:**
- (a) loses the principal-facing simplicity of "I want to move from PAI to Soma" as one verb.
- (c) keeps two names for one concept — drift later; principal directed "no backcompat worry pre-release" so cleaner to commit to one verb.

**Killed synonyms (still banned):**
- `transfer`, `move`, `port`, `convert` → `migrate`

**Naming for future migrations:** `soma migrate <source-system>` where `<source-system>` is the system being moved out of (`migrate pai`, future: `migrate cortex`, `migrate <other-personal-ai>`).

**Supersedes:** `CONTEXT.md` line 235 ("`migrate`, `republish`, `bump` → `upgrade`") — `migrate` removed from that kill-list; `republish` and `bump` remain killed.

**Discussion:** `/grill-with-docs` session 2026-05-17 (Q8).

## 4. Adapter Install Facts

### DD-4: Adapters own install facts; installer owns lifecycle orchestration

**Status:** Decided (2026-05-22)

**Context:** Soma's install path had substrate-specific facts spread across the
installer, home projection, active ISA projection paths, private projection
roots, and adapter modules. Adding or changing a substrate required editing
multiple unrelated modules, which weakened locality and made install,
reproject, upgrade, and uninstall behavior harder to compare.

Three candidates surfaced:
- **(a) Central install registry.** Keep all substrate install facts in one
  installer-owned module.
- **(b) Adapter-owned install facts.** Each adapter exports its own install
  facts; the installer consumes them.
- **(c) Push full install behavior into adapters.** Each adapter owns planning,
  projection writing, lifecycle refresh, and uninstall behavior end to end.

**Decision:** **(b)** — adapter-owned install facts with installer-owned
orchestration.

Adapters own substrate-native facts: default home, projected file paths,
substrate-specific skill destinations, lifecycle projection paths, validators,
cleanup hooks, private projection roots, and uninstall targets. The installer
owns orchestration: bootstrapping Soma home, loading active ISA, running
lifecycle updates, writing projections, and applying the install, reproject,
upgrade, and uninstall verbs.

**Rejected:**
- (a) improves switch locality but keeps substrate-native knowledge far from
  the adapter code that defines the projection.
- (c) gives maximum adapter autonomy but makes adapters too deep in the wrong
  direction: they would own lifecycle and Soma home behavior that is
  substrate-neutral.

**Implications:**
- A future substrate should add an adapter-local install spec rather than
  editing scattered installer tables.
- Existing public per-substrate projection functions can remain as compatibility
  and test surface while sharing a generic internal install/projection path.
- The install spec stays internal until external/custom adapter installation
  needs a stable public API.
- Missing uninstall support should be represented explicitly as reserved install
  spec data, not hidden only in CLI branching.

**Discussion:** `/grill-with-docs` session 2026-05-22.

## 5. Shared Work State

### DD-5: Soma canonicalizes the PAI-style work registry

**Status:** Decided (2026-05-26)

**Context:** Issue #165 exposed a mismatch between Soma learning tools and
live PAI conventions. `soma learning harvest` had an implicit default
`memory/STATE/sessions/*.jsonl`, but current PAI v5 uses
`MEMORY/STATE/work.json`, `MEMORY/STATE/session-names.json`,
session-scoped current-work pointers, and durable
`MEMORY/WORK/<slug>/` artifacts as the continuation surface. PAI v5 no longer
treats full session transcripts as the primary memory model.

Three candidates surfaced:
- **(a) Preserve `STATE/sessions` as a Soma-native transcript store.**
- **(b) Invent a cleaner Soma-only registry and map PAI into it.**
- **(c) Canonicalize the PAI-style work/session registry in Soma.**

**Decision:** **(c)** — Soma adopts the PAI-style work/session registry as
canonical Soma state. `memory/STATE/work.json` is the **work registry** and
`memory/STATE/session-names.json` is the **session name registry**. They are
not compatibility shims. Current-work pointer filenames include a bounded safe
session token plus a hash suffix; adapters should resolve them through
`somaWorkRegistryPaths(..., sessionId).currentWork` rather than constructing
the filename by hand.

Raw transcript sources are explicit, adapter-declared, and policy-governed.
They are not default Soma state and `soma learning harvest` must not silently
scan an unproduced transcript directory.

Issue #165 should define the minimal writeback observability event that points
to updated state and artifacts. Full tool activity/failure observability remains
separate work, tracked by the observability feature area.

**Rejected:**
- (a) recreates an older PAI model that v5 intentionally moved away from and
  risks storing full private prompts/results by default.
- (b) is theoretically cleaner but creates unnecessary translation work and
  loses parity with the already-proven PAI continuation model.

**Implications:**
- Substrate adapters should converge on the same work registry and session name
  registry instead of inventing per-substrate continuation state.
- Learning harvest defaults should read canonical work state/artifacts or
  require an explicit raw transcript source.
- Session-end writeback should append a bounded observability event that names
  the state files and artifacts touched.
- Full transcript mirroring, if added later, needs an explicit policy gate.

**Discussion:** `/grill-with-docs` session 2026-05-26 for issue #165.

### DD-6: Core lifecycle owns the minimal current-work pointer

**Status:** Decided (2026-05-28)

**Context:** PAI v5 uses two live continuation surfaces. Hooks
deterministically maintain `MEMORY/STATE/work.json` and
`MEMORY/STATE/session-names.json` at prompt and ISA-sync boundaries, while the
Algorithm assistant is responsible for creating
`MEMORY/STATE/current-work-{sessionId}.json` during execution. Soma inherited
the file shape in DD-5, but the PAI ownership split is too Claude-specific for
a substrate-portable core.

Three candidates surfaced:
- **(a) Preserve PAI ownership.** The assistant/Algorithm writes the current-work
  pointer; hooks only consume it.
- **(b) Core lifecycle creates the minimal pointer; assistant/Algorithm enriches
  it through gated writeback.**
- **(c) Do not maintain a live current-work pointer; derive continuation from
  `work.json`, events, and artifacts on demand.**

**Decision:** **(b)** — Soma core lifecycle owns the minimal current-work
pointer. Adapters should create and refresh a metadata-only pointer from
deterministic session facts, prompt classification, phase/progress signals, and
artifact pointers. Assistant/Algorithm work may enrich the pointer only through
explicit writeback gates with deterministic merge rules.

**Rejected:**
- (a) works in PAI because Claude is heavily conditioned by the PAI harness, but
  makes cross-substrate continuation depend on model behavior instead of a
  system contract.
- (c) preserves less mutable state but fails the "another substrate can see
  live work before shutdown" requirement.

**Implications:**
- `memory/STATE/current-work-<token>-<hash>.json` is live continuation state, not
  a session-end summary. It should carry a top-level
  `schema: "soma-current-work-v1"` marker.
- Pointer status values are constrained to `active`, `idle`, `complete`, and
  `failed`.
- Bounded prompt-derived task metadata is allowed: task labels and session names
  may be generated from a prompt or classifier, but raw prompts, pasted bodies,
  full assistant outputs, and long user-provided content must not be stored in
  the pointer. Task labels should be single-line and capped.
- Session start and prompt classification should create or refresh the pointer
  before any Algorithm-specific artifact exists.
- Adapters should refresh the pointer at bounded semantic boundaries:
  `session_start`, prompt submission or before-agent-start classification,
  Algorithm/ISA updates, result/feedback/rating capture, pre-compaction, and
  session end. Routine tool calls should not refresh the pointer unless they
  create or update a known artifact or emit a bounded observability event.
- The pointer routes learning by naming learning sources such as events,
  ratings, feedback/result events, work artifacts, and optional raw transcript
  sources. It does not store learning material directly.
- Current-work pointer writes should use a dedicated core writer with
  deterministic merge semantics, path normalization, atomic file replacement,
  and internal policy checks. They should not require loosening the generic
  event-only writeback gate for arbitrary durable memory writes.
- Session end should mark the registry entry complete and may leave or archive
  the current-work pointer as a historical session snapshot; it should not
  delete the pointer immediately, and it should not be the first time the
  pointer appears.
- The first implementation slice should deliver the core pointer type/writer and
  Codex/Pi.dev lifecycle integration. Learning harvest improvements should
  follow after live continuation is deterministic.
- The pointer remains metadata-only by default. Full prompts, full results, and
  raw transcripts require separate policy-gated raw transcript sources.

**Discussion:** `/grill-with-docs` session 2026-05-28, checked against
`~/work/PAI/Releases/v5.0.0`.

## 6. Policy & Security

### DD-7: Soma owns inbound-content security; scanners provide evidence

**Status:** Decided (2026-05-29)

**Context:** Issue #250 asks Soma to integrate
`@metafactory/content-filter` as an inbound-content security layer. The
library came from the PAI collaboration security model and still carries some
PAI-shaped vocabulary and configuration surface. Soma is replacing PAI as the
canonical assistant body, so copying PAI hooks or letting a scanner package
define Soma Policy would invert the ownership model from DD-1.

Three candidates surfaced:
- **(a) Port the content-filter hooks directly.** Keep the library's sandbox and
  hook semantics as the implementation contract.
- **(b) Wrap content-filter in a Soma-owned inbound security model.** Soma owns
  Policy, decisions, audit, provenance, config, and projection; scanner
  packages provide evidence.
- **(c) Reimplement detection in Soma with no scanner dependency.** Avoid the
  library boundary and keep all inbound security code local.

**Decision:** **(b)** — Soma owns inbound-content security; scanners provide
evidence. The canonical model is:
- Externally sourced content lands in an **untrusted root**. The default
  home-level root is `<soma-home>/memory/RAW/untrusted/`; workspace roots are
  explicit Policy config.
- Inbound security has two separate gates: an **acquisition gate** that routes
  external content into an untrusted root where possible, and a
  **context-entry gate** that decides whether specific bytes may enter context.
- The scanner boundary is a Soma-owned `InboundContentScanner` interface.
  `@metafactory/content-filter` may implement that interface after it is
  released as a package, but its config paths, env names, and hook semantics do
  not become Soma's public Policy surface.
- Soma's core inbound decision values are `ALLOWED`, `BLOCKED`, and
  `HUMAN_REVIEW`. Override, human approval, and rejection are workflow events
  around a decision, not additional core decision values.
- Allowed content enters context through an **allowed content reference** bound
  to content hash, origin metadata, scanner evidence, and decision record. The
  original path does not become permanently trusted.
- `memory/STATE/events.jsonl` receives the normalized append-only observability
  event. `memory/SECURITY/` receives richer private security traces. Neither
  mirrors raw external content by default.
- Adapters must declare a **policy enforcement level** for inbound security:
  `enforced`, `advisory`, or `ingress-gated`. Uniform enforcement remains a
  goal, not a current fact.
- Context-entry failures fail closed as `BLOCKED` decisions with explicit
  reasons. Acquisition enforcement gaps must be declared by enforcement level;
  malformed enforceable config blocks.

**Rejected:**
- (a) would reintroduce PAI as the de facto policy authority and overfit the
  integration to Claude-style hook mechanics.
- (c) throws away a public scanner package that is already designed for this
  threat class. Soma should not duplicate scanner work when the boundary can be
  cleanly owned by Policy.

**Implications:**
- #250 should ship as a core-first vertical slice: Policy-owned config,
  scanner interface, fake scanner tests, decision normalization, event/trace
  writes, allowed content references, and one enforceable substrate projection.
- Codex is the first enforceable projection because Soma already has a tested
  `PreToolUse` policy hook and target extraction path. Claude Code, Pi.dev,
  Cursor, and Cortex/Myelin follow via adapter-specific projections using the
  same core contract.
- The first CLI surface should extend `soma policy` rather than create a new
  top-level `security` command. Security traces are storage; Policy is the
  command domain.
- `HUMAN_REVIEW` blocks context entry in the first slice. Approval, override,
  revocation, and any interactive review UI are follow-up work with their own
  hash-bound policy.
- The production `@metafactory/content-filter` dependency should wait for a
  released package. Until then, Soma can implement and test the scanner
  interface without pinning a GitHub dependency or vendoring scanner code.

**Discussion:** `/grill-with-docs` session 2026-05-29 for issue #250.

### DD-8: Soma runtime policy inspection replaces PAI security hooks

**Status:** Decided (2026-05-29)

**Context:** Issue #251 tracks the PAI security hook behaviors not owned by
#250's inbound-content security model: tool-call policy, prompt/user-input
scanning, permission intelligence, config-change auditing, task/skill/substrate
assistant governance, and security event writeback. PAI implemented these as
Claude Code hook files (`SecurityPipeline.hook.ts`, `PromptGuard.hook.ts`,
`SmartApprover.hook.ts`, `ConfigAudit.hook.ts`, `TaskGovernance.hook.ts`,
`SkillGuard.hook.ts`, `AgentExecutionGuard.hook.ts`,
`StopFailureHandler.hook.ts`). Soma needs the behaviors where they are
portable, but must not make Claude hook mechanics the core model.

Three candidates surfaced:
- **(a) Port the PAI hooks as hook-equivalent files per substrate.** Keep PAI's
  hook names and behavior as the source model.
- **(b) Define a Soma runtime policy inspection model.** Soma owns inspection
  surfaces, inspectors, decisions, failure semantics, events, traces, and
  adapter projection; hooks/extensions/gates are substrate wrappers.
- **(c) Fold the remaining PAI security behavior into the existing path guard.**
  Extend `soma policy check` until it covers prompts, tool calls, permissions,
  config changes, and governance events.

**Decision:** **(b)** — Soma replaces PAI security hooks with a
Soma-owned runtime policy inspection model. The canonical model is:
- **Runtime policy inspection** is the Soma core concept. Hooks, extensions,
  MCP gates, and daemon dispatchers are substrate projection mechanisms.
- The canonical runtime inspection surfaces are `prompt`, `tool_call`,
  `permission_request`, `config_change`, and `governance_event`.
- The canonical runtime decision values are `allow`, `deny`, `ask`, and
  `alert`. `ask` degrades by policy enforcement level: enforceable surfaces
  without approval support treat it as `deny`; advisory surfaces treat it as
  `alert` and record that approval was unavailable.
- Runtime policy failures are surface-specific. Enforceable pre-action gates
  fail closed when the core evaluator cannot produce a trustworthy decision.
  Advisory, audit, and recovery surfaces fail soft by recording the failure
  where possible.
- Principal prompt inspection belongs to runtime policy, not #250 inbound
  security. A principal prompt may contain suspicious text, but it is not
  content from an untrusted root unless it causes external content to be
  acquired or read.
- Runtime policy uses the same event/trace split as DD-7:
  `memory/STATE/events.jsonl` gets normalized events, while `memory/SECURITY/`
  gets detailed private security traces. Raw prompts, full tool inputs, command
  output, and transcripts are not mirrored by default.
- Soma-owned runtime policy config replaces PAI `PATTERNS.yaml` as canonical
  vocabulary. Optional principal-authored runtime policy rules replace PAI
  `SECURITY_RULES.md` as the Soma term.

**Rejected:**
- (a) would preserve PAI's Claude-specific hook architecture and make
  cross-substrate behavior a porting problem rather than a Soma Policy model.
- (c) overloads the existing path/private-source guard. Runtime inspection has
  different inputs, surfaces, decisions, and failure semantics, so it should
  use `soma policy inspect` rather than stretching `soma policy check`.

**Implications:**
- #251's first implementation slice should be core-first and Codex-first:
  runtime inspection types, deterministic inspectors, `soma policy inspect`,
  Codex `PreToolUse` and `UserPromptSubmit` integration, normalized events,
  security traces, and tests for `allow`, `deny`, `ask`, `alert`, malformed
  input, and fail-closed pre-action behavior.
- The first slice is deterministic-only for enforcement: path/private-root
  checks reuse existing Soma guard primitives; command inspection covers narrow
  egress and dangerous shell-composition patterns; prompt inspection covers
  security-disable, exfiltration-intent, encoded/evasion, and instruction
  override patterns.
- Model-backed inspectors are deferred and must be explicit opt-in (#256).
  Deterministic denies must remain higher priority than model-backed judgment.
- Governance events are reserved but deferred pending a terminology/modeling
  pass (#255).
- Broader deterministic command inspection is deferred (#257).
- Config-change auditing is reserved but deferred until the event/trace
  contract exists and per-substrate config surfaces are mapped (#258).
- Permission-request intelligence is reserved but deferred; Soma must not
  inherit PAI's broad trusted-prefix defaults (#259).
- Alert handling is surface-specific. Prompt alerts may inject bounded context;
  tool-call/config alerts usually log or trace unless a substrate has a clean
  warning channel.

**Discussion:** `/grill-with-docs` session 2026-05-29 for issue #251.
