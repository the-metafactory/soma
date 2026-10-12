# Findings — node #783: attention surfaces a Vigil could reuse

Checkpoint: `cp-mfp-attention-inventoried`. Probed 2026-10-12.

## Method and refs read

Code was read at each repo's fetched default branch, not the local checkout:

| repo | ref read | note |
|---|---|---|
| ranger | `origin/main` 6004cb6 | re-checked at a355d2e: no change to `escalate.ts`, `card-sync.ts`, `digest.ts`, `serve.ts`, `cli.ts`, `announce.ts`, `budget.ts` |
| enzian (pack) | deployed clone `~/.local/share/metafactory/arc/repos/packs/enzian` 620d7c0 | |
| cortex | `origin/main` a9dc3aa8 | deployed copy `~/.local/share/metafactory/arc/repos/cortex` is v6.15.0 (80af4dea); it has the same attention wiring (`src/cortex.ts` holds 3 `publishReconcileDelta` references) |
| reflex | `origin/main` c49aacd | launchd runs the local checkout, which is on `chore/bump-myelin-v0.6.0` (1 commit ahead of and 1 behind `origin/main`); `src/daemon.ts` there also has the expiry sweep |
| recall | `origin/master` 1dcca52 | |
| metafactory-cortex-adapter-{discord,slack,mattermost,web} | `origin/main` c5c3d9c / cf15e1f / c00fb8f / 9993128 | |
| metafactory-cortex-renderer-pagerduty | `origin/main` f3c12dc | |
| soma | this worktree, `origin/main` | |

Deployment was checked with `launchctl list`, `~/Library/LaunchAgents/*.plist`, `curl` against local ports, and live config files read via `soma redact`.

Terms follow cortex `CONTEXT.md`: an **adapter** is a live chat-surface connection (inbound and outbound). A **renderer** is a render-only bus subscriber with no inbound path. **Mission Control** is the dashboard surface.

---

## 1. ranger escalation desk (HITL/provisioning cards)

- **What it does.** Posts one card per frontier node that needs the principal (HITL, provisioning, brief-not-ready) into each map's Discord thread. It announces once and then edits the card in place, keyed by a journal-cached message id. Cards show their age from first post: day 1 shows the age, 3+ days is "aging", and 7+ days is "overdue" with an `@`-mention of `principal.discordId` (`src/escalate.ts:41-51`, `src/card-sync.ts:80-86`, `src/card-sync.ts:123-136`). The 7-day mention arrives by editing the existing card, not as a separate post (`src/card-sync.ts:270`). Cards for nodes that left the queue are reconciled first, with a reserve of 5 (`src/escalate.ts:137-170`).
- **Limits.** There's a per-tick cap of `MAX_CARDS_PER_TICK = 50` (45 active cards plus a reserve of 5 absent ones, `src/card-sync.ts:21-23`) and a 120 s wall-clock budget per pass (`src/escalate.ts:39`). These are rate and throughput bounds. They don't count interruptions to the principal.
- **Graph access.** Read-only. Its side effects are Discord messages and the journal `escalations` table (`src/escalate.ts:49-50`).
- **Runs.** Deployed. `ranger tick` runs the cards pass and then the walk (`src/cli.ts:790-814`). launchd `ch.invisible.ranger-tick` runs it every 600 s (`StartInterval: 600`). It is loaded with last exit 0.
- **Scope.** Per producer and per map: ranger only. The live `~/work/mf/ranger/ranger.yaml` has 14 maps, each with its own Discord thread across 2 channel ids.
- **Vigil reuse.** This is the existing "announce once, edit in place, age, escalate" state machine (text and edit). It's tied to Discord and to ranger's journal.

## 2. ranger daily digest

- **What it does.** Builds one message per map: open cards (up to 15, with counts aged 3+d and 7+d), audit findings (receipt-less closes, open without checkpoint, open claims), and ranger's own budget (spawns today / `spawnCapPerDay`, dead-man, paused) (`src/digest.ts:74-158`). It truncates to 1950 chars and reserves room for the audit and budget sections.
- **Delivery.** The delivery state machine is `syncDailyDigest` (`src/digest.ts:191-260`). A new host-local day gets a fresh post. A same-day change edits in place. Unchanged content writes nothing. A deleted message is detected (404) and reposted. The cache lives in the journal health key `digest.<mapKey>`.
- **Runs.** Deployed. `ranger escalate --digest` (`src/cli.ts:1057-1076`) runs from launchd `ch.invisible.ranger-escalate` at `StartCalendarInterval {Hour: 7, Minute: 30}`. It is loaded with last exit 0.
- **Scope.** Per producer and per map. 14 maps means up to 14 digest messages a day. There is no cross-map or cross-producer digest.
- **Vigil reuse.** This is a working digest primitive: post, edit on change, no-op when unchanged, repost when deleted. It only works for Discord.

## 3. ranger's other unbudgeted Discord posts

Several other ranger paths post to the same per-map thread through `DiscordAnnouncer` or `EscalationDiscord`, with no shared counter:

- claim-announce, fail-closed: no message id means no claim (`src/announce.ts:5-14`, `src/walk.ts:97`)
- park card (`src/worker.ts:775-790`)
- base-red notice (`src/implement.ts:855`)
- merge-desk posts (`src/merge-desk.ts:283`)

`src/budget.ts` is a GitHub API budget gate (`src/budget.ts:8-25`). The spawn cap (`workers.spawnCapPerDay`, 20 in the live config) limits workers. Neither limits messages to the principal.

## 4. `ranger serve` dashboard

- **What it does.** A local, read-only dashboard (`src/serve.ts:7-49`). It shows the current job, the next node in the queue, nodes ranger can take on its own, open grillings, and "needs you" rows (parked, failed, needs-eye). Its action buttons only spawn existing CLI verbs (`ranger resume-node`, `gh pr merge`, `ranger build-now`) or an iTerm2 session. There's a `GET /api/state` JSON endpoint (`src/serve.ts:838`).
- **Runs.** Started manually (`src/cli.ts:1095`), port 7311 (`serve.port` in `ranger.yaml`). No launchd agent exists for it. At probe time `http://127.0.0.1:7311/` returned 200 with title "Ranger".
- **Scope.** Per producer: ranger only.

## 5. cortex attention queue and `system.attention.*` (attention-notify.ts)

- **Model.** `AttentionItem {id, stackId, workItemId, sessionId, kind, severity, status}`, where:
  - kind is one of `input_needed | permission | review | failed_dispatch | stale | blocked`
  - severity is one of `low | normal | high | critical`
  - status is one of `open | resolved | dismissed`

  Sources: `src/surface/mc/types.ts:384-410`. It's stored in `attention_items` with `created_at` and `updated_at` and no expiry column (`src/surface/mc/db/schema.ts:543-556`). The principal can resolve or dismiss an item via `POST /api/attention/:id/resolve|dismiss` (`src/surface/mc/api/attention.ts:69-92`, `src/surface/mc/server.ts:746-753`).
- **Producers.**
  - `db/attention-sources.ts:101-105,178,240`: permission, review, blocked, stale
  - `projection/failed-dispatch.ts:247`: failed_dispatch
  - `projection/observability-attention.ts:148-214`: blocked, signal health
  - `projection/adapter-lifecycle.ts:93`: blocked, adapter health
- **Notify path.** `attention-notify.ts` builds `system.attention.{opened,resolved}` envelopes from a reconcile delta: absent→open becomes "opened", open→resolved becomes "resolved". The message is a code-rendered `presentation` one-liner, `[severity] kind needs attention — <url>` / `[severity] kind cleared` (`src/surface/mc/attention-notify.ts:41-46,69-77,146-154`). So it notifies on state change, not on every pass.
- **What the comments say is deferred.** The header says the emit wiring and the Discord adapter branch are deferred and "does NOT exist yet" (`attention-notify.ts:17-23`). That comment is stale on `origin/main`. Wiring now exists:
  - the failed_dispatch producer publishes via `publishReconcileDelta` whenever `mc.enabled` (`src/cortex.ts:4928-4955`)
  - the cockpit loop publishes when `cockpit.enabled` (`src/cortex.ts:5879-5884`, `src/surface/mc/refresh.ts:57-66,143`)
  - the review-sink subscribes to `…system.attention.>` and renders `presentation` to `cockpit.attention.channel` (`src/adapters/review-sink.ts:73-74,107-114,137`; `src/cortex.ts:4180-4194`)
- **What is still missing** in the type and DB layer: the item has no TTL or expiry, `attention-notify.ts` has no rate, budget or digest logic, and each item becomes one envelope (`publishAttentionNotifications`, `:126-139`).
- **Runs.** cortex is deployed: launchd `ai.meta-factory.cortex.default` and `ai.meta-factory.cortex.switch`, both KeepAlive and running. `mc.enabled: true` in both stacks (`~/.config/cortex/default/stacks/default.yaml`, `~/.config/cortex/switch/stacks/switch.yaml`). Neither stack sets a `cockpit:` block, and `CockpitSchema.enabled` defaults to `false` with `attention.channel` defaulting to `""` (`src/common/types/config.ts:552-575,895-902`). So in the deployed config:
  - the cockpit loop is off
  - failed_dispatch attention is produced and published on the bus
  - the review-sink has no `attentionRouting` and ignores `system.attention.*`

  Attention reaches the principal only on the Mission Control dashboard.
- **Live state.** `GET /api/attention` showed 3 open items on 8767 (default: 3 failed_dispatch high). On 8768 (switch) it showed 38 open: 36 failed_dispatch high, 1 critical, 1 normal. Nothing expires them.
- **Scope.** Shared within cortex, across producers and stacks: `aggregateLocalStacks` plus federated attention projection (`src/surface/mc/projection/dispatch-lifecycle-renderer.ts:123-125,227`). Ranger, reflex and soma don't publish into it.

## 6. cortex Mission Control F-11 Discord push sink

- **What it does.** A pure `shouldNotify` policy maps assignment transitions (from, to, blockReason, priority) to `{audiences: dm|channel, severity: ping|silent, …}` (`src/surface/mc/notifications/should-notify.ts:1-45`). The sink keeps three in-memory buffers (`src/surface/mc/notifications/discord-sink.ts:1-22`):
  - a 5 s dedup window per assignment
  - a 3 s coalesce window per principal (N ≥ 2 collapses to one summary DM)
  - a 10 s throttle per channel

  It's called from `api/handlers.ts:965` and `session/stdout-dispatcher.ts:206`.
- **Runs.** Off. The master toggle is `grove.notifications.discord`, default `false` (`src/common/types/config.ts:606,631`), and neither deployed stack sets it.
- **Scope.** Per producer: MC assignment transitions only.
- **Vigil reuse.** This is the only code found that collapses bursts (coalescing) and separates DM from channel. Its windows are seconds long, not a daily budget.

## 7. cortex platform adapters (discord, slack, mattermost, web)

The contract is `PlatformAdapter` (`cortex src/adapters/types.ts:216-359`). The members relevant here are `postResponse(target, text, files)` (returns `void`, no message id), `sendProgress`/`clearProgress`, `resolveLogicalTarget({surface, channel, thread})`, and `notifyPrincipal(text)`.

| adapter | text to principal | edit in place | digest | dashboard entry |
|---|---|---|---|---|
| discord | `notifyPrincipal` sends a DM; buffers DMs while disconnected and drains them on reconnect (`src/index.ts:1234-1250,1330-1345`) | only the progress message (`sendProgress` edits, `src/index.ts:890-900`); `postResponse` can't edit | none | no |
| slack | `notifyPrincipal` posts to `principal.slackId` (`src/index.ts:677-687`) | no: "send once, skip subsequent" (`src/index.ts:616-619`) | none | no |
| mattermost | `notifyPrincipal` sends a DM via bot user (`src/index.ts:438-448`) | no (`src/index.ts:384-386`) | none | no |
| web | `notifyPrincipal` pushes to `broadcastUrl` with `target.channel = "_principal"` (`src/index.ts:393-403`) | no; push only | none | the receiving app decides; the deployed receiver is "Principal Console" at `127.0.0.1:8791` |

- **Deployed.** In the switch stack, Discord and Mattermost presences are enabled for agents (`~/.config/cortex/switch/stacks/switch.yaml`, `presence.discord` / `presence.mattermost` blocks), plus one web binding (`switch/surfaces/surfaces.yaml`, console-switch → `broadcastUrl :8791/switch/ingest`). In the default stack, the listed agents' Mattermost presences are disabled.
- **Scope.** Each is a delivery channel. None holds a counter, budget or digest. A text can go to any of the four. Only ranger (Discord, own client) and the MC dashboard (§8) have a dashboard entry or a digest.

## 8. cortex Mission Control dashboard

- **What it does.** The React dashboard (`src/surface/mc/dashboard-v2/`, attention view `components/attention-view.tsx`, `hooks/use-attention.ts`) is served by `src/surface/mc/server.ts`. It's the one pane for the cross-producer attention queue in §5, with live WebSocket `mc.projection` refresh.
- **Runs.** Deployed inside each cortex daemon. Port 8767 (default stack) and 8768 (switch, `mc.port: 8768`) both returned 200, title "Cortex · Mission Control". The `renderers: [{kind: dashboard, port: 8766}]` entry in `default/stacks/default.yaml` did not answer (curl 000).
- **Scope.** Shared within cortex (see §5).

## 9. PagerDuty renderer

- **What it does.** Forwards bus envelopes that match its `subscribe` patterns to PagerDuty events-v2 (README; `src/pagerduty.ts`):
  - `event_action` is always `"trigger"`. Resolve is a noted future step (`src/pagerduty.ts:30-32,155,169`).
  - `dedup_key` is `${source}:${type}` (`:33,170`).
  - Severity is derived from the type or from `payload.severity` (`:35-37,166,174`).
- **Runs.** Installed: `~/.local/share/metafactory/arc/repos/metafactory-cortex-renderer-pagerduty`, a cortex `arc-manifest.yaml` dependency. Not configured: no `kind: pagerduty` renderer appears in any `~/.config/cortex/{default,switch}` file.
- **Scope.** A shared renderer for whatever subjects it subscribes to. It can deliver a page, a text with no edit. It can't send a resolve, a digest or a dashboard entry.

## 10. reflex approval policy and TTL

- **Design.** `policy: auto | approval | disabled`. Under `approval`, a match becomes a **Matched Decision**, the only non-terminal outcome. It resolves to Fired via `reflex approve`, Denied via `reflex deny`, or Expired after the per-blueprint `approval_timeout` (default `1h`) (`docs/design-reflex-v0.md:49-53,70-75,126-140,227`).
- **Implementation.**
  - schema default `policy: "auto"`, `approval_timeout: "1h"` (`src/activation/schema.ts:125-126`)
  - `expiresAt` is set at match time (`src/pipeline/evaluate.ts:57-72`)
  - the daemon sweeps expired approvals once at boot and then every 30 s (`src/daemon.ts:124-132`)
  - removed blueprints expire their waiting decisions (`src/daemon.ts:112-114`)
  - decisions are published as `reflex.activation.decision.{matched|blocked|fired|denied|expired}` (`src/bus/envelopes.ts:7,16-23`; design `:162`)
- **Principal notice.** Nothing notifies the principal that a decision is waiting. Approval is CLI-only (`reflex pending` / `approve` / `deny`), and no notify, Discord or adapter call exists in `src/`.
- **Runs.** Deployed: launchd `ai.meta-factory.reflex`, KeepAlive, running. `reflex status` reported: `blueprints: 8 (schedule: 5, manual: 3)`, `Matched Decisions awaiting approval: 0`.
- **Which live blueprints use `policy: auto`.** All 8 in `~/.config/reflex/activations/` (`watch_roots: []`):
  - `enzian-morning`, `enzian-retry`, `enzian-digest` (weekdays 17:30), `enzian-manual` (`enzian.yaml`)
  - `f-testing` (`f-testing.yaml`)
  - `tana-meetings-daily`, `tana-meetings-catchup`, `tana-meetings-manual` (`tana-meetings.yaml`)

  No live blueprint uses `approval`. `enzian-digest` fires `@jc/enzian-tick` with `mode: digest`; its delivery is §10a.
- **Scope.** Shared across reflex blueprints. It is the only implemented "proposal that expires" in MetaFactory.

## 10a. Enzian daily digest (reflex → cortex brain → web adapter)

- **What it does.** Weekdays 17:30 reflex fires `enzian-digest` (`~/.config/reflex/activations/enzian.yaml`). The cortex process spec `~/.config/cortex/switch/processes/enzian-tick-kick.yaml` runs `brain/kick.ts --mode digest`, which publishes one brain task on `local.jc.switch.brain.enzian.tick` with `response_routing {surface: web, thread: <channel>/digest-<YYYY-MM-DD>, adapter_instance: ENZIAN_HOME_ADAPTER ?? "web:console-switch"}` (`brain/kick.ts:50,60-70,100`). The brain renders ran/delivered/failed/queued per meeting (`brain/digest.ts:18-45`) and posts it on its own task (`brain/handler.ts:24-27,148-161`). The "Waiting on you" line is hard-coded to "nothing (Enzian raises no gates)" (`brain/digest.ts:43`).
- **Delivery.** One post per day on a fresh thread. No edit in place, no no-op when unchanged. Meeting names stay in the console's local store (`brain/digest.ts:6-7`).
- **Runs.** Deployed. reflex (`ai.meta-factory.reflex`) → cortex switch stack → web adapter → "Principal Console" (`~/work/cyphr/sales-assistant/apps/console/src/main.ts`, launchd `ch.switch.console`, running, `127.0.0.1:8791` returned 200).
- **Scope.** Per producer: Enzian only. It is the one live digest that already rides the cortex adapter path instead of a private client.
- **Vigil reuse.** Shows the shape a Vigil digest could take today: reflex schedule → cortex task with `response_routing` → any adapter. Nothing in that path counts or merges other producers.

## 10b. soma harness gate (macOS notification)

- **What it does.** Weekly `harness-eval --check` against live soma-home data. On `regressed` or `could-not-run` it raises a macOS Notification Center banner via `osascript` (`scripts/harness-gate-check.sh:50,57,63,91,94`), plus a `RESULT` line in `~/Library/Logs/soma/harness-gate.log`.
- **Runs.** Deployed: launchd `ch.switch.soma.harness-gate`, Monday 09:00 (`scripts/launchd/ch.switch.soma.harness-gate.plist.template:28-32`), loaded, last exit 1. The last 4 logged results are all `RESULT regressed`.
- **Scope.** Per producer. It alerts on every red run, not on a change of state: a regression that stays red re-notifies weekly.
- **Vigil reuse.** None beyond being one more unbudgeted channel (Notification Center) a Vigil would have to absorb.

## 11. recall proposal spine

- **What it does.** `propose()` deduplicates by `sha256(type::normalized content)` (repeats count `occurrences`) and by Jaccard ≥ 0.6 against pending proposals of the same type (a match boosts confidence). It then sorts by threshold into `accepted_auto | pending | rejected_auto`. It holds at most 20 pending proposals per type. Eviction archives the lowest-confidence row (`decided_reason='cap_eviction'`) and deletes nothing (`src/lib/proposals.ts:1-26,202-236`). Statuses: `pending, accepted, rejected, accepted_auto, rejected_auto, deferred, archived` (`:64-71`). `deferred` rows carry a resurface time and flip back to pending when listed (`:93,707`).
- **Expiry.** None based on time. `ProposalStatus` has no `expired`. Preconscious proposals are documented as "auto-expire at SessionEnd", but the code says "mechanism lands in a later wave; today the expiry path is a documented lifecycle hole" (`src/commands/preconscious.ts:30-37,100-104`).
- **Deployed.** No. `recall` is not on PATH, there is no `~/.config/recall` or `~/.local/share/recall`, no launchd agent, no recall hooks in `~/.claude/settings.json`, and it is absent from `~/.local/share/metafactory/arc/repos/`.
- **Scope.** Per producer: memory proposals only.
- **Vigil reuse.** The bounded pending queue per type (cap 20, evict to archive) is a model for a bounded proposal inbox.

## 12. soma statusline

- **What it does.** One line per Claude Code session: mode and task, model, dir and branch, context %, 5 h and 7 d usage windows. It reads Claude Code stdin JSON plus `STATE/statusline-mode-<sid>.json` and `STATE/current-work-<sid>-*.json` (`src/adapters/claude-code/statusline.sh:1-13,172-193`). It doesn't use the network and shows no attention, alert or proposal content.
- **Runs.** Deployed by `soma install claude-code`: `~/.claude/settings.json` `statusLine` → `~/.claude/hooks/soma/soma-statusline.sh`. The file matches source except the substituted `SOMA_HOME` (line 12).
- **Scope.** Per session. It renders only when a session is open. Soma `src/` has no other notification sender: no Discord, push or webhook code found. The one soma notifier outside `src/` is the harness gate script (§10b).

## 13. Other prior art for limiting interruptions

- **ivy-heartbeat** (`~/work/ivy-heartbeat`, last commit 2026-03-26) runs checks and dispatches alerts to terminal, voice and email (`src/alert/dispatcher.ts:16-37`). It suppresses all channels outside active hours, default 08–22 (`src/alert/hours.ts`, `src/alert/types.ts:17-20`). This is the only quiet-hours rule found. It's not running: `com.pai.ivy-heartbeat-serve.plist` exists but is not loaded, and port 7878 didn't answer.
- **What actually limits interruptions.** Taken together, only these mechanisms limit, count or collapse messages to the principal:
  - ranger card caps and age bands (§1)
  - ranger digest no-op when unchanged (§2); the Enzian digest (§10a) and harness gate (§10b) have no such rule
  - MC F-11 dedup, coalesce and throttle, which is off (§6)
  - PagerDuty `dedup_key`, which is not configured (§9)
  - recall pending cap, which is not deployed (§11)
  - ivy-heartbeat active hours, which is not running (§13)

  None of them counts interruptions across producers.

---

## Capabilities a Vigil needs that nothing provides

1. **One attention budget across producers.** No component counts or caps messages to the principal across ranger, cortex, reflex, Enzian and soma. Live channels today: Discord (ranger), MC dashboard (cortex), Principal Console (Enzian via cortex web adapter), macOS Notification Center (soma harness gate). Ranger caps cards per tick by throughput. MC F-11 throttles over seconds and is off. Nothing has a daily or rolling count of interruptions.
2. **One router choosing text, digest or dashboard per state change.** Each producer hard-wires its channel: ranger → its own Discord client per map; cortex attention → MC dashboard, plus a review-sink channel only if `cockpit.attention.channel` is set (it isn't); reflex → bus decision envelopes plus CLI. Nothing picks the delivery form from severity or remaining budget.
3. **A cross-producer digest.** Ranger's digest covers one map from one producer (14 a day possible); Enzian's covers Enzian only and hard-codes "Waiting on you: nothing". The cortex adapters have no digest primitive. Nothing merges ranger cards, cortex attention and reflex decisions into one digest.
4. **Ranger and reflex on the shared attention path.** The `system.attention.*` envelope plus the MC queue exist but are fed only by cortex producers. Ranger's cards stay in its journal and Discord. reflex Matched/Expired decisions aren't turned into attention items.
5. **Expiring proposals that reach the principal.** reflex has a TTL, but no live blueprint uses `approval`, and a Matched Decision raises no notice. MC `AttentionItem` has no expiry (38 open on switch). recall has no time-based expiry and isn't deployed.
6. **Edit in place across adapters.** `PlatformAdapter.postResponse` returns no message id. Only Discord's progress message and ranger's own Discord client edit in place. Slack and Mattermost can't edit.
7. **An attention view in the statusline.** It shows session data only. No surface shows pending attention or proposals inside a session.
8. **Quiet hours on a live path.** The only implementation (ivy-heartbeat) isn't running and isn't connected to any MetaFactory producer.
9. **Resolve on the paging path.** The PagerDuty renderer only triggers, and it isn't configured.
10. **Change-of-state gating for every producer.** ranger cards and cortex `system.attention.*` fire on transitions; the soma harness gate re-notifies on every red weekly run (4 in a row logged) and the Enzian digest posts daily regardless of content. Nothing enforces "alert on change" at a shared choke point.
