# @metafactory/soma-dsh-hide-tools

DSH client plugin that hides **tool-call rows from the chat flow** — the "tool
call spam" you see in coding agents. Tool calls stay fully recorded in the
durable session log (`tool/call` + `tool/result` pairs) and remain visible in
the **Trajectory** audit tab; only the in-flow cards disappear, so the
assistant's own voice is what you read.

Part of the Soma ↔ DeepSeek Harness substrate integration (P0). See
[`docs/dsh-substrate.md`](../../../docs/dsh-substrate.md) in the soma repo.

## How it works

The chat flow renders each conversation node through
`renderSlot("conversation.chat.node", …)` (`dsh-client-ui-conversation`
`ChatNodeSeat`), keyed by `node.kind`. Tool calls are the `tool-call` node kind,
rendered by `dsh-client-ui-tool`. Disabling `ui-tool` alone is NOT enough — an
unmounted node kind renders a `JsonBlock` "Unknown surface" fallback.

This plugin hides by CSS against the stable DOM contract every chat row carries:

- `[data-chat-flow-kind="tool-call"]` — the tool-call tree rows
- `[data-chat-anchor-key^="call:"]` — belt-and-suspenders

Zero external `require`s, so the bundle cannot break on module-table drift.

## Install

From the DSH profile:

```bash
# from the soma repo root
dsh plugin --profile web add file:./integrations/dsh/soma-dsh-hide-tools
```

Then add the row to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: soma-hide-tools
      name: '@metafactory/soma-dsh-hide-tools'
```

Restart the web server (`dsh web`). The `dsh.client` package is scanned by
`dsh-client-modules`, its `./client` bundle is served under
`/plugins/<id>/client.js`, and the shell composes it via
`window.__ModuleLoader__.load({ id, factory })` — no rebuild needed for this
hand-authored classic-script bundle.

## Options / alternatives

- **Hide the Trajectory tab too:** disable `ui-trajectory` in the same patch:
  ```yaml
  - id: ui-trajectory
    disabled: true
  ```
  (The trajectory is the audit surface; hiding it in CSS would still load it.)
- **Renderer variant (instead of CSS):** register a null renderer for the
  `tool-call` chat node key via `ctx.slots.inject("conversation.chat.node", …)`.
  See the commented `applyRenderer` in `lib/client.js`. Requirements verified
  against `@deepseek-ai/dsh*` 0.1.0-rc.8: it must declare the `slots` **service**
  in the plugin's returned `inject` (`["slots"]`), and it must use
  `priority: -1` because `ui-tool` registers the same key at the implicit
  priority `0` — same key + same priority throws; lowest priority renders.
  Note this variant still leaves an empty row box in the flow (ChatNodeSeat
  renders the wrapper *outside* the slot), so the CSS route is preferred.

## Verify

In a live session, run a task that calls tools (e.g. a `bash` or `read`). The
assistant's text and reasoning rows appear; the tool cards do not. Export the
session (`/export`) and confirm `tool/call` + `tool/result` events are still in
the log.

## License

MIT.
