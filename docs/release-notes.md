# Release notes

One summary per release, newest first. The [changelog](../CHANGELOG.md)
lists every change. The
[GitHub releases](https://github.com/the-metafactory/soma/releases) carry the
tags.

## 0.29.2

[0.29.2](https://github.com/the-metafactory/soma/releases/tag/v0.29.2) is a
documentation release. It describes the Claude Code mode classifier and
policy guard, which are installed by default, and how each one fails. See the
[changelog](../CHANGELOG.md#0292---2026-10-28).

## 0.29.1

[0.29.1](https://github.com/the-metafactory/soma/releases/tag/v0.29.1) makes the
hooks that run on every tool call and prompt start faster. The CLI loads only
the command it runs, and the Claude Code policy guard and mode classifier run
in a worker of the hook process instead of a second `bun`. A guarded tool call
takes about 156 ms instead of 316 ms. See the
[changelog](../CHANGELOG.md#0291---2026-10-28) for the complete changes. GitHub
releases and Arc registry publication are verified separately.

## 0.29.0

[0.29.0](https://github.com/the-metafactory/soma/releases/tag/v0.29.0) moves
the playbook cards out of the-algorithm into the soma-pstack pack's
`playbooks` skill. The working method projects the Playbooks section from that
skill when it is installed. Breaking: a home without the pack projects no
cards; install soma-pstack to keep them.
`soma graph close --dry-run` no longer runs command probes unless
`--run-probes` is given. See the
[changelog](../CHANGELOG.md#0290---2026-10-28) for the complete changes. GitHub
releases and Arc registry publication are verified separately.

## 0.28.0

[0.28.0](https://github.com/the-metafactory/soma/releases/tag/v0.28.0) lets a
skill manifest fill a capability with `algorithmCapability.satisfies`, so an
arc pack can bind contract rows such as `TraceMechanics`. It adds the
prototype and planning playbook cards, two more principles, the `verify-soma`
skill, a `Live probe` requirement in audited build briefs, and Codex and pi
substrates for knowledge-eval. Breaking: the root barrel `src/index.ts` and
`src/types.ts` are removed. See the
[changelog](../CHANGELOG.md#0280---2026-10-26) for the complete changes. GitHub
releases and Arc registry publication are verified separately.

## 0.27.0

[0.27.0](https://github.com/the-metafactory/soma/releases/tag/v0.27.0) turns
goals into records that pursue themselves: a goal-kind catalog with `feed`,
`queue` and `rate` sensors, `soma goal propose`, `add --accept`, `activate` and
a daily `sweep`, run-ledger emits, and an Errata ledger with daily triage. The
working method now loads in every substrate, and the source is split into
components behind public entries. Breaking: PAI migration and `soma import` are
removed. See the [changelog](../CHANGELOG.md#0270---2026-10-17) for the complete
changes. GitHub releases and Arc registry publication are verified separately.

## 0.26.0

[0.26.0](https://github.com/the-metafactory/soma/releases/tag/v0.26.0) adds
selected-section graph reads and safe node editing, preserves Resolution
headings on close, and routes task notices and ranger escalations to NATIVE.
It also ships bounded graph audits, safer frontier and blocker handling,
bundled skills in compiled binaries, and isolated scratch-home lifecycle writes.
See the [changelog](../CHANGELOG.md#0260---2026-10-11) for the complete changes.
GitHub releases and Arc registry publication are verified separately.

## 0.25.0

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
the [changelog](../CHANGELOG.md#0250---2026-10-07). This version is published on
GitHub only; the Arc registry is not updated by this release.

## 0.24.0

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
(#747). See the [changelog](../CHANGELOG.md#0240---2026-10-07). This version is
published on GitHub only; the Arc registry is not updated by this release.

## 0.23.1

[0.23.1](https://github.com/the-metafactory/soma/releases/tag/v0.23.1) adds a
build-node brief to the orienteer skill and fixes receipt counting in the work
graph. A new `references/build-brief.md` sets the template and rules for a build
node's body: nothing left to decide, Given/When/Then acceptance criteria with a
failure case and a test seam, an out-of-scope list that binds review, and one
vertical slice per node. `soma graph audit` and `decisions --write` again count
close receipts written before receipts carried an autonomy line, so those closes
are no longer reported as receipt-less (#744). See the
[changelog](../CHANGELOG.md#0231---2026-10-05). This version is published on
GitHub only; the Arc registry is not updated by this release.

## 0.23.0

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

See the [prompt-inspection section](runtime-policy-inspection.md#deterministic-v0-inspectors),
the [changelog](../CHANGELOG.md#0230---2026-10-05), and the
[release checklist](releases.md). This version is published on GitHub
only; the Arc registry is not updated by this release.
