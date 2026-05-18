# Changelog

All notable changes to Soma are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-05-18

### Added

- `soma migrate claude-skills --rewrite-descriptions <claude|codex|pi|none>` — compresses oversize SKILL.md descriptions (>1024 chars, the Codex + Pi.dev substrate limit) via LLM agent. Synthesizes missing frontmatter from the body when description is absent. Without the flag, oversize/missing descriptions classify as a new `refused-description-limit` outcome with footer suggestion. Per-skill manifest records rewrite provenance (agent, ISO timestamp, original + rewritten SHA, original + rewritten length) for idempotent re-runs. ([#120], [#121])

### Fixed

- 10 PAI skills that previously loaded as `imported` from Soma but silently failed at Codex + Pi.dev runtime now import cleanly with `--rewrite-descriptions claude`: Apify, BrightData, Browser, Council, Ideate, Interceptor, Knowledge, Sales, SystemsThinking, mycelia. Real-world before/after on Apify: 1318 → 836 chars (USE WHEN triggers + domain identity preserved). ([#121])

[#120]: https://github.com/the-metafactory/soma/issues/120
[#121]: https://github.com/the-metafactory/soma/pull/121

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

[Unreleased]: https://github.com/the-metafactory/soma/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/the-metafactory/soma/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/the-metafactory/soma/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/the-metafactory/soma/releases/tag/v0.2.0
