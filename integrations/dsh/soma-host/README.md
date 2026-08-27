# @metafactory/soma-dsh-host

DSH **host** plugin that carries Soma into a live session — the hooks/memory/
algorithm side of the Soma ↔ DeepSeek Harness substrate integration (P1). See
[`docs/dsh-substrate.md`](../../../docs/dsh-substrate.md) in the soma repo.

It gives every live session:

1. an **always-on Soma prompt section** (identity / purpose / policy anchor)
   via `ctx.systemPrompt.section({ name, order, text })`;
2. **lifecycle writeback to `~/.soma`**: `soma lifecycle session-start` on
   `agent/session-start`, and `soma lifecycle session-end` when the agent first
   goes idle (deduped per session via `ctx.storageDomain`);
3. a **runtime digest skill** (`soma-digest`) routing session wrap-up to
   `soma memory digest`;
4. host CLI tools: **`soma_memory`** for recall, **`soma_algorithm`** for
   durable Algorithm run reads/mutations, and **`soma_graph`** for bounded
   work-graph reads/mutations. The latter two avoid the model-facing workspace
   sandbox, which cannot write `~/.soma`.

The plugin shells out to the `soma` CLI (raw `ctx.subprocess` argv, no shell
interpolation) rather than re-implementing Soma — Soma stays the single source
of truth. The full `the-algorithm`, `Memory`, `VSA`, and `orienteer` skills are
projected as files by the soma `dsh` adapter and auto-discovered by DSH's
`dsh-skill-filesystem`; this plugin only adds the always-on session layer.

## Status

**Smoke-tested against real cordis; applied in a booted `dsh web` server.**
The plugin declares its services (`export const inject = ["systemPrompt",
"skills", "tools", "storageDomain", "subprocess"]` — cordis throws "cannot get
property X without inject" otherwise; all five are mounted by the default
`dsh-base` + `dsh-web-app` composition).

The executable evidence is checked in: [`tools/cordis-smoke.mts`](./tools/cordis-smoke.mts)
applies the plugin on the DSH checkout's own cordis runtime with stub
services, fires lifecycle events through DSH's real scoped `emitAgentEvent`
dispatch, and asserts prompt-section/skill/tool registration, both lifecycle
spawns with storageDomain dedup, and the failure path (a failed session-end
spawn must not write the dedup key — it has to stay retryable):

```bash
DSH_CHECKOUT=/path/to/deepseek-harness \
  node --import tsx/esm tools/cordis-smoke.mts
```

Run it from the DSH checkout (so `tsx` resolves). In a booted server the
plugin has applied and fired session-start (the runtime skill is visible in
the session catalog; `lifecycle.session_start` events land in the Soma event
log); the session-end path has not yet been observed live.

## Install

From the DSH profile (note the `-w`: `dsh plugin` forwards to pnpm inside the
profile directory, which is a workspace root, so pnpm demands
`--workspace-root`):

```bash
# from the soma repo root
dsh plugin --profile web add -w file:./integrations/dsh/soma-host
```

Add the host row to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: soma-host
      name: '@metafactory/soma-dsh-host'
      config:
        writeDigests: true
        somaPath: soma
```

Restart `dsh web`. (A `soma` **preset** is the alternative: put the row in
`~/.dsh/.agent-presets/soma/agent.cordis.yml` so only sessions that pick the
preset get it; rows that publish a *service* must sit inside a
`cordis:group` with an `isolate` realm — pure registrants like this one do not.)

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `writeDigests` | `true` | shell out to `soma` for lifecycle writeback |
| `somaPath` | `soma` | soma CLI (absolute path if not on PATH) |
| `sectionOrder` | `0` | system-prompt section order (persona is `0`; use `1`+ to follow it) |

## Verify

1. Start a session, send a prompt, let it run to idle.
2. `~/.soma/memory/STATE/events.jsonl` gains `lifecycle.session_start` (+
   `session_end`) rows with `substrate: dsh`.
3. The system prompt contains the "You run on Soma" anchor.
4. Ask the model to recall memory — it can use the `soma_memory` tool.
5. Start or update an Algorithm run — the model uses `soma_algorithm`, not a
   sandboxed shell command, and the run is written under `~/.soma`.
6. Close a graph node with `soma_graph`: pass `resolution` prose or a
   workspace-relative `resolutionFile`. The host rejects absolute paths,
   traversal, and symlink escapes; direct prose is written as a temporary,
   mode-0600 workspace file and removed after the CLI returns. `decisions
   --write` is available because the CLI updates only the map's marker-bounded
   derived index.

## License

MIT.
