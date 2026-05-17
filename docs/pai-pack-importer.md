# PAI Pack Importer

PAI packs are the migration unit for the PAI skill layer. Soma imports them as
portable Soma skills instead of installing them into a substrate home directly.

## V0 Contract

`soma import pai-pack` reads a PAI pack directory containing:

- `README.md`
- `INSTALL.md`
- `VERIFY.md`
- `src/SKILL.md`
- optional `src/Workflows/`, `src/Tools/`, and template directories

Dry-run is the default:

```bash
bun run soma import pai-pack --pai-pack-dir /Users/fischer/work/PAI/Packs/Telos
```

Apply requires an explicit flag:

```bash
bun run soma import pai-pack --apply --pai-pack-dir /Users/fischer/work/PAI/Packs/Telos
```

`--pai-pack-dir` is required. Existing Soma skills are not overwritten unless
`--overwrite` is supplied. Files classified as `substrate-specific` are refused
unless `--include-substrate-specific` is supplied. Likely secret files such as
`.env`, private keys, credentials, tokens, and local settings files are denied
by default.

## Target Layout

Imported packs land under `~/.soma/skills/<skill-name>/`.

```text
skills/telos/
  SKILL.md
  Workflows/
  Tools/
  DashboardTemplate/
  ReportTemplate/
  references/
    PAI-PACK-README.md
    PAI-PACK-INSTALL.md
    PAI-PACK-VERIFY.md
  soma-pack.json
```

The importer rewrites `SKILL.md` frontmatter to use a portable,
lowercase Soma skill name. Source docs are preserved under `references/` so
Claude-specific installation guidance remains available without becoming the
Soma install procedure.

Soma skill descriptions are compact runtime metadata. Imported descriptions are
normalized to the portable Soma skill metadata limit of 1024 characters; longer
routing doctrine belongs in the skill body, references, or generated routing
metadata rather than frontmatter. The importer records this as a normalization
action when it compacts an oversized description.

## Classification

The import plan classifies each file:

- `portable`: skill entrypoint, workflows, tools, and the generated manifest.
- `template`: dashboard/report application templates.
- `source-doc`: original PAI pack README, INSTALL, and VERIFY docs.
- `substrate-specific`: anything outside the known portable/template/doc paths.

Each planned file also has an `origin`: `source` files include a PAI pack source
path, while `generated` files carry a generator name for importer metadata. The
generated `soma-pack.json` follows the exported `PaiPackManifest` contract.

The classification is advisory in V0. It gives later adapters and review tools a
stable place to decide what should project into Codex, Pi.dev, Claude Code, or a
Cortex daemon.

When substrate-specific files are explicitly included, Soma stores them outside
the skill payload under `~/.soma/imports/pai-packs/<skill>/source/`. They are
kept as migration source material, not projected skill content.

## Normalization Actions

`normalizeSkillContent` applies a fixed pipeline of deterministic
transformations to every skill-rendered file (the entry `SKILL.md` and every
`Workflows/*.md`, `Tools/*.md`). Each transformation either records an
**action** in the audit trail (the change actually fired) or a **warning**
(the change is advisory and needs human review). The pipeline runs in a
fixed order — strips first so path rewrites do not chase content that is
about to be deleted, deterministic rewrites before the catch-all so they
keep their named-target detail, catch-all last so it only fires on residue.

### Strip actions

| Action kind | Trigger (in original content) | Replacement |
| --- | --- | --- |
| `stripped-mandatory-runtime-block` | A `## MANDATORY` heading whose section body contains `localhost:31337/notify`, `voice notification`, or `notify endpoint`. | Entire section removed. Unrelated `MANDATORY` headings (e.g. `## MANDATORY: Input Requirements`) survive. |
| `removed-substrate-notification-hook` | A bare `curl ... localhost:31337/notify ...` line that was not already inside a stripped MANDATORY block. | Curl invocation line removed. |
| `stripped-pai-customization-block` | A `## Customization` heading whose section body contains `SKILLCUSTOMIZATIONS`. | Entire section removed. The PAI runtime hook has no Soma equivalent (see "Out of scope" in issue #86). Unrelated `## Customization` headings (e.g. theme docs) survive. |

### Deterministic path rewrites

| Action kind | Pattern | Replacement |
| --- | --- | --- |
| `rewrote-claude-home-path` | `~/.claude/skills/<rest>` | `~/.soma/skills/<rest>` |
| `rewrote-claude-home-path` | `~/.claude/PAI/MEMORY/<rest>` | `~/.soma/memory/<rest>` |

### Catch-all rewrite (unmapped Claude paths)

| Action kind | Pattern | Replacement |
| --- | --- | --- |
| `rewrote-unmapped-claude-path` | Any remaining `~/.claude/<segment>/<rest>` after deterministic rewrites and runtime-block strips. | `~/.soma/UNMAPPED/<segment>/<rest>` with a `unmapped-claude-home-path` warning per distinct first segment, per file. The placeholder makes runtime breakage loud (path does not exist) while the audit-trail warning makes import-time review loud. |
| `rewrote-unmapped-claude-path` | Bare `~/.claude` or `~/.claude/` prose mentions (no path continuation). | `~/.soma` with an `unmapped-claude-home-path` warning. Used by sentence-form references like *"never leave `~/.claude`"*. |

After the pipeline runs, a bare `grep "~/.claude" SKILL.md Workflows/*.md`
returns zero — that is the integration-level invariant tested in
`test/pai-pack-importer-issue-86.test.ts` against a real fixture pack.

### Compaction

| Action kind | Trigger | Replacement |
| --- | --- | --- |
| `compacted-skill-description` | Skill description longer than the 1024-character Soma portable metadata limit. | Sentence-boundary-aware truncation; falls back to hard truncation on a non-sentence input. |

### Advisory warnings (no rewrite)

| Warning kind | Trigger |
| --- | --- |
| `customization-overlay-reference` | `~/.claude/(context|user|customization)/...` — substrate-overlay model is undefined in Soma. |
| `execution-logging-path` | `~/.claude/memory/...` or `~/.claude/(history|backup|logs)/...` — route through Soma memory events instead. |
| `ambiguous-substrate-path` | `~/.claude/(docs|documentation)/...` — no deterministic Soma mapping. |
| `substrate-mutation-command` | Embedded shell command that mutates Claude home (e.g. `rm -rf ~/.claude/skills/Foo`). |
| `release-safety-path` | `grep`/`scan`/`check` for secrets, credentials, tokens, or keys against `~/.claude/...`. |
| `unmapped-claude-home-path` | Catch-all signal that some part of the body referenced a Claude-only path with no Soma equivalent; emitted alongside the `rewrote-unmapped-claude-path` action. |

The named warnings above can fire in addition to `unmapped-claude-home-path`
— they communicate *why* a path is ambiguous, which the bare catch-all
warning does not capture.

## Boundaries

The importer does not:

- execute the PAI pack installer,
- modify `~/.claude`,
- overwrite existing Soma skills without `--overwrite`,
- copy likely secret files,
- run template dependency installs,
- infer personal TELOS content,
- publish imported skills to substrates by itself.

Projection remains the adapter's job. Import makes the capability available in
Soma; install/projection makes it available in a substrate.

After a successful applied import, refresh the substrate projection before
expecting the skill to appear in that substrate's skill directory. For Codex:

```bash
bun run soma install codex --apply --soma-home <soma-home>
```

## Source archive preservation

Every PAI-pack source file routed as `skill` or `skill-body` is also copied
verbatim to `~/.soma/imports/pai-packs/<skill>/source/<original-path>`. The
archive is never normalized — it is the auditable original. The normalized
projection lives under `~/.soma/skills/<skill>/`; the archive lets a future
reviewer diff what the normalizer changed.
