# Session-start operation and verification

The registry and startup-history fixes shipped in Soma 0.20.3. Version 0.20.4
adds this operator guide; it does not change the runtime.

## Registry lock behavior

`lifecycle session-start` writes the session into `memory/STATE/work.json`.
Its `--work-registry-lock-timeout-ms` option bounds registry lock acquisition,
not the entire lifecycle invocation. Startup context loading, projection work,
and event writes also take time.

An ownerless lock directory is reclaimable once its age reaches the caller's
lock timeout. A lock with owner metadata retains the 30-second age threshold
and same-host dead-process check. A live owner, malformed metadata, or a
foreign hostname is not treated as an abandoned lock. Inspect failures before
attempting manual cleanup; deleting a live lock can break serialization.

If the registry write fails, startup records
`lifecycle.session_start.registry-write-failed` and can still complete with a
normal `lifecycle.session_start` event. Exit status alone therefore does not
prove a successful registry write.

## Bounded history loading

Startup reconciles `memory/STATE/algorithm-work-index.json` with Algorithm run
files, reading changed entries and using the existing scan fallback when
needed. Memory-only reprojection loads the home without the full skill
catalog. This reduces work before the registry write while preserving the
active-run summary.

## Verify an installed host

Use a unique probe session ID and invoke the installed runtime used by the
host. `soma runtime status --target codex` and `--target cli` identify the
active artifacts; they may differ. A source-tree test alone does not verify
an installed hook.

For the installed CLI, a manual probe looks like this; replace the example ID
with a fresh one and use the same ID for both lifecycle calls:

```bash
soma lifecycle session-start --substrate codex --session-id startup-check-001 \
  --work-registry-lock-timeout-ms 1000
soma telemetry list --kind lifecycle.session_start --limit 10 --json
soma telemetry list --kind lifecycle.session_start.registry-write-failed --limit 10 --json
soma lifecycle session-end --substrate codex --session-id startup-check-001 \
  --work-registry-lock-timeout-ms 1000
```

Before ending the probe, confirm its matching session entry in `work.json`,
a normal start event, and no registry-write failure for that session. Use the
session ID to distinguish it from concurrent work and older failures. End the
probe even if verification fails, so it does not remain active in the registry.
Telemetry reads the archive and live tail together; see
[Observability](observability.md).

The [lock-fix acceptance record](https://github.com/the-metafactory/soma/issues/682)
was completed on 2026-09-27: three noncontending installed Codex-runtime starts
took 429–488 ms, each wrote its registry entry and emitted a normal start event
without a failure event. These are host-specific observations, not a general
startup guarantee or a representative W2 baseline. Regression tests separately
cover stale ownerless locks and the CLI timeout under contention.
