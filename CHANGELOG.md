# Changelog

All notable changes to Soma are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

## [0.17.0] - 2026-08-19

### Added

- **Communication contract (Identity compartment).** Section structure and part
  of the banned-phrase list are adapted (not copied) from
  [disler/fixing-smartass-opus-5](https://github.com/disler/fixing-smartass-opus-5), MIT.
  `~/.soma/profile/communication.md`
  governs how the assistant talks — positive/negative patterns, banned phrases,
  reference codes, aliases, and authored do/don't examples. `soma init` ships a
  generic starter; the file projects **verbatim** (no provenance header, no
  re-render) into all six substrates, and Pi.dev additionally reads it into the
  generated extension's system prompt, that substrate's native equivalent of an
  appended system-prompt file. Soma parses nothing out of the file: every
  section works by being read. Absent file → nothing projected, never a
  Soma-authored default.
- **Behavioral policy is wired (Policy compartment).** `~/.soma/policy/behavior.md`
  has existed since the 2026-07 PAI migration and no code under `src/`,
  `scripts/`, `test/`, or `docs/` referenced it — the file even carried its own
  note that substrate instruction files were carrying its rules by hand. It is now
  parsed by `src/policy/behavior-policy.ts` and merged into every adapter's
  policy-projection advisory list. The parser folds wrapped bullets and keeps
  prose-only sections, because the previous `sectionBullets` helper would have
  truncated every wrapped rule at its first line and dropped the two sections
  that state their rules as paragraphs.
- **Reference codes as run state.** `soma algorithm ref --code F1 --text ...` and
  `soma algorithm resolve --code D1 --verdict kept` (plus `ref:`/`resolve:` batch
  ops) make `keep D1` a write rather than a comment. `C` and `P` are reserved for
  VSA criteria and plan steps and are refused; codes are unique within a run; `D`
  codes mirror into the run's decisions log rather than opening a parallel
  record. The reservation is enforced at the write path, not at contract-read
  time — a prose file on the home-load path must never be able to fail
  `install` or a hook. `AlgorithmRun.references` is additive and defaulted by the store — no
  schema-version bump, and pre-existing runs load with an empty list.
- **Docs:** [docs/communication-and-behavior.md](docs/communication-and-behavior.md)
  covers both files, how each reaches a substrate, the behavioral-policy
  authoring rules, and the reference-code CLI.

## [0.16.1] - 2026-08-16

### Fixed

- **Quota-safe GitHub work-graph reads (#625, #629, #630).** The normal
  subtree query now has a deliberately bounded `20/3/3` fanout, with a tested
  predicted primary-rate cost of 8 points instead of roughly 414 for the former
  `50/25/10` shape. Parent edges use REST, and a recognizable GraphQL quota
  error restarts the complete subtree observation through paginated REST reads
  without mixing partial GraphQL state into the result. The fallback preserves
  depth-first traversal, blocker hydration, and cycle protection; unrelated
  GraphQL errors still surface.

  Pagination now asks `gh api` to slurp pages before flattening them, so callers
  receive one array across REST pages. The quota matcher also accepts the
  alternate `rate limit already exceeded` wording, which is covered by the
  backend regression suite.

## [0.16.0] - 2026-08-15

An **orienteer** release, driven by external feedback on 0.15.0: an adopter
charted a map, the map returned decisions that assumed a budget they did not
have, and there was no way to feed the missing parameter back in. Their own
words for it — *"a parameter my agents already know"* — name the gap precisely.
Their agents knew; the map never asked.

### Added
- **A `## Constraints` section on the map, and a charting pass that asks for one
  (#617, #619).** A constraint — no budget, a deadline, a runtime that cannot
  change — was previously homeless: not fog (it is not a question awaiting an
  answer), not out of scope (it is not past the destination), not a decision
  (nobody decided it). It landed in Notes, which nothing checks an answer
  against. It now sits beside the Destination, since the two together fix the
  effort's shape, and the test for what belongs there is whether an *answer*
  could violate it.

  `ChartTheMap` step 1 now asks what is fixed regardless of route, and seeds the
  question from the principal's own store (`soma memory recall`,
  `profile/purpose.md`) rather than only the conversation in front of it —
  degrading to simply asking where there is no Soma home, since orienteer runs
  in any repository. `WalkTheMap` reads the section as binding on the answer
  being written, and surfaces the *dimension* a constraint touches in the
  options it offers, so cost appears where the choice is made.

  Two limits stated rather than papered over. **Nothing enforces it**: no verb
  reads the section, the close gate does not test against it, `decisions
  --write` does not project it. It binds the way the Destination binds — by
  being read. And **constraints live on the map alone**; a node never restates
  one, or an amendment leaves stale copies behind.

  What charting reads is private, and where it writes is not: the seeding pass
  proposes *the constraint, never the source*, and never pastes recall output
  into a map body that is as public as the repository holding it.

### Fixed
- **The map body template ships the `soma:decisions` markers (#621, #622).**
  `soma graph decisions --write` refuses a body without them — deliberately,
  since guessing where an index belongs in prose it does not own is worse than
  refusing. The template did not carry them, so **every** map charted from it
  failed its first write, on the first node anyone closed. The verb was right;
  the template was wrong. It survived because the error prints the two lines to
  add, so each walker hand-patched their own map and moved on.

  `WalkTheMap`'s wording is corrected with it: *"if the map predates them"* read
  as legacy handling when it in fact described every map. A regression guard now
  runs the real `spliceSection` over the real template file — the two are one
  contract living in two files, and each half was correct alone, which is why
  nothing caught it.

  Not adopted: injecting the markers at `soma graph add` time. It would append
  them to a body whose shape it does not know — the same guess the splice
  refuses to make.

## [0.15.0] - 2026-08-11

The **work graph** release: a typed primitive for planning work that outlives a
single agent session, walked with `soma graph` verbs, closed only through
checkpoint gates that refuse a hollow close. Built and dogfooded on its own map
(#495) from first spec to close — every decision below was resolved as a node on
the graph it describes.

### Added
- **The work graph primitive, its verbs, and its trust gate (#484, #499, DD-16).**
  Nodes of work joined by two relations — *membership* (a node belongs to a map)
  and *blocking* (a node gates another) — with a typed `GraphStore` seam and a
  GitHub backend where the tracker is the sole authoritative store. Five verbs:

  ```bash
  soma graph frontier <root>    # open, unassigned, unblocked nodes in the subtree
  soma graph node <id>          # the node's state and body
  soma graph claim <id>         # take it
  soma graph add <root> …       # attach a node, --checkpoint required
  soma graph close <id> …       # the gate: probes, prose, receipt
  ```

  A node carries an `autonomy` class (`auto` / `propose` / `approve`), an
  uninterpreted `kind`, a checkpoint, and — for anything machine-closable —
  probes. `assertClosable` is the hollow-close refusal: a node closes only
  through its checkpoint, and an `auto` node with zero probes is unconstructible
  rather than merely discouraged.

- **`soma graph audit <root>` (#597)** reports what the gates structurally cannot
  see: nodes closed with no receipt (the tracker closed them; no gate ran), open
  nodes with no checkpoint (they can never close), and open-and-claimed nodes.
  Read-only by design — an auditor that reopened nodes would be a second writer
  with its own race.

- **`soma graph decisions <root>` (#597)** collects the resolution prose of a
  map's closed nodes into one document, so a finished map reads as a record
  rather than as a list of closed tickets.

- **Probe types and the registry gate (DD-16 Amendment A, #524, #526).** Probes
  are `command`, `url`, `git-ref-exists`, `git-merged-into`, and
  `artifact-exists`. Tracker content may *parameterise* a probe but may never
  introduce executable code or a network destination: a `command` probe is
  refused unless the exact `run` **and** `cwd` pair is declared in
  `~/.soma/policy/probe-registry.json`, and a `url` probe unless its host is.
  Inspect with `soma policy probes`; adding an entry is a loosening mutation and
  stays the adopter's hand — Soma ships no verb that writes it.

- **Close receipts with derived attestation (#502).** Every close posts a
  receipt naming the checkpoint, the probes and what they observed, the probe
  trees with their HEAD and dirty state, and an `attestation` of `verified` or
  `unverified` **derived from authorship and reachable credentials**, never
  declared. An unverified receipt lists its reasons rather than failing quietly.

- **The `orienteer` skill**, bundled and projected with the primitive rather
  than after it: doctrine for charting a map of decision nodes for work too big
  for one session, and walking its frontier one node at a time.

- **`planSteps` ↔ node bridge (#501).** An `AlgorithmPlanStep` may carry an
  optional `nodeId`; a bridged step's `status` is then a cache of the node's
  reported state, re-derived through `GraphStore.readNode` rather than authored
  by the caller.

- **Progressive skill loading on the adapter spec (#542).** `skillsLoading`
  declares a substrate's loading mode as an install fact; eager substrates get
  stubs, and Pi.dev gains a `skill_body` promotion action. `soma doctor` now
  detects skill stubs whose body no longer resolves.

- **`bun run measure-graph-read-path`** counts and times every backend call a
  graph verb makes.

- **[docs/pai-to-soma-untangling-runbook.md](docs/pai-to-soma-untangling-runbook.md) (#470)** —
  reference runbook for untangling a live PAI install into Soma.

### Changed
- **BREAKING — `GraphStore.listCandidateFrontier` is replaced by `readSubtree` (#576).**
  The seam returned candidate `NodeRef`s that `WorkGraph.frontier` then re-fetched one
  by one; it now returns `NodeState[]` for the root's whole membership subtree, already
  confirmed, and the frontier is a filter over that single read. Any external
  `GraphStore` implementation must be updated — the new method must report **live**
  state (a backend discovering through a stale index owes itself a second read
  internally), must report closed nodes and descend through them, must never truncate
  in silence, and must return each node whole: a short read of assignees or blockers
  now produces a false positive that nothing downstream catches.

  On the reference backend, `soma graph frontier` over a 21-node subtree went from
  **16 `gh` invocations to 1**. Reproduce with `bun run measure-graph-read-path --
  --root <node-id>`, added in this change: it counts and times every backend call a
  verb makes. Spawn count is the claim; the wall-clock that came with it (9 606ms →
  ~920ms, against `the-metafactory/soma#495`) depends on the network and the tracker,
  so treat it as one observation rather than a figure to hold the release to.

  This also amends spec §2.4, superseding #492 correction 3: confirm-by-direct-fetch
  was written for a discovery step assumed to be a lagging search index, and where
  discovery already reads the authoritative store, that read confirms.

- **The frontier walks the whole subtree, at any depth (#564).** It was one level
  deep, so scaffold nodes attached below their spawning ticket were invisible —
  and because scaffold outlives its parent by construction, the invisible case was
  the normal one. Discovery is nested GraphQL `subIssues` with re-rooting on
  truncation; recursive REST would have scaled with a map's *closed* history,
  making a map slower as it succeeded. Depth now records provenance and nothing
  else: gating is what a blocking edge means.

- **Every close carries prose (#588).** `--resolution-file` is required on an
  `auto` close and on a bare HITL close, exempt only when `--proposal-comment`
  names a proposal whose body already is the prose. It is folded into the receipt
  comment, so no ordering exists in which one half lands without the other.
  Documented as a **forcing function, not evidence** — no machine can check that
  the prose says anything.

- **The close has an operational envelope (#592).** `observed` output is bounded
  by outcome (200 chars on pass, 1 200 on fail); a **runtime** 15-minute deadline
  clamps a close and records unrun probes as failed rather than skipped; and an
  oversized receipt is refused *before* any probe runs, counting the resolution
  prose, since GitHub caps a comment at 65 536 characters and the receipt posts
  after the expensive part.

- **A HITL node closes on the session's say-so (#549).** Ratification is a label
  on the receipt, not a gate: a node whose autonomy class puts a human in the loop
  closes when that human closes it. A ratification is a **reaction** on a proposal
  comment — a deliberate, unambiguous gesture — never inferred from prose.

- **Labels are a write-only human index for a map (#532).** Topology comes from
  native edges and `kind` from the node block; labels exist because a tracker list
  view is unreadable without them. The runtime never interprets one.

- **`soma graph add` refuses without `--checkpoint` (#597),** and `soma graph node`
  prints the node body — the most frequent read in a walk was the one operation
  with no verb.

- **Skill loading mode belongs to the install spec, not skill frontmatter (#542).**

### Fixed
- **Probes ran in whatever directory the close was invoked from (#579, #580).**
  The probe directory was ambient, unstated and unprinted, so a wrapper with a
  `cd` silently fixed every session's probes to the install tree. The close now
  resolves **one** base directory and passes it to both the runner and the
  registry match — `ProbeRunnerOptions.cwd` is required, so an ambient probe
  directory is no longer expressible — and the receipt records every tree the
  probes actually resolved to, with HEAD and dirty state. Dirty is **recorded,
  never refused**. Named plainly as detection, not prevention.

- **The ungated probes escaped the stated tree (#529, #582).** `artifact-exists`
  resolves its `path` against the cwd, so an absolute path escaped with no `repo`
  field at all — verified live, where `path: "/etc/passwd"` passed and echoed into
  a world-readable receipt. Containment is now one predicate before dispatch: the
  *resolved* absolute path must be the stated tree or a descendant, by a
  separator-aware prefix test. Lexical, not `realpath` — a symlink inside the tree
  pointing out still escapes, and that is written down rather than implied away.

- **The confidentiality gate's generated header claimed it could not block a
  merge (#560).** It could: `decideExit` returns 1 on any block-class finding
  under `set -e`, and with the check required by a ruleset a finding does block.
  The header now states only what the file controls and points at the ruleset,
  instead of asserting a deployment fact from inside a generated source file.

- **PAI naming leaked into projected artifacts (#577 and follow-ups).** The
  Algorithm's shipped references, the bundled-skill pointers missed by the #329
  ISA→VSA rename, and the importer's emitted names all still said PAI; the residue
  guard missed the bare form. The `the-algorithm` skill now ships a closed,
  executable reference set.

- **Standalone-binary hook assets no longer break Pi.dev (#531).**

- **The Codex work-registry lock wait is bounded (#583).**

## [0.14.1] - 2026-08-02

### Fixed
- **pi-dev message-path freeze (#475, #489)** — `before_agent_start` ran two blocking
  `spawnSync` calls on every message: a full `soma lifecycle session-start` plus
  `soma algorithm classify`. Entering a message froze Pi.dev until both returned.
  The message path now spawns nothing.

  The larger finding: **classification never needed a subprocess.**
  `classifyAlgorithmPrompt` is pure and synchronous — regex matching, zero I/O — so
  the entire cost attributed to it was bun cold start (~210ms measured) spawned to
  run a regex. The classifier is now projected into the generated extension and
  called locally, which keeps classification correct for the *current* prompt on
  every message including the first, with no cache and no deferral.

- **`session-end` lifecycle records were being lost** — `captureSessionEnd` was
  fire-and-forget on `session_shutdown`, so the process exited and killed the child
  mid-write. It is now awaited with a bounded timeout.

### Changed
- **Startup context is computed once per session** and reused by `before_agent_start`
  instead of re-running the whole session-start lifecycle per message.
- **Work-index refreshes are deferred and coalesced** behind an in-flight guard.
  `spawnSync` previously serialised them; an unguarded async fan-out would let a
  tool-heavy turn race dozens of concurrent writers on `algorithm-work-index.json`.
- **Classifier pattern set extracted to `ALGORITHM_CLASSIFIER_CONTRACT`**
  (`src/algorithm-classifier.ts`), serialised into the projected copy by the new
  `src/adapters/shared/algorithm-classifier-source.ts` rather than retyped — the same
  share-the-data-generate-the-logic idiom as `feedback-helper.ts`. Classification
  behaviour is unchanged; a behavioural-equivalence test pins the projected copy to
  the runtime function.

### Added
- `test/pi-dev-blocking-calls.test.ts` — pins the pi-dev message path as
  subprocess-free, alongside a transpile check of the generated extension.
- `test/pi-dev-classifier-projection.test.ts` — drift guard comparing the projected
  classifier against the runtime one across a branch-covering prompt corpus.

## [0.14.0] - 2026-07-26

### Added
- **Portable substrate executors + execution kernel hardening (#454)** — substrate
  membership centralised, kernel admission and output bounds hardened, prepared-request
  values validated, preflight work cancellable, and probe/terminal failures normalised
  so a failed probe reports as a failure rather than an ambiguous result.
- **SelfHealing doctrine across all substrates (#459, #464)** — a uniform policy for
  what a substrate repairs on its own versus what it escalates.
- **Projection self-repair at session start (#460, #465)** — a drifted or partially
  written projection is detected and repaired when a session begins, instead of being
  discovered later as confusing behaviour.
- **Session-start readback of the learning signal (#458, #466)** — what was learned is
  read back at session start rather than only written.
- **Loop-closure T1–T6 + Sage-review hardening (#455)**.

### Changed
- **Statusline made OS- and dependency-agnostic (#457)** — no longer assumes a
  particular platform or installed tooling.

### Fixed
- **Runtime policy: match signal, not presence (#472)** — three detector rules fired on
  the mere *appearance* of a token rather than on evidence of intent, blocking ordinary
  correct work. `env-egress` matched the English words `set`/`export`/`env` anywhere in
  prose (so "the same set" was denied) and now requires shell **command position** on
  quote-stripped text; the secret-egress rule now requires an attached value (`=`/`:`)
  or a variable reference rather than a bare topic word; and the prompt heuristics now
  weigh **polarity**, so a sentence *refusing* to do the unsafe thing ("never disable
  the guard") is no longer flagged harder than one requesting it.

  Both directions are pinned by tests — every attack shape still fires, and the
  legitimate shapes no longer do. The motivating argument is that **a noisy control is a
  disabled control**: a detector with a bad false-positive rate does not degrade to
  "annoying", it degrades to *bypassed*, and usually silently. The general rule is
  written up in `compass/standards/detector-precision.md`.

## [0.13.0] - 2026-07-09

### Added
- **Uniform provenance headers + content-compare doctor across all 5 substrates
  (#370)** — the eligible markdown narrative projection files on codex, cursor,
  grok, and pi.dev now carry the same byte-stable `Generated by Soma` header
  claude-code already had. Files that legitimately cannot or must not carry the
  HTML-comment header are excluded by design: JSON, TOML (grok personas/roles),
  YAML-frontmatter `SKILL.md`, `.mjs`/`.ts` assets, the marker-patched
  `.cursorrules`/`AGENTS.md`/`config.toml`, and the verbatim cross-substrate
  artifacts (ACTIVE_VSA.md, the memory index) — wrapping any of these would
  corrupt parsing or diverge from stored bytes. `soma doctor` no longer
  diagnoses drift via a profile-mtime heuristic: it constructs a fresh home
  projection in memory (the same builder `soma install`/`soma export` use) and
  content-compares it against disk, so `--substrate` now covers cursor and
  pi-dev too (previously unsupported) alongside codex/claude-code/grok. Grok
  additionally keeps its `grok inspect --json` runtime-discovery oracle — a
  different, non-deterministic question from whether the on-disk bytes match a
  fresh projection. Findings are `missing` (projected file absent — new `error`
  severity), `unmanaged-edit` (present but lost its header — hand-replaced),
  `stale` (present but the Soma source moved on), or `not-diagnosable` (`info`:
  Soma is not installed / the Soma home is incomplete, so no source projection
  could be built to compare against — surfaced honestly instead of a bare "ok",
  but non-fatal). `soma doctor`'s process exit code now reflects the worst
  finding: 0 clean, 1 drift, 2 error (a projected file missing on disk) —
  CI-friendly, mirroring the `vsa` command's existing exit-code convention.
- **SessionStart smart memory reprojection (M8) (#443, #444)** — a substrate's
  projected memory file (e.g. Claude Code's `rules/soma/MEMORY.md`) now stays
  current at the start of every session: `memory/INDEX.md` reindexes only when
  a note changed since the last index, then only the one projected file whose
  content actually changed is rewritten — an idle session touches no disk and
  churns no git history. `soma memory reproject` exposes the same operation on
  the CLI. Codex inherits the identical substrate-neutral path; a regression
  test locks the parity (#444).
- **Soma status line for Claude Code (#445, #446)** — `soma install claude-code
  --apply` now projects a status line into `settings.json` (default-on, like
  the rest of the session hook fleet; opt out with `statusLine: false`):
  directory, git branch/ahead-behind, context-window percentage, 5h/7d usage
  windows, and a mode+effort indicator (e.g. `⚙E3 task`). The mode+effort
  indicator reads a per-session state file (keyed by session id) rather than the
  global active-run pointer, so it reflects the current session's own mode
  rather than a concurrent session's Algorithm run (#446).
- **Compact skill registry projection under a line budget (#371)** — the
  projected skill catalog now emits one tight entry per skill (name, a
  truncated lead-clause description, and its path, plus optional `triggers:`
  and `not:` lines) instead of a full heading + description + Path + Triggers
  block per skill — 962 → 122 lines measured against the real 106-skill
  `~/.soma` tree, well inside the declared 300-line budget. Skill bodies still
  load on demand via the Skill tool; only the eager catalog projection shrank.
- **Bundled skills project as invocable dirs on every substrate (#437)** —
  `the-algorithm` and `Memory` now ship via `soma install` on all five
  substrates (claude-code, cursor, codex, grok, pi-dev), retiring the manual
  `~/.claude/skills/the-algorithm` symlink workaround.
- **`migrate-pai-purpose` skill (#440)** — a bundled skill that finishes a
  PAI→Soma migration correctly: keeps Purpose as the lean four-field
  distillation (never a raw TELOS dump), promotes PAI's beliefs, mental
  models, decision frames, challenges, and hard-won lessons into Soma memory
  as recall-able notes with a source-of-truth pointer, and guards
  `profile/purpose.md` against the identity-importer clobber.
- **Anthropic Cowork substrate scaffold (#436)** — an initial adapter skeleton
  for a future Anthropic Cowork substrate; not yet an installable target.
- **VerificationGate + PreCompact ports (#439)** — `soma algorithm verify` now
  refuses to record a `passed` criterion on specification-only or rote
  ("done"/"verified"/…) evidence, moving the existing hollow-pass check from
  audit time to record time (escape hatches: evidence kind `probed`/`tested`,
  or status `deferred-probe`). A new Claude Code PreCompact hook captures
  active Algorithm-run state into a session-scoped file before a mid-session
  compaction and resurfaces it as context on the next prompt, so live
  work-state survives a compaction boundary that Claude Code does not re-run
  SessionStart after.
- **Code-only projection mode (`--code-only`) (#416)** — `soma install`,
  `soma reproject`, and `soma upgrade` accept `--code-only` to project a
  substrate's core files without the portable-skill dirs, for callers that
  only want the code-facing surface.
- **Memory recall/consolidation feedback loop** — `soma memory recall` now
  appends one `memory.recall` journal event per call (query terms, returned
  note ids, result count), feeding a new informational, non-gating
  retrieval-quality probe in `soma memory audit` (recall volume, empty-recall
  rate, verify-follows-recall rate) (#425). `soma memory used <id>` records a
  low-friction "this recalled note helped" resurface signal, distinct from
  `verify`, at the same governed write path (#427). Write-time `--upsert`
  delta-merges a colliding write into its best-scoring near-duplicate instead
  of only refusing, and `soma memory consolidate` gains an assistant-trust-
  only auto-merge pass (delta-merge + close, never delete, never supersede)
  (#428). `soma memory promote` now mints a principal-trust durable note that
  is admitted to the INDEX immediately, instead of landing quarantined
  pending a later backfill pass (#415).
- **Greenfield install acceptance across all adapters (#373)** — a new test
  suite installs every adapter into a fully empty home and audits the result:
  every reported file exists and is non-empty, every projected markdown/JSON
  file parses and is valid UTF-8, and no projected file contains a dangling
  absolute-path reference into the temp tree.

### Changed
- **Memory write/consolidation hardening (#407, #408, #409, #410, #412, #417,
  #423)** — internal refactor: note writes and consolidation now share one
  atomic plan/apply primitive with matching rollback on a mid-write or
  event-append failure, one symlink-safe note-traversal seam (closing a
  durable-note read path that previously had no symlink guard), one shared
  set of corpus operations (near-duplicate scoring, note aging, id slugs,
  text sanitization), and path construction routed through the typed
  `SomaPaths` seam. No user-facing behavior change; closes several
  defense-in-depth gaps along the way (symlink traversal on enumeration and
  read, a path-escape guard on the consolidation-apply path).

### Fixed
- **Reserve `profile/purpose.md` on migrate/import (#441)** — `soma migrate
  pai`'s identity importer no longer clobbers a hand-curated `purpose.md` on
  every rerun; once it exists on disk it is left untouched unless
  `--overwrite-reserved` is passed. `soma import pai` gains the same flag for
  parity.
- **Key portable-skill manifest per substrate home (#438)** — the portable-
  skill install manifest is now keyed per substrate home instead of a single
  shared key, so multiple substrate homes no longer collide.
- **Capture codex session digests (#414)**; escape backticks in the pi-dev
  digest-reminder line so the generated `agent/extensions/soma.ts` extension
  parses instead of failing to load.

## [0.11.0] - 2026-07-03

### Added
- **Generated `~/.claude/CLAUDE.md` projection (`--claude-md`, #368)** — opt-in
  flag on `soma install claude-code` writes `CLAUDE.md` as a projection: a
  provenance header, a thin pointer to the auto-discovered `rules/soma/` bundle,
  and a preserved `<!-- soma:overlay:start/end -->` region. On first conversion a
  pre-Soma CLAUDE.md is carried WHOLE into the overlay (content-lossless, edge
  whitespace normalized). No-op without the flag, so the default install still
  leaves CLAUDE.md untouched.
- **Runtime-policy enforcement on Claude Code + pi.dev** — the portable
  `inspectRuntimePolicy` engine (already enforced on codex/grok) now gates tool
  calls on two more substrates. Both layers are **fail-closed**: any broken path
  denies rather than silently allowing an un-inspected action.
  - **Claude Code (`--policy-guard`)** — a new synchronous `soma-policy-guard.mjs`
    hook runs `soma policy guard` on `PreToolUse`
    (`Bash|Read|Edit|Write|MultiEdit|NotebookEdit`) and `soma policy inspect
    --surface prompt` on `UserPromptSubmit`. Dangerous commands, outbound
    credential exfiltration, credential-path access, and prompt injection are
    denied/blocked. Installs/uninstalls + idempotent settings patching mirror the
    mode-classifier track. (As of #369 this is default-on — see Changed below.)
    Closes the enforcement gap where Claude Code carried only advisory policy.
  - **pi.dev** — the existing `tool_call` path-guard extension gains a
    runtime-policy inspection layer ahead of its destructive-path checks, reaching
    codex/claude-code parity in one extension.
- **Composite `soma policy guard` (full three-check parity)** — a portable
  `evaluateToolCallPolicyGuard` engine + `soma policy guard` CLI run all three
  PreToolUse checks in core: runtime inspection → write-target private-context
  check → inbound content scan, fail-closed at the first block. Claude Code's
  guard now calls this single command for full codex parity (dangerous commands +
  outbound exfil + credential-path access + private-marker writes + inbound TOFU
  scan of reads from untrusted roots), with no 500-line per-substrate target
  extractor to drift.
- **pi.dev prompt-injection (defense-in-depth)** — the guard extension adds a
  `before_agent_start` inspector that flags prompt injection and hardens the
  system prompt with a refusal directive. pi.dev's prompt surface returns a
  systemPrompt patch (not a block), so this layer is advisory and fails open; the
  hard gate stays the `tool_call` layer, which denies any dangerous action a
  prompt injection would actually drive.

### Fixed
- **VSA skill version bump `1.0.4` → `1.0.5`** — the 0.10.0 `pack-id`
  `pai-vsa-v1.0.0` → `soma-vsa-v1.0.0` rename (#362) changed
  `src/skills/VSA/SKILL.md` without bumping its `version:`. The drift-protected
  installer treats same-version as "no upgrade" (restores missing files only,
  never overwrites), so the rename never propagated to `~/.soma/skills/VSA` or the
  substrate projections (they stayed `pai-vsa-v1.0.0`). Bumping the version lets
  the installer re-copy on the next release + reproject.

### Changed
- **Adapter owns the Claude Code session hook fleet by default (#369)** —
  `soma install claude-code` now registers the mode classifier and the
  fail-closed policy guard by default (previously opt-in via `--mode-classifier`
  / `--policy-guard`). A fresh install loads context, classifies mode, and
  enforces policy with no extra flags. Opt out with `--no-mode-classifier` /
  `--no-policy-guard`; the old enable flags are still accepted but inert (a
  `--no-*` flag always wins). Uninstall removes both unconditionally.

## [0.10.0] - 2026-06-26

### Added
- **Skill projection primitive (#354 / #355)** — `soma project-skill <dir>` and
  `soma unproject-skill <dir|name>`: symlink a skill into the soma registry
  (`~/.soma/skills/`) and each substrate's invocable loader, then refresh only the
  `SKILLS.md` catalog. Idempotent, multi-substrate, dry-run by default with
  `--apply`; `--force` replaces a real (non-symlink) directory occupying a slot
  (otherwise refused, guarding user skills from clobber). One owned projection
  truth that `install --skills` and (future) arc delegate to. Fixes the latent
  `loadSomaSkills` bug that silently skipped symlinked skills.
- **`soma install <substrate> --skills <name[,name…]>` (#357)** — projects the
  named official skills (under `~/.soma/skills/`) into the substrate on install.
  Names only, not paths; dry-run names them, apply projects + reports status.
- **`projectSkills` batch projection (#358 / #360)** — `install --skills` links
  all selected skills then refreshes the catalog ONCE. `linkSkill` is
  all-or-nothing: it rolls back its own partial symlinks on failure, so a mid-batch
  failure leaves the registry holding only fully-linked skills and the one
  post-batch catalog refresh reflects only those (no partially-linked, non-invocable
  entry).

### Changed
- **Adapter owns the skill-loader path (#356)** — `SubstrateInstallSpec` gains
  `skillsLoaderDir(substrateHome)`; `home-projection` exposes a single
  `buildSubstrateHomeProjection` dispatcher. `project-skill` no longer derives
  loader paths from the VSA skill destination or keeps a parallel builder map.
- **the-algorithm ships as plain `.md` (#359)** — retired the
  `renderSkill()` / `renderRunWorkflow()` string-literal code-gen in
  `algorithm-importer.ts`; the content lives in `src/skills/the-algorithm/` and is
  read from the bundled repo source on import (same model as the VSA skill).
- **Official skill `pack-id` `pai-*` → `soma-*` (#362)** — `VSA`
  (`soma-vsa-v1.0.0`) and `Purpose` (`soma-purpose-v1.0.0`), since these are
  Soma-native, not PAI imports.

### Docs
- The design and decisions behind this release — the official skill collection,
  the projection primitive, and the mid-epic course corrections (the VSA skill is
  not code-gen and stays; the migrated PAI skills are not evicted) — are recorded
  in `docs/adr/0002-official-skill-collection-and-projection-primitive.md`. See
  that ADR for the rationale; it is the source of truth, not duplicated here.

## [0.9.1] - 2026-06-25

### Fixed
- **Case-clean projection (#351, #352)** — install/reproject now leaves ONE clean
  state, identically on case-sensitive and case-insensitive filesystems, with no
  rename/recase orphans (the cross-filesystem divergence class). Two parts:
  - *Self-reconciling generated subtrees* (#351): Soma-owned subtrees
    (`rules/soma`, `memories/soma`, `hooks/soma`, `agent/soma`) reconcile to exactly
    the projected file set every install — renamed/recased/removed projections
    self-clean (case-normalized via a crash-safe temp-hop, or removed), with no
    per-rename bookkeeping and never deleting the subtree root. `removeObsoleteHomeFiles`
    is now recursive. pi-dev projects the VSA skill as canonical `vsa` (was a stale
    pre-#329 `isa`, which had left frozen `## Criteria` content).
  - *Renamed-away skill orphan prune* (#352): the pre-#329 `ISA` skill dir left
    beside the canonical `VSA` is removed from the source home (`~/.soma/skills/ISA`,
    the propagation root) and the codex/claude-code `skills/` roots, behind a
    two-signal provenance gate (frontmatter `name: ISA` + the VSA-skill identity
    sentence) so a user skill named `ISA` is never touched. cursor + pi-dev are
    covered by the part-1 reconcile / legacy prune.

## [0.9.0] - 2026-06-24

### Added
- **Algorithm meta-reflection layer** (#333) — the "how the Algorithm itself
  should have behaved" layer PAI captured (`reflection_q1/q2/q3` + `doctrine_fired`)
  and Soma never ported. A typed `AlgorithmMetaReflection` on the run carries two
  halves by design: **deterministic `gatesFired`** (computed from run state via the
  same predicates the live gates enforce — `currentStateFloor` #331, `learnGateClean`
  #330, `completeness`) and the **model-proposed `smarterRun`** q-signals. Record
  with `soma algorithm reflect`; the gate-flags are computed, the q-signals are the
  caller's. `soma algorithm reflections --id <run>` lists a run's reflections;
  `--digest` ranks the cross-run improvement backlog — **gate-miss counts rank,
  q-signal keyword buckets enrich** — optionally folding in a historical PAI
  reflections jsonl via `--pai-source`. Reflections mirror into the run's
  `LEARNING/ALGORITHM/<run>.md`. Run over a sample of the historical PAI corpus the
  current-state-verification cluster ranks first, re-surfacing P2 (#331) — evidence
  that recurring meta-reflections surface the runner/prompt fixes worth making
  (the digest ranks the backlog; a human or agent still writes the fix). Note:
  imported PAI records carry a documented best-effort gate-flag mapping, distinct
  from the live `computeGatesFired` computation.
- **OBSERVE current-state floor** for the Algorithm. Advancing `observe → think`
  now requires at least one recorded current-state *probe* — a typed
  `AlgorithmObservation { claim, evidence, evidenceKind }` whose `evidenceKind`
  is `probed` or `tested`. A `specified` observation only restates a spec and
  does NOT clear the floor. Empirically motivated: 63% of 188 real runs stalled
  at OBSERVE or advanced on unverified assumptions and reworked later (#331).
  New surfaces: `soma algorithm observe --claim … --evidence … [--evidence-kind]`
  (kind defaults to the fail-safe `specified`; assert `probed`/`tested` to clear
  the floor) and the batch op `observe:<claim>:<kind>:<evidence>`. Like every
  evidence surface the kind is caller-asserted — the gate makes skipping the floor
  explicit and auditable; it does not confirm the probe actually happened.
  Sync from an already-advanced ISA reconstructs the declared probe so historical
  imports still round-trip. Back-compat: runs without `observations` default to
  `[]` on load.
- The agent-facing **`the-algorithm` rendering contract** (projected to codex/grok)
  now states the OBSERVE current-state floor: OBSERVE phase rules instruct the
  agent to probe every current-state assumption and record it with
  `algorithm observe … --evidence-kind probed` before the gate will leave OBSERVE.

### Changed
- **Vocabulary alignment (#329)** — completed across four slices: Telos →
  Purpose compartment (#339); ISA → VSA across docs, code, CLI (`soma vsa`; `soma isa`
  kept as a deprecated alias), projections, and skill (#341, #342); on-disk
  storage/wire `isa` → `vsa` — the `~/.soma/isa/` dir migrates to `vsa/`
  (snapshot-first, on upgrade), the AlgorithmRun `isa` field → `vsa`
  (schemaVersion 2 → 3), `lifecycle.isa_updated` → `vsa_updated` events, and the
  work.json `isa` pointer → `vsa`, all dual-read for back-compat (#343);
  `IdealStateCriterion` type → `Checkpoint` with a deprecated alias (#344); and the
  VSA section heading `## Criteria` → `## Checkpoints`, dual-read legacy + emit-new,
  no migration (#348, #349). `ISC-N` criterion ids are retained.

### Fixed
- **Grok pre-tool-use fail-open hole** (#345) — the policy chain ran `bun run soma`
  from `trustedSomaRepo`, which silently fell back to a global `soma` on `PATH` when
  the repo was missing/wrong, so a misconfigured repo could return `allow`. It now
  runs the trusted repo's own declared entrypoint (`<repo>/src/cli.ts` via
  `scripts.soma`) with no PATH fallback — an unusable repo fails closed (deny). Also
  fixed a pre-existing order-dependent flaky test in the same area that intermittently
  failed the pre-push smoke gate.

## [0.8.8] - 2026-06-22

### Added
- Grok (xAI `grok-cli`, home `~/.grok/`) as the fifth Soma substrate, with the
  full lifecycle the other adapters have (`install`/`doctor`/`reproject`/
  `upgrade`/`uninstall`): home projection of auto-loaded skills plus an
  `AGENTS.md` pointer, a fail-closed `PreToolUse` policy hook on Grok's
  otherwise fail-open hook platform, per-session lifecycle hooks, a
  version-floor validator (`0.2.38`), and a marker-guarded uninstall. The
  adapter rests on empirically probed grok-cli runtime facts, captured as DD-14
  (#326).

### Fixed
- Bun-path resolution validates the binary before freezing it into substrate
  hook commands, and resolves it win32-correctly: on Windows the resolver
  probes `where` (never `which`), normalizes the MSYS/Git Bash `/c/...` dialect
  to a native path, and rejects any candidate — including a `SOMA_BUN_PATH`
  override — that is not on disk and spawnable. A frozen unspawnable path would
  silently disable the policy gate on a fail-open hook platform (#324, #323).
- The Grok hook's fail-closed backstop no longer allows a private-marker
  reference glued behind a non-path prefix (`@.soma/…`, `@./.soma/…`,
  `@~/.soma/…`, `@$HOME/.soma/…`, `@%USERPROFILE%/.soma/…`,
  `@${env:USERPROFILE}/.soma/…`). The whole home-anchor class is closed by
  degluing the leading prefix and re-running the shared path resolver, plus a
  full-text scan for markers embedded in opaque tokens; benign forms
  (`my.soma`, nested `proj/.soma`) are not over-blocked (#328, #327).

## [0.8.7] - 2026-06-15

This release also carries the 0.8.6 changes below, which were version-bumped
but never tagged or published (registry latest was still 0.8.5).

### Fixed
- `soma export --out <relative>` now writes to the directory the command was
  invoked from instead of the repo root. The arc launcher shim `cd`s into the
  repo before exec, overwriting `process.cwd()`/`$PWD`; the shim now exports
  the caller directory as `ARC_INVOCATION_CWD` (arc#239) and `--out` resolves
  against it, falling back to `process.cwd()` when unset (#315).
- `soma export codex` now emits the ISA skill, completing the exported bundle
  so an export matches a fresh install byte-for-byte (#313).
- Hook installation no longer embeds an ephemeral `/tmp/bun-node-*/bun` path
  into the substrate hook config. Such a path is Bun's temporary
  self-extraction and breaks after a reboot; both the PATH-resolved and
  `process.execPath` candidates are now screened, and resolution fails loudly
  with remediation when only an ephemeral Bun is found (#316).
- Codex hooks now run under `bun` rather than `node`, which is not a declared
  Soma prerequisite — aligning `hooks.json` with the `#!/usr/bin/env bun`
  shebang the hook script already ships (#317).

### Added
- Regression coverage locking first-install ISA-skill convergence and that
  `soma init` fully populates the Soma home while skipping a non-flat
  `~/.claude/skills` tree (#318).

## [0.8.6] - 2026-06-12

### Added
- Fresh-machine onboarding story: `soma init` now creates the Soma home
  skeleton itself (`bootstrap-soma-home` is the first plan step), so a machine
  with no Claude Code / PAI installation gets identity, telos, memory, skills,
  and policy files even when a later step fails or is skipped. The dry-run
  plan explains that init imports from detected sources and notes when it
  starts from the starter profile.
- `docs/soma-home-layout.md`: what `soma init` creates on disk, where the
  Soma-native Algorithm and ISA implementations live
  (`~/.soma/memory/WORK/algorithm-runs/`, `~/.soma/isa/`), and which init
  steps run when. Linked from the README quickstart and Documentation index.

### Changed
- `soma init --apply` is the canonical execute flag, aligning init with
  `install`/`adopt`/`migrate`/`import`. `--yes` remains accepted for one
  release as a deprecated alias with a stderr warning.

### Fixed
- A fresh Claude Code install ships an empty `~/.claude/skills/`; `soma init`
  no longer plans a `migrate-claude-skills` step for it (and `soma doctor` no
  longer suggests one), instead reporting "empty — nothing to import".
  Direct `soma migrate claude-skills` runs now distinguish a missing or empty
  `--from` tree from a genuinely non-flat layout instead of misreporting
  "not a flat skills tree".

## [0.8.3] - 2026-06-03

### Fixed
- Publish the `soma` CLI as an Arc `provides.cli` PATH shim so
  `arc install @metafactory/soma` supports the README quickstart commands.
  ([#302])

### Chore
- Move the source release to 0.8.3 because the Arc registry already contained
  immutable version 0.8.2 before this fix could be published.

## [0.8.1] - 2026-06-02

### Chore
- Bump release metadata to 0.8.1 for the Sigstore-capable Arc publish path.
- Refresh the Arc pinned-install troubleshooting example to the current
  release.

## [0.8.0] - 2026-06-02

### Cross-substrate Algorithm
- Persist pi-dev (and all non-Claude substrate) Algorithm provenance on
  resumable runs, so every hop is visible in the run trail. ([#294])
- Date-prefix run slugs generated by the OBSERVE ISA-sync path, closing the
  collision gap left when a Claude-side scaffold mints its own slug. ([#295])
- Add an Algorithm handoff resume boundary so a resuming substrate advances
  only to an agreed phase instead of running straight to `complete`. ([#296])
- Use the shared Soma ISA home for Claude scaffolds, ending the divergence
  between the claude-side and soma-side per-run ISA. ([#297])
- Sync ISA edits into resumable Soma runs via a hook bridge.
- Persist per-hop substrate provenance on algorithm runs. ([#282])
- Date-prefix generated run/ISA slugs for sortability and collision
  avoidance. ([#281])
- Honor ISA frontmatter `progress` instead of recounting `[x]`. ([#280])
- Rewrite non-Claude substrate paths in projected context. ([#283])
- Accept a positional query for `soma memory search`. ([#278])

### Runtime security policy
- Model-backed runtime policy inspectors and a governance event policy
  model. ([#273], [#268])
- Permission-request and config-change runtime policy with audit. ([#271],
  [#270])
- Expanded runtime command inspectors and runtime policy inspection.
  ([#269], [#262])
- Inbound content security for untrusted ingested material. ([#261])
- Hardened direct-path guard targets. ([#275])

### CLI & tooling
- `soma --version` / `-v` flag. ([#252])
- `soma doctor` claude-code projection health check. ([#253])
- Opt-in Claude Code mode classifier.
- Clarified `soma install` dry-run output. ([#279])
- `sync-from-isa` debug signal. ([#276])

### Chore
- Bump version to 0.8.0 across `package.json`, `arc-manifest.yaml`, and the
  README badge. ([#298], [#299])

## [0.7.1] - 2026-05-29

- Added an MIT `LICENSE` file.
- Renamed `docs/migration-from-pai.md` to `docs/integration-with-pai.md`
  to match the companion/integration framing, and updated README links.

## [0.7.0] - 2026-05-29

- Repositioned the README around substrate portability ("change tools
  without losing the assistant"): framed PAI/TELOS as inspiration and a
  first-class import source rather than a fork, split the PAI path into
  the ideas (`soma migrate pai`) and Daniel's published skill library on
  top (`soma migrate claude-skills`), added a "see it work in Codex"
  quickstart, and credited Soma as a Meta Factory project. Dropped the
  fork-implying `PAI for Codex` skill trigger in `arc-manifest.yaml`.
- Named session work-registry entries by active ISA slug (then `cwd`
  basename + non-default git branch), falling back to `session <uuid>`,
  so sessions align with the goal-derived `memory/WORK/{slug}` names
  instead of showing up as `(unnamed)`. Plumbs `cwd`/`--cwd` from the
  Claude Code hook through the lifecycle CLI. ([#242])
- Added observability V0 over `memory/STATE/events.jsonl` with
  `soma telemetry list`, `soma telemetry stats`, and `soma stats` for local
  event queries, summaries, malformed-row accounting, and JSON output. ([#151])
- Added canonical PAI-aligned shared work state for lifecycle writeback and
  learning harvest defaults: `work.json`, `session-names.json`,
  resolver-backed `current-work-<safe-session-token>-<session-id-hash>.json`,
  and metadata-only writeback events. ([#165])

## [0.6.0] - 2026-05-21

### Added

- Added guided PAI onboarding and drift-detection surfaces for Soma initialization and diagnosis. ([#171], [#179])
- Added a plan-resolve flow and clearer duplicate-pack remediation for `soma migrate pai`. ([#114], [#181])

### Changed

- Improved Claude skill migration remediation by persisting refused outcomes and giving clearer recovery guidance for symlink and `.git` failures. ([#175], [#177])
- Installer migration can now prompt for oversized skill-description rewrites instead of leaving users to discover the rewrite flag manually. ([#174], [#180])

### Fixed

- Removed the default German TELOS data leak from install-time seed content. ([#170], [#178])
- Hardened the pi.dev Algorithm renderer runtime hooks with install-time version checks, checkpoint/restore bounds, and EXECUTE-phase policy handling. ([#85], [#182])

## [0.5.0] - 2026-05-20

### Added

- Migrated PAI runtime tools for memory search, result capture/search, learning capture, Wisdom Frames, relationship reflection, and Algorithm execution modes. These are now exposed through deterministic Soma CLI/tool surfaces instead of remaining only as migrated source artifacts. ([#129], [#130], [#131], [#132], [#133])
- Cursor is now a first-class substrate for `install`, `export`, `reproject`, `upgrade`, and `uninstall`. Soma writes `.cursorrules` plus `.cursor/rules/soma/*.md`, preserves user-owned Cursor rules, and carries active ISA context into Cursor projections. ([#148], [#162])
- Deterministic portability CI now runs on pull requests and pushes to `main`, covering shared projection semantics, portable skill smoke verification, and active ISA writeback/reprojection across shipping home projections. ([#154], [#163])

### Fixed

- `soma migrate claude-skills --rewrite-descriptions <agent>` now participates in the idempotency decision. Skills imported before description rewriting, or with a different rewrite agent, re-import and record rewrite provenance instead of staying `skipped-idempotent` forever. ([#123], [#164])
- Arc upgrade troubleshooting now documents the remove-then-install recovery path for active extracted installs. ([#127], [#159])
- Claude-skills migration progress output no longer floods non-TTY logs with concurrent per-skill phase rows. ([#139], [#160])
- Generic Soma home references in public docs/tests no longer trip the private-source guard. ([#144], [#161])

## [0.4.1] - 2026-05-18

### Added

- `soma migrate claude-skills --rewrite-descriptions <claude|codex|pi|none>` — compresses oversize SKILL.md descriptions (>1024 chars, the Codex + Pi.dev substrate limit) via LLM agent. Synthesizes missing frontmatter from the body when description is absent. Without the flag, oversize/missing descriptions classify as a new `refused-description-limit` outcome with footer suggestion. Per-skill manifest records rewrite provenance (agent, ISO timestamp, original + rewritten SHA, original + rewritten length) for idempotent re-runs. ([#120], [#121])

### Fixed

- 10 PAI skills that previously loaded as `imported` from Soma but silently failed at Codex + Pi.dev runtime now import cleanly with `--rewrite-descriptions claude`: Apify, BrightData, Browser, Council, Ideate, Interceptor, Knowledge, Sales, SystemsThinking, mycelia. Real-world before/after on Apify: 1318 → 836 chars (USE WHEN triggers + domain identity preserved). ([#121])

[#120]: https://github.com/the-metafactory/soma/issues/120
[#121]: https://github.com/the-metafactory/soma/pull/121
[#123]: https://github.com/the-metafactory/soma/issues/123
[#127]: https://github.com/the-metafactory/soma/issues/127
[#129]: https://github.com/the-metafactory/soma/issues/129
[#130]: https://github.com/the-metafactory/soma/issues/130
[#131]: https://github.com/the-metafactory/soma/issues/131
[#132]: https://github.com/the-metafactory/soma/issues/132
[#133]: https://github.com/the-metafactory/soma/issues/133
[#139]: https://github.com/the-metafactory/soma/issues/139
[#144]: https://github.com/the-metafactory/soma/issues/144
[#148]: https://github.com/the-metafactory/soma/issues/148
[#151]: https://github.com/the-metafactory/soma/issues/151
[#154]: https://github.com/the-metafactory/soma/issues/154
[#159]: https://github.com/the-metafactory/soma/pull/159
[#160]: https://github.com/the-metafactory/soma/pull/160
[#161]: https://github.com/the-metafactory/soma/pull/161
[#162]: https://github.com/the-metafactory/soma/pull/162
[#163]: https://github.com/the-metafactory/soma/pull/163
[#164]: https://github.com/the-metafactory/soma/pull/164
[#165]: https://github.com/the-metafactory/soma/issues/165
[#170]: https://github.com/the-metafactory/soma/issues/170
[#171]: https://github.com/the-metafactory/soma/issues/171
[#174]: https://github.com/the-metafactory/soma/issues/174
[#175]: https://github.com/the-metafactory/soma/issues/175
[#177]: https://github.com/the-metafactory/soma/pull/177
[#178]: https://github.com/the-metafactory/soma/pull/178
[#179]: https://github.com/the-metafactory/soma/pull/179
[#180]: https://github.com/the-metafactory/soma/pull/180
[#181]: https://github.com/the-metafactory/soma/pull/181
[#182]: https://github.com/the-metafactory/soma/pull/182
[#242]: https://github.com/the-metafactory/soma/pull/242

## [0.4.0] - 2026-05-18

### Added — Canonical PAI migration sprint

- `soma migrate pai --pai-repo <root>` — single-flag derivation of `--pai-source-dir` + `--pai-packs-dir` from canonical PAI layout (`Releases/<latest-semver>/.claude/PAI` + `Packs/`). Proper semver compare (not lexical). Explicit flags override derivation. ([#98], [#100])
- Memory taxonomy alignment — `SOMA_BOOTSTRAP_DIRECTORIES` extended to the canonical 19 PAI v5.0.0 categories (17 substrate-neutral + 2 PAI-bound: `PAISYSTEMUPDATES`, `AUTO`). Each new dir ships a `README.md` with provenance. ([#88], [#93])
- `soma import pai-docs --pai-source-dir <path>` — new CLI verb importing the in-scope subset (`DOCUMENTATION/`, `TEMPLATES/`, `ALGORITHM/`) of a PAI release tree into `~/.soma/PAI/`. Per-file SHA manifest, escape guards, idempotent re-import. ([#89], [#94])
- `soma migrate pai` orchestration extended — memory translation (per DD-2 mapping table), bulk pack import, docs import wrap, idempotency manifest, `--status` summary, `--skip-{memory,skills,docs}` flags, `--overwrite-reserved`. ([#90], [#95])
- Importer deterministic rewrites — `~/.claude/PAI/{DOCUMENTATION,TEMPLATES,ALGORITHM,MEMORY}/` paths rewritten to their Soma equivalents instead of falling through to the UNMAPPED catch-all. ([#91], [#96])
- `pilot+Holly` review path documented as the canonical review surface for Soma PRs (Sage daemon retained as backup). All PRs in this release routed through Holly via Discord-listening reviewer bot.

### Added — Claude-skills migration path

- `soma migrate claude-skills --from <path>` — second migration path that reads the installed skills tree (`~/.claude/skills/` or any PAI release's `.claude/skills/`). Bypasses the collection-pack collision soup in `~/work/PAI/Packs/` by reading the clean, deduplicated installed form. ([#115 Phase 1], [#116])
- Per-skill portability classifier — `portable | needs-adapt | claude-specific`. Heuristic regex detection of `~/.claude/...` refs, hook bindings (`Stop:`, `UserPromptSubmit:`, etc.), `/<slash-command>` references. `needs-adapt` runs through the deterministic rewriter; `claude-specific` skipped unless `--include-claude-specific`. ([#115 Phase 1])
- Composite source SHA — hashes every collected file (sorted `relPath:sha` join), so sibling edits trigger re-import (not just `SKILL.md` changes). Per-skill manifest at `~/.soma/imports/claude-skills/.manifest.json`. Portability report at `.portability-report.md`. ([#115 Phase 1])
- `soma migrate claude-skills --smoke codex|pi-dev|all` — substrate verification phase. After import, projects each skill into the named substrate(s) and runs static shape checks (frontmatter parse, metadata fields, no dangling refs, no substrate-only primitives, sane file sizes). Per-substrate verdict (`verified` / `verified-with-warnings` / `failed`) recorded in manifest + report. Idempotent (verified+unchanged skips). ([#115 Phase 2], [#117])
- User-owned symlink follow — symlinks whose realpath resolves within `$HOME` (and outside denylisted subpaths: `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`) are FOLLOWED + target bytes imported as if at the symlink path. Per-walk cycle detection. Out-of-home symlinks classify the containing skill as `refused-other` (other skills continue). Three nesting cases handled: top-level `<Name>/SKILL.md`, inner file, inner directory. ([#118], [#119])

### Added — Migration UX

- Per-pack outcome enum (`PaiPackOutcome`): `imported` | `refused-substrate-specific`/`unrecognized-layout` | `refused-reserved` | `refused-other` | `refused-name-collision`. Bulk-pack phase log-and-continues on per-pack failures instead of aborting the whole orchestration. ([#97], [#99])
- Plan-mode log-and-continue mirror for `migrate pai` planning phase (#97 fix was apply-only). ([#102], [#103])
- Plan-mode exit semantics — `soma migrate pai` (no `--apply`) exits 0 even with `refused-other` packs; apply mode keeps exit 1 per #97 AC-4. Footer line still emitted in both modes. ([#112], [#113])
- Renamed `substrate-specific` classification → `unrecognized-layout` (more honest — the original was a misleading catch-all label). Legacy `--include-substrate-specific` flag accepted as deprecated alias with stderr warning. ([#106], [#110])
- `noise` classification — silently skips well-known editor/IDE/language infrastructure files (`.gitignore`, `bun.lock`, `package.json` without SKILL.md sibling, `.cursor/**`, `.vscode/**`, etc.). Files counted in audit but not in outcome refusal lists. ([#106], [#110])
- Collapsed plan output — per-pack counts instead of file dumps. Full lists in `~/.soma/profile/imports/claude/MIGRATION.md`. `--verbose` flag emits inline lists. Footer suggestion lines for unrecognized-layout / reserved outcomes. ([#106], [#110])
- Nested skill bundle support — PAI pack with N nested `src/<Name>/SKILL.md` skills imports as N separate Soma skills. Closes most refused-substrate-specific cases on real PAI Packs (`art`, `thinking`, `utilities`, etc.). ([#105], [#108])
- Nested-bundle detection fix — addressed pack-level outcome poisoning where one unrecognized sibling file refused the whole pack. Per-file partial-import semantics. ([#109], [#111])
- Editor-config symlink skip — `.cursor/`, `.vscode/`, `.idea/`, `.fleet/`, `.zed/` symlinks skipped quietly (with audit entry) instead of aborting the pack. ([#104], [#107])

### Added — Documentation

- `docs/migration-from-pai.md` — full user-facing PAI→Soma migration walkthrough: prereqs, plan, apply, override derivation, per-substrate install (Claude Code, Codex, Pi.dev), verification, troubleshooting, re-migration, what changes after migration. ([#101], [#92])
- DD-1 (Soma is the canonical home), DD-2 (PAI v5.0.0 taxonomy adoption), DD-3 (`migrate` verb reinstated for system-to-system orchestration). ([#92])

[#88]: https://github.com/the-metafactory/soma/issues/88
[#89]: https://github.com/the-metafactory/soma/issues/89
[#90]: https://github.com/the-metafactory/soma/issues/90
[#91]: https://github.com/the-metafactory/soma/issues/91
[#92]: https://github.com/the-metafactory/soma/pull/92
[#93]: https://github.com/the-metafactory/soma/pull/93
[#94]: https://github.com/the-metafactory/soma/pull/94
[#95]: https://github.com/the-metafactory/soma/pull/95
[#96]: https://github.com/the-metafactory/soma/pull/96
[#97]: https://github.com/the-metafactory/soma/issues/97
[#98]: https://github.com/the-metafactory/soma/issues/98
[#99]: https://github.com/the-metafactory/soma/pull/99
[#100]: https://github.com/the-metafactory/soma/pull/100
[#101]: https://github.com/the-metafactory/soma/pull/101
[#102]: https://github.com/the-metafactory/soma/issues/102
[#103]: https://github.com/the-metafactory/soma/pull/103
[#104]: https://github.com/the-metafactory/soma/issues/104
[#105]: https://github.com/the-metafactory/soma/issues/105
[#106]: https://github.com/the-metafactory/soma/issues/106
[#107]: https://github.com/the-metafactory/soma/pull/107
[#108]: https://github.com/the-metafactory/soma/pull/108
[#109]: https://github.com/the-metafactory/soma/issues/109
[#110]: https://github.com/the-metafactory/soma/pull/110
[#111]: https://github.com/the-metafactory/soma/pull/111
[#112]: https://github.com/the-metafactory/soma/issues/112
[#113]: https://github.com/the-metafactory/soma/pull/113
[#115 Phase 1]: https://github.com/the-metafactory/soma/pull/116
[#115 Phase 2]: https://github.com/the-metafactory/soma/pull/117
[#116]: https://github.com/the-metafactory/soma/pull/116
[#117]: https://github.com/the-metafactory/soma/pull/117
[#118]: https://github.com/the-metafactory/soma/issues/118
[#119]: https://github.com/the-metafactory/soma/pull/119

## [0.3.2] - 2026-05-17

### Changed
- arc-manifest.yaml: declare `repository: https://github.com/the-metafactory/soma`. Activates the registry's same-repo image rewrite (the-metafactory/meta-factory#501, #502, #505), so relative `<img src="docs/...">` paths in `README.md` resolve to `raw.githubusercontent.com/the-metafactory/soma/HEAD/...` on the package landing page instead of 404ing.

## [0.3.0] - 2026-05-17

### Added
- `soma install claude-code` — the unified install verb now covers all three substrates (codex, pi-dev, claude-code). `soma adopt claude` continues to work as a legacy alias. ([#54], [#81])
- `soma install --workspace` — projects into `./.{codex,pi,claude}/soma/` instead of the substrate home. Explicit `--substrate-home` still wins. ([#54], [#81])
- `soma uninstall <substrate>` — symmetric to `install`. Functional for `claude-code`; `codex` and `pi-dev` reserve the surface and exit non-zero "not yet implemented". ([#54], [#81])
- `soma reproject <substrate>` — re-emits the projection for a substrate. Routes through the install applier. ([#54], [#81])
- `soma upgrade <substrate>` — reproject + future migration work; currently a reproject alias. ([#54], [#81])
- `soma export <substrate>` — builds the home projection in memory and emits the file list as JSON to stdout. `--out <dir>` writes the projection into `<dir>` (with lexical + symlink-realpath escape guards). No homes are touched. ([#54], [#81])
- `soma daemon` — reserved CLI placeholder for the long-lived Myelin-subscriber runtime mode. Implementation lands in a follow-up. ([#54], [#81])

### Changed
- Renamed the `context` vocabulary to `projection` across types, functions, file names, and prose. `context` is now reserved for the LLM context window only (per CONTEXT.md Q8). Types `SomaContextBundle` / `SomaContextInput` / `WrittenContextBundle` became `Projection` / `ProjectionInput` / `WrittenProjection`. Functions `build{Codex,ClaudeCode,PiDev}{,Home}Context` became `project{Codex,ClaudeCode,PiDev}{Home}`. `writeContextBundle` became `writeProjection`. ([#52], [#80])
- Soma is `"private": true`; no deprecated aliases were kept for the renamed exports. If/when Soma is published, a separate issue will add a deprecation window.
- CLI `--help` now lists `install`, `uninstall`, `reproject`, `upgrade`, `export`, `daemon` consistently. The CLI surface maps 1:1 onto CONTEXT.md "Runtime modes" and "Lifecycle verbs" tables.

### Fixed
- Pi.dev skill-name projection: skill manifests now project under the correct display name. ([#77])

### Security
- `soma export --out` rejects projection paths that escape the `--out` directory through both lexical (`..`, absolute path) and symlink-traversal vectors. The latter resolves the realpath of the parent directory and verifies it is still under `realpath(--out)`.

[#52]: https://github.com/the-metafactory/soma/issues/52
[#54]: https://github.com/the-metafactory/soma/issues/54
[#77]: https://github.com/the-metafactory/soma/issues/77
[#80]: https://github.com/the-metafactory/soma/pull/80
[#81]: https://github.com/the-metafactory/soma/pull/81

## [0.2.0] - 2026-05-17

### Added
- **ISA goes live.** Layer 6 projections for Codex/Pi.dev/Claude Code ([#37], [#65]), deterministic reconcile ([#35], [#74]), library CRUD API ([#34], [#53]), ISA-aware lifecycle hooks ([#38], [#62]), advisory non-blocking algorithm bridge ([#39], [#63]), unified `IdealStateArtifact` / `SomaIsa` type ([#41], [#44]).
- **Claude Code becomes a first-class substrate** — full projection via `.claude/rules/` ([#29], [#66]).
- New orchestrator commands: `soma migrate pai` ([#28], [#67], [#70]) and `soma adopt claude` ([#68], [#72]).
- `soma isa` CLI surface ([#36], [#58]).
- New `CONTEXT.md` domain glossary; all docs aligned to it ([#56], [#60]).

### Fixed
- Codex lifecycle hooks ship verbatim with bun shebang ([#73], [#75]).
- Pi skill name projection ([#77]).
- Path-protection policy allows memory writes while guarding destructive roots ([#50]).
- Codex `PreToolUse` success output kept minimal ([#55]).
- Imported skill descriptions stay Codex-safe ([#59]).

### Changed
- README refreshed.

[#28]: https://github.com/the-metafactory/soma/issues/28
[#29]: https://github.com/the-metafactory/soma/issues/29
[#34]: https://github.com/the-metafactory/soma/issues/34
[#35]: https://github.com/the-metafactory/soma/issues/35
[#36]: https://github.com/the-metafactory/soma/issues/36
[#37]: https://github.com/the-metafactory/soma/issues/37
[#38]: https://github.com/the-metafactory/soma/issues/38
[#39]: https://github.com/the-metafactory/soma/issues/39
[#41]: https://github.com/the-metafactory/soma/issues/41
[#50]: https://github.com/the-metafactory/soma/issues/50
[#53]: https://github.com/the-metafactory/soma/pull/53
[#55]: https://github.com/the-metafactory/soma/issues/55
[#56]: https://github.com/the-metafactory/soma/issues/56
[#58]: https://github.com/the-metafactory/soma/pull/58
[#59]: https://github.com/the-metafactory/soma/issues/59
[#60]: https://github.com/the-metafactory/soma/pull/60
[#62]: https://github.com/the-metafactory/soma/pull/62
[#63]: https://github.com/the-metafactory/soma/pull/63
[#65]: https://github.com/the-metafactory/soma/pull/65
[#66]: https://github.com/the-metafactory/soma/pull/66
[#67]: https://github.com/the-metafactory/soma/pull/67
[#68]: https://github.com/the-metafactory/soma/pull/68
[#70]: https://github.com/the-metafactory/soma/pull/70
[#72]: https://github.com/the-metafactory/soma/pull/72
[#73]: https://github.com/the-metafactory/soma/pull/73
[#74]: https://github.com/the-metafactory/soma/pull/74
[#75]: https://github.com/the-metafactory/soma/pull/75

## [0.1.x]

See git history. 0.1.x predates this changelog and was iterated rapidly during the initial ISA + adapter bootstrap. The 0.2.0 entry above marks the first stable surface.

[Unreleased]: https://github.com/the-metafactory/soma/compare/v0.8.6...HEAD
[0.8.6]: https://github.com/the-metafactory/soma/compare/v0.8.5...v0.8.6
[0.8.1]: https://github.com/the-metafactory/soma/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/the-metafactory/soma/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/the-metafactory/soma/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/the-metafactory/soma/compare/v0.6.4...v0.7.0
[0.3.1]: https://github.com/the-metafactory/soma/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/the-metafactory/soma/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/the-metafactory/soma/releases/tag/v0.2.0
