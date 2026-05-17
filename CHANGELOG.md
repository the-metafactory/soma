# Changelog

All notable changes to Soma are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/the-metafactory/soma/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/the-metafactory/soma/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/the-metafactory/soma/releases/tag/v0.2.0
