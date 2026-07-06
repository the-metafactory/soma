# Anthropic Cowork Adapter

Status: experimental local projection scaffold implemented; Cowork-native load surface unverified
Target substrate id: `anthropic-cowork`
Primary mode: home

## Purpose

The Anthropic Cowork adapter projects Soma into a standalone folder for manual
review or future Cowork handoff experiments. Cowork's installed substrate
surface is not treated as verified until a live app probe identifies stable
app-support paths, global-instruction storage, MCP reachability, and any hook or
plugin surface.

The implemented scaffold therefore writes a reviewable local bundle under the
selected projection folder, defaulting to `~/.anthropic-cowork/`. Use
`--substrate-home` to target another local folder. This PR does not prove that
Cowork loads, grants, or watches that folder.

This is deliberately below the normal Soma adapter bar: it reuses install/export
plumbing to produce a local scaffold, but it is not a verified substrate-native
Cowork projection until a future probe proves the Cowork load primitive.

## Local Probe

The scaffold is intentionally based on a negative capability claim: this PR
does not encode any Cowork-owned app-support path, preference path, session
database, plugin store, MCP bridge, or hook surface as verified.

Future probes should record their commands and searched paths before promoting
any app-owned target into this adapter. A starting macOS probe surface is:

```bash
mdfind 'kMDItemKind == "Application" && (kMDItemFSName == "*Cowork*" || kMDItemFSName == "*Claude*")'
ls -d ~/Library/"Application Support"/*Cowork* ~/Library/"Application Support"/*Claude*
ls -d ~/Library/Preferences/*cowork* ~/Library/Preferences/*claude*
ls -d ~/Library/Containers/*Cowork* ~/Library/Containers/*Claude*
pgrep -af 'Cowork|Claude'
```

Because this PR encodes no Cowork-owned config target, the adapter does not
edit Claude/Cowork app state, `claude_desktop_config.json`, session databases,
VM state, preferences, or plugin stores.

## Projection Shape

```text
<projection-folder>/
  SOMA.md
  soma/
    README.md
    instructions.md
    profile.md
    purpose.md
    skills.md
    policy.md
    memory-snapshot.md
    active-vsa.md       # only when an active VSA exists
  capture/
    README.md
  skills/
    VSA/
      SKILL.md
```

`~/.soma` remains the source of truth. The generated Cowork files are snapshots
under the projection folder; `memory-snapshot.md` renders the memory projection
input and is not an independent privacy filter.

## Memory And Trust

`memory-snapshot.md` is populated from the `indexContent` projection input when
that input is available. The Cowork adapter does not traverse private memory
directories, relationship notes, security traces, raw transcripts, or non-index
memory notes itself, and it must not be treated as an independent scrubber for
whatever the upstream projection contains.

Cowork-authored candidate memory belongs in top-level `capture/`, outside the
generated `soma/` snapshot tree. Captures are not
Soma memory unless a separately implemented, policy-checked process later
admits them. This PR only creates the capture inbox; it does not implement
ingestion, quarantine classification, or promotion into Soma memory.

## Policy

Policy is advisory in the Cowork scaffold. No hook or pre-tool-use surface has
been verified, so deterministic enforcement must remain outside Cowork until a
future probe proves an enforceable substrate surface.

## Current Commands

```bash
soma install anthropic-cowork --dry-run
soma install anthropic-cowork --apply --substrate-home <projection-folder>
soma export anthropic-cowork --out <dir>
soma uninstall anthropic-cowork --substrate-home <projection-folder>
```

## Held Work

- live Cowork app-support path discovery
- global-instructions projection
- MCP configuration, blocked until the Soma MCP server exists and Cowork
  reachability is verified
- plugin packaging
- optional capture admission tooling, run outside Cowork
- doctor drift checks
