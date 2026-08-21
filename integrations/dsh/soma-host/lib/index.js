// @metafactory/soma-dsh-host — DSH host plugin carrying Soma into a live session.
//
// P1 prototype (Soma substrate integration). Mount as a host row in the DSH
// profile (or inside a `soma` agent preset). It gives every live session:
//
//   1. an always-on Soma prompt section (identity / purpose / policy),
//   2. lifecycle writeback to ~/.soma (session-start / session-end),
//   3. a runtime digest skill,
//   4. a `soma_memory` tool that shells out to the `soma` CLI.
//
// Status: smoke-tested against the DSH checkout's own cordis (apply registers
// the section/skill/tool; scoped emitAgentEvent dispatch fires both lifecycle
// spawns with storageDomain dedup). Applied in a booted `dsh web` server —
// session-start observed live; session-end not yet observed in a live server.
//
// The plugin deliberately shells out to the `soma` CLI (via ctx.subprocess, no
// shell interpolation) rather than re-implementing Soma logic — Soma stays the
// single source of truth.

import { defineTool } from "@deepseek-ai/dsh-tools";

const SOMA_SUBSTRATE = "dsh";

function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.id;
}

function cwdOf(agentOrSession) {
  return agentOrSession?.session?.header?.cwd ?? agentOrSession?.header?.cwd ?? process.cwd();
}

export const name = "soma-host";

// Cordis gates every service property access behind the plugin's declared
// inject list (vendor/cordis/src/registry.ts: `new Fiber(ctx, config,
// Inject.resolve(plugin.inject), …)` — an undeclared access throws
// "cannot get property X without inject"). A named `inject` export on the
// module IS the plugin object's static inject (the loader treats the module
// namespace as a Plugin.Object). All five services are mounted by the default
// web composition: systemPrompt + skills + subprocess in @deepseek-ai/dsh-base,
// tools + storageDomain in @deepseek-ai/dsh-web-app.
export const inject = ["systemPrompt", "skills", "tools", "storageDomain", "subprocess"];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 * @param {boolean} [config.writeDigests=true]  shell out to `soma` for lifecycle writeback
 * @param {string}  [config.somaPath='soma']    soma CLI (absolute path if not on PATH)
 * @param {number}  [config.sectionOrder=0]     system-prompt section order
 */
export function apply(ctx, config = {}) {
  const { writeDigests = true, somaPath = "soma", sectionOrder = 0 } = config;

  // ── 1. Always-on Soma prompt section ──────────────────────────────────────
  // Sections concatenate ascending `order` (-100 identity, 0 persona,
  // 100-199 tool guidance). This registers in the global layer, so every agent
  // sees it on every turn.
  ctx.systemPrompt.section({
    name: "soma:core",
    order: sectionOrder,
    text: () => renderSomaEntry(),
  });

  // ── 2. Runtime skill: the digest route ────────────────────────────────────
  // The full Memory / the-algorithm / orienteer / VSA skills are PROJECTED as
  // files by the soma `dsh` adapter and auto-discovered by
  // dsh-skill-filesystem; this runtime card only routes session wrap-up.
  ctx.skills.register({
    name: "soma-digest",
    description:
      "Route a session wrap-up to the Soma session digest: write the ONE assistant-authored digest at the end of a working session.",
    whenToUse: "A session is wrapping up and durable notes about what was done should be recorded.",
    content: [
      "# Soma session digest",
      "",
      "At the end of a substantive working session, write ONE session digest:",
      "```bash",
      `soma memory digest --session <session-id> --body "$(cat)" --substrate ${SOMA_SUBSTRATE}`,
      "```",
      "A second digest for the same session no-ops (with an event). Keep it 8-15 non-empty lines.",
    ].join("\n"),
  });

  // ── 3. Lifecycle writeback ────────────────────────────────────────────────
  // Unscoped listeners (host composition) receive every agent's events.

  ctx.on("agent/session-start", ({ agent }) => {
    if (!writeDigests) return;
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return;
    const cwd = cwdOf(agent);
    void runSoma(ctx, somaPath, ["lifecycle", "session-start", "--substrate", SOMA_SUBSTRATE, "--session-id", sessionId, "--cwd", cwd], cwd);
  });

  // Fire session-end at most once per session, when the agent first goes idle.
  // Dedup via storageDomain so reconnects can't double the writeback;
  // `soma lifecycle session-end` is also idempotent on its side.
  ctx.on("agent/status", ({ agent, status }) => {
    if (!writeDigests || status !== "idle") return;
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return;
    void recordSessionEnd(ctx, somaPath, agent).catch((error) => {
      console.warn("[soma-host] session-end writeback failed:", error);
    });
  });

  // ── 4. soma CLI tools ─────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "soma_memory",
      description: "Recall Soma memory (durable notes) for a topic. Shells out to `soma memory recall`.",
      parameters: {
        query: { type: "string", required: true, description: "Topic to recall from Soma memory." },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      async execute(args, exec) {
        const { stdout } = await runSoma(ctx, somaPath, ["memory", "recall", "--query", args.query], cwdOf(exec));
        return stdout;
      },
    }),
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function renderSomaEntry() {
  // Compact static fallback. The projected `~/.dsh/AGENTS.md` and
  // `~/.dsh/skills/soma/SKILL.md` already carry the full identity / purpose /
  // policy block; this section only anchors the Soma home so the identity file
  // is not duplicated per turn.
  return [
    "You run on Soma: a portable assistant core whose home is ~/.soma.",
    "Your identity, purpose, memory, and working method (the Algorithm, VSA, work graph) live there and project into this harness.",
    "When a task matches the Algorithm, VSA, Memory, or orienteer skills, load and follow them.",
  ].join("\n");
}

async function recordSessionEnd(ctx, somaPath, agent) {
  const sessionId = sessionIdOf(agent);
  const key = `session-end:${sessionId}`;
  const table = await ensureDigestTable(ctx);
  if (await table.get(key)) return; // already written this session

  const cwd = cwdOf(agent);
  const outcome = await runSoma(ctx, somaPath, ["lifecycle", "session-end", "--substrate", SOMA_SUBSTRATE, "--session-id", sessionId, "--cwd", cwd], cwd);
  // Only mark done on success: a failed spawn (soma missing, non-zero exit)
  // must stay retryable — writing the dedup key here would permanently lose
  // this session's writeback. `soma lifecycle session-end` is idempotent on
  // its side, so a later idle re-firing is safe.
  if (outcome.exitCode !== 0) {
    console.warn(`[soma-host] session-end writeback failed (exit ${outcome.exitCode}); will retry on next idle`);
    return;
  }
  await table.put(key, { sessionId, writtenAt: Date.now() });
}

let digestTableHandle = null;

async function ensureDigestTable(ctx) {
  // module-level handle; the JSON backend writes ~/.dsh/storages/soma_state.json
  if (digestTableHandle) return digestTableHandle;
  const { defineDomain } = await import("@deepseek-ai/dsh-storage-domain");
  const { z } = await import("zod");
  const domain = await ctx.storageDomain.open(
    defineDomain({
      name: "soma_state",
      version: 1,
      tables: {
        digests: {
          valueSchema: z.object({
            sessionId: z.string(),
            writtenAt: z.number(),
          }),
        },
      },
    }),
  );
  digestTableHandle = domain.table("digests");
  return digestTableHandle;
}

/**
 * Run the soma CLI best-effort. Uses ctx.subprocess (raw argv, no shell) and
 * returns `{ exitCode, stdout }`; never throws for a non-zero exit.
 */
async function runSoma(ctx, somaPath, args, cwd) {
  const subprocess = ctx.subprocess;
  if (!subprocess) {
    console.warn("[soma-host] no subprocess provider mounted; skipping", args.join(" "));
    return { exitCode: null, stdout: "" };
  }
  const handle = subprocess.spawn({
    argv: [somaPath, ...args],
    cwd,
    stdio: { stdin: "ignore", stdout: { maxBytes: 200_000 }, stderr: { maxBytes: 100_000 } },
    graceMs: 10_000,
  });
  try {
    const outcome = await handle.done;
    const stdout = handle.collected?.stdout?.readFrom?.(0)?.text ?? "";
    if (outcome.exitCode !== 0) {
      const stderr = handle.collected?.stderr?.readFrom?.(0)?.text ?? "";
      console.warn("[soma-host]", [somaPath, ...args].join(" "), "exited", outcome.exitCode, stderr.slice(0, 400));
    }
    return { exitCode: outcome.exitCode, stdout };
  } catch (error) {
    console.warn("[soma-host] spawn failed for", [somaPath, ...args].join(" "), error);
    return { exitCode: null, stdout: "" };
  }
}
