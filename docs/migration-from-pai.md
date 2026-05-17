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
