# Soma ↔ DeepSeek Harness integration

DeepSeek Harness (DSH) is a local, cordis-plugin-based coding agent. These are
the Soma-side artifacts that make DSH a Soma substrate. The full design and the
Soma `dsh` substrate adapter spec live in
[`docs/dsh-substrate.md`](../../docs/dsh-substrate.md).

| Package | Plane | What it does | Status |
| --- | --- | --- | --- |
| [`soma-host/`](./soma-host) | host | Always-on Soma prompt section, session-start/end lifecycle writeback to `~/.soma`, runtime digest skill, `soma_memory` tool. | live — installer-managed, smoke-tested against real cordis |
| [`soma-dsh-hide-tools/`](./soma-dsh-hide-tools) | client | Hides tool-call rows from the chat flow (the "tool call spam"). Tool calls stay in the durable session log + Trajectory tab. | prototype (hand-authored bundle, hand-installed) |

The `dsh` **adapter** (`soma install dsh` / `soma export dsh` /
`soma doctor --substrate dsh`) is implemented: loader-mode skill registry
symlinks, the `soma` entry skill, the `AGENTS.md` pointer block, and lifecycle
projection — see the design doc's
[Adapter contract](../../docs/dsh-substrate.md#adapter-contract) section.

## Install

The **host plugin is installer-managed**: `soma install dsh --apply` copies it
from the running soma installation into `<somaHome>/integrations/dsh/soma-host`,
adds it to the composed `web` profile via pnpm, and upserts the marker-guarded
`- insert:` row into `~/.dsh/profiles/web/cordis.patch.yml`. No manual steps.
Restart `dsh web` afterwards and verify:

```bash
grep '"substrate":"dsh"' ~/.soma/memory/STATE/events.jsonl | tail -3
```

The **hide-tools client plugin** is still hand-installed:

```bash
# from the soma repo root; -w because the profile dir is a pnpm workspace root
dsh plugin --profile web add -w file:./integrations/dsh/soma-dsh-hide-tools
```

then add its row to `~/.dsh/profiles/web/cordis.patch.yml` (see its README)
and restart `dsh web`.
