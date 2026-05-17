# PAI Docs Importer

`soma import pai-docs` imports a subset of a PAI release tree into
`~/.soma/PAI/`. It is the first step of the PAI → Soma migration chain
(per [DD-1](../design/design-decisions.md#dd-1-soma-is-the-new-canonical-home-of-personal-ai-state)):
Soma is the canonical home of personal AI state, and the PAI release
tree is the source we translate from.

The problem this solves: imported PAI skills reference PAI documentation
paths (`~/.claude/PAI/DOCUMENTATION/Skills/SkillSystem.md`, etc.) that
do not exist under Soma. The normalizer added in #86 rewrites these to
`~/.soma/UNMAPPED/PAI/...` and surfaces them as warnings — making the
gap loud rather than silent. This verb is the deterministic fix:
populate `~/.soma/PAI/` so the references resolve to real files.

## Contract

```
soma import pai-docs --pai-source-dir <path>
soma import pai-docs --pai-source-dir <path> --apply
soma import pai-docs --pai-source-dir <path> --apply --soma-home /custom
```

`<path>` points at a PAI release tree root, for example
`~/work/PAI/Releases/v5.0.0/.claude/PAI`. The flag is required — the
verb refuses to guess a source location.

Dry-run is the default. `--apply` writes files.

## Scope

| Subdir                  | Imported? | Why                                                                |
| ----------------------- | --------- | ------------------------------------------------------------------ |
| `DOCUMENTATION/`        | yes (required) | Resolves the broken doc references in imported skills.        |
| `TEMPLATES/`            | yes       | Referenced by `CreateSkill` workflows that scaffold from templates. |
| `ALGORITHM/`            | yes       | Referenced by skills that produce phase markers; aligns with Soma's `the-algorithm`. |
| `PAI_SYSTEM_PROMPT.md`  | no        | Reference only. Soma has its own assistant identity.               |
| `MEMORY/`               | no        | Soma has its own memory model (see issue #88).                     |
| `USER/`                 | no        | User state, not release content.                                   |
| `PULSE/`                | no        | Runtime, not portable.                                             |
| `bin/`, `PAI-Install/`, `statusline-command.sh` | no | Install/runtime infrastructure.                |
| `TOOLS/`                | no        | Likely Claude-specific runtime; deferred.                          |

## Target Layout

Imported files land under `~/.soma/PAI/` with the source subdirs preserved:

```text
.soma/PAI/
  DOCUMENTATION/
    Skills/SkillSystem.md
    Memory/MemoryArchitecture.md
    ...
  TEMPLATES/
    User/PRINCIPAL_IDENTITY.md
    ...
  ALGORITHM/
    v6.3.0.md
    LATEST
    ...
  .import-manifest.json
```

## Manifest

After `--apply`, the importer writes
`~/.soma/PAI/.import-manifest.json`:

```json
{
  "schema": "soma.pai-docs-import.v1",
  "paiSourceDir": "/Users/fischer/work/PAI/Releases/v5.0.0/.claude/PAI",
  "releaseVersion": "v5.0.0",
  "importedAt": "2026-05-17T15:00:00.000Z",
  "files": [
    {
      "target": "DOCUMENTATION/Skills/SkillSystem.md",
      "source": "DOCUMENTATION/Skills/SkillSystem.md",
      "sha256": "..."
    }
  ]
}
```

`releaseVersion` is detected in this order:

1. A `VERSION` file at the source root (`<pai-source-dir>/VERSION`),
   trimmed of whitespace.
2. The path hint `Releases/<version>/` — matches the canonical PAI
   release layout `~/work/PAI/Releases/v5.0.0/.claude/PAI`.
3. `null` when neither is present. The manifest stays explicit about
   not knowing rather than guessing.

## Idempotency

`--apply` is content-addressed: each source file's SHA-256 is compared
against the previous manifest entry. A re-run with unchanged sources
copies zero files and reports `writtenCount: 0 (idempotent no-op —
source SHAs unchanged)`. The manifest is always rewritten so the
`importedAt` timestamp reflects the most recent run.

Dry-run plans list files without reading their bytes. SHA-256 is
computed on the apply path only — where it is needed for both the
manifest (AC-5) and the idempotency comparison against any prior
manifest. Plan callers that only want paths and counts pay no
content-read cost.

## Refusals

The verb refuses, with a loud error, on:

- **Non-PAI source.** Missing a `DOCUMENTATION/` subdir or it is not a
  directory. The verb does no heuristic guessing.
- **Symlinks inside the source tree.** Mirrors `soma import pai-pack`'s
  hardening and matches `soma export --out`'s symlink-realpath guard.
- **Targets that escape the Soma home.** Lexical and symlink-realpath
  checks both run before every write, including the manifest itself.
  Mirrors `writeProjectionExportFile` in `src/cli.ts` (added in #54,
  reinforced in Sage round 1 on PR #81).
- **VCS metadata directories.** `.git/`, `.hg/`, `.svn/` are refused
  outright inside the source tree.

## Follow-ups

- The `unmapped-claude-home-path` warning class added in #86 will be
  replaced by a deterministic `~/.claude/PAI/<rest>` →
  `~/.soma/PAI/<rest>` rewrite in #91 — once this verb has shipped and
  `~/.soma/PAI/` exists in the target layout.
- The wider PAI migration orchestrator (`soma migrate pai`) wraps this
  verb plus the memory and pack importers in a single principal-facing
  command (issue #90).
