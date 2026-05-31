# Soma Home Replication

Issue #146 asks for cross-machine access to the same Soma state. The
implementation term is **home replication**: exchanging eligible Soma home
state between machines while preserving `~/.soma/` as the local source of truth
and keeping projection/writeback semantics unchanged.

The issue uses the familiar word "sync", but Soma avoids that as a core term
because it hides direction, authority, privacy, and conflict behavior. Home
replication is explicit about what can move, when it can move, and what happens
when two machines edit the same durable artifact.

## Goals

- Let a principal carry one Soma home across laptop, VM, and future
  daemon-backed use.
- Preserve the existing filesystem-native home contract: profile, Telos,
  memory, skills, policy, Algorithm runs, and ISAs remain plain files.
- Reuse Git history and the snapshot/rollback safety net before applying remote
  changes.
- Merge append-only state deterministically where Soma already has merge
  semantics.
- Refuse or surface conflicts for durable files that do not yet have a
  store-specific merge rule.
- Gate every replicated path through Policy so private compartments and secrets
  do not leak to a remote by default.

## Non-Goals

- Home replication is not a live overlay, shared filesystem, or substrate
  projection refresh.
- Home replication does not let substrates directly edit durable memory stores.
  Substrate-originated changes still enter through the writeback gate.
- The first backend does not need S3, Turso, or another hosted service.
- The first implementation does not automatically reconcile arbitrary Markdown
  conflicts in `KNOWLEDGE`, `RELATIONSHIP`, `LEARNING`, `WORK`, profile, Telos,
  skills, policy, or ISA files.
- Home replication does not copy raw prompts, transcripts, full tool inputs, or
  command output unless a future policy explicitly allows that path.

## Model

Each machine has a local Soma home and an optional replica identity:

```text
~/.soma/
  .git/
  .soma-replica.json
  profile/
  memory/
  skills/
  policy/
  isa/
```

The local home is authoritative while a machine is running. The remote is an
exchange surface and audit history, not a daemon and not the global source of
truth. Replication happens only when a principal or substrate invokes a
replication operation.

The first backend should be Git-backed because Soma homes are already
filesystem-native and snapshots already initialize safe Git repositories. A
later cloud backend may implement the same exchange contract, but it must not
change conflict or privacy semantics.

## Replication Scopes

Replication operates on explicit scopes. The first implementation should expose
these scopes in status output and config instead of silently pushing the whole
home.

| Scope | Default | Merge rule |
| --- | --- | --- |
| `identity` | eligible | normal file, conflict surfaced |
| `telos` | eligible | normal file, conflict surfaced |
| `skills` | eligible | normal file, conflict surfaced |
| `policy` | eligible | normal file, conflict surfaced |
| `isa` | eligible | normal file, conflict surfaced, append-only logs can be merged later |
| `state-events` | eligible | append-only event union by event id |
| `work-state` | eligible | session-keyed metadata merge for work registry and current-work pointers |
| `learning` | opt-in | normal file, conflict surfaced until promotion merge rules exist |
| `knowledge` | opt-in | normal file, conflict surfaced until citation merge rules exist |
| `relationship` | opt-in | private by default, conflict surfaced |
| `raw` | off | never replicated by default |
| `security` | off | never replicated by default |

Eligible does not mean public. It means the scope may be replicated after the
configured remote, path policy, and secret guard all allow the specific path.

## Privacy Gate

Before a path enters a replication commit or export bundle, Soma runs a
replication policy check:

1. The path must be inside the Soma home.
2. The path must match an enabled replication scope.
3. The path must not match snapshot safety ignores such as `.env`, key files,
   token files, `.ssh/`, `.aws/`, `.secrets/`, or `secrets/`.
4. The path must not be generated projection output.
5. Private scopes such as `relationship`, `raw`, and `security` require an
   explicit allow rule naming the scope and remote.

Policy refusal fails closed. A replication operation should return a report
listing refused paths by category without printing secret file contents.

## Operation Flow

The first CLI surface should be:

```bash
soma replicate init --remote <git-url>
soma replicate status
soma replicate pull
soma replicate push
soma replicate exchange
```

`pull` and `exchange` must create a Soma snapshot before applying remote state.
`push` must create a Soma snapshot before staging and publishing eligible local
state. `exchange` is shorthand for pull then push with the same safety checks.
`status` must show the configured remote, replica id, enabled scopes,
uncommitted local changes, pending remote changes, refused paths, and conflicts.

No operation should refresh substrate projections automatically. After a
replication operation changes the home, the principal or substrate still runs
`soma reproject <substrate>` or `soma install <substrate> --apply` when a
projection refresh is needed.

## Conflict Rules

Home replication has three conflict classes.

### Append-Only State

`memory/STATE/events.jsonl` merges by event id. A merge keeps the first valid
event for an id, drops exact duplicate ids, preserves malformed rows in a
conflict report, and writes a deterministic file order:

1. valid events sorted by timestamp when present
2. ties ordered by event id
3. rows without timestamps ordered by original replica/source order

This is safe because the writeback gate already treats events as an audit log
and inbox, not durable learned truth.

### Session-Keyed Work State

`memory/STATE/work.json`, `memory/STATE/session-names.json`, and
`current-work-*.json` may merge by session id, run id, or pointer filename
because DD-5 and DD-6 made those files metadata-only continuation state.
Conflicting values for the same key must be reported, not silently overwritten.

### Durable Memory And Profile Files

Files in profile, Telos, skills, policy, ISA bodies, `KNOWLEDGE`, `LEARNING`,
`RELATIONSHIP`, and `WORK` are normal durable artifacts. Until a store has a
specific merge rule, concurrent edits are conflicts. The first implementation
should keep both sides reachable through Git history and write a bounded
conflict report under `memory/STATE/replication-conflicts.json` instead of
choosing last-writer-wins.

## Backend Boundary

The Git backend owns transport:

- initialize or reuse the Soma home repository
- set and inspect a remote
- fetch remote refs
- stage only policy-eligible paths
- commit replication changes with replica metadata
- push or pull refs

Soma core owns semantics:

- scope eligibility
- policy checks
- snapshot creation before applying remote changes
- append-only event merge
- work-state merge
- conflict reports
- refusal messages

Hosted backends such as S3 or Turso must implement the same semantic contract.
They may optimize transport, but they must not invent weaker privacy or
conflict rules.

## First Implementation Slice

The first code slice should add the Git-backed CLI and library surface without
attempting full durable-memory auto-merge:

- `soma replicate init --remote <git-url>` stores remote and replica metadata.
- `soma replicate status` reports scopes, dirty state, pending remote changes,
  refused paths, and conflicts without mutating files.
- `soma replicate pull` snapshots first, fetches remote state, merges
  append-only state events, merges session-keyed work state, and reports
  durable-file conflicts.
- `soma replicate push` stages only policy-eligible paths and refuses if
  unresolved conflicts remain.
- Tests cover secret refusal, raw/security default refusal, event-log union,
  work-state keyed conflict reporting, snapshot-before-pull, and no projection
  refresh side effects.
