# Daily Errata triage activation

Operator verification for node #850, checkpoint
`mfp-errata-triage-activation`, on 2026-10-30.

The personal Reflex already has the activation installed. This work corrects
its manual-fire comment and records the live verification. It adds no schedule
or runtime code to Soma or Reflex.

## Installed configuration

The operator files remain outside this repository:

- `~/.config/reflex/personal.yaml` selects the personal activations directory.
- `~/.config/reflex/personal-activations/errata-triage.yaml` declares the daily
  `errata-triage` activation at `40 6 * * *`, Europe/Zurich, with policy `auto`
  and a one-hour cooldown. `errata-triage-manual` is its manual counterpart.
- `~/.config/cortex/default/stacks/default.yaml` maps their shared target,
  `@jc/errata-triage`, to the `errata-triage` process.
- `~/.config/cortex/default/processes/errata-triage.yaml` runs
  `soma errata triage` with the principal's `SOMA_PRINCIPAL`, `SOMA_STACK`,
  `SOMA_NATS_URL`, and `SOMA_NATS_CREDS` settings. Credential contents remain local.

The goal sweep uses a different activation, target, and process. Its daily
schedule remains `45 6 * * *`, Europe/Zurich. Neither process invokes the other.
There is no triage-success dependency or shared run lock in these activations.

## Live evidence

`reflex validate` accepted all 39 personal activation blueprints. The running
personal Reflex listed both triage entries and both sweep entries.

The manual fire used:

```sh
REFLEX_CONFIG="$HOME/.config/reflex/personal.yaml" reflex fire errata-triage-manual --json
```

The daily entry accepts scheduled impulses. The manual entry is the correct
test seam. The operator comment now names that entry.

The manual fire returned `fired` with decision
`bf25dc2f-0e68-4066-9645-156c189bf91f` and correlation
`4a90b814-34ed-4968-8e4c-788273c21a68`.
Triage ran from `2026-10-30T19:10:24.468Z` to
`2026-10-30T19:10:32.830Z`.

The principal's `memory/STATE/run-ledger/outbox.jsonl` contained exactly one
`put` with that correlation, followed by an `ack` for the same envelope:

| Field | Observed value |
| --- | --- |
| Envelope ID | `01d06a0a-b881-44d3-8d83-0071f94f4910` |
| Subject | `local.jc.default.execution.run.finished` |
| Type | `execution.run.finished` |
| Source | `jc.default.soma` |
| Run ID | `acffbec3-f711-4650-aa67-3a3e787682dc` |
| `ran` | `{ "kind": "job", "ref": "errata-triage" }` |
| Outcome | `succeeded` |

The matching private report is
`memory/STATE/errata/triage-runs/acffbec3-f711-4650-aa67-3a3e787682dc.json`.
Existing reports also record scheduled starts at 06:40 Europe/Zurich on
October 29 and 30. These reports corroborate scheduling; the correlated manual
fire supplies the observed envelope evidence.

## Failure isolation

A foreground probe ran the repo CLI against a temporary Soma home containing
a corrupt judgment ledger. A test principal and an unreachable loopback bus
kept the probe outside the principal's ledger and bus. The CLI exited `1`
and persisted exactly one outbox envelope with `ran.ref: "errata-triage"`
and `outcome: "failed"`. The temporary state was removed afterward.

The installed CLI wrapper requires runtime state in its selected Soma home,
so the temporary-home probe uses `bun src/cli.ts`. The successful live fire
above uses the installed runtime through Cortex.

`bun test --timeout=60000 test/flows/errata-triage.test.ts` passed all 14 tests,
including the real run-ledger envelope contract for successful, empty, and
failed attempts. The running Reflex separately listed `goal-sweep-daily`
after the manual fire. Failure injection did not alter either live process.
This verifies failure reporting and configuration independence; it does not
claim a deliberately failed live scheduled run followed by a scheduled sweep.

## Repository checks

The required full host run, `bun run test && bun run typecheck`, ran once.
Tests finished with 4,197 passes and two timeouts across 225 files:

- `test/knowledge-eval-batch.test.ts`: “CLI dispatch runs the real isolated
  trial and projection against a local substrate stub” exceeded 120 seconds.
- `test/content-compare-doctor.test.ts`: “reprojecting every doctor-supported
  substrate twice is byte-identical, headers included” exceeded 60 seconds.

At test time, `HEAD` was base commit
`4e666d16401cf47ce36ee6230561a132688819ba`. Source, tests, scripts, manifests,
and lockfile were unchanged, confirmed with `git diff --exit-code HEAD -- src
test scripts package.json bun.lock`. The only repository addition was this
document. A separate rerun of both files on that same base source and Bun
1.4.2 finished with 28 passes and the same reprojection timeout. Batch dispatch
passed in isolation. The underlying timeout causes remain undiagnosed.

The failed full test command skipped its chained typecheck.
`bun run typecheck` then passed separately. The node uses the SOP's exception
for failures on unchanged base code and leaves those tests untouched.
