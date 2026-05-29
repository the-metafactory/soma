# PAI Tools Migration Inventory

Issue [#128](https://github.com/the-metafactory/soma/issues/128) tracks the
second PAI migration layer: reimplementing the small set of PAI tools that are
part of Soma's portable assistant core. The first migration layer already moved
identity, Algorithm source material, memory, docs, and skill packs through
`soma migrate pai`.

This inventory records the 13 in-scope tools, their Soma destination, and the
current migration stance. It is a reimplementation map, not a copy plan. PAI
tools assume a Claude Code install layout and direct `claude -p` execution;
Soma tools must use shared `~/.soma` state, typed APIs, substrate adapters, and
mockable boundaries.

## Current State

| Phase | Original tools | Current Soma status | Destination |
| --- | --- | --- | --- |
| 1 | `Inference.ts` | Implemented as a core primitive | `src/tools/inference/` |
| 2 | `LearningPatternSynthesis.ts`, `FailureCapture.ts`, `OpinionTracker.ts`, `SessionHarvester.ts`, `GetCounts.ts`, `SessionProgress.ts` | Implemented in core today; packaging design may later extract behavior-bearing pieces to `soma-skill-*` repos | `src/tools/learning/` |
| 3 | `WisdomDomainClassifier.ts`, `WisdomFrameUpdater.ts`, `WisdomCrossFrameSynthesizer.ts` | Implemented in core today; packaging design may later extract to one wisdom-frames skill | `src/tools/wisdom/` |
| 4 | `RelationshipReflect.ts` | Implemented in core today; packaging design may later extract to a relationship-reflect skill | `src/tools/relationship/` |
| 5 | `algorithm.ts`, `FeatureRegistry.ts` | Algorithm core exists; PAI execution-mode gaps are tracked separately; `FeatureRegistry.ts` is intentionally not migrated | `src/algorithm*`, `docs/algorithm-execution-modes.md` |

The cross-cutting path resolver from #134 is present as `src/paths.ts`. Tool
paths resolve to the shared Soma home and do not vary by substrate.

## Phase 1: Inference Engine

### `Inference.ts`

PAI role: unified inference helper with three run levels and an advisor mode.
It spawns `claude -p`, reads prompts from stdin to avoid argument-length
limits, supports JSON extraction, and can include current work state in advisor
context.

Soma role: core primitive. Anything that needs model reasoning should call the
typed API instead of shelling out directly.

Soma destination:

- `src/tools/inference/index.ts` exposes `inference()`, `advisor()`,
  `synthesizeAdvisorState()`, and JSON parsing.
- `src/tools/inference/cli.ts` exposes `soma inference`.
- `src/tools/inference/backends/claude-code.ts` preserves the Claude Code
  subprocess behavior behind an `InferenceBackend`.
- `src/tools/inference/backends/anthropic-api.ts` provides a direct API backend.
- `src/tools/inference/factory.ts` selects a backend without making model
  dispatch part of the caller.

Migration notes:

- Run levels remain `fast`, `standard`, and `smart`; concrete model IDs belong
  to the backend.
- Advisor mode reads `memory/STATE/work.json` through `createPaths()`.
- JSON parsing is deterministic and unit-tested with mock backends.
- Codex and Pi.dev do not need to be hardcoded into this module; their adapters
  can inject an `InferenceBackend` or call the same API from their own runtime.

## Phase 2: Learning Pipeline

### `LearningPatternSynthesis.ts`

PAI role: aggregate `ratings.jsonl` into time-windowed pattern groups for week,
month, or all-time review. Groups recurring frustration and success signals,
counts occurrences, and produces confidence-weighted learning output.

Soma destination: `src/tools/learning/pattern-synthesis.ts` and
`soma learning synthesize`.

Migration notes:

- Reads Soma ratings from `memory/LEARNING/SIGNALS/ratings.jsonl`.
- Keeps synthesis filesystem-native rather than database-backed.
- Produces typed pattern groups for callers and CLI rendering.

### `FailureCapture.ts`

PAI role: capture a structured failure record when low-sentiment events or
ratings occur. It collects transcript context, sentiment details, tool-call
metadata, and a short description generated through fast inference.

Soma destination: `src/tools/learning/failure-capture.ts` and
`soma learning capture-failure`.

Migration notes:

- Uses injected inference rather than importing a concrete PAI script.
- Writes structured failure directories under `memory/LEARNING/FAILURES/`.
- Keeps transcript and tool-call extraction deterministic and testable.

### `OpinionTracker.ts`

PAI role: track confidence-scored opinions about working with the principal.
Evidence changes confidence asymmetrically: small increases for supporting
evidence, larger decreases for counter-evidence, and explicit confirmation or
contradiction as stronger signals.

Soma destination: `src/tools/learning/opinion-tracker.ts` and `soma opinion`.

Migration notes:

- Stores opinions under Soma identity as `identity/opinions.md`.
- Shared confidence logic is consumed by relationship reflection.
- Evidence records can also be written to relationship memory.

### `SessionHarvester.ts`

PAI role: mine Claude Code transcripts for decisions, preferences, milestones,
problems, and learning moments. It recognizes correction language such as
"actually", "wait", and "I was wrong".

Soma destination: `src/tools/learning/session-harvester.ts` and
`soma learning harvest`.

Migration notes:

- Raw Claude transcript access is optional; the default path can harvest from
  Soma's work registry.
- Substrate-specific transcript locations must stay outside the learning core.
- Harvested output is represented as learning candidates rather than direct
  durable-memory mutation.

### `GetCounts.ts`

PAI role: single count source for banners and status lines: skills, workflows,
hooks, signals, ratings, users, work sessions, and research files.

Soma destination: `src/tools/learning/metrics.ts` and `soma metrics`.

Migration notes:

- Counts Soma's own skills, memory, ratings, work sessions, and event log.
- Does not depend on Claude Code settings for hook counts.
- Shell-rendering remains a CLI concern.

### `SessionProgress.ts`

PAI role: maintain multi-session continuity per project: objectives, decisions,
completed work, blockers, handoff notes, next steps, and completion state.

Soma destination: `src/tools/learning/session-progress.ts` and `soma session`.

Migration notes:

- Stores progress under `memory/STATE/progress/`.
- Complements, rather than replaces, Algorithm run state.
- Resume output is derived from structured records.

## Phase 3: Wisdom Frames

### `WisdomDomainClassifier.ts`

PAI role: route a request to relevant wisdom frames using keyword matching and
return ordered frame matches by relevance.

Soma destination: `src/tools/wisdom/classifier.ts` and
`soma wisdom classify`.

Migration notes:

- Reads available frames dynamically from `memory/WISDOM/FRAMES/`.
- Default keyword matching is bootstrap behavior, not a closed domain list.

### `WisdomFrameUpdater.ts`

PAI role: update or create domain-specific wisdom frames with observations:
principles, contextual rules, predictions, anti-patterns, and evolution notes.

Soma destination: `src/tools/wisdom/frame.ts` and `soma wisdom update`.

Migration notes:

- Preserves the markdown frame contract with `[CRYSTAL]` principles and
  standard sections.
- Tracks observation count and evolution in the frame itself.

### `WisdomCrossFrameSynthesizer.ts`

PAI role: compare wisdom frames, find shared principles that appear across two
or more domains, and write verified cross-frame principles plus frame health.

Soma destination: `src/tools/wisdom/synthesizer.ts` and
`soma wisdom synthesize` / `soma wisdom health`.

Migration notes:

- Similarity remains deterministic and testable.
- Weekly scheduling is an orchestration concern, not part of the core module.

## Phase 4: Relationship Reflection

### `RelationshipReflect.ts`

PAI role: periodic reflection on relationship growth. It scans relationship
notes and ratings, updates confidence-scored opinions, detects milestones, and
queues notifications for significant shifts.

Soma destination: `src/tools/relationship/reflect.ts` and
`soma relationship reflect`.

Migration notes:

- Parses the `W:`, `B:`, `O:` note format as a Soma relationship-memory
  contract.
- Reuses the learning opinion model instead of duplicating confidence logic.
- Notification dispatch is injected; direct `ntfy.sh` calls do not belong in
  portable core code.

## Phase 5: Algorithm CLI

### `algorithm.ts`

PAI role: large CLI for Algorithm loop mode, interactive mode, ideation mode,
optimization mode, dashboard integration, and voice notifications.

Soma role: gap-fill, not port. Soma already has typed Algorithm run state,
phase gates, criteria, decisions, verification, learning evidence, and CLI
support. The remaining useful pieces are execution-mode contracts:

- loop state and plateau detection
- criteria partitioning for parallel workers
- ideate and optimize parameter schemas and presets
- executor interface for substrate-owned model invocation
- notification event contracts

Detailed extraction notes live in
[algorithm-execution-modes.md](./algorithm-execution-modes.md).

### `FeatureRegistry.ts`

PAI role: JSON feature tracking for complex multi-feature tasks, with commands
to initialize, add, update, verify, and pick the next feature.

Soma decision: do not migrate as a separate tool. Algorithm criteria, plan
steps, verification entries, and dependencies cover the same function with
better typing. If a concrete gap remains, extend Algorithm plan-step metadata
instead of adding a second feature tracker.

## Cross-Cutting Contracts

### Path resolution

All migrated tools must use `createPaths()` from `src/paths.ts`. Shared memory
is rooted in Soma home, independent of the calling substrate.

Important paths:

| Contract | Path |
| --- | --- |
| Ratings | `memory/LEARNING/SIGNALS/ratings.jsonl` |
| Failures | `memory/LEARNING/FAILURES/` |
| Wisdom frames | `memory/WISDOM/FRAMES/` |
| Verified wisdom | `memory/WISDOM/PRINCIPLES/verified.md` |
| Relationship notes | `memory/RELATIONSHIP/` |
| Work state | `memory/STATE/work.json` |
| Session progress | `memory/STATE/progress/` |
| Opinions | `identity/opinions.md` |
| Story | `identity/our-story.md` |

### Track A and Track B

`docs/design-skill-packaging.md` revises the original #128 assumption that all
13 tools should live forever inside Soma core:

- Track A stays in core: inference, path resolution, and Algorithm harness
  primitives.
- Track B may become installable skills: learning pipeline, wisdom frames, and
  relationship reflection.

The current codebase implements Track B behavior in core. That is acceptable
for the migration phase, but future packaging work should avoid treating that
placement as permanent architecture.

