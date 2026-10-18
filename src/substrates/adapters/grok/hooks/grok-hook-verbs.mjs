// Single source of truth for the security-critical Grok hook verb. The PreToolUse verb is
// coupled across THREE call sites that must agree exactly, or the fail-closed gate silently
// disables itself on grok's fail-open platform:
//   - adapter.ts renderGrokHooksJson registers `hook(GROK_PRE_TOOL_USE_VERB)`
//     under PreToolUse — the verb grok spawns the hook with;
//   - grok-hook-entry.mjs runGrokHook dispatches `event === GROK_PRE_TOOL_USE_VERB`
//     into the enforcing handlePreToolUse chain (an UNMATCHED verb falls
//     through to `{continue:true}` = ALLOW);
//   - soma-lifecycle.mjs fails the config-load CLOSED (deny + exit 2) only
//     for this verb.
// A rename in one place without the others is an egress hole. Importing this
// constant in all three makes a rename atomic. This module is projected to
// `~/.grok/hooks/grok-hook-verbs.mjs` so the runtime hooks can import it; it
// holds only a literal (no runtime graph), so the TS CLI imports it too.
export const GROK_PRE_TOOL_USE_VERB = "pre-tool-use";
