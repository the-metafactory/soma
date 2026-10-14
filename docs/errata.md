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
soma errata triage
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
result should be handed to `appendErrata(somaHome, result.errata)`.

## Triage

`soma errata triage` reads feedback candidates from the event log, including
rotated segments. Only `metadata.actor: "interactive"` with a nonempty
`redactedExcerpt` is eligible; other actors and missing excerpts count as
skipped. It never recovers raw complaint text from a transcript. Previously
judged event IDs are ignored, and overlapping triage jobs serialize their work.

An excerpt starting with `errata:` promotes directly, with backend
`explicit-marker`, version `1`. Otherwise headless `claude -p` classifies the
redacted excerpt as `promote` or `drop` with a short reason. The model is fixed
to `claude-haiku-4-5-20251001`; JSON schema output is validated again locally.
The invocation uses an empty temporary working directory, a replacement system
prompt, safe mode, no settings sources, no tools, no MCP servers, disabled hooks
and skills, and no session persistence. Authentication remains Claude's own.
No goal records or transcript content enter the classifier prompt.

Every verdict is recorded under caller `errata-triage` in the judge ledger,
with event ID, input hash, backend, CLI version (for `claude-p`) and link status.
The shared filesystem ledger lives in core (`src/judge-ledger.ts`); caller
registration and measurement remain in `src/judge.ts` behind the router boundary.
The caller starts in `shadow` for measurement; promotion is autonomous as
settled for node #849. Classification of the entire batch precedes any writes:
missing Claude, a nonzero exit or invalid output fails the run and leaves all
its candidates unjudged for the next attempt, including explicit markers.

Promotions go through the linker and private Errata append. Missing session or
transcript anchors count as unlinkable, and the verdict is still recorded.
The CLI cannot establish graph close-receipt session attribution, so its default
receipt reader returns `null`; Algorithm checks remain available. Callers can
inject an attributable receipt reader. If judgment persistence fails after an
Errata append, the next attempt reuses that rejection's session/turn/complaint
timestamp anchor. A vetoed Errata is preserved rather than recreated.

Each attempt calls the run-ledger funnel once with
`ran: {kind: "job", ref: "errata-triage"}`. Its `detail_ref` points at
`memory/STATE/errata/triage-runs/<run-id>.json`, containing outcome, timestamps
and promoted/dropped/skipped/unlinkable counts, never complaints or reasons.
The usual run-ledger configuration and outbox semantics apply. A failed triage
exits nonzero after reporting. Scheduling the daily invocation is operator work.

## Clusters

After a triage batch promotes, `clusterErrata` assigns every active, unclustered
Errata to a cluster (soma#785 Q15), appending one `clustered` event per Errata
to the same ledger. The cluster id is `EC<n>`; an Errata's `clusterId` never
changes afterwards. Keys, in order:

1. `check`: the same `passedBy` check and criterion (Algorithm run plus
   criterion, or close receipt).
2. `artifact`: a `passedBy: null` Errata sharing an artifact path with another
   null-link Errata, whether already clustered (in any cluster kind) or promoted
   in the same batch. Pending null-link Errata are grouped as connected sets
   over shared paths first, so three Errata on `a`, `b` and `a, b` form one
   cluster; a group touching an existing cluster joins it whole (the earliest
   cluster when it touches several). No judge is called. A linked Errata's paths
   never key a cluster.
3. `theme`: a null-link Errata nothing shares is given a theme by headless
   `claude -p` (same model and isolation as the verdict call). The judge sees the
   redacted complaint and the theme labels already in use; it reuses one or
   coins a new one. A label is at most 60 characters, one line, in Ivy's words.
   A label that quotes the complaint (the whole label, or any three consecutive
   words of it) is refused locally. Every theme verdict is recorded under caller
   `errata-triage` with `decision.verdict: "theme"`, the Errata and cluster ids
   and the label, before the `clustered` event is written. Labels match
   case-insensitively.

Clustering takes the ledger lock twice. First it applies and writes the
deterministic keys and lists the Errata nothing shares; then it releases the lock
while every one of those is judged, so readers never wait on a Claude call; then,
under the lock again, it re-reads the ledger and commits each verdict whose
Errata is still unshared (recording the judgment first). A verdict whose Errata
was dropped or keyed deterministically meanwhile is discarded. All themes of a
batch are judged before any theme is written. A judge failure, a refused label or
a judgment that cannot be recorded fails the triage run; the deterministic
assignments, already written, stand, and the themes are retried on the next run.
An explicit `errata:` marker therefore still promotes without Claude, but the run
reports failure until its theme is judged.

Ripeness (soma#785 Q16) is derived on read, never stored: a cluster is `ripe`
with one member whose `passedBy` is not null, or with two members whose
`complaintAt` dates, as Europe/Zurich calendar days, lie at most 30 days apart.
Dropped Errata are never clustered, drop out of their cluster's members and count
toward no threshold; a cluster with no active member is not reported.
`readErrataClusters(somaHome)` returns the folded clusters; the triage report and
`soma errata triage` output add `clustered` and `ripe` counts. Turning a ripe
cluster into a Vigil proposal is a later node.

`clusterErrata(deps)` accepts an injected clock, ledger reader and appender,
theme judge and judgment writer. `runErrataTriage(deps)` accepts an injected clock, event reader, classifier,
linker, Errata append, judge reader/writer and run publisher for deterministic
testing. Classifier input is only the redacted feedback string.
