# Judge labels and enforcement

`soma judge stats --json` includes ledger judgments with their `id`, caller,
decision, and backend version. `--caller <id>` and `--since <YYYY-MM-DD>` filter
judgments by caller and judgment date. Judgment inputs remain hashed.

`soma judge label <judgment-id> --right` records that the principal agrees with
the judgment. `--wrong` records disagreement. Exactly one verdict is required.
`SOMA_PRINCIPAL` must contain the principal's identity. An unknown or ambiguous
ID, a missing principal, or a write failure exits nonzero. `--json` returns the
stored label. Both commands accept `--soma-home <dir>` or `--home-dir <dir>`.

Judgments live in `memory/STATE/judgments/ledger.jsonl`. New records have IDs.
For older records, the reader derives an ID from the original line and its
line number. Appending judgments preserves those IDs. Rewriting or reordering
legacy lines changes them. Labels append to `memory/STATE/judgments/labels.jsonl`
with the judgment ID, timestamp, principal, verdict, and `source: principal`.

`soma judge stats` reports the labeled count and agreement per caller.
Agreement is right labels divided by labeled judgments, or `n/a` when none are
labeled. The latest appended principal label for each judgment counts once.
Model labels and malformed labels do not count. Malformed label counts appear
in both text and JSON output. Labels for absent judgments do not affect stats.
An unreadable label file is an error.

`JUDGE_REGISTRY` defaults to `minLabels: 20` and `enforceBar: 0.9` per caller.
An entry can override either threshold. Its registry test permits `enforce`
only when `measuredOn.labelSource` is `principal`, `principalLabels` meets
`minLabels`, and `agreement` meets `enforceBar`. Measurements also identify
their date, backend, and backend version. Model measurements cannot qualify.
Recording labels does not change caller state or populate `measuredOn`.
