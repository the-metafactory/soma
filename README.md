<!--
  Soma
-->

<p align="center">
  <img src="docs/diagrams/2026-05-16-soma-nautilus.jpg" alt="Soma, chambered nautilus, the durable portable self" width="320" />
</p>

<h1 align="center">Soma</h1>

<p align="center">
  <strong>Soma lets you change tools without losing the assistant.</strong>
</p>

<p align="center">
  Your assistant's identity, purpose, memory, skills, and working method kept in one place —<br />
  projected into Claude Code, OpenAI Codex, Pi.dev, Cursor, and future substrates.
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.26.0-2A3F6A?labelColor=0E1726" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-2A3F6A?labelColor=0E1726" />
  <img alt="Runs in" src="https://img.shields.io/badge/runs%20in-Codex%20%C2%B7%20Pi.dev%20%C2%B7%20Claude%20Code%20%C2%B7%20Cursor-2A3F6A?labelColor=0E1726" />
</p>

<p align="center">
  Soma is <a href="https://meta-factory.ai">Meta Factory</a>'s first Arc-distributed package.<br />
  Join the Meta Factory community on <a href="https://discord.gg/32xa5ev6Tq">Discord</a>.
</p>

---

## Current release: 0.26.0

[0.26.0](https://github.com/the-metafactory/soma/releases/tag/v0.26.0) adds
selected-section graph reads and safe node editing, preserves Resolution
headings on close, and routes task notices and ranger escalations to NATIVE.
It also ships bounded graph audits, safer frontier and blocker handling,
bundled skills in compiled binaries, and isolated scratch-home lifecycle writes.
See the [changelog](CHANGELOG.md#0260---2026-10-11) for the complete changes.
GitHub releases and Arc registry publication are verified separately.

### 0.25.0

[0.25.0](https://github.com/the-metafactory/soma/releases/tag/v0.25.0) stops
`soma graph add --blocked-by` from exposing a new node on the frontier before
its blockers land. A walker claimed one in that window. `add` now writes every
blocking edge first and attaches the node to its parent last, on GitHub and
GitLab. If an edge or the attach fails, the node is left unattached, so it is on
no frontier, and the error prints the repair: the new
`soma graph link <id> --parent <id>`. `soma graph claim` refuses a node with an
open blocker. A partly wired `add --json` now reports `attached: false` in
place of `held`. Library users take note: `GraphStore` requires
`attachToParent`, so a store implemented outside soma must add it (#740). See
the [changelog](CHANGELOG.md#0250---2026-10-07). This version is published on
GitHub only; the Arc registry is not updated by this release.

### 0.24.0

[0.24.0](https://github.com/the-metafactory/soma/releases/tag/v0.24.0) lets a
work-graph node wait on another repo's node and stops `soma graph add` from
leaving a node half-wired. `--blocked-by` accepts `owner/name#N` on the same
forge and host, and the blocker reads back with its repo; the GitHub store still
writes only to its own repo (#749). `add` reads every blocker before it creates
the node; if an edge still fails, the node is claimed so it stays off the
frontier, and the error prints the command that finishes the wiring (#750). The
new `soma graph link` adds blocking edges to an existing node (#703). `close
--dry-run` now refuses a closed node like the real close, `audit` includes the
root node, and orienteer forbids closing keywords in a PR that delivers a node
(#747). See the [changelog](CHANGELOG.md#0240---2026-10-07). This version is
published on GitHub only; the Arc registry is not updated by this release.

### 0.23.1

[0.23.1](https://github.com/the-metafactory/soma/releases/tag/v0.23.1) adds a
build-node brief to the orienteer skill and fixes receipt counting in the work
graph. A new `references/build-brief.md` sets the template and rules for a build
node's body: nothing left to decide, Given/When/Then acceptance criteria with a
failure case and a test seam, an out-of-scope list that binds review, and one
vertical slice per node. `soma graph audit` and `decisions --write` again count
close receipts written before receipts carried an autonomy line, so those closes
are no longer reported as receipt-less (#744). See the
[changelog](CHANGELOG.md#0231---2026-10-05). This version is published on
GitHub only; the Arc registry is not updated by this release.

### 0.23.0

[0.23.0](https://github.com/the-metafactory/soma/releases/tag/v0.23.0) stops the
prompt guard from denying prose that describes a guard instead of asking to
defeat one. `security-disable-request` and `data-exfiltration-intent` now clear
a verb only when its subject makes it a description ("Serialization collisions
bypass the tamper guard"), when it is hyphen-joined into an identifier, or when
a sentence end splits it from its target. Other bare, un-negated verbs near a
target fire as before. A denial now shows the words that tripped it. That text
goes only into the reason relayed to the substrate; Soma's own traces and events
still hold no raw input, which the regression tests check. Known trade-offs:
- Descriptions built on modals, causatives or purpose "to" ("symlinks can
  bypass the guard", "allows an attacker to bypass the guard") still fire.
- A plural vocative with no comma ("Workers bypass the guard") passes.
- Whether a prompt denial stays fail-closed at `high` is still open (#544).

See the [prompt-inspection section](docs/runtime-policy-inspection.md#deterministic-v0-inspectors),
the [changelog](CHANGELOG.md#0230---2026-10-05), and the
[release checklist](docs/releases.md). This version is published on GitHub
only; the Arc registry is not updated by this release.

## Why this project?

Every coding agent you adopt rebuilds the assistant from scratch. Claude Code,
Codex, Pi.dev, and Cursor each want their own instruction files, their own
memory, their own skill format. Switch tools and you start over; run two at
once and you maintain two drifting assistants. The work that makes an assistant
*yours* — who it is, what it is for, what it has learned, how it works — ends up
trapped inside whichever host you happened to use.

A useful AI assistant is not just a model prompt. It is a portable operating
context around the model:

- identity: who the assistant is and who it serves
- purpose: goals, principles, commitments, and desired state
- memory: what has been learned across sessions
- skills: reusable procedures and capability folders
- working method: Algorithm, VSA, verification, and learning loops
- policy: privacy, permission, and evidence rules

Soma keeps that core in one filesystem-native home and projects it into each
host, so Codex, Claude Code, Pi.dev, Cursor, and future substrates share one
assistant instead of each becoming a separate island. Change tools without
losing the assistant.

This idea was proven before Soma. Daniel Miessler's
[Personal AI Infrastructure (PAI)](https://github.com/danielmiessler/Personal_AI_Infrastructure)
showed that deep operating context can become active inside an AI assistant,
and his [TELOS](https://github.com/danielmiessler/telos) framework gave that
context a structure — missions, goals, problems, strategies, projects, and
measures of progress. Soma takes the durable parts of that approach and makes
them substrate-portable. PAI and TELOS are the inspiration and a first-class
import source; Soma is independent, MIT-licensed tooling, not a PAI fork.

---

## The shape

```text
             +----------------+
             |   Soma home    |
             | identity       |
             | purpose        |
             | VSA            |
             | skills         |
             | memory         |
             | policy         |
             | Algorithm runs |
             +--------+-------+
                      |
        +-------------+-------------+
        |             |             |
     Codex      Claude Code      Pi.dev      Cursor      Cortex/Myelin
  projection     projection   projection   projection      planned
```

Soma owns the durable assistant core. Adapters own the substrate-native shape:
instruction files, rules, hooks, skills, extensions, lifecycle writeback, and
cleanup behavior.

Soma deliberately does not own the chat UI, model provider, package manager,
observability stack, bus, or agent orchestration layer. Those stay with the
host substrate and the surrounding Meta Factory stack. See
[docs/boundaries.md](docs/boundaries.md) and
[docs/substrate-adapters.md](docs/substrate-adapters.md).

---

## See it work in Codex (~5 minutes)

The fastest way to understand Soma is to project it into one substrate and run
a single gated task. This walk-through uses Codex; any supported host works.

### Prerequisite: install Arc

Soma is distributed as an Arc package. If you do not have `arc` yet, install
the Arc CLI first:

https://meta-factory.ai/download

If your Arc setup requires authentication, run `arc login` before installing
Soma.

```bash
# 1. Install Soma (Arc, or from source - see Install below)
arc install @metafactory/soma

# 2. Create your Soma home (identity, purpose, memory, skills, policy).
#    If an existing Claude Code / PAI installation is found, init also
#    imports its skills and identity. On a fresh machine (no Claude at
#    all) it starts from the starter profile — run `soma init` without
#    --apply first to see the dry-run plan.
soma init --apply

# 3. Project that core into Codex
soma install codex --apply

# 4. Inspect exactly what was generated for the host
soma export codex --out ./soma-codex-preview
soma doctor --substrate codex
```

**What to expect from step 2:** `soma init --apply` prints `soma init — applied`
followed by one line per step. `bootstrap-soma-home` always runs first;
`migrate-claude-skills` and `migrate-pai` appear only when an existing
installation was detected (an empty `~/.claude/skills` is reported as
"empty — nothing to import" and skipped). Afterwards `~/.soma` contains
`profile/`, `skills/`, `memory/`, `isa/`, and `policy/` — see
[docs/soma-home-layout.md](docs/soma-home-layout.md) for the full layout and
which init steps run when.

Open `./soma-codex-preview` and you will see the same assistant context rendered
in Codex's native shape: AGENTS instructions, rules, skills, and memory
summaries. Nothing is hidden in a binary — it is all readable files.

Goal records live in `<soma-home>/profile/goals/G<n>.md`. Create a draft,
then activate it after its sensor has been provisioned in Reflex:

```bash
soma goal add --supports M1 --wording "<private wording>" \
  --sensor <activation-id> --review-by 2026-12-31
soma goal activate G5
soma goal set-status G5 paused
soma goal list
soma goal list --wording
```

`add` prints only the new ID and always writes `status: draft`, including when
sensor and review date are supplied. IDs start at G5 and use the largest existing
`G<n>.md` filename plus one, leaving gaps untouched. Repeat `--supports` to name
multiple missions; `--sensor` and `--review-by` are optional on creation.
Wording must be one non-empty line; edit wording and supports by hand afterwards.

`activate` requires `sensor` and a valid `review_by` date. It reads every
`*.yaml` under `~/.config/reflex/personal-activations` by default. Set
`goals.activations_dir` in `<soma-home>/config.yaml` to use another directory:

```yaml
goals:
  activations_dir: ~/.config/reflex/personal-activations
```

`REFLEX_ACTIVATIONS_DIR` takes precedence over that config key. Config paths
may be absolute, start with `~/` (expanded against `--home-dir` or the user's
home), or be relative to Soma home. Missing config or an unset key uses the
default; unreadable or invalid config refuses activation. `activate` requires
the sensor in a blueprint's
`activations[].id`, with `schema: metafactory/activation/v1`. A missing directory,
unreadable, unparseable or invalid blueprint, absent sensor, missing required
field, or nonexistent goal refuses activation with exit 1 and leaves the goal
unchanged. Soma never writes the Reflex blueprints.

`activate` and `set-status` change only the status scalar, preserving the rest
of the file. `set-status` accepts `paused`, `achieved`, `dropped` or `draft`;
becoming `active` requires `activate`. `list` prints ID, status, supports and
sensor for every goal. Only `--wording` includes the private first body line;
other body text is never printed. All goal commands accept `--soma-home <dir>`
or `--home-dir <dir>` (which resolves Soma to `<dir>/.soma` and Reflex to
`<dir>/.config/reflex/personal-activations` unless a config or environment
override is set).
Keep wording in Soma home; use goal IDs in trackers, run metadata and logs.

`soma goal sweep` checks each active goal's pursuit, review date and sensor.
It publishes three job runs through the run ledger, with check states `ok` or
`regressed` on `G<n>.pursuit`, `G<n>.review` and `G<n>.sensor`. Goal wording is
never included. Draft, paused, achieved and dropped goals are skipped.

Pursuit requires an open VSA or open map root serving the goal with an update
in the last 14 days (`pursuit_window` overrides this), or an enabled scheduled
Reflex blueprint serving it. A map's descendants count toward its latest
update; the goal's sensor blueprint never counts as pursuit. Reviews become
overdue the day after `review_by`, using Europe/Zurich. Sensor existence checks
all blueprint IDs, including disabled ones. A missing review date or sensor
regresses its check.

Map discovery is restricted to `<soma-home>/profile/goals/sweep.yaml`:

```yaml
repos: [owner/name, owner/another-repo]
```

When the file is absent, one warning is printed and only VSAs and blueprints
are scanned. Blueprints use the same directory selection as `goal activate`.
An unreadable repo produces a failed pursuit run with no state; review and
sensor checks still run, and stderr names the repo. Other unreadable sources
likewise fail only the checks that need them. Check or publication failures
exit 1. With `SOMA_PRINCIPAL` unset, no envelopes are published: the sweep
prints ID-only results to stdout and exits 0. Scheduling this command in
Reflex is an operator task.

A goal's sensor reports its state on the run ledger (see [Run ledger](#run-ledger)).
`soma goal sense feed` is the feed sensor, meant to be run by a Reflex activation:

```bash
soma goal sense feed --goal G5 --url https://example.org/feed.xml [--window-days 7] [--min 1] [--link-match <substring>]
```

It fetches one RSS 2.0 or Atom feed over `https:` (10 s limit for the whole
fetch; up to 5 redirects, every hop `https:`; body at most 2 MiB), counts the
items dated in the last `--window-days` days (RSS `<pubDate>`; Atom
`<published>`, else `<updated>`; items dated after now do not count), and
publishes one `execution.run.finished` with `ran.kind = job`, `ran.ref =
goal-sense/G<n>`, `serves.goal = G<n>` and `state {subject: G<n>, value}`. At
least `--min` items is `on-track`, fewer (including none) is `off-track`.
With `--link-match <substring>`, only items whose link contains that literal,
case-sensitive substring count; items without a link do not count.
For example, `--link-match /shorts/` counts YouTube Shorts while excluding
`/watch?v=` entries. Without the flag, every item in the window counts. An
item with a missing or unparseable date is skipped with one stderr warning
naming its position. A failed fetch (network, timeout, non-2xx, a redirect off
`https:` or past 5 hops, a body over 2 MiB) or a body with
neither an `<rss>` nor a `<feed>` root publishes `outcome: failed` with no
state, names the cause on stderr and exits 1. A goal id that is not `G<n>`, a
non-`https:` URL or a `--window-days`/`--min` that is not a positive integer
exits 2 before anything is fetched or published. The envelope carries the goal
id and the state only, never the URL, the feed title or item text. The feed is
scanned for its item blocks and date elements, not parsed as XML: links are
never followed and entities never resolved. stdout prints the value, the count
and the ledger result; with `SOMA_PRINCIPAL` unset nothing is published and the
exit code is 0 (1 on a failed fetch).

### Proposing a goal

```bash
soma goal propose --wording "<private wording>" [--hint "<revision guidance>"] \
  [--param url=https://example.org/feed.xml] [--json]
```

The session assistant shows the proposal and asks the principal to accept it.
On a yes, the next step is `soma goal add --accept <hash>` (acceptance and
activation are separate commands, delivered by the follow-on nodes). An edit
means re-proposing with `--hint`, producing a new hash. Activation requires a
separate yes naming the goal id. Proposing creates neither a goal record nor an
activation and reserves no goal id; `params.goal: G0` is an acceptance placeholder.

The proposer uses standard-level `soma inference` over mission bullets,
existing goal ids, statuses, kinds and wording for overlap, the kind catalog,
and resource names and types. Wording and hints go to the inference provider;
resource values never do. Replies are validated locally against kind Zod
schemas, with one retry carrying value-free validation errors. A second invalid
reply becomes `no_fit`. Schedules and sensor state rules come from kinds;
`review_by` defaults to today plus 13 weeks. Zero mechanisms is allowed, with a
warning that nothing moves the goal and the sweep's pursuit check will flag it.

Private params use `<resource:name>`. Values come from `profile/resources.yaml`
or `--param key=value`: use a private parameter name, `kind.parameter`, resource
name or resource type (in that precedence order). Values may be JSON for
structured inputs, such as a channel array. Overrides stay local and are stored
only in the successful proposal for later staging. Missing required resources
return `needs_input: [<resource type>]` and create no file. A single matching
resource type can fill an omitted private param; ambiguous resources need a
named reference or override.

A valid proposal is written only to
`<soma-home>/profile/goals/proposals/<sha256>.yaml`, mode `0600`. The hash covers
the full YAML bytes. Local output shows the design, state rule, schedules, drop
line, review date, overlaps and any mechanism gap, followed by the hash;
`--json` returns the same result as JSON. Proposal files older than 24 hours are
pruned on every invocation. Calls create no log or publication; the Claude
backend disables session persistence, hooks and tools for this private call.

On `no_fit` or a mechanism gap, show the generic needed-kind description to the
principal. Only on a yes, file that generic description with
`soma graph add 781 --kind grilling --title "<generic kind>" --autonomy approve --checkpoint <checkpoint-id> --body "<generic description>"`.
Keep wording, hints, drop text and resource values out of the tracker. Proposing
does not file that node itself.

`soma goal kinds --json` lists the goal-kind catalog for inference; without
`--json` it prints a compact ID, role and description list. The registry lives
in `src/goal-kinds/registry.ts`. Each kind lives in
`src/goal-kinds/<kind>.ts` and declares a strict Zod parameter object, public
parameters, private parameter resource types, its existing command and argv
mapping, a Reflex target, and a fixed default schedule. Sensors own a
state rule rendered from their threshold parameters. Unknown fields and missing
required fields fail `params.safeParse`; JSON output uses JSON Schema for public
parameters and only `{resourceType: "..."}` for private parameters.
Catalog listing never reads private resources. There is no `soma goal run`.

The first kind is `feed`: `goal` and `url` are required; `window_days` defaults
to 7 and `min` to 1, both positive integers. Its argv maps to `--goal`, `--url`,
`--window-days` and `--min` on `soma goal sense feed`. Optional `link_match`
is a string mapped to `--link-match`. Its default schedule is
`30 6 * * *`, timezone `Europe/Zurich`; the proposer must keep it. The declared
target `@jc/goal-sense-feed` uses Cortex's existing `process` handler. Binding
that target to a process spec on the personal stack belongs to goal activation
setup; listing a kind does not install a route or activation.

Two mechanism kinds register the landed draft commands. Their default schedules
use `Europe/Zurich`, and private values are resolved locally before execution:

| Kind | Parameters | Private resource types | Schedule | Target |
| --- | --- | --- | --- | --- |
| `outline` | Required `goal`, `tana_tag`, `drafts_dir`; `days` defaults to 7; optional positive integer `slot_minutes` | `tana_tag`: `tana-tag`, `drafts_dir`: `directory` | Monday 06:00 (`0 6 * * 1`) | `@jc/g5-outline` |
| `announce` | Required `goal`, `url`, `channels` (nonempty list of channel names) | `url`: `feed`, `channels`: `channels` | Daily 06:35 (`35 6 * * *`) | `@jc/g5-announce` |

`outline` maps to `soma goal outline --goal ... --tana-tag ... --drafts-dir ...
--days ...`, adding `--slot-minutes` only when supplied. Both numeric parameters
are positive integers. The slot proposal is part of `outline`, with no separate
kind. Its existing target kickstarts the Calendar-granted launchd runner from
node #845: a Cortex-spawned process is silently denied calendar access.
`announce` maps to `soma goal announce --goal ... --url ... --channels ...`,
joining the channel list with commas. Feed URLs must use HTTPS; private parameters
also accept `<resource:name>` references for local resolution. Neither mechanism
publishes a post or writes a calendar event.

Private resources live only at `<soma-home>/profile/resources.yaml`, as one
YAML sequence of entries. For example, using a generic placeholder URL:

```yaml
- name: blog
  type: feed
  value: https://example.org/feed.xml
```

`loadGoalResources({somaHome})` returns the entries;
`resolveGoalResource(resources, "blog", "feed")` returns that pair's value or
`undefined` if absent or differently typed. Names and types are lowercase slugs
starting with a letter; values are JSON-compatible scalars, arrays or objects,
validated against the kind's parameters after resolution. Feed parameters accept
`<resource:blog>` before local resolution and an HTTPS URL afterwards. The loader
does not substitute references or stage activations. A missing file returns an
empty list. Malformed YAML, invalid entries, unknown fields, duplicate name/type
pairs and aliases fail with the file and source line, never resource values.
Keep this file private; inference receives names and types only.

Now run one Algorithm-backed task to see the working method, not just the
context:

```bash
soma algorithm classify --prompt "Add a health-check endpoint to the API"
soma algorithm new \
  --prompt "Add a health-check endpoint to the API" \
  --intent "Expose service liveness" \
  --current-state "No health endpoint exists" \
  --goal "GET /health returns 200 with build info" \
  --criterion "C1:Endpoint returns 200 and is covered by a test"
soma algorithm verify --id <run-id> --criterion-id C1 --status passed --evidence "bun test"
soma algorithm advance --id <run-id>
```

Generated run ids are date-prefixed when you omit `--id`, and `soma algorithm
show --id <run-id>` reports which substrates have touched the run. Phase
advances, criterion verification, capability invocation, and learning
promotion all append substrate provenance when the caller supplies
`--substrate`.

The Algorithm and VSA are implemented by Soma itself — `soma algorithm` and
`soma vsa` work on any substrate, with run state in
`~/.soma/memory/WORK/algorithm-runs/` and VSAs in `~/.soma/isa/`. See
[The Algorithm](#the-algorithm) and [VSA](#isa) below, and
[docs/soma-home-layout.md](docs/soma-home-layout.md) for the full on-disk
layout `soma init` creates.

That run, your identity, purpose, and anything learned now travel with you to the
next host. Switch to Claude Code or Cursor (`soma install claude-code --apply`)
and the same assistant shows up.

---

## Bring your PAI along

Soma runs alongside PAI, not instead of it — your PAI keeps working untouched.
There are two complementary things worth bringing across, and you can use
either or both.

### 1. The ideas: algorithm, memory, learning

Daniel Miessler's deep-context approach — the Algorithm harness, structured
memory, the learning loop, identity, and Purpose — is the durable base. Soma
ships its own Algorithm, memory and Purpose; it no longer syncs them from a PAI
install: `soma migrate pai` and `soma import` were removed. To
run a one-time PAI migration, pin soma 0.25 or earlier, migrate, then
upgrade. [docs/integration-with-pai.md](docs/integration-with-pai.md) describes
that older walkthrough.

### 2. The skills on top: Daniel's published library (and your own)

On top of those ideas, Daniel has published a rich and generous set of skills.
If you already run them through a `.claude` installation, Soma can pull that
whole skill library into a portable home — every skill you have installed, not
only PAI's, so anything you have added comes along too:

```bash
soma migrate claude-skills --from <claude-home>/skills
soma migrate claude-skills --from <claude-home>/skills --apply
```

The migrator classifies each skill as portable, needs adaptation, or
Claude-specific. Add substrate smoke checks when you want proof that imported
skills project cleanly:

```bash
soma migrate claude-skills --from <claude-home>/skills --smoke codex --smoke pi-dev
```

Oversize descriptions can be rewritten for substrate limits:

```bash
soma migrate claude-skills --from <claude-home>/skills --rewrite-descriptions auto --apply
```

Apply-mode migrations create a Git-backed Soma snapshot first, so you can
inspect or roll back the Soma home:

```bash
soma history
soma snapshot --name before-big-change
soma rollback <snapshot-id>
```

---

## One assistant, many substrates

Install Soma once, then project it into the agents you use:

```bash
soma install codex --apply
soma install claude-code --apply
soma install pi-dev --apply
soma install cursor --apply
```

Each adapter writes the same assistant context into the host's native shape:

| Substrate | Projection |
| --- | --- |
| OpenAI Codex | AGENTS instructions, rules, hooks, skills, and memory summaries |
| Claude Code | rules, hooks, settings entries, a status line (mode+effort, git, context %, 5h/7d usage windows), and generated Soma-owned skill files |
| Pi.dev | extensions, context files, skills, and Algorithm rendering support |
| Cursor | `.cursorrules` and `.cursor/rules/soma/` projection files |
| Cortex/Myelin | planned agent/daemon integration |

The shared experience comes from a single source of truth:

- session startup reads the same identity, purpose, active work, and learning
- Algorithm runs and VSA state stay portable
- feedback and lifecycle events write back through Soma's memory and policy gates
- uninstall removes only generated Soma projection files

The home projection is the default assistant context for a substrate: identity,
purpose, memory layout, policy, active work, and shared skills. A workspace
projection is an extra project-local layer. Use it when a repository needs its
own VSA, local rules, local skills, or project-specific memory pointers. The
workspace layer adds that context for sessions started in that repository
without forking the assistant or replacing the shared Soma home.

```bash
soma install codex --workspace --apply
soma install claude-code --workspace --apply
soma install cursor --workspace --apply
```

---

## Portable tools

Soma turns proven assistant patterns — several of them first demonstrated by
PAI — into typed, substrate-portable tools.

### The Algorithm

The Algorithm is the deterministic work harness around non-trivial AI work.
It turns "help me do this" into a gated run:

```text
OBSERVE -> THINK -> PLAN -> BUILD -> EXECUTE -> VERIFY -> LEARN -> COMPLETE
```

The assistant proposes current state, goal, criteria, plan, changes, evidence,
and learning. Soma stores the run and decides whether phase gates are allowed
to advance.

```bash
soma algorithm classify --prompt "..."
soma algorithm new --prompt "..." --intent "..." --current-state "..." --goal "..." --criterion "C1:..."
soma algorithm plan --id <run-id> --step "P1:C1:Implement the adapter"
soma algorithm verify --id <run-id> --criterion-id C1 --status passed --evidence "bun test"
soma algorithm advance --id <run-id>
```

Capabilities are registry-backed commitments. If a run selects a capability,
it must be invoked with evidence or explicitly removed before completion.

```bash
soma algorithm capabilities --id <run-id> --capability sequential-analysis --reason "Order the migration steps"
soma algorithm invoke --id <run-id> --capability sequential-analysis --evidence "Plan sequenced and recorded"
```

#### Run ledger

When a verb (`advance`, `resume`, `batch`) moves a run into `complete`, Soma
publishes one `execution.run.finished` envelope (`ran.kind = algorithm`,
outcome `succeeded`) through myelin's outbox. The outcome `cancelled` is
reserved for a run moved to `abandoned`, which no verb does today, so for now
Soma emits only `succeeded`. Hooks never emit, and `sync-from-isa` stops at `learn`, so
it never emits. Nothing is sent unless `SOMA_PRINCIPAL` is set.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOMA_PRINCIPAL` | unset (ledger off) | Principal segment of the subject `local.<principal>.<stack>.execution.run.finished` and of the source `<principal>.soma.run`. |
| `SOMA_STACK` | `default` | Stack segment of the subject. |
| `SOMA_NATS_URL` | `nats://127.0.0.1:4222` | NATS server. A non-loopback host requires `SOMA_NATS_CREDS`. |
| `SOMA_NATS_CREDS` | unset | Path to a NATS `.creds` file. A missing file fails the emit. |
| `MF_CORRELATION_ID` | unset (generated) | Passed through as `payload.correlation_id`; any non-empty string. |
| `MF_SERVES_GOAL` | unset | Goal ID the run serves (`serves.goal`). |
| `MF_SERVES_NODE` | unset | Work-graph node the run serves (`serves.node`). |

Delivery fails open. The emit (connect, replay the spool, publish, close)
gives up after 2 s. A failed or timed-out emit leaves the verb's output, exit
code and run file unchanged and appends one `run_ledger.publish_failed` event
to the Soma event log. An envelope whose send failed stays in
`<soma-home>/memory/STATE/run-ledger/outbox.jsonl`, and the next emit replays
it. A configuration failure (missing creds file, non-loopback URL without
creds) is refused before the spool and is not replayed. A timed-out emit is
abandoned, not cancelled: its bounded connect or publish can keep the process
alive a few seconds after the verb has printed.

The arc-installed `soma` runs a frozen runtime artifact
(`<soma-home>/runtime/artifacts/<hash>/`) that carries `src`, `package.json`
and the production dependency closure under `node_modules`, so myelin loads
from the artifact with no network (node #866). An artifact installed before
that change holds no `node_modules`; its emits fail at stage `load`, and
`soma doctor` reports the missing dependency until `soma install <substrate>
--apply` restages it. See [soma-home-layout.md](docs/soma-home-layout.md).

### Weekly goal outline

```bash
soma goal outline --goal G1 --tana-tag capture --drafts-dir /path/to/drafts --days 7 [--slot-minutes 60]
```

Reads recent captures from the local `supertag` index (`search --tag ...
--created-after ... --json --offline --limit -1`) and recursively reads files
whose YAML frontmatter has `draft: true`. Symlinks are skipped. With inputs,
one `soma inference` call at level `standard` recommends an outline. With no
inputs, it records that nothing was captured and skips inference.

The private output is `<soma-home>/outputs/G1-YYYY-Www.md`, using the current
ISO week in Europe/Zurich. It has Captures, Open drafts and Outline sections.
Re-running replaces it while preserving an existing `## Share drafts` section
verbatim. Generated outlines are fenced as Markdown source so their headings
and code fences cannot interfere with that section. This command only
recommends; it does not share or schedule anything.

With `--slot-minutes <n>`, the outline also gets a `## Proposed slot` section
(before `## Share drafts`): the first window of `n` minutes in the next 5
weekdays, 08:00–18:00 Europe/Zurich, free in both the macOS calendars and
Exchange. It reads `ical availability` and `ical exchange availability`, each
with `--next 7 --duration <n> --hours 08:00-18:00 --exclude-weekends --format
json`, intersects their slots and starts no earlier than the next quarter hour.
It never runs `ical create` or any Exchange write. If either read fails
(non-zero exit or unparseable JSON), the section names the calendar and
proposes nothing. If the macOS read returns every working hour of all 5
weekdays as free, the section warns that calendar access may have been denied
(macOS returns an empty calendar with exit 0 when access is refused) and
proposes nothing. Neither case changes the run's outcome, and the slot never
reaches the run envelope. Without the flag, no calendar is read.

One job run (`goal-outline/G1`, serving `G1`) finishes through the run-ledger
funnel. Success carries `result_ref: soma:outputs/G1-YYYY-Www.md`, without a
state or source text. With `SOMA_PRINCIPAL` unset, nothing is published.
Missing or failing `supertag` exits 1 without writing an output. Inference
failure or its 30-second timeout exits 1 after writing the sources and a
failure message in Outline. Failed runs carry no `result_ref`. Usage errors
exit 2. Ledger delivery retains the fail-open behavior documented above.

### Goal announcement drafts

```bash
soma goal announce --goal G5 --url https://example.org/feed.xml --channels linkedin,mastodon
```

Fetches the RSS or Atom feed through the feed sensor's bounded reader. On the
first run, records every current item link in the private JSON string array
`<soma-home>/memory/STATE/goal-announce/G5.json` and drafts nothing. Later runs
draft one short announcement per channel for each unseen link, using `soma
inference` at level `standard` through its tool-free Claude Code backend (no
HTTP API fallback). Item links are never fetched and nothing is posted.

Drafts are added under `## Share drafts` in
`<soma-home>/outputs/G5-YYYY-Www.md`, creating the file if needed. The ISO week
uses Europe/Zurich, like `goal outline`. Existing sections are retained;
generated text is fenced as Markdown source. Links join the seen-set only
after all their channel drafts are saved. Duplicate links and channel names
are collapsed; items without HTTP(S) links are skipped. With no unseen items,
inference is skipped and the output and seen-set are untouched.

Feed failure leaves both files untouched and exits 1. Inference failure or a
30-second timeout leaves that item unseen for retry, saves other successful
items and exits 1. Usage errors exit 2. Each run reports one `goal-announce/G5`
job serving `G5`, without state, URLs, titles or draft text. Only a succeeded
run that added drafts carries `result_ref: soma:outputs/G5-YYYY-Www.md`.
With `SOMA_PRINCIPAL` unset no ledger envelope is published; delivery otherwise
uses the existing fail-open ledger funnel.

### VSA

An Verification State Artifact is the definition of done for a project, task, or work
session. It carries criteria and verification evidence across substrates.

```bash
soma vsa scaffold --slug launch-plan --effort E2 --goal "Ship the launch plan with evidence"
soma vsa use <yyyy-mm-dd-launch-plan>
soma vsa active
soma vsa check <yyyy-mm-dd-launch-plan>
```

`soma vsa scaffold` date-prefixes newly scaffolded slugs unless the slug is
already date-prefixed. Use the slug printed by the scaffold command for
`use`, `active`, and `check`.

For parallel feature work, Soma can reconcile feature VSAs back into a master
VSA by stable criterion IDs. See [docs/vsa-reconcile.md](docs/vsa-reconcile.md).

### The work graph

Some work is too big for one agent session and too foggy to plan in one sitting.
The **work graph** is Soma's typed primitive for that case: nodes of work joined
by *membership* (a node belongs to a map) and *blocking* (a node gates another),
walked one node at a time, closed only through a checkpoint gate.

```bash
soma graph frontier <root>   # open, unassigned, unblocked nodes — anywhere in the subtree
soma graph node <id>         # its state and body
soma graph claim <id>        # take it
soma graph chart --title "…" --autonomy approve --checkpoint <id>  # create a typed graph root
soma graph add <root> --title "…" --autonomy approve --checkpoint <id>
soma graph link <id> [--blocked-by <ref>]... [--parent <id>]  # wire a blocker later (may name owner/name#N); --parent attaches an unattached node
soma graph close <id> --resolution-file <path>
soma graph audit <root>      # what the gates cannot see
soma graph decisions <root>  # the map's resolutions, collected
soma graph file-proposal <proposal_ref>  # file an approved soma-home proposal; a re-run returns the same node
```

The store is a seam with GitHub and GitLab backends. On GitLab, a typed map root
is a group Epic bound to a home project; its children are Issues and Tasks in
that project. For example:

```bash
soma graph chart --repo gitlab:gitlab.example.com/acme/work \
  --home-project acme/work --title "Service roadmap" \
  --autonomy approve --checkpoint cp-roadmap
soma graph frontier 'gitlab:gitlab.example.com/acme&17'
```

Replace the example Epic number with the one printed by `chart`. See the
[GitLab work-graph guide](docs/gitlab-work-graph.md) for prerequisites, node
creation, refs, close receipts, and current limitations. GitLab API behavior
has fake-transport coverage, but server compatibility and Task-floor re-home
have not yet been exercised against a live GitLab instance. The tracker stays
the sole authoritative record — Soma keeps no parallel copy of the graph.

**A node closes only through its gate.** Each carries an autonomy class
(`auto` / `propose` / `approve`), a checkpoint, and — for anything machine-closable
— probes: `command`, `url`, `git-ref-exists`, `git-merged-into`, `artifact-exists`.
An `auto` node with zero probes cannot be constructed. The close runs the probes,
requires human-readable prose, and posts a **receipt** naming the checkpoint, what
each probe observed, the tree it ran in with its HEAD and dirty state, and an
attestation of `verified` or `unverified` derived from authorship and reachable
credentials rather than declared. An unverified receipt lists its reasons.

Because tracker content is untrusted input, a `command` probe runs only if its
exact command and directory are declared in your Soma home:

```bash
soma policy probes           # read the registry; Soma ships no verb that writes it
```

The **orienteer** skill is the doctrine for using this: chart a loose idea as a map
of decision nodes, then resolve them one at a time until the route is clear. The
map also records what is **fixed regardless of route** — budget, deadlines,
tooling that cannot change — so every node's options are weighed against the
constraints instead of discovering one after the decisions close.
See [docs/work-graph.md](docs/work-graph.md) for the spec.

### Skills

Skills are portable capability folders. A skill can include `SKILL.md`,
workflows, references, examples, tools, and a `soma-skill.json` manifest.
Adapters decide how the skill is projected into each substrate.

Soma supports progressive skill loading: project a compact registry by default,
then load the selected skill body only when a task route needs it. The
registry entry per skill is compact (name, a truncated description, and its
path, plus optional `triggers:`/`not:` lines) instead of a full heading block,
kept inside a declared line budget. See
[docs/progressive-skill-loading.md](docs/progressive-skill-loading.md).
MCP-capable substrates can use the optional
[docs/mcp-server.md](docs/mcp-server.md) surface for the same on-demand loading
without replacing the eager projection.

### Memory

Beyond Algorithm-run and learning state, Soma keeps a files-first memory of
markdown notes under `~/.soma/memory/`. There is no database and no model in the
loop — every operation is a deterministic `soma memory` subcommand over readable
files, and each note carries frontmatter (id, type, trust, provenance,
verification) so its origin and trust stay auditable.

Notes come in three kinds:

- **semantic** — durable facts
- **procedural** — durable how-to and SOPs
- **episodic** — session digests and a planned-action log

A generated `memory/INDEX.md` is the earned-inclusion index over durable notes.
Trust is *derived* from how a note was written, never set by a flag: a principal
correction requires `--principal-authority`, imports land at lower trust, and
consolidation never mints or elevates trust.

On substrates with a SessionStart hook (Claude Code, Codex, Grok), the
projected memory file (e.g. Claude Code's `rules/soma/MEMORY.md`) reprojects
from the shared `~/.soma` store at the start of each session, so a note written
via one of them surfaces in a later session of another without a full
`soma install` reproject — and, because the reprojection is mtime-gated, an
idle session touches no disk.

```bash
# Save a durable fact (trust derived from the trigger, not a flag)
soma memory write --trigger principal-correction --principal-authority \
  --id client-sovereignty --type semantic --body "Clients own their agency data."

soma memory recall "client sovereignty"   # note-aware, read-only, with links
soma memory digest --session <id> --body "..."   # the one session digest
soma memory consolidate --dry-run          # deterministic maintenance, plan only
soma memory audit                          # health check; exits non-zero on failure
soma memory backfill --dry-run             # bulk-import legacy markdown → notes (plan only)
```

`soma memory recall` retrieves durable notes with a verification banner and
one-hop links, and never mutates. `soma memory consolidate` is idempotent and
event-logged: it prunes aged episodic notes into archived digests, marks
aged-unverified semantic notes `review: stale`, flags near-duplicate pairs for
review, and rebuilds the INDEX — it never auto-merges notes. `soma memory audit`
is a deterministic smoke check (note-root integrity, schema validity, INDEX
freshness, digest coverage) that exits non-zero on any health-gating failure, so
it can gate CI. `soma memory backfill` bulk-imports a principal's existing
free-form markdown (default source: the legacy `<somaHome>/memory` category dirs) into
schema-valid notes through the same governed write path — deterministically, no
LLM, idempotent via a SHA manifest. Every imported note lands at `quarantined`
trust (recall-discoverable with a ⚠ banner, held out of the INDEX until the
principal re-authors it at higher trust — `verify` alone does not elevate a
quarantined note); the category dir maps to a note type (`LEARNING`→procedural,
`KNOWLEDGE`→semantic) unless `--type` forces one. The note subsystem also ships
as the portable **Memory** skill,
which routes a remember/recall/log/maintain/audit request to the right
subcommand. See [docs/architecture.md](docs/architecture.md#memory) for the full
model.

### Learning patterns

PAI's strongest lesson is that the assistant should improve from verified
work, not vague session vibes. On top of the memory notes above, Soma exposes
explicit learning paths that turn a verified run into a durable lesson:

```bash
soma memory search --query "client sovereignty agency"
soma memory search "client sovereignty agency"
soma memory promote --from-run <run-id> --store learning --title "Reusable lesson"
soma feedback capture --text "you missed the arc-manifest check"
```

`soma memory search` is the path-based line grep over the legacy
`WORK/`/`KNOWLEDGE/` stores — distinct from the note-aware `soma memory recall`
above. It accepts either `--query <text>` or a single positional query; when
both are present, `--query` wins.

Promotion is deliberate: a verified run can become durable learning. Feedback
capture is weaker by design: it records candidate corrections, preferences, or
learning events for review. Prompt excerpts are not stored by default; storing
one requires explicit opt-in.

---

## Install

Install with Arc:

1. Install the Arc CLI from https://meta-factory.ai/download.
2. Run `arc login` if your Arc setup requires authentication.
3. Install Soma:

```bash
arc install @metafactory/soma
```

Arc installs the `soma` CLI on PATH. Verify the shim before continuing:

```bash
soma --version
```

`soma install <substrate> --apply` also activates a content-addressed CLI runtime
in `~/.soma/runtime/cli/current`. After that, Arc's `soma` launcher executes
this snapshot for normal commands and verifies its hash before graph commands.
Install, reproject, and `soma runtime`
remain source-backed recovery commands. `soma graph close` refuses to run from
a source checkout or an invalid runtime. Inspect it with
`soma runtime status --target cli`; if an upgrade is interrupted, use
`soma runtime rollback --target cli` or rerun the install.
The integrity check governs the installed PATH entrypoint; directly executing
modified artifact code bypasses that entrypoint's check.

If `arc upgrade soma` resolves the new version but refuses to replace an older
active install, use Arc's remove-then-install recovery path:

```bash
arc remove soma
arc install @metafactory/soma
```

See [docs/arc-install-troubleshooting.md](docs/arc-install-troubleshooting.md)
for the pinned-version variant.

Or run from source:

```bash
git clone https://github.com/the-metafactory/soma.git
cd soma
bun install
bun run soma --help
```

Then project Soma into at least one substrate:

```bash
bun run soma install codex --apply
bun run soma install claude-code --apply
bun run soma install claude-code --mode-classifier --apply
bun run soma install pi-dev --apply
bun run soma install cursor --apply
```

`--mode-classifier` is an opt-in Claude Code hook. It installs Soma's
`UserPromptSubmit` classifier, emits a compact MODE context block, and disables
the PAI mode classifier entry while Soma owns that hook.

---

## How the assistant talks, and what it may do

Two principal-authored files in the Soma home govern conduct, and they reach
every substrate:

- **`profile/communication.md`** — the *communication contract*: voice, positive
  and negative patterns, a banned-phrase list, reference codes, aliases, and
  authored do/don't examples. Identity compartment. `soma init` writes a generic
  starter; edit it directly. It projects **verbatim** into every substrate, and
  Pi.dev injects it into the system prompt so it is present on every turn.
  Soma parses nothing out of it — every section works by being read.
- **`policy/behavior.md`** — the *behavioral policy*: verification, scope
  discipline, permission boundaries, external-content handling. Policy
  compartment. Its `## Heading` sections become advisory lines in every
  substrate's policy projection. `soma init` does **not** create it: Soma
  projects conduct rules you wrote, or none.

One rule, one home. An absent file projects nothing rather than a default.

### Reference codes

When the assistant presents three or more findings, options, risks, questions,
actions, or decisions, it labels each with a short code that stays stable for
the conversation, so your reply collapses to `keep D1, reject O2, answer Q1`.

`C` and `P` are reserved — `C1` is a VSA criterion and `P1` an Algorithm plan
step — so recording a code under either is refused. A code becomes durable when
written to a run, and a `D` code also lands in that run's decisions log:

```bash
soma algorithm ref     --id <run-id> --code D1 --text "Drop the co-author rule."
soma algorithm resolve --id <run-id> --code D1 --verdict kept --note "Applied."
```

See [docs/communication-and-behavior.md](docs/communication-and-behavior.md).

---

## Privacy and policy

Soma's V0 policy guard blocks obvious movement of private Soma or projection
source material into public destinations and records checks as events.

```bash
soma policy check --action write --destination ./README.md --content "..."
```

The guard allows normal writes under Soma's memory tree while protecting
public files and destructive root-level paths. See
[docs/private-source-guard-v0.md](docs/private-source-guard-v0.md).

---

## Status

Soma is a typed CLI and library with shipping home projections for Codex,
Claude Code, Pi.dev, and Cursor. The current center of gravity is the portable
filesystem contract: profile, purpose, memory, policy, skills, Algorithm runs,
and VSAs stay in the Soma home while adapters project that core into each
substrate's native shape.

`soma doctor --substrate <substrate>` content-compares each substrate's
projection against a fresh projection built in memory — not a timestamp
heuristic — across all 5 install substrates (codex, claude-code, cursor, grok,
pi-dev), catching hand-edited, stale, or missing projection files with
CI-friendly exit codes (0 clean, 1 drift, 2 error).

The work graph is phase 1: the primitive, its verbs, and its close gates are on
`main` and were dogfooded on their own map from spec to close. Phase 2 — a
scheduled unattended tick that walks a frontier without a human present — is
specified and deliberately unbuilt.

Daemon mode and deeper Cortex/Myelin integration come after the file format,
writeback gates, and adapter behavior are stable.

Cross-machine use is designed as Soma home replication: a policy-gated,
snapshot-backed exchange of eligible `~/.soma/` state between machines. It does
not change projection or writeback semantics. See
[docs/home-replication.md](docs/home-replication.md).

Team-shared skills, knowledge, work artifacts, and VSAs are designed as
read-only team overlays. A team overlay supplements one principal's Soma home;
it does not make the home multi-principal or share private Identity, Purpose, or
Relationship state. See [docs/team-overlays.md](docs/team-overlays.md).

Daemon mode is designed as a long-lived Soma process that consumes Myelin-owned
contracts through Cortex, routes centrally, and preserves the same policy and
writeback boundaries as substrate sessions. See
[docs/daemon-mode.md](docs/daemon-mode.md).

---

## Documentation

- [CONTEXT.md](CONTEXT.md), the shared Soma vocabulary used by docs, CLI, and VSA
- [docs/soma-home-layout.md](docs/soma-home-layout.md), what `soma init` creates and where Algorithm/VSA state lives
- [docs/communication-and-behavior.md](docs/communication-and-behavior.md), the communication contract, the behavioral policy, and reference codes
- [docs/architecture.md](docs/architecture.md), the core/adapters/runtime model
- [docs/boundaries.md](docs/boundaries.md), exactly what Soma owns and does not own
- [docs/substrate-adapters.md](docs/substrate-adapters.md), adapter behavior by host
- [docs/integration-with-pai.md](docs/integration-with-pai.md), PAI integration walkthrough (PAI migration needs soma ≤ 0.25)
- [docs/progressive-skill-loading.md](docs/progressive-skill-loading.md), skill registry and just-in-time loading
- [docs/mcp-server.md](docs/mcp-server.md), optional read-mostly MCP tool surface
- [docs/home-replication.md](docs/home-replication.md), cross-machine Soma home replication
- [docs/team-overlays.md](docs/team-overlays.md), read-only team overlays and shared-state boundaries
- [docs/daemon-mode.md](docs/daemon-mode.md), daemon mode ownership and Myelin contract boundaries
- [docs/work-graph.md](docs/work-graph.md), the work graph spec — node vocabulary, close gates, probes, and receipts
- [docs/gitlab-work-graph.md](docs/gitlab-work-graph.md), the GitLab setup and operation guide
- [docs/writeback-and-policy.md](docs/writeback-and-policy.md), projection, writeback, conflict, and policy semantics
- [docs/portability-proof.md](docs/portability-proof.md), the first portability proof and evidence contract

---

## License

MIT.

---

<p align="center">
  <sub>A <a href="https://meta-factory.ai">Meta Factory</a> project, by
  <a href="https://github.com/jcfischer">Jens-Christian Fischer</a> and
  <a href="https://github.com/mellanon">Andreas Aaström</a>.</sub><br />
  <sub>Inspired by <a href="https://github.com/danielmiessler/Personal_AI_Infrastructure">Daniel Miessler's PAI</a> and <a href="https://github.com/danielmiessler/telos">TELOS</a>.</sub>
</p>
