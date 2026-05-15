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

The importer rewrites `SKILL.md` frontmatter to use a substrate-portable,
lowercase Soma skill name. Source docs are preserved under `references/` so
Claude-specific installation guidance remains available without becoming the
Soma install procedure.

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
