# Substrate projection

`soma install <substrate>` projects the Soma home into a substrate's native files: for claude-code, `rules/soma/*.md`, hook scripts under `hooks/soma/`, hook entries in `settings.json`, and skill symlinks. `reproject` rewrites them from the current home; `uninstall` removes them and leaves the Soma home.

## Sub-features

- `install-dry` lists the plan, writes nothing.
- `install-apply` writes the projection.
- `reproject` rebuilds an existing projection.
- `uninstall` removes projected rules, hooks, settings entries and skill links; `~/.soma` stays.

## How to get to it (user POV)

- `soma install claude-code [--dry-run|--apply] [--claude-md] [--skills a,b]`
- `soma reproject claude-code`
- `soma uninstall claude-code`

## Driving it with verify-soma.sh

Preconditions:

- `$V launch "$RUN"` done (claude-code already installed).

- **Uninstall.** `$V soma "$RUN" uninstall claude-code`. Lists removed paths. Then `ls "$RUN/home/.claude/rules"` is empty and `grep -c soma "$RUN/home/.claude/settings.json"` prints `0`; `ls "$RUN/home/.soma"` still shows `memory/ policy/ profile/`.
- **Dry run.** `touch "$RUN/m"; $V soma "$RUN" install claude-code --dry-run`. Prints `Soma install PLAN (no changes written)`; `find "$RUN/home/.claude" -newer "$RUN/m"` is empty.
- **Apply.** `$V soma "$RUN" install claude-code --apply`. `$RUN/home/.claude/rules/soma/CONTEXT.md` exists again and `settings.json` hook commands reference `$RUN/home/.claude/hooks/soma/soma-claude-code-hook.mjs`.
- **Reproject.** Edit nothing, run `$V soma "$RUN" reproject claude-code`; projected files are byte-identical (`shasum` before/after) — install is idempotent.

## Gotchas

- Hook commands in `settings.json` embed the absolute bun path of the machine that installed them.
- With `--soma-home` but no `--home-dir`, substrate writes land under `<soma-home>/.substrate-home`; always pass both (the helper does).
- `--claude-md` also writes `CLAUDE.md` in the substrate home; leave it off unless that is the feature under test.
