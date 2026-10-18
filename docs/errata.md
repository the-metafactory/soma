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
registration and measurement remain in `src/router/judge.ts` behind the router boundary.
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
`soma errata triage` output add `clustered`, `ripe`, `proposed` and `unroutable` counts.

`clusterErrata(deps)` accepts an injected clock, ledger reader and appender,
theme judge and judgment writer. `runErrataTriage(deps)` accepts an injected clock, event reader, classifier,
linker, Errata append, judge reader/writer and run publisher for deterministic
testing. Classifier input is only the redacted feedback string.

## Proposals

A ripe cluster becomes one proposal file the principal can answer (soma#785 Q17/Q20,
soma#903 D2/D3/D9). Triage proposes after clustering, so a cluster this batch made ripe is
drafted in the same run.

The ref is `errata-<cluster-key>-g<generation>` and it is the dedup key: the same ref while
Vigil's item is open updates that item, and a new generation is the producer's act. The
cluster key is the cluster's own spelling — `check-<passedBy kind>-<run or repo>-<criterion>`,
`artifact-<path>`, or `theme-<label>` — folded to `[A-Za-z0-9._-]`: accented letters to their
base, anything else to one `-`, runs of separators collapsed, ends trimmed. Every key gets a
16-hex-character SHA-256 suffix over its ordered field array, preserving identity when
punctuation, accents or field separators fold to the same readable head. The head is trimmed
to keep the whole slug within 80 characters. Already minted refs remain as recorded in the
ledger for delivery and answers. The file sits at
`<soma-home>/proposals/<ref>.md` with front-matter that `soma graph file-proposal` reads —
`proposal_kind`, `landing`, `map_root`, `title`, `checkpoint: errata-<cluster-key>` and
`cites` — and it is validated through that same schema before anything is written. A
`deterministic-check` body is a build brief naming the check that should have caught the miss;
every other kind is the question that settles the standard. Triage never files the node: on
approve, cortex runs `soma graph file-proposal`.

The retro-style reading (soma#785 Q22) runs only for ripe clusters, over the turn each member
rejected: the principal's prompt and that turn's own words and tool calls, redacted and capped.
The transcript path is the one the session's capture recorded, since an Errata keeps only the
session and the turn. The call is the same isolated `claude -p` as the verdict and the theme —
an empty working directory, a replacement system prompt, no tools, no MCP servers, no hooks, no
session persistence — and no goal records or Soma home instructions enter it. The draft is
refused locally when its kind is not one of the five, when a `deterministic-check` lacks its
check or its brief or another kind lacks its question, when any field carries 41 or more
folded characters of a member's complaint (soma#785 Q23), or when a field names the Soma home,
a cluster session's working directory, or an absolute local path (POSIX with two or more
segments, Windows drive or UNC), home-relative path or file URI. Repository-relative paths,
public links, slash commands such as `/correct` and single-segment routes such as `GET /api`
remain usable.
Every cluster of a batch is drafted before any file
is written, using at most three concurrent planning workers. One refused draft stops new
planning, waits for the in-flight workers, and leaves the whole batch for the next run
without committing a file. A filesystem failure during the subsequent commits can leave
earlier proposals committed; their delivery remains pending.

What a cluster is owed is folded from the ledger, never stored:

| Last mint | Answer after it | Newer Errata joined | Triage writes |
| --- | --- | --- | --- |
| none | — | — | generation 1 |
| `proposed` | none | any | nothing: the item is still open |
| `proposed` | `expired`, `dismissed` or `resolved` | yes | the next generation |
| `unroutable` | — | yes | the report again |

Registering an `unroutable` cluster's named repo in `errata.landing` releases it for a
proposal on the next triage run, without requiring a new Errata. An unroutable report
does not consume a proposal generation.

Triage appends the `proposed` and `unroutable` events. The answer kinds — `resolved`,
`dismissed`, `expired` — are appended by the answer reader that drains Vigil's resolution
records; triage only reads them to decide what a cluster is owed.

Every committed `proposed` event also represents pending delivery. The next successful run
carries all pending refs as `proposal_refs` on its `execution.run.finished`, in the
`soma:proposals/<ref>.md` form myelin requires. A failed batch, report write, or delivery
before spooling leaves those refs pending; retry sends the existing files without drafting
or incrementing their generations. Publication and acknowledgments serialize across jobs.
After publication or confirmed outbox persistence, triage writes private receipt markers
under `memory/STATE/errata/proposal-deliveries/<ref>.delivered`. An answer also establishes
delivery. A crash between delivery and the receipt can resend a ref; it never remints it.
The run-ledger funnel reports `spooled` when it confirms the exact envelope's outbox entry
after a send failure. An unreachable bus therefore keeps delivery in the outbox, and the
proposal file stays written once.

`proposeFromCluster(deps)` is the seam for one cluster: injected transcript reader, repo
resolver, draft judge, clock, ledger reader and appender. `planClusterProposal` decides and
drafts without writing; `commitClusterProposal` writes the file and appends the event.

### Landing maps

Soma's config registers the maps a proposal may land on (soma#903 D11):

```yaml
errata:
  landing:
    the-metafactory/soma: 781
```

Each row has to read the way the proposal front-matter reads: `owner/repo` and a positive
integer root. The landing repo comes from evidence before any model runs — a member's close
receipt names its repo, otherwise the rejected turn's working directory answers with its
`origin` remote, and only a github.com remote names one. A ripe cluster whose repo the registry
does not register, or whose sessions name no repo at all, gets no proposal and costs no
inference. The run instead writes `<soma-home>/outputs/errata-unroutable-<date>.md` naming
every cluster still waiting for a landing map, carries it as the run's `result_ref`, and
appends `unroutable` so the same cluster is not planned again until a newer Errata joins it
or its repo gains a registered map.

Each `unroutable` event remains a pending notice until publication or confirmed spooling of
its `result_ref`. Under the same delivery lock as proposal refs, the next successful run
rebuilds its day's summary from the ledger, including every pending notice and the clusters
still waiting for a map. A failed summary write, run-report write or delivery before spooling
leaves the notice pending without appending another event or rereading transcripts. Private
receipts under `memory/STATE/errata/unroutable-deliveries/<event-hash>.delivered` acknowledge
each event separately, so a newer Errata can produce a fresh notice. The hash includes the
ledger position, cluster, repo and timestamp. A crash after delivery and before its receipt
may resend the notice; it cannot silently consume it.
