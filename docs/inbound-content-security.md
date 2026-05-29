# Inbound Content Security

Soma treats externally sourced content as untrusted until Policy records a
scanner-backed decision for the exact bytes being read into context.

This is a Soma-native port of the useful PAI/content-filter security model, not
a direct copy of PAI hooks. Soma owns the Policy vocabulary, audit/writeback
contract, security trace format, and substrate projection. Scanner packages
provide evidence behind the `InboundContentScanner` interface.

## Model

The default untrusted root is:

```text
<soma-home>/memory/RAW/untrusted/
```

Inbound security has two gates:

- acquisition gate: routes external bytes into an untrusted root where a
  substrate can enforce or encourage that routing
- context-entry gate: scans exact bytes before they enter model context

The first implementation slice ships the context-entry gate. Acquisition
routing is adapter-specific follow-up work.

## Decisions

Soma normalizes scanner output into three decisions:

| Decision | Meaning |
| --- | --- |
| `ALLOWED` | Content may enter context for this hash-bound scan result. |
| `BLOCKED` | Content must not enter context. |
| `HUMAN_REVIEW` | Content is ambiguous and blocks context entry until a future review/override flow exists. |

Allowed content is represented by a content reference:

```json
{
  "algorithm": "sha256",
  "hash": "<content-hash>"
}
```

The source path is never permanently trusted by itself. If the file changes, it
gets a different hash and needs a new decision.

## Audit

`soma policy scan` writes bounded observability to:

```text
<soma-home>/memory/STATE/events.jsonl
```

It writes richer private traces to:

```text
<soma-home>/memory/SECURITY/inbound-content/
```

Traces contain the decision, reason, scanner id, source metadata, content hash,
and findings. They do not mirror raw external content by default.

## CLI

Scan a file:

```bash
bun run soma policy scan --path <path> --json
```

Scan a string:

```bash
bun run soma policy scan --content "..." --json
```

Promote an allowed file reference:

```bash
bun run soma policy promote --path <path> --json
```

`promote` fails unless the scan decision is `ALLOWED`.

## Scanner Dependency

`@metafactory/content-filter` is the intended production scanner adapter, but
it is not yet published on npm as of the #250 implementation. Soma therefore
ships the interface and deterministic fallback scanner now, without vendoring
or GitHub-pinning the package. When the package is released, it should implement
`InboundContentScanner` behind the existing boundary.

## Codex Projection

Codex gets the first enforceable projection because Soma already has a
`PreToolUse` hook path. The Codex home projection now includes inbound security
config in `hooks/soma-lifecycle.config.json`; `Read` calls under
`<soma-home>/memory/RAW/untrusted/` invoke `soma policy scan`. `BLOCKED` and
`HUMAN_REVIEW` deny the read.
