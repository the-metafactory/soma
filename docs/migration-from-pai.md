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
any packs that were refused (substrate-specific, reserved-name, or
genuine error) via the per-pack outcome table from #97.

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
| `... refused-substrate-specific ...`                                | A pack ships files under `src/` that aren't `SKILL.md`, `Workflows/`, `Tools/`. Pass `--include-substrate-specific` to land them. |
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

## Related

- #88 — memory taxonomy alignment.
- #89 — `soma import pai-docs` (the docs phase, callable standalone).
- #90 — full orchestration (memory + bulk packs + docs phases added).
- #91 — importer deterministic rewrites for cross-references.
- #97 — substrate-specific passthrough + log-and-continue per-pack.
- #98 — `--pai-repo` single-flag derivation (this doc).
