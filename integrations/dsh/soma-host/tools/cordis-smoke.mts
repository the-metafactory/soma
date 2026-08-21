// Cordis smoke test for the soma-host plugin — the evidence behind the
// "smoke-tested against real cordis" claims in this package's README.
//
// Applies the INSTALLED plugin (the copy `soma install dsh --apply` wired
// into the DSH web profile) on the DeepSeek Harness checkout's own cordis
// runtime with stub services, fires lifecycle events through DSH's real
// scoped agent-event dispatcher (`packages/core/agent/src/dispatch.ts`), and
// asserts every registration + writeback path — including the failure path
// where a failed session-end spawn must NOT write the dedup key (it has to
// stay retryable).
//
// Usage (from anywhere):
//   DSH_CHECKOUT=/path/to/deepseek-harness \
//     node --import tsx/esm tools/cordis-smoke.mts
// MUST run under Node (as `dsh web` does): dsh-tools' JSON-schema author
// checks are realm-sensitive and reject plain object literals under Bun.
// DSH_CHECKOUT defaults to /Users/fischer/work/deepseek-harness; the plugin
// under test defaults to the profile-installed copy and can be overridden
// with DSH_PLUGIN_PATH.

import { homedir } from "node:os";
import { join } from "node:path";

const dshCheckout = process.env.DSH_CHECKOUT ?? "/Users/fischer/work/deepseek-harness";
const pluginPath =
  process.env.DSH_PLUGIN_PATH ??
  join(homedir(), ".dsh/profiles/web/node_modules/@metafactory/soma-dsh-host/lib/index.js");

// Both imports resolve from the DSH checkout on purpose: this harness runs
// the plugin against the exact cordis + dispatch code DSH ships, without
// making cordis a soma dependency.
const { Context } = await import(join(dshCheckout, "vendor/cordis/src/index.ts"));

const plugin = await import(pluginPath);

let scenario = "happy";
const calls: string[] = [];
const app = new Context();
app.provide("systemPrompt", { section: (s: any) => calls.push(`section:${s.name}:order=${s.order}`) });
app.provide("skills", { register: (s: any) => calls.push(`skill:${s.name}`) });
app.provide("tools", { register: (t: any) => calls.push(`tool:${typeof t === "function" ? t.name : t?.name ?? "?"}`) });
app.provide("storageDomain", {
  open: async () => ({
    table: () => ({
      get: async () => null,
      put: async () => calls.push(`dedup-put[${scenario}]`),
    }),
  }),
});
app.provide("subprocess", {
  spawn: (opts: any) => {
    calls.push(`spawn[${scenario}]:${opts.argv.slice(0, 3).join(" ")}`);
    return {
      done: Promise.resolve({ exitCode: scenario === "failing" && opts.argv.includes("session-end") ? 1 : 0 }),
      collected: {
        stdout: { readFrom: () => ({ text: "" }) },
        stderr: { readFrom: () => ({ text: "" }) },
      },
    };
  },
});

const fiber = app.plugin(plugin, { writeDigests: true, somaPath: "soma" });
await fiber.await();

const { emitAgentEvent } = await import(join(dshCheckout, "packages/core/agent/src/dispatch.ts"));
const fakeAgent = { id: "smoke-1", session: { header: { cwd: "/tmp" } } } as any;
emitAgentEvent(app, fakeAgent, "agent/session-start", { source: "startup" });
emitAgentEvent(app, fakeAgent, "agent/status", { status: "idle" });
await new Promise((r) => setTimeout(r, 2000));

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL (${scenario}): ${message}`);
}

assert(calls.some((c) => c.startsWith("section:soma:core")), "prompt section registered");
assert(calls.some((c) => c.startsWith("skill:soma-digest")), "runtime skill registered");
assert(calls.some((c) => c.startsWith("tool:soma_memory")), "tool registered");
assert(calls.some((c) => c.includes("lifecycle session-start") && c.startsWith("spawn[happy]")), "session-start fired");
assert(calls.some((c) => c.includes("lifecycle session-end") && c.startsWith("spawn[happy]")), "session-end fired");
assert(calls.includes("dedup-put[happy]"), "dedup key written after successful session-end");

scenario = "failing";
calls.length = 0;
emitAgentEvent(app, fakeAgent, "agent/status", { status: "idle" });
await new Promise((r) => setTimeout(r, 500));
assert(
  calls.some((c) => c.includes("lifecycle session-end") && c.startsWith("spawn[failing]")),
  "failed session-end still attempted",
);
assert(!calls.includes("dedup-put[failing]"), "dedup key NOT written when session-end fails (retryable)");

console.log("CORDIS SMOKE OK");
await app.destroy();
