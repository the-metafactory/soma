// @metafactory/soma-dsh-hide-tools — DSH client plugin (P0).
//
// Hides tool-call rows from the DSH web chat flow. Tool calls remain fully
// logged in the durable session log (tool/call + tool/result pairs) and stay
// visible in the Trajectory audit tab; only the in-flow tool cards disappear,
// so the assistant's own voice (Soma's communication.md) is what the user
// reads.
//
// This bundle is a CLASSIC SCRIPT served by the DSH shell under
// /plugins/<id>/client.js (the `./client` export). Its only job is to register
// a factory through the module loader; the factory returns the cordis client
// plugin entry ({ apply, inject }).
//
// WHY CSS IN THE FACTORY BODY (not in apply): the chat-flow row wrapper
// (`<div data-chat-flow-kind="tool-call">`) is rendered by ChatNodeSeat OUTSIDE
// the render slot, so a null renderer still leaves an empty row box in the
// flow. CSS removes the whole row, including its layout box. Injecting the
// <style> in the factory body matches the codebase's own CSS-module emission
// pattern: the tag carries data-plugin + data-plugin-css so the HMR driver
// owns/removes it, and the querySelector guard keeps re-execution idempotent.
//
// Verified against @deepseek-ai/dsh* 0.1.0-rc.8:
//   - dsh-client-modules serves exports["./client"] and composes __DSH_BOOT__.
//   - ChatNodeSeat emits data-chat-flow-key/data-chat-flow-kind (ui-conversation).
//   - ui-tool registers the "tool-call" chat node at implicit priority 0.

window.__ModuleLoader__.load({
  id: "@metafactory/soma-dsh-hide-tools",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ── CSS injection (runs once at materialization) ────────────────────────
    var STYLE_ID = "soma-dsh-hide-tools/tool-call-hide.css";
    var RULES = [
      // Tool call trees in the conversation flow.
      '[data-chat-flow-kind="tool-call"] { display: none !important; }',
      // Belt-and-suspenders: any chat row keyed as a call.
      '[data-chat-anchor-key^="call:"] { display: none !important; }',
    ].join("\n");

    if (
      typeof document !== "undefined" &&
      document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null
    ) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "soma-dsh-hide-tools";
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = RULES;
      document.head.appendChild(tag);
    }

    // No services used → apply is a no-op.
    function apply() {}

    module.exports = { apply: apply };

    // ALTERNATIVE — null renderer for the "tool-call" chat node key (NOT active):
    //
    //   var inject = ["slots"]; // the `slots` SERVICE, not a package name
    //
    //   function applyRenderer(ctx) {
    //     ctx.slots.inject("conversation.chat.node", () =>
    //       ctx.slots.register({
    //         name: "conversation.chat.node",
    //         key: "tool-call",
    //         priority: -1, // MUST differ from ui-tool's implicit 0; lowest renders
    //       }, function ToolCallHidden() { return null; }),
    //     );
    //   }
    //
    // Duplicate-key semantics (SlotCore): same key AND same priority throws;
    // a different priority is kept and the lowest-priority entry renders. This
    // variant still leaves an empty row box (ChatNodeSeat renders the wrapper
    // outside the slot), so CSS is the preferred approach.

    return module.exports;
  },
});
