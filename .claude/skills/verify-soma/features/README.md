# Soma verification map

The maintained source for verifying Soma's user-facing behavior. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Run from the repo root with `V=.claude/skills/verify-soma/scripts/verify-soma.sh`.
- `$RUN` is a fresh absolute path outside the repo, one per verification run.
- `$V launch "$RUN"` printed `READY` and `$V doctor "$RUN"` exits 0.
- Never point `--home-dir`/`--soma-home` at `~` or `~/.soma`; never drive the principal's installed `soma` binary.

## Driving conventions

- Start every recipe from a freshly launched home unless its preconditions say otherwise.
- `$V soma` for subcommands that take home flags, `$V raw` for those that do not, `$V hook` for installed hook scripts.
- Treat every command as literal; keep flags and quoted values unchanged.
- When editing this map, write the principal's home as `$HOME/.soma/...`. The tilde form of a Soma memory path is a private-source marker and the Soma write guard blocks the file.

## Proof and skip reporting

- CLI proof is the transcript entry: command, stdout, stderr, exit code (`$RUN/evidence/transcript.log`).
- Mutation proof includes a read-only second view (recall, list, show) and the file on disk.
- Record the feature ID and entry point with every artifact.
- An unreachable path is reported with the attempted command and the unmet precondition, never as verified through a different path.

## Feature entry contract

Each feature file has an H1, one paragraph of user-visible behavior, then exactly four H2s: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-soma.sh` (starting with `Preconditions:`), `Gotchas`.

## Features

- [Bootstrap and doctor](./bootstrap.md) — `soma init`, `soma doctor` on a fresh home.
- [Substrate projection](./install-projection.md) — `soma install|reproject|uninstall claude-code`, dry-run vs apply.
- [Memory](./memory.md) — `soma memory write|recall|reproject|audit`.
- [Algorithm runs](./algorithm-runs.md) — `soma algorithm classify|new|list|show|verify`.
- [Claude Code hooks](./claude-code-hooks.md) — the installed `soma-claude-code-hook.mjs` driven with substrate payloads.
