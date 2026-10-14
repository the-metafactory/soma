# Errata ledger and linker

An Errata records a principal rejection of a delivered output. Its anchor is
`sessionId` plus `rejectedTurnUuid`; it stores artifact paths and an optional
`passedBy` reference, never assistant output content. Complaints share feedback's
secret-redaction patterns and are capped at 2,000 characters after redaction.

Private state lives at `<soma-home>/memory/STATE/errata/ledger.jsonl`. Creation
and veto are appended events; a directory lock serializes allocation and append
across processes. A torn or invalid ledger refuses writes rather than risking
id reuse. A writer that dies holding the lock requires operator recovery; the
next writer times out rather than stealing the lock.

```sh
soma errata list
soma errata list --all --json
soma errata drop E2
```

`linkErrataCandidate({ candidate, readTranscript, readRuns, readCloseReceipts })`
is read-only. The transcript reader defaults to a local JSONL file; the run
reader defaults to the Algorithm store. The last assistant UUID before the
complaint anchors the rejection. Edit, Write, MultiEdit and NotebookEdit calls
in that delivered response provide paths; tool-result user entries do not start
a new principal turn. Absolute paths under the transcript's working directory
are normalized relative to it.

Only structured Algorithm passes in the same session, before the rejected
turn, whose historical evidence names an artifact qualify. The close-receipt
reader supplies receipts attributable to the session's time window and the
files touched by their PRs. It returns `null` when attribution is ambiguous;
the linker reports `receipt-session-unattributable` for the caller to escalate
and considers no receipt passes. The latest qualifying pass across both kinds
wins; otherwise `passedBy` is null.

A missing transcript returns `unlinkable: transcript-missing` and reads no
checks. The caller can continue processing other candidates. Only a linked
result should be handed to `appendErrata(somaHome, result.errata)`. Classification
and scheduled processing belong to separate nodes.
