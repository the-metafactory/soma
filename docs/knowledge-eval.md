# Knowledge-orientation batches

`bun run knowledge-eval batch` runs the frozen fixtures through repeated hint
ladders using the isolated `knowledge-eval trial` runner:

```sh
bun run knowledge-eval batch --arms baseline,candidate --substrate claude \
  --home-source /private/eval-homes/baseline \
  --arm-home candidate=/private/eval-homes/candidate \
  --fixtures discover-reuse,recovery
```

`--home-source` supplies the default home for every arm; repeat
`--arm-home <label>=<dir>` to override a selected arm. Arm labels alone do not
change the treatment. `--fixtures <id,...>` selects fixtures; omitting it selects
all `.json` fixtures in sorted filename order under
`$SOMA_HOME/evals/knowledge-orientation/fixtures/`. Fixture schemas and the
supported substrates are the same as for `trial` (`claude` aliases `claude-code`,
`pi` aliases `pi-dev`; `codex` and `pi` are described below). The batch accepts
the trial options `--model`, `--soma-home`, `--timeout-ms`, `--probe-timeout-ms`,
`--claude-bin`, `--codex-bin`, `--pi-bin`, and `--keep`.

Each fixture gets three repeats per arm. Every repeat starts at H0. Each hint
level calls `runTrial` afresh, with its own isolated home and detached worktree;
only acceptance-probe failure advances to the next hint, through H3. Two arms
alternate at each active hint level within a fixture-repeat (A H0, B H0, A H1,
B H1, …); an arm stops as soon as it passes or errors. The score is the lowest
passing hint, `fail` after H3, or `errored` when the trial errors. An error stops
that ladder and remains visible; it does not become an acceptance failure.

Spread is maximum minus minimum hint rank, with `fail` ranked 4, one step beyond
H3. If either arm's first three repeats have spread greater than 1, both arms
get two more repeats for that fixture. Errors are excluded from hint median
and spread; an entirely errored arm has `unmeasured` statistics. Fractional
medians are ordinal midpoints; rank 4 is displayed as `fail`.

Fixture bytes are snapshotted before the first trial. The batch stores the
first trial's observed model id and CLI name/version; any later difference
aborts immediately and writes a partial report. An unknown CLI version also
aborts. Fixture identity/hash drift aborts rather than mixing evidence. Arms
are compared only within this batch; there is no cross-batch comparison or
accept/reject threshold.

Results stay in the private store, in a new
`$SOMA_HOME/evals/knowledge-orientation/batches/batch-*/` directory, or a new
directory named by `--out` inside that store. Existing directories are refused.
`report.json` holds the ordered trial log, original fixture paths/hashes and
snapshots, repeat scores, and summaries. `report.md` lists each fixture and arm,
scores, median, spread, errors, token medians, duplicates, and sources read.
Individual trial records and transcripts live under `trials/`.

Token medians cover all attempted fresh trials, including unsuccessful hint
levels; a missing token measurement makes that median `unmeasured`. Duplicate
and sources-read counts sum all attempted hints, with counts per repeat also
retained. These count observed occurrences, not unique sources across repeats.
A trial that throws before returning telemetry leaves its counts `unmeasured`.
The CLI exits 0 for a completed batch without errors, 1 for an aborted batch or
errored repeats, and 2 for usage errors.

## Codex substrate

`--substrate codex` runs each trial through `codex exec --json` instead of
Claude. The model defaults to the one ranger dispatches on Codex (`gpt-6.1-sol`,
effort `high`, set with `-c model_reasoning_effort`), never the caller's
`config.toml`. Compare only within one substrate and model; there is no
cross-substrate pass/fail.

- The trial home gets the Soma Codex projection from `soma install codex --apply
  --soma-home <tmp> --home-dir <tmp> --substrate-home <tmp>/.codex`, and the run
  sets `CODEX_HOME` to that directory. The command is
  `codex exec --json -C <worktree> -m <model> --sandbox workspace-write
  --add-dir <cache repo> -`, with the prompt on stdin.
- Auth: Codex reads `auth.json` from `CODEX_HOME`. A caller `CODEX_API_KEY` or
  `OPENAI_API_KEY` is passed to the substrate alone; otherwise the caller's
  `auth.json` (from `$CODEX_HOME`, else `~/.codex`) is copied into the trial
  home. The principal's Codex home is only read, and nothing else is copied.
  A ChatGPT login refreshed inside the trial rotates tokens in the copy only.
- The record carries CLI `codex` and its `--version`. `total_tokens` is input
  plus output from the stream's `turn.completed` usage (input already includes
  cached tokens). `start_of_session_tokens` is the first model call's input,
  read from the `token_count` events of the session rollout Codex writes under
  the trial's `CODEX_HOME/sessions`; the exec stream alone carries one
  cumulative usage and cannot give it. Without usage the field is `unmeasured`.
- Tool use is read from `command_execution` (as `Bash`, with the `sh -lc`
  wrapper removed; a non-zero exit is a failed call) and `file_change` (as
  `Edit`) items. An edit made through a shell command is not an edit, as for
  Claude.
- `codex` missing or not running refuses the trial or batch before anything is
  cloned (`--codex-bin <path>` names another binary).

## pi substrate

`--substrate pi` runs each trial through `pi --print --mode json`. The model
defaults to the provider and model ranger dispatches on pi
(`spark/longctx-think`, passed as `--provider spark --model longctx-think`),
never the caller's pi settings. Compare only within one substrate and model.

- The trial HOME gets the Soma pi projection from `soma install pi-dev --apply
  --soma-home <tmp> --home-dir <tmp-home>`, and pi runs with `HOME=<tmp-home>`,
  so its extension reads `$HOME/.pi/agent/soma`. The command is
  `pi --print --mode json --no-session --provider <p> --model <id> -- <prompt>`,
  run in the worktree.
- Provider: pi registers custom providers, with their endpoints and keys, in
  `~/.pi/agent/models.json`, so a fresh HOME knows none of them. The trial copies
  only the pinned model's provider entry from the caller's `models.json`
  (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`) into
  `<tmp-home>/.pi/agent/models.json`, mode 0600. Nothing else of the caller's pi
  configuration is copied, and the caller's `~/.pi` is only read. The copy is
  removed with the trial workdir; `--keep` keeps it.
- The record carries CLI `pi` and its `--version`. Each assistant `message_end`
  carries that call's usage, with cached input in `cacheRead` and `cacheWrite`,
  apart from `input`. `start_of_session_tokens` is the first call's input plus
  cached input; `total_tokens` sums every call's input, cached input and output.
  A usage that is absent or all zeros is `unmeasured`.
- Tool use is read from `tool_execution_start` (`bash`, `read`, `edit`, `write`
  and `grep` map onto `Bash`, `Read`, `Edit`, `Write` and `Grep`). A
  `tool_execution_end` with `isError` marks its call failed, matched by
  `toolCallId` because parallel calls end out of order.
- Before anything is cloned, `pi --version` must run and `pi auth check
  --provider <p> --model <id> --json --no-refresh` must pass in a throwaway HOME
  built the same way; otherwise the trial or batch refuses (`--pi-bin <path>`
  names another binary). The check proves the provider is registered with a
  key, not that the key works.
