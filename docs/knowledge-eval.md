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
supported substrate are the same as for `trial` (`claude` aliases `claude-code`).
The batch accepts the trial options `--model`, `--soma-home`, `--timeout-ms`,
`--probe-timeout-ms`, `--claude-bin`, and `--keep`.

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
