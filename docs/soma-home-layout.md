# The Soma home: what `soma init` creates

`soma init --apply` creates `~/.soma/` (override with `--soma-home`). This
directory is the portable source of truth for your assistant. Substrate homes
(`~/.codex`, `~/.claude`, …) are generated projections of it. Everything in
`~/.soma` is plain, readable files; profile, skills, memory, VSAs, and policy
are yours to edit directly, while `projections/` holds generated caches that
re-projection rewrites.

## Layout

```text
~/.soma/
├── profile/
│   ├── assistant.md        # assistant identity (name, traits)
│   ├── principal.md        # who the assistant works for
│   ├── purpose.md            # mission, goals, principles, commitments
│   ├── communication.md    # how the assistant talks (voice, reference codes, aliases)
│   └── imports/            # provenance of migrated PAI/Claude identity
├── skills/                 # portable skill folders (<name>/SKILL.md)
├── memory/                 # Soma memory taxonomy (WORK, KNOWLEDGE, LEARNING, …)
│   ├── WORK/
│   │   └── algorithm-runs/ # Algorithm run state, one <run-id>.json per run
│   └── STATE/
│       └── active.json     # active VSA pointer
├── isa/                    # Verification State Artifacts, one <slug>.md per project/task
│   └── .templates/         # VSA scaffolding templates
├── policy/                 # substrate policy declarations
│   ├── behavior.md         # cross-substrate behavioral rules (advisory, projected)
│   └── probe-registry.json # work-graph probe authorisations (see docs/work-graph.md §2.2)
├── imports/                # migration manifests and portability reports
└── projections/            # cached generated projections (codex, claude-code, …)
```

## How the assistant talks, and what it may do

Two principal-authored files govern conduct, and they are deliberately separate:

- **`profile/communication.md`** — the *communication contract*: voice, positive
  and negative patterns, the banned-phrase list, reference codes, and aliases.
  It belongs to the Identity compartment, which owns voice and personality.
  `soma init` writes a generic starter; edit it directly. Soma projects the file
  **verbatim** into every substrate and parses only `## Reference codes` for
  itself, to refuse a contract that claims a reserved letter. Everything else —
  aliases, labels, examples — reaches the model through the verbatim content,
  so there is nothing else for Soma to extract.
- **`policy/behavior.md`** — the *behavioral policy*: scope discipline,
  verification, permission boundaries, external-content handling. It belongs to
  the Policy compartment. Its `## Heading` sections become advisory lines in
  every substrate's policy projection, wrapped bullets folded back into whole
  rules.

One rule, one home: an operational boundary goes in `behavior.md`, a habit of
speech goes in `communication.md`. Neither file is created with rules Soma
invented — an absent file projects nothing rather than a default.

Reference codes (`F1`, `O2`, `D3`) are addressable run state, not display
formatting: `soma algorithm ref` records one and `soma algorithm resolve`
closes it, so `keep D1` is a write. `C` and `P` are reserved for VSA criteria
and Algorithm plan steps and are refused; `D` codes additionally mirror into
the run's decisions log.

`policy/probe-registry.json` is **not** created by `soma init`: it authorises
`command` and `url` probes to run on this machine, and its absence is the
fail-closed default — those probes refuse until an adopter writes it by hand. See
[`work-graph.md` §2.2](work-graph.md) for the format, or run `soma policy probes`
to see the current state.

On a fresh machine the profile files start as a **starter profile**
(`status: starter-profile` in `principal.md`). Replace them with your own
content, or import an existing installation (see below). `soma doctor` warns
while the starter profile is still in place.

## Where the Algorithm and VSA live

Soma ships its own, substrate-neutral implementation of the Algorithm work
harness and Verification State Artifacts — they do not depend on PAI or any
substrate being installed:

- **Implementation:** the `soma algorithm ...` and `soma vsa ...` CLI commands
  (see [README — The Algorithm](../README.md#the-algorithm) and
  [README — VSA](../README.md#isa)).
- **State on disk:** Algorithm runs persist as JSON under
  `memory/WORK/algorithm-runs/`; VSAs are markdown files under `isa/`, with
  the active VSA recorded in `memory/STATE/active.json`.
- **Projection:** substrate adapters surface the active VSA and Algorithm
  state into each substrate (for Claude Code: `~/.claude/rules/soma/`).

## How the home gets populated

`soma init` runs up to four steps, shown by the dry-run plan (`soma init`
without `--apply`):

1. `bootstrap-soma-home` — always. Creates the skeleton above; idempotent,
   existing files are never overwritten.
2. `migrate-claude-skills` — only when `~/.claude/skills` exists **and**
   contains at least one importable `<Name>/SKILL.md`. A fresh Claude Code
   install ships an empty skills directory; the plan reports it as
   "empty — nothing to import" and skips the step.
3. `migrate-pai` — only when a PAI installation (`~/.claude/PAI`) is detected.
   Imports identity, Purpose, Algorithm context, memory, and docs.
4. `install-<substrate>` — projects the Soma home into the selected substrate
   (default `codex`; choose with `--substrate`).

No Claude Code, no PAI? Steps 2 and 3 simply do not appear; you get a working
Soma home from the starter profile. Re-running `soma init --apply` later, after
installing Claude Code or PAI, picks the migrations up.
