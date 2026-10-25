---
name: verify-soma
description: Drive the real soma CLI (bun src/cli.ts) from this checkout against a disposable HOME and capture proof — init, install/uninstall projections, memory write/recall/reproject, Algorithm runs, the installed Claude Code hooks. Use when a change to soma must be shown working in the real CLI, not only in bun test.
---

# verify-soma

A repo-local Claude Code skill (not a Soma skill: it is not projected by `soma install`).

Soma's user surface is the `soma` CLI plus the files it projects into a substrate home (`~/.claude/rules/soma/`, hooks in `settings.json`, skill symlinks). Verification runs the CLI from this checkout against a scratch `HOME`, never the principal's `~/.soma` or `~/.claude`.

Secondary surfaces, not covered here: `bun run dashboard` (mission dashboard, WIP on `feat/mission-dashboard`), and `soma graph` (talks to real GitHub/GitLab work graphs; never drive it against a real map, use a throwaway root).

All steps go through one helper, run from the repo root:

```sh
V=.claude/skills/verify-soma/scripts/verify-soma.sh
RUN=<scratch-dir>/verify-soma-$(date +%Y%m%d-%H%M%S)   # absolute path; outside the repo
```

The helper sets `HOME=$RUN/home`, unsets `SOMA_PRINCIPAL` (no bus publishing), `SOMA_HOME` and `PAI_DIR`, and passes `--home-dir $RUN/home --soma-home $RUN/home/.soma`.

## Launch

```sh
$V launch "$RUN"
```

Runs `soma init --apply --substrate claude-code` into the scratch home: Soma home skeleton, starter profile, bundled skills, then the claude-code projection (rules, hooks, settings). Ready when it prints `READY run=<dir>`; it checks `$RUN/home/.claude/rules/soma/CONTEXT.md` exists. Takes about a second. There is no server: every drive is a fresh CLI process. Refuses to reuse a run dir that already has a home.

Isolation: each run dir is independent; two agents can drive side by side with different `$RUN`s.

## Doctor

```sh
$V doctor "$RUN"
```

Read-only. Checks the run dir was made by `launch`, the scratch Soma home and projection exist, `soma --version` equals `package.json` (so you drive this checkout, not an installed `soma`), and every soma hook path in `settings.json` sits under the scratch home (none at all, or any outside it, fails). Exit 0 = worth driving.

The product's own `soma doctor` (`$V soma "$RUN" doctor --substrate claude-code`) reports `drift detected` on a fresh home (`starter-profile`, `claude-skills-not-migrated`) and still exits 0. That is expected, not a failure.

## Drive

```sh
$V soma "$RUN" <subcommand> [args...]   # appends --home-dir/--soma-home
$V raw  "$RUN" <subcommand> [args...]   # isolated env, no home flags (algorithm classify, policy check)
$V hook "$RUN" <event> '<json>'         # pipe a substrate payload into the installed hook script
```

Recipes per feature are in [features/README.md](features/README.md). Stable handles are CLI subcommands, flags, output labels (`path:`, `id:`, `reindexed:`) and file paths under the scratch home.

## Evidence

Every `soma`/`raw`/`hook` call appends the command, stdout, stderr and `[exit N]` to `$RUN/evidence/transcript.log`. For state proof, copy the files the command wrote into `$RUN/evidence/` (`cp "$RUN/home/.soma/memory/semantic/<id>.md" "$RUN/evidence/"`) before cleanup.

Proof standards:

- Prove a write with a second, read-only view: `memory write` → `memory recall` and the projected `MEMORY.md`; `algorithm new` → `algorithm list`/`show` and the run JSON.
- Prove side effects in files, not only stdout: `grep` the projected file or event log.
- `--dry-run` claims "no changes written": confirm with `find "$RUN/home" -newer <marker>`, not the label.
- Exit codes: never read `$?` after a pipe (`cmd | tail` reports `tail`'s code). The helper's transcript records the real code.
- Run `$V real-home-check "$RUN"` at the end. It makes two checks, and its claim is only as wide as they are:
  1. Files and symlinks changed since launch (mtime) in the principal's Soma home (outside `memory/STATE`) and in every surface the claude-code projection writes: `rules/soma/`, `hooks/soma/`, `skills/`, `settings.json`. Anything listed: inspect before claiming isolation; a live session can touch `rules/soma/MEMORY.md` too.
  2. New lines in the principal's `memory/STATE/events.jsonl` since launch that name this run dir or a session id the run sent through `hook`. Those fail the check. Other new lines are counted, not attributed: the live session writes there continuously, so a leaked event that names neither (a bare `memory.recall`) is not caught. Other `memory/STATE` files are not checked.

## Cleanup

```sh
$V cleanup "$RUN"
```

Removes `$RUN/home` and the marker only. Evidence stays at `$RUN/evidence/`. Refuses a dir that `launch` did not create. No processes to kill: the CLI exits after each call.

## Helpers

- `scripts/verify-soma.sh` — all commands above. Usage line: `verify-soma.sh <launch|doctor|soma|raw|hook|real-home-check|cleanup> <run-dir> [args...]`.
