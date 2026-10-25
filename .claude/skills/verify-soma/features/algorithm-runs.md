# Algorithm runs

The Algorithm is Soma's working method: a prompt is classified into a mode and effort tier, and a run records goal, criteria, phase, decisions and verification under the Soma home.

## Sub-features

- `alg-classify` maps a prompt to `{mode, effort, source, reason}`.
- `alg-new` creates a run in phase `observe`.
- `alg-list-show` lists and shows runs.
- `alg-verify` records a criterion result; `passed` needs `+probed`/`+tested` evidence.

## How to get to it (user POV)

- `soma algorithm classify --prompt <text> [--json]`
- `soma algorithm new --prompt … --intent … --current-state … --goal … --criterion "C1:…" [--effort E1]`
- `soma algorithm list`, `soma algorithm show --id <id>`
- `soma algorithm verify --id <id> --criterion-id C1 --status passed --evidence <text> --evidence-kind probed`

## Driving it with verify-soma.sh

Preconditions:

- `$V launch "$RUN"` done; no runs exist.

- **Classify.** `$V raw "$RUN" algorithm classify --prompt "refactor the install pipeline across modules" --json`. JSON with `"mode":"algorithm"` and an `effort`.
- **New.** `$V soma "$RUN" algorithm new --prompt "probe" --intent "verify skill probe" --current-state "none" --goal "a run exists" --criterion "C1:run file written" --effort E1 --substrate claude-code`. Prints `id: <date>-verify-skill-probe`, `phase: observe`, and a `path:` under `memory/WORK/algorithm-runs/`.
- **List.** `$V soma "$RUN" algorithm list`. Shows `<id>: observe 0/1 E1 - a run exists`.
- **Verify.** `$V soma "$RUN" algorithm verify --id <id> --criterion-id C1 --status passed --evidence "run json exists" --evidence-kind probed`; then `algorithm show --id <id>` reports C1 passed.
- **Proof.** Copy the run JSON from `memory/WORK/algorithm-runs/` into `$RUN/evidence/`.

## Gotchas

- The run id is derived from the date and `--intent`; a second `new` with the same intent on the same day collides.
- `new` sets `memory/STATE/active-algorithm-run.json`; later runs and hooks read it.
- `--status passed` with `--evidence-kind specified` is rejected; that is the hollow-pass guard, not a bug.
