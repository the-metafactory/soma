# Claude Code hooks

After `soma install claude-code`, Claude Code runs `hooks/soma/soma-claude-code-hook.mjs <event>` with a JSON payload on stdin at session start/end, tool use, subagent stop and prompt submit. Each hook records lifecycle events into the Soma home and may reproject memory.

## Sub-features

- `hook-session-start` records `lifecycle.session_start` for the payload's `session_id`.
- `hook-settings` wires each event in `settings.json` to the scratch hook path.

## How to get to it (user POV)

- Start a Claude Code session with the projected `settings.json`; the substrate pipes the payload.
- Equivalent drive: `printf '<json>' | bun <home>/.claude/hooks/soma/soma-claude-code-hook.mjs <event>`.

## Driving it with verify-soma.sh

Preconditions:

- `$V launch "$RUN"` done; `$V doctor "$RUN"` reports hooks pointing into the scratch home.

- **Settings.** `grep -o 'soma-claude-code-hook.mjs'"'"' [a-z-]*' "$RUN/home/.claude/settings.json" | sort -u`. Lists `session-start`, `session-end`, `writeback-tool` and the other events.
- **Session start.** `$V hook "$RUN" session-start '{"session_id":"verify-hook-1","cwd":"/tmp","hook_event_name":"SessionStart","source":"startup"}'`. Exit 0.
- **Event landed.** `grep -c verify-hook-1 "$RUN/home/.soma/memory/STATE/events.jsonl"` is at least 1, and `grep -c verify-hook-1 "$HOME/.soma/memory/STATE/events.jsonl"` is `0` (nothing leaked into the principal's home).
- **Proof.** `cp "$RUN/home/.soma/memory/STATE/events.jsonl" "$RUN/evidence/"`.

## Gotchas

- The hook resolves the Soma home from `HOME`; without the helper's `HOME=$RUN/home` it writes into the principal's live Soma home.
- Hooks must not fail a session: a broken payload may still exit 0. Prove effects in `events.jsonl`, not by exit code.
- The live Claude Code session running the agent fires its own hooks into the principal's `memory/STATE`; that is why `real-home-check` excludes that directory.
