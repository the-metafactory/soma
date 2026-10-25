# Bootstrap and doctor

A new principal runs `soma init` to create a Soma home (identity, purpose, memory, skills, policy) and project it into a substrate, then `soma doctor` to see what still drifts from a real profile.

## Sub-features

- `init-plan` prints the plan without writing (`--dry-run`).
- `init-apply` creates the home skeleton and installs the chosen substrate.
- `doctor-fresh` reports starter-profile drift on a fresh home.

## How to get to it (user POV)

- `soma init [--dry-run|--apply] [--substrate <id>]`
- `soma doctor [--substrate <id>]`

## Driving it with verify-soma.sh

Preconditions:

- A new `$RUN` with no `home/` yet (for `init-plan`, create `$RUN/home` empty by hand first and touch a marker).

- **Plan.** `mkdir -p "$RUN/home" && touch "$RUN/m" && $V raw "$RUN" init --dry-run --substrate claude-code --home-dir "$RUN/home" --soma-home "$RUN/home/.soma"`. Output starts `soma init — plan (dry-run`; `find "$RUN/home" -newer "$RUN/m"` lists nothing but bun's cache. Remove `$RUN/home` before the next step.
- **Apply.** `$V launch "$RUN"`. Transcript shows `bootstrap-soma-home: applied` and `install-claude-code: applied (N files)`, exit 0.
- **Doctor.** `$V soma "$RUN" doctor --substrate claude-code`. Prints `drift detected` with `starter-profile` and `claude-skills-not-migrated`, exit 0.

## Gotchas

- `HOME=$RUN/home` makes bun create `$RUN/home/Library/Caches/bun`; ignore it in "nothing written" checks.
- Without `--substrate`, init installs `codex`.
- `init` detects a PAI install via `PAI_DIR`; the helper unsets it so a fresh home stays fresh.
