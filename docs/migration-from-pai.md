# Migrating from PAI to Soma

This walkthrough takes a Personal AI Infrastructure (PAI) install and
projects it into a substrate-portable Soma store at `~/.soma/`. It is
the principal-facing companion to the four-issue canonical migration
sprint (#88 / #89 / #90 / #91) and the `--pai-repo` simplification
landed in #98.

The orchestrator behind the walkthrough is `soma migrate pai`. Under
the hood it runs identity import, the Algorithm import, memory
translation, the bulk pack import, and the PAI docs import as ordered
phases against your Claude home (`~/.claude` by default) and a PAI
release checkout. Every phase is idempotent — rerun is safe.

## Prerequisites

- A PAI repo checked out somewhere on disk. The canonical location is
  `~/work/PAI/`. The repo must have the canonical layout:
    - `<pai-repo>/Releases/v<semver>/.claude/PAI/` — DOCUMENTATION,
      TEMPLATES, ALGORITHM.
    - `<pai-repo>/Packs/` — canonical pack source.
- A PAI install rooted at `~/.claude/` (or a custom path supplied via
  `--pai-install`). The orchestrator reads identity + memory from it.
- Soma installed (`bun install` in this repo; the `soma` CLI on
  `$PATH` or invoked via `bun src/cli.ts`).

## Step 1 — Dry-run the migration

Always start with a dry-run. It lists every file the orchestrator
intends to touch and refuses loud on any setup problem (missing PAI
identity, malformed release tree, etc.).

```bash
soma migrate pai --pai-repo ~/work/PAI
```

`--pai-repo` derives both paths the orchestrator needs from a single
root:

- `--pai-source-dir` → `<root>/Releases/<latest-semver>/.claude/PAI`
  (where `<latest-semver>` is the highest 3-segment semver under
  `Releases/`; non-semver siblings like `Pi` or `v2.3` are filtered
  out).
- `--pai-packs-dir` → `<root>/Packs`.

If either path doesn't resolve, the command refuses loud — it does
not silently fall back to defaults.

You can still pass the underlying flags directly if you need to
override either side (see [Step 4](#step-4--overriding-the-derivation)).

## Step 2 — Apply the migration

Once the dry-run looks right, apply it:

```bash
soma migrate pai --pai-repo ~/work/PAI --apply
```

The orchestrator writes:

- `~/.soma/profile/principal.md` — identity projection (#28).
- `~/.soma/the-algorithm/` — Algorithm import (#28).
- `~/.soma/memory/<CATEGORY>/...` — translated PAI memory (#90).
- `~/.soma/skills/<slug>/` — one per pack under `Packs/` (#28 / #90).
- `~/.soma/PAI/DOCUMENTATION|TEMPLATES|ALGORITHM/...` — docs import
  (#89).
- `~/.soma/profile/imports/claude/MIGRATION.md` — the human-readable
  manifest of what landed and when.

Per-pack and per-phase fingerprints land in MIGRATION.md so rerunning
without source drift leaves the file byte-stable (`--status` will
report `Last migrated at:` unchanged).

## Step 3 — Inspect the result

```bash
soma migrate pai --status
```

Prints MIGRATION.md as-is. It lists each phase's outcome, including
any packs that were refused (`refused-unrecognized-layout`,
`refused-reserved`, or `refused-other` genuine errors) via the
per-pack outcome table from #97. Full per-pack file lists for
`refused-unrecognized-layout` packs land in the `## Pack outcome
details` section of MIGRATION.md (#106) so the CLI summary can stay
scannable while the manifest preserves full auditability.

### Reading the plan output

`soma migrate pai` (without `--apply`) prints a per-pack outcome
table with collapsed file counts (#106). Each row looks like one
of:

```
Pack outcomes:
  - aperture-oscillation: imported (1 skill, 5 workflows)
  - art: refused-unrecognized-layout (17 files — run --verbose or read MIGRATION.md for paths)
  - utilities: refused-unrecognized-layout (612 files — run --verbose or read MIGRATION.md for paths)
  - isa: refused-reserved — reserved Soma skill 'isa' — re-run with --overwrite-reserved to permit.
  - prompting: refused-other — symlink: src/Templates/Tools/.cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc
```

If one or more packs were refused for either reason, a footer
suggestion line appears at the bottom of the plan:

```
2 pack(s) refused-unrecognized-layout — re-run with --include-unrecognized to import them.
1 pack(s) refused-reserved — re-run with --overwrite-reserved to overwrite Soma's reserved skills.
```

For the full per-pack file lists (the canonical inspection surface),
pass `--verbose` or read MIGRATION.md — both surfaces always carry
the complete list of unrecognized files per pack.

Editor / IDE / language infrastructure files (`.gitignore`,
`bun.lock`, `.vscode/*`, `tsconfig.json` with no `SKILL.md` sibling,
etc.) are silently skipped as `noise` and never pollute the
unrecognized-layout list. They're still counted in the per-pack
audit (`soma-pack.json` under `normalization.actions`) so reviewers
can see exactly which files the pack carried that were dropped.

## Step 4 — Overriding the derivation

Explicit `--pai-source-dir` and `--pai-packs-dir` always win over
`--pai-repo` derivation. You can pass either or both:

```bash
# Override only the source-dir; packs still derived from --pai-repo.
soma migrate pai \
  --pai-repo ~/work/PAI \
  --pai-source-dir ~/work/PAI/Releases/v4.0.3/.claude/PAI \
  --apply

# Override both; --pai-repo is then only used for existence checking.
soma migrate pai \
  --pai-repo ~/work/PAI \
  --pai-source-dir ~/work/PAI/Releases/v4.0.3/.claude/PAI \
  --pai-packs-dir /tmp/test-packs \
  --apply

# The pre-#98 verbose form still works without --pai-repo at all.
soma migrate pai \
  --pai-install ~/.claude \
  --pai-source-dir ~/work/PAI/Releases/v5.0.0/.claude/PAI \
  --pai-packs-dir ~/work/PAI/Packs \
  --apply
```

## Step 5 — Project Soma into your coding agent(s)

After migration, `~/.soma/` is the source of truth. Each substrate
(Claude Code, Codex, Pi.dev) needs a one-time install so it picks Soma
up at session start. Install one, two, or all three — they share the
same `~/.soma/` state and stay in sync automatically.

### 5a — Claude Code

Claude Code has the richest native surface (CLAUDE.md, hooks, skills,
sub-agents, slash commands, statusline). The install projects Soma into
the familiar `~/.claude/` layout *without* making Claude Code the
source of truth.

```bash
soma install claude-code --dry-run
soma install claude-code --apply
```

This writes:

- `~/.claude/rules/soma/README.md` + `CONTEXT.md` + `PROFILE.md` +
  `TELOS.md` + `MEMORY_LAYOUT.md` + `SKILLS.md` + `POLICY.md` +
  `ACTIVE_ISA.md` — the canonical home projection. Claude Code
  auto-discovers `.claude/rules/` at session start and loads Soma
  context from these files (per architectural pivot in soma#64; the
  pre-pivot `~/.claude/CLAUDE.md` `@`-import path was unreliable).
- `~/.claude/skills/ISA/` — bundled ISA skill (Soma's verification
  harness).

Hooks are deliberately not in the home install. They are an optional
overlay that can improve behaviour but are not required for the storage
contract. Configure them separately if you want memory writeback or
lifecycle integration.

If you previously used `soma adopt claude`, that verb still works as a
legacy alias — `soma install claude-code` is the canonical form.

**Workspace install** (per-repo) — pin a different Soma to a specific
workspace:

```bash
cd <project>
soma install claude-code --workspace --apply
```

Writes `.claude/soma/` inside the workspace; it overlays the home
projection, not replaces it.

### 5b — Codex (OpenAI)

The Codex projection is a workspace-shaped instruction set plus a home
projection into `~/.codex/`:

```bash
soma install codex --dry-run
soma install codex --apply
```

This writes:

- `~/.codex/AGENTS.md` — imports the Soma startup context and the
  Algorithm skill.
- `~/.codex/rules/soma.rules` — Codex-native rule files projecting
  Soma identity, telos, active ISA, policy.
- `~/.codex/hooks/` — soma-lifecycle, policy, feedback-capture hooks.
- `~/.codex/skills/{soma,the-algorithm}/SKILL.md` — local skill
  projection.
- `~/.codex/memories/soma/` — projected memory layout and PAI-import
  references.
- `~/.codex/config.toml` — Codex configuration with Soma defaults.

**Workspace install** for a specific repo:

```bash
cd <project>
soma install codex --workspace --apply
```

Lands under `.codex/soma/`.

### 5c — Pi.dev

Pi.dev is model-agnostic with extensions and skills. The projection
follows the reduced PAI-on-Pi pattern: one core extension + Soma-aware
skills.

```bash
soma install pi-dev --dry-run
soma install pi-dev --apply
```

This writes:

- `~/.pi/agent/extensions/soma.ts` — registers the `soma_context` tool
  and appends Soma identity to the LLM context on `before_agent_start`.
- `~/.pi/agent/extensions/soma-path-guard.ts` — Pi.dev-side enforcement
  of Soma's write-policy (see
  [docs/writeback-and-policy.md](writeback-and-policy.md)).
- `~/.pi/agent/extensions/soma-algorithm.ts` — Algorithm phase
  renderer.
- `~/.pi/agent/soma/` — context, profile, startup-context, memory
  layout, policy snapshot, PAI-imports manifest.
- `~/.pi/agent/skills/soma/SKILL.md` — Soma skill registered as a
  Pi.dev skill.

## Step 6 — Verify

Confirm Soma is the live source for each installed substrate.

### Storage check

```bash
ls ~/.soma/profile/                # principal.md, telos.md, identity
ls ~/.soma/memory/                 # 19 categories (17 + 2 PAI-bound)
ls ~/.soma/PAI/                    # DOCUMENTATION, TEMPLATES, ALGORITHM
ls ~/.soma/skills/                 # imported PAI packs as Soma skills
soma migrate pai --status          # manifest + per-pack outcome table
```

### Substrate check

Start a session in each installed substrate. The principal identity,
active ISA, and recent learning should appear unchanged across all
three.

- **Claude Code** — `~/.claude/rules/soma/CONTEXT.md` and
  `PROFILE.md` exist; Claude Code auto-loads them at session start.
- **Codex** — `~/.codex/AGENTS.md` `@`-imports
  `~/.codex/memories/soma/startup-context.md` and the Algorithm skill.
- **Pi.dev** — the `soma` extension registers on `before_agent_start`
  and `soma_context` is a callable tool.

### Algorithm round-trip

Run a small Algorithm session and verify it lands under `~/.soma/`:

```bash
soma algorithm new \
  --prompt "verify migration" \
  --intent "confirm Soma owns the run" \
  --current-state "PAI just migrated" \
  --goal "see the run land in ~/.soma" \
  --criterion "C1:Run file exists under ~/.soma/memory/WORK/algorithm-runs/"

ls ~/.soma/memory/WORK/algorithm-runs/  # the run is here, not under ~/.claude/
```

## What changes for you after migration

- **Source of truth shifts to `~/.soma/`.** Treat `~/.claude/` as a
  generated surface. Edit `~/.soma/profile/*`, `~/.soma/memory/*`,
  `~/.soma/skills/*`. Re-run `soma install claude-code --apply` to
  pick changes up in the projection.
- **All substrates see the same state.** Switching between coding
  agents no longer means re-onboarding the assistant.
- **PAI keeps working.** Your existing PAI session and hooks continue
  to run. If you write into `~/.claude/PAI/MEMORY/` after migration,
  the next `migrate pai --apply` translates the new content forward;
  the inverse does not happen.
- **The Algorithm and ISA are now Soma's.** Phase markers, ISC
  verification, and learning routing land in `~/.soma/`. Project ISAs
  created with `soma isa scaffold` live in the same place.

## Failure modes

| Symptom                                                             | Likely cause                                                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `--pai-repo: <path> does not exist`                                 | Root passed to `--pai-repo` is missing. Check the path; PAI lives at `~/work/PAI` on the canonical machine. |
| `--pai-repo: <root>/Releases does not exist`                        | `<root>` doesn't have the canonical layout. Either fix it or pass `--pai-source-dir` explicitly.       |
| `--pai-repo derivation: <root>/Releases contains no semver-named directories` | The Releases/ tree only has non-semver names (`Pi`, `v2.3`, `latest`). Pass `--pai-source-dir` explicitly to override. |
| `--pai-repo: <root>/Packs does not exist`                           | Releases is fine but Packs/ is missing. Either fix it or pass `--pai-packs-dir` explicitly.            |
| `soma migrate pai — N pack(s) failed with genuine errors`           | Per #97. Other packs proceeded; the failure detail is in the outcome table. The whole run was non-zero exit. |
| `... refused-unrecognized-layout ...`                               | A pack ships files under `src/` the router didn't recognize (not `SKILL.md`, `Workflows/`, `Tools/`, or a nested skill bundle). Pass `--include-unrecognized` to archive them. Pre-#106 this was named `refused-substrate-specific`; the legacy CLI flag `--include-substrate-specific` is accepted as a deprecated alias for one release. |
| `... refused-reserved ...`                                          | A pack's slug collides with `isa`, `the-algorithm`, `knowledge`, or `telos`. Pass `--overwrite-reserved` to permit. |

## Skipping phases

For partial reruns:

```bash
# Memory and docs only — skip identity/algorithm if those are stable.
soma migrate pai --pai-repo ~/work/PAI --apply --skip-skills

# Skip docs — useful if you're iterating only on packs.
soma migrate pai --pai-repo ~/work/PAI --apply --skip-docs
```

`--skip-skills` also short-circuits pack discovery, so a malformed
`Packs/` dir won't throw when you've explicitly opted out of that
phase.

## Migrating from installed `.claude/skills/` instead of `Packs/`

`soma migrate pai` imports from a PAI source repo's `Packs/` tree (the
**distribution** source). That tree carries collection bundles
(Media, Thinking, Utilities, Scraping, etc.) that bundle nested
duplicates of standalone skills — on a real PAI install this produces
22+ name collisions per run that have to be triaged via
`--include-unrecognized` and `--overwrite-reserved`.

`soma migrate claude-skills` is a **second** migration path. It imports
directly from an installed flat skills tree (e.g.
`~/.claude/skills/` or
`~/work/PAI/Releases/v5.0.0/.claude/skills/`) — one `<Name>/SKILL.md`
per skill, no pack-level metadata, no collection bundles. The installed
tree is the same content the user's running PAI install already
projects to Claude Code, so the delta from "what's running today" to
"what's in `~/.soma/`" is smaller.

### Usage

```bash
# Plan (default): list every skill with a portability tag.
soma migrate claude-skills --from ~/.claude/skills

# Apply: write portable + needs-adapt skills to ~/.soma/skills/<kebab>/.
soma migrate claude-skills --from ~/.claude/skills --apply

# Apply with a custom Soma home (useful for staging).
soma migrate claude-skills \
  --from ~/work/PAI/Releases/v5.0.0/.claude/skills \
  --soma-home /tmp/soma-staging \
  --apply

# Also import skills the classifier flagged as Claude-Code-specific.
soma migrate claude-skills --from ~/.claude/skills --apply --include-claude-specific

# Status: read the SHA manifest of the prior apply.
soma migrate claude-skills --status
```

### Portability classifier (Phase 1, heuristic)

Each source skill gets one of three tags:

| Tag | Trigger |
|---|---|
| `portable` | No `~/.claude/` references, no hook bindings, no `/<slash-command>` references in prose. |
| `needs-adapt` | `~/.claude/...` reference(s); rewritten via the existing `pai-pack-normalizer.ts` deterministic rewrite table (the same one `soma migrate pai` uses for `~/.claude/PAI/DOCUMENTATION/`, `~/.claude/PAI/TEMPLATES/`, `~/.claude/PAI/ALGORITHM/`, `~/.claude/PAI/MEMORY/`, and `~/.claude/skills/`). |
| `claude-specific` | Hook binding (`Stop:`, `UserPromptSubmit:`, `PreToolUse:`, `PostToolUse:`, `SessionStart:`, `SubagentStop:`, `Notification:`, `PreCompact:`) OR `/<slash-command>` reference in prose (outside fenced code blocks). |

**Apply behavior:**

- `portable` + `needs-adapt` → imported. `needs-adapt` content runs
  through the normalizer; `portable` is passed through bit-for-bit.
- `claude-specific` → skipped with a `skipped-claude-specific`
  disposition. Re-run with `--include-claude-specific` to land them
  anyway (the audit warning stays).

### Outputs

- `~/.soma/skills/<kebab>/SKILL.md` (+ Workflows/, Tools/,
  References/, Examples/, …) for each imported skill.
- `~/.soma/imports/claude-skills/.manifest.json` — per-skill SHA
  manifest, used for idempotent reruns (unchanged source = zero
  writes, byte-stable manifest).
- `~/.soma/imports/claude-skills/.portability-report.md` — markdown
  table of every source skill with its tag, disposition, and the
  reason the classifier picked the tag.

### Limits of Phase 1

The classifier is **regex-based** — pattern match, not semantic
analysis. Slash-command detection runs only on Markdown/text files;
code files (`.ts`, `.js`, `.py`, etc.) routinely embed `/path`
fragments and Discord-style command names that would otherwise false-
positive. Subtle Claude-only behavior that doesn't trip the regex
signals can still slip through as `portable`. The classifier emits
reasons (count of `~/.claude` refs, file path that fired the signal)
so reviewers can audit.

Phase 2 (`--smoke <substrate>`, deferred to a separate PR) adds per-
skill substrate projection verify — turns the verdict from heuristic
to verified.

### Choosing between the two migration paths

| Need | Use |
|---|---|
| Importing from a PAI source repo (`~/work/PAI`) | `soma migrate pai --pai-repo` |
| Importing from your running `.claude/skills/` install (e.g. `~/.claude/skills/` or a Releases/vX.Y.Z snapshot) | `soma migrate claude-skills --from` |
| Need identity/algorithm/memory phases alongside skills | `soma migrate pai` (this path runs all four phases) |
| Want a smaller, collision-free skill import | `soma migrate claude-skills` |

The two paths are not mutually exclusive — `soma migrate pai` covers
identity + algorithm + memory + skills; `soma migrate claude-skills`
covers skills only, from the installed-tree shape instead of the
distribution-pack shape.

## Related

- #88 — memory taxonomy alignment.
- #89 — `soma import pai-docs` (the docs phase, callable standalone).
- #90 — full orchestration (memory + bulk packs + docs phases added).
- #91 — importer deterministic rewrites for cross-references.
- #97 — substrate-specific passthrough + log-and-continue per-pack.
- #98 — `--pai-repo` single-flag derivation (this doc).
- #104 — silent skip of IDE/editor config symlinks (`.cursor/.vscode/.idea/.fleet/.zed/`).
- #105 — nested skill bundles (one PAI pack → N Soma skills).
- #106 — rename `substrate-specific` → `unrecognized-layout`; collapse plan output; `noise` classification.
- #115 — `soma migrate claude-skills` verb + portability classifier (Phase 1, this section).
