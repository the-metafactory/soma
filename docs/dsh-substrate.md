# DeepSeek Harness Substrate

**Status:** Adapter implemented (`src/adapters/dsh/`, `soma install dsh`); the
host plugin (`integrations/dsh/soma-host`) is live: installer-managed (install
copies it from the running soma package, wires the profile dependency, and
patches the composition row) and smoke-tested against real cordis. The
client-side `soma-dsh-hide-tools` remains a hand-installed prototype.

This document specifies how Soma projects into **DeepSeek Harness (DSH)** as a
new substrate, and how a set of DSH plugins carries Soma's algorithm, hooks,
memory, and orienteer surfaces inside a live DSH session. It is the DSH
counterpart of the Codex, Grok, Pi.dev, Cursor, and Claude Code adapters.

## Why DSH

DSH is a local, cordis-plugin-based coding agent (a Web GUI at
`127.0.0.1:3080`, plus a headless CLI) whose runtime is a pure event/plugin
surface: identity, instructions, skills, tools, and prompts all arrive through
plugins, and its UI is itself a set of client plugins. That makes DSH one of
the most *composable* Soma substrates yet:

- it auto-loads a user-global instruction file (`$DSH_HOME/AGENTS.md`) and
  per-project `AGENTS.md`/`CLAUDE.md` into every session, like Codex;
- it auto-discovers skills from `~/.dsh/skills`, `~/.agents/skills`, and
  project `.dsh/skills`, in the exact `SKILL.md` + frontmatter format Soma
  already ships;
- its tool registry, system-prompt sections, and skill catalog are per-agent
  compositions ("presets"), so a Soma persona can be a first-class preset;
- its host plugin surface exposes session/turn/tool lifecycle events that map
  one-to-one onto Soma's SessionStart/SessionEnd/PostToolUse hooks.

The concrete driver of this proposal is a UI wish: DSH's chat flow renders
every tool call as a card, and the model's trajectory is on screen all the
time — the same "tool call spam" Soma users see in Codex. A small client
plugin hides the tool-call rows (they stay in the durable session log for
audit), leaving the assistant's own voice — Soma's `communication.md` — as the
only visible surface.

## DSH substrate facts (verified against `@deepseek-ai/dsh*` 0.1.0-rc.8)

| Surface | Mechanism | Soma projection target |
| --- | --- | --- |
| User-global instructions | `dsh-agent-instructions` loads `$DSH_HOME/AGENTS.md` into every session as a `<system-reminder>` block | `~/.dsh/AGENTS.md` |
| Project instructions | `dsh-agent-instructions` also loads `<project>/AGENTS.md` / `CLAUDE.md` (candidates `['AGENTS.md','CLAUDE.md']`) | repo `AGENTS.md` (already Soma-shaped) |
| Skills | `dsh-skill-filesystem` auto-discovers `<name>/SKILL.md` under `~/.dsh/skills`, `~/.agents/skills`, `<project>/.dsh/skills`, `<project>/.agents/skills` | `~/.dsh/skills/<skill>/SKILL.md`, `<project>/.dsh/skills/...` |
| Skills in-context | `dsh-tool-skill` renders a catalog + `<skill_content>` on demand via the `skill` tool | symlink bodies under the loader dir (on-demand) |
| Per-session composition | agent presets at `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml` (tools + prompt sections + skills) | `~/.dsh/.agent-presets/soma/` |
| Prompt sections | `ctx.systemPrompt.section({name, order, text})` | Soma identity/purpose/policy, always-on |
| Tools | `ctx.tools.register(defineTool({...}))`; `restrict`/`guard` for model visibility | Soma CLI verbs as tools |
| Session lifecycle | live `agent/session-start`, `agent/turn-stopping`, `session/event`, durable `turn/end`, `tools/pre-execute → execute → post-execute → result` | Soma SessionStart/SessionEnd/PostToolUse writeback |
| Feedback | durable `feedback/record{text}`; `ctx.messageFeedback` sidecar | `soma feedback capture` |
| Goals | durable `goal/change`; `ctx.goals` verbs | Soma Algorithm runs / active VSA |
| Persistence | `ctx.storageDomain` domain/table KV store under `~/.dsh/storages` | Soma idempotency/state for the plugin |
| External process | `ctx.subprocess.spawn` / `ctx.shell.run` (providers: `dsh-subprocess-local`, `dsh-bash-local`) | invoke the `soma` CLI |
| Model-facing tool presentation | `ctx.tools.presentAs('native'|'code'|'both')` | **model**-facing only |
| Browser tool-card rendering | `dsh-client-ui-tool` registers the `tool-call` chat node; `dsh-client-ui-trajectory` is the audit tab | **UI**-facing: hide via a client plugin |

Two facts matter for the design:

1. **`AGENTS.md` is loaded verbatim.** DSH does not process Codex's `@./...`
   include lines. The DSH home `AGENTS.md` must carry the entry context
   directly (identity, purpose, memory pointers, policy, and pointers to the
   Soma skills to load via the `skill` tool), not `@`-imports.
2. **Skills are a real, auto-discovered surface.** Soma's bundled skills
   (`the-algorithm`, `Memory`, `VSA`, `orienteer`) already use the
   `SKILL.md` + `name`/`description`/`metadata` frontmatter format DSH reads,
   so projecting them is a pure copy — no format adaptation.

## Projection layout

### Home projection (`~/.dsh`)

```
~/.dsh/
  AGENTS.md                          # Soma entry: identity, purpose, policy,
                                     # memory layout, active VSA, "load these skills"
  skills/
    soma/SKILL.md                    # entry skill: the portable assistant core
    the-algorithm/SKILL.md           # Algorithm doctrine (+ Workflows/, references/)
    Memory/SKILL.md                  # files-first memory skill
    VSA/SKILL.md                     # managed VSA skill (via vsaSkillProjection)
    orienteer/SKILL.md               # work-graph doctrine (progressive: registry only)
  .agent-presets/
    soma/agent.cordis.yml            # optional: a Soma preset (persona + plugins)
    soma/preset.yml
```

`~/.dsh/AGENTS.md` is auto-loaded into every session. The `soma` entry skill
and the Soma skills are auto-discovered by `dsh-skill-filesystem` and load on
demand through DSH's `skill` tool — this is the **on-demand / loader**
skill-loading mode, so Soma projects symlinked bodies and no catalog
(`skillsLoading: 'on-demand'`, `skillsDiscovery: 'loader'`).

### Workspace projection (`<project>/.dsh`)

```
<project>/.dsh/
  skills/
    soma/SKILL.md                    # project-local Soma layer (VSA, local rules)
    the-algorithm/SKILL.md
    ...
```

Project skills are auto-discovered per workspace. A repo that already carries a
Soma-shaped `AGENTS.md` needs no further instruction file.

### Communication and policy

- `~/.soma/profile/communication.md` projects **verbatim** into
  `~/.dsh/skills/soma/communication.md` (mirroring the Codex
  `memories/soma/communication.md` path) and is referenced from the entry
  skill.
- `~/.soma/policy/behavior.md` is parsed by `behaviorPolicyAdvisory` and merged
  into the `AGENTS.md` policy section, exactly as every other adapter does
  (no adapter restates a rule).

## Adapter contract

The adapter is registered the same way the other install substrates are. The
adapter lives in `src/adapters/dsh/` (a directory adapter, mirroring the
refactored `src/adapters/codex/`), with `adapter.ts` (projection), `install.ts`
(install spec), and `index.ts` (barrel). `SubstrateId` gains `"dsh"` in
`src/types.ts` (lines 5–13), and `"dsh"` is added to the `Extract` literal at
line 17 so it flows into `ProjectionSubstrate` and `InstallSubstrate`.

The exact wiring list (verified against the current tree; the `Record<
InstallSubstrate, …>` tables make missing rows compile errors):

1. `src/types.ts` — `SubstrateId` (5–13) and `InstallSubstrate` extract (17).
2. `src/adapters/private-roots.ts` — `DSH_DEFAULT_HOME = ".dsh"`; registered in
   `src/projection-private-roots.ts` (`Record<InstallSubstrate, …>`).
3. `src/install-spec-registry.ts` — `dshInstallSpec` in `INSTALL_SPECS`.
4. `src/home-projection.ts` — `"dsh"` in `HOME_PROJECTION_INSTALL_SUBSTRATES`
   (21) + `buildDshHomeProjection`/`installDshHomeProjection` + the
   `buildSubstrateHomeProjection` switch (184–197).
5. `src/install.ts` — `planSomaForDshInstall` / `installSomaForDsh` /
   `uninstallSomaForDsh` + the `installHomeProjectionFor` switch (414–427).
6. `src/cli/substrate-lifecycle.ts` — `INSTALL_SUBSTRATES` (106),
   `installPlanners` (133), `installers` (142), `projectionBuilders` (151),
   `runUninstall` (555).
7. `src/adapters/doctor.ts` — `DOCTOR_SUPPORTED_SUBSTRATES` (17);
   `src/adapters/content-compare-doctor.ts` — `ContentCompareSubstrate` (37) +
   `SUBSTRATE_LABELS` (130).
8. `src/execution/registry.ts` — `KNOWN_SUBSTRATES` (5).
9. `src/cli/substrate.ts` — `SUBSTRATE_IDS` (7–16).
10. `src/adapters/index.ts` + `src/index.ts` — exports.
11. Help strings (`src/cli/onboarding.ts:43`) and docs.

### Projection layout for the adapter

Home (`defaultHome: ".dsh"`):

- `AGENTS.md` — marker-guarded Soma pointer block (copy the grok pattern from
  `src/adapters/grok/config-patch.ts`), naming `skills/soma/SKILL.md`.
- `skills/soma/SKILL.md` — the auto-discovered entry skill: frontmatter
  `name: soma` / `description` / `metadata.short-description` **plus a
  `whenToUse` key** (see the gap below), body = `renderAssistantCore(input)`
  + read-the-colocated-files guidance.
- `skills/soma/{memory-layout,skills,policy,communication,startup-context}.md`
  — colocated reference files DSH loads on demand (grok's shape).
- `skills/<portable>/…` — `buildPortableSkillFiles(input.profile.skills,
  input.bundledSkillNames, "dsh")` (the generic portable loop).
- `skills/the-algorithm/SKILL.md` — `renderAlgorithmRenderingContract("DSH")`
  (emitted after portable files, last-wins).
- `skills/VSA/…` — `vsaSkillProjection.destinationDir = vsaSkillUnder()`.
- optional `skills/soma/memory-index.md` (Tier-0 index, mirroring codex) and
  `.agent-presets/soma/` (a DSH-native preset — no other adapter does this).

Workspace: DSH's native per-project surface is `<projectRoot>/.dsh/skills/`, so
the workspace install needs a dedicated resolver (like cursor's
`cursorWorkspaceSubstrateHome`) targeting `<project>/.dsh/`, emitting portable
skills + an optional `.dsh/AGENTS.md` pointer — not the default
`./.dsh/soma` convention.

```ts
export const dshInstallSpec: SubstrateInstallSpec<"dsh"> = {
  substrate: "dsh",
  defaultHome: ".dsh",
  homeFiles: [
    "AGENTS.md",
    "skills/soma/SKILL.md",
    "skills/the-algorithm/SKILL.md",
    "skills/soma/communication.md", // conditional on communication.md
    "skills/soma/startup-context.md",
    "skills/soma/soma-repo.txt",
    // portable skills land via the generic loop; VSA via vsaSkillUnder()
  ],
  ownedSubtrees: ["skills/soma"], // DSH skills/ is shared, like Codex
  skillsLoaderDir: skillsLoaderUnder(),        // <home>/skills
  skillsLoading: "on-demand",                  // skill tool loads bodies on demand
  skillsDiscovery: "loader",                   // dsh-skill-filesystem advertises its own catalog
  vsaSkillProjection: { destinationDir: vsaSkillUnder() }, // <home>/skills/VSA
  lifecycleProjection: {
    startupContextPath: "skills/soma/startup-context.md",
    somaRepoPathPath: "skills/soma/soma-repo.txt",
  },
  postProjection: [
    // marker-guard-merge the user's AGENTS.md (grok-style) here
  ],
  uninstall: { kind: "reserved", reason: "…" },
};
```

Policy and communication follow the shared helpers:

- `renderPolicyProjection("dsh", enforceable, [...behaviorPolicyAdvisory(
  input.behavior), ...SELF_HEALING_DOCTRINE_ADVISORY])` → `skills/soma/policy.md`
  (the drift tests enforce that no adapter restates a rule).
- `communicationContractFile(input, path)` → `skills/soma/communication.md`
  (verbatim bytes, omitted when the home has none), with a
  "read `…/communication.md` when present" instruction in the entry `SKILL.md`
  — `test/communication-contract.test.ts` enforces every projection that
  carries the contract also tells the model to read it.

**Detect:** `detect()` returns
`Boolean(process.env.DSH_HOME) || existsSync(<home>/.dsh)` (the grok pattern).

### Known gaps for the implementer

- **`whenToUse` frontmatter.** DSH's `dsh-skill-filesystem` parses an optional
  `whenToUse` key; the shared `buildPortableSkillFiles` / codex skill renderer
  emit only `name`/`description`/`metadata`. The DSH adapter must either
  confirm the loader tolerates its absence (it is optional) or synthesize a
  `whenToUse` line on the entry skill — a deliberate adapter-side addition.
- **Uninstall** — start `reserved` like Codex; removing the Soma block from a
  user-owned `~/.dsh/AGENTS.md` needs the marker-guarded merge to be reversed
  in a follow-up.

## Installer-managed plugin wiring (host plugin)

`soma install dsh --apply` owns the host-plugin activation chain end to end
(`src/adapters/dsh/plugin.ts`, postProjection step `dsh-host-plugin`):

1. **Copy from the running install** — the plugin package is resolved relative
   to the running soma module (`import.meta`), so a deployed soma copies its
   own bytes into `<somaHome>/integrations/dsh/soma-host`; never a development
   checkout path.
2. **Profile dependency** — `pnpm add -w file:<copy>` inside
   `~/.dsh/profiles/web` (the `-w` is required: the profile directory is a
   pnpm workspace root; this is exactly what `dsh plugin add` forwards to).
3. **Composition row** — a marker-guarded `- insert:` block in the profile's
   `cordis.patch.yml` (`# <!-- soma:dsh:cordis-patch:begin -->`). The upsert
   handles the valid document shapes (missing file, bare `[]` placeholder,
   existing user rows), strips a legacy hand-written `id: soma-host` row
   instead of double-inserting, and is byte-stable outside the markers.

Ordering is load-bearing: the row references the `file:` dependency, so a
failed pnpm call must leave `cordis.patch.yml` untouched — an insert row
without its dependency crashes every subsequent `dsh web` boot with
"cannot get property … without inject"-style loader failures. The step skips
cleanly when no composed profile exists (`profiles/web/package.json` absent),
which keeps greenfield installs deterministic; for the same reason
`profiles/web/cordis.patch.yml` is NOT declared in `DSH_HOME_FILES`
(memory-index.md precedent for conditionals).

Cordis contract worth remembering: every service property access must be
declared on the plugin (`export const inject = ["systemPrompt", "skills",
"tools", "storageDomain", "subprocess"]`) or the fiber throws "cannot get
property X without inject". All five are mounted by the default
`dsh-base` + `dsh-web-app` composition.

## The plugins

### P0 — `soma-dsh-hide-tools` (client plugin): hide tool calls in the UI

The chat flow renders each chat node through
`renderSlot("conversation.chat.node", owner, { entryKey: node.kind })`
(`dsh-client-ui-conversation` `ChatNodeSeat`); `dsh-client-ui-tool` registers
the `tool-call` key and renders the call tree. Disabling `ui-tool` alone is
**not** enough — an unmounted node kind renders a `JsonBlock` "Unknown surface"
fallback.

The verified hide is a **CSS** client plugin: `ChatNodeSeat` wraps every node in
`<div data-chat-flow-kind={node.kind}>` rendered *outside* the render slot, so
`[data-chat-flow-kind="tool-call"] { display: none }` removes the entire row
(including its layout box). The `<style>` tag is injected in the bundle's
*factory body* with `data-plugin`/`data-plugin-css` attributes (the codebase's
own CSS-module pattern, HMR-owned and idempotent). The durable session log
keeps every `tool/call` + `tool/result` pair.

A renderer variant (register the `tool-call` chat-node key with a null
component) is also possible but has two verified wrinkles: it must declare the
`slots` service in the plugin's `inject`, and must use `priority: -1` (ui-tool
registers the same key at implicit `0`; same key + same priority throws, lowest
priority renders). It still leaves an empty row box, so CSS is preferred.

The trajectory tab (`ui-trajectory`) is a separate audit view and can stay, or
be disabled alongside (`- id: ui-trajectory\n  disabled: true`).

**Install:** the package is added to the `web` profile and mounted as a client
row (note the `-w`: `dsh plugin` forwards to pnpm in the profile dir, which is
a workspace root):

```bash
dsh plugin --profile web add -w <file:../integrations/dsh/soma-dsh-hide-tools>
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: soma-hide-tools
      name: '@metafactory/soma-dsh-hide-tools'
```

(The `dsh.client` package is scanned by `dsh-client-modules`, its `./client`
bundle served under `/plugins/<id>/client.js`, and composed by the shell via
`window.__ModuleLoader__.load({ id, factory })`.)

### P1 — `soma` host plugin: algorithm, hooks, memory, orienteer

A host cordis plugin (added to the `web` profile, or to a user `soma` preset)
that gives a live DSH session Soma's four portable surfaces. The verified DSH
surface (against `@deepseek-ai/dsh*` 0.1.0-rc.8):

1. **Prompt section** — `ctx.systemPrompt.section({ name, order, text })`
   (`dsh-system-prompt`). Sections concatenate ascending `order` (−100
   identity, 0 persona, 100–199 tool guidance); an unscoped host row lands in
   the global layer, so every agent sees it on every turn.

2. **Hooks / lifecycle writeback** — DSH splits *live* (in-process cordis)
   events from *durable* (session-log) events:
   - **SessionStart** = live `agent/session-start{ agent, source }`
     (`source: startup|resume|clear|compact`) → `soma lifecycle session-start
     --substrate dsh --session-id <id> --cwd <cwd>`;
   - **SessionEnd** = there is no live turn/end event; the durable `turn/end`
     arrives via `session/event`, and the live last-chance hook is
     `agent/turn-stopping`. The plugin fires `soma lifecycle session-end` when
     the agent first reports `agent/status → 'idle'` (deduped per session via
     `ctx.storageDomain`);
   - **PostToolUse** = durable `tool/result{turn,step,message,error?,meta?}`
     via `session/event` (the live `tools/result` is observe-only);
   - **Feedback** = `recordFeedback(session, text)` (durable
     `feedback/record`) → `soma feedback capture`, and `ctx.messageFeedback`
     for per-message ratings;
   - **Goals** = durable `goal/change` + `ctx.goals` verbs → mirror active
     Soma Algorithm runs / VSAs (optional, later).

3. **Memory** — register the Soma memory route as a runtime skill via
   `ctx.skills.register({ name, description, whenToUse, content })`
   (`dsh-skill`), and/or project the CLI-facing tools.
   `ctx.subprocess.spawn({ argv, cwd, stdio, graceMs })` / `ctx.shell.run`
   invoke the `soma` CLI for `soma memory …`, `soma graph …`,
   `soma algorithm …`, `soma vsa …`.

4. **Algorithm / orienteer** — the `the-algorithm` and `orienteer` skills are
   projected as files (the adapter) and auto-discovered; the plugin can
   additionally seed `ctx.goals` from an active VSA and surface `soma vsa
   check` state in the prompt section.

**Preset:** `~/.dsh/.agent-presets/soma/agent.cordis.yml` mounts a Soma persona
(`@deepseek-ai/dsh-persona`) + the soma plugin rows, so a session created under
the Soma preset gets the full composition while other sessions keep the
`standard` preset. Rows that publish a *service* must sit inside a
`cordis:group` with an `isolate` realm; pure registrants (tools / sections /
skills) need no realm.

## Implementation plan

| Phase | Work | Verify |
| --- | --- | --- |
| 1 | `dsh` adapter: types, install spec, adapter, home/workspace projection, CLI wiring, `docs/substrate-adapters.md` entry | `bun test`, `bun run typecheck`, `soma install dsh --dry-run`, `soma doctor --substrate dsh` |
| 2 | P0 plugin `soma-dsh-hide-tools` (client) — hand-authored bundle + profile row | live reload in a DSH web session; tool calls hidden, session log intact |
| 3 | P1 host plugin `soma` (prompt section + lifecycle writeback + runtime skills) + `soma` preset | session-start digest appears in `~/.soma/memory/episodic/sessions/`; identity visible on turn 1 |
| 4 | Optional: goal/VSA bridge, feedback capture, trajectory hiding | `soma telemetry stats` shows dsh lifecycle events |

## Open questions / deferred

- **Uninstall** — start `reserved` like Codex; removing Soma's `AGENTS.md`
  block and `skills/` entries needs a follow-up that preserves user-owned DSH
  files.
- **`~/.agents/skills`** — DSH also scans the shared agent home; Soma could
  either project there too or rely on `~/.dsh/skills`. Recommend `~/.dsh/skills`
  first (Soma-owned subtree, cleaner uninstall).
- **Plugin distribution** — resolved for the host plugin: the adapter's
  `postProjection` scaffolds it into the profile (see "Installer-managed
  plugin wiring"). The client-side hide-tools plugin is still hand-installed;
  shipping both as Arc/registry packages remains an option later.
- **Code Mode** — `ctx.tools.presentAs('code')` is a model-facing decision and
  orthogonal to hiding UI tool calls; do not conflate them.
