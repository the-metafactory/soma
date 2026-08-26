// @metafactory/soma-dsh-host — DSH host plugin carrying Soma into a live session.
//
// P1 prototype (Soma substrate integration). Mount as a host row in the DSH
// profile (or inside a `soma` agent preset). It gives every live session:
//
//   1. an always-on Soma prompt section (identity / purpose / policy),
//   2. lifecycle writeback to ~/.soma (session-start / session-end),
//   3. a runtime digest skill,
//   4. narrow host tools for Soma memory, Algorithm, and work-graph commands.
//
// Status: smoke-tested against the DSH checkout's own cordis (apply registers
// the section/skill/tool; scoped emitAgentEvent dispatch fires both lifecycle
// spawns with storageDomain dedup). Applied in a booted `dsh web` server —
// session-start observed live; session-end not yet observed in a live server.
//
// The plugin deliberately shells out to the `soma` CLI (via ctx.subprocess, no
// shell interpolation) rather than re-implementing Soma logic — Soma stays the
// single source of truth.

import { randomUUID } from "node:crypto";
import { realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
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

  // ── 4. Soma CLI tools ─────────────────────────────────────────────────────
  // These run through the host's local subprocess provider, rather than the
  // model-facing workspace sandbox. Keep the exposed verbs narrow: they may
  // mutate the Soma home or the work graph, but cannot become an arbitrary
  // host-shell or arbitrary-path capability.
  ctx.tools.register(
    defineTool({
      name: "soma_memory",
      description: "Recall Soma memory (durable notes) for a topic. Shells out to `soma memory recall`.",
      parameters: {
        query: { type: "string", required: true, description: "Topic to recall from Soma memory." },
      },
      output: textOutput(),
      async execute(args, exec) {
        return await runSomaChecked(ctx, somaPath, ["memory", "recall", "--query", args.query], cwdOf(exec));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "soma_algorithm",
      description:
        "Read or update a durable Soma Algorithm run. This host tool writes through to the Soma home outside the workspace sandbox; use it instead of bash for `soma algorithm`.",
      parameters: {
        action: { type: "string", required: true, enum: ALGORITHM_ACTIONS, description: "The supported `soma algorithm` verb." },
        arguments: { type: "array", required: true, items: { type: "string" }, description: "CLI arguments for the selected verb only, without `algorithm` or the action." },
      },
      output: textOutput(),
      async execute(args, exec) {
        const argv = algorithmArgv(args.action, args.arguments);
        return await runSomaChecked(ctx, somaPath, argv, cwdOf(exec));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "soma_graph",
      description:
        "Read or perform bounded work-graph operations through Soma. Use it instead of bash for graph frontier, claim, release, add, close, audit, or decisions. For close, provide resolution text or a workspace-relative resolutionFile; declared probes execute through the existing graph close gate.",
      parameters: {
        action: { type: "string", required: true, enum: GRAPH_ACTIONS, description: "The supported `soma graph` verb." },
        arguments: { type: "array", required: true, items: { type: "string" }, description: "CLI arguments for the selected verb only, without `graph` or the action." },
        resolution: { type: "string", description: "Close-resolution prose. The host writes it to a temporary file inside the current workspace, passes that file to the CLI, then removes it." },
        resolutionFile: { type: "string", description: "Existing resolution prose file relative to the current workspace. Absolute paths, traversal, and symlink escapes are refused." },
      },
      output: textOutput(),
      async execute(args, exec) {
        const cwd = cwdOf(exec);
        const prepared = await graphArgv(args, cwd);
        try {
          return await runSomaChecked(ctx, somaPath, prepared.argv, cwd);
        } finally {
          await prepared.dispose();
        }
      },
    }),
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

const ALGORITHM_ACTIONS = [
  "new", "classify", "list", "show", "capabilities", "invoke", "remove-capability",
  "plan", "observe", "decision", "change", "ref", "resolve", "step", "verify",
  "learn", "reflect", "reflections", "batch", "advance", "resume",
];
const ALGORITHM_SUBSTRATE_ACTIONS = new Set([
  "new", "capabilities", "invoke", "observe", "verify", "learn", "reflect", "batch", "advance", "resume",
]);
const GRAPH_ACTIONS = ["frontier", "node", "claim", "release", "add", "close", "audit", "decisions"];
const FORBIDDEN_ARGUMENTS = new Set(["--home-dir", "--soma-home", "--isa", "--body-file", "--resolution-file"]);
const TEMP_RESOLUTION_PREFIX = ".soma-graph-resolution-";

function textOutput() {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }],
  };
}

function validateArguments(action, args, forbidden = FORBIDDEN_ARGUMENTS) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) {
    throw new Error(`${action}: arguments must be strings without NUL bytes.`);
  }
  for (const arg of args) {
    if (forbidden.has(arg)) throw new Error(`${action}: ${arg} is not available through this host tool.`);
  }
}

function algorithmArgv(action, args) {
  validateArguments(`soma_algorithm ${action}`, args);
  if (args.includes("--substrate")) {
    throw new Error("soma_algorithm: --substrate is managed by the DSH host and must not be supplied.");
  }
  return ["algorithm", action, ...args, ...(ALGORITHM_SUBSTRATE_ACTIONS.has(action) ? ["--substrate", SOMA_SUBSTRATE] : [])];
}

async function graphArgv(input, cwd) {
  const { action, arguments: args, resolution, resolutionFile } = input;
  validateArguments(`soma_graph ${action}`, args);
  if (action !== "close" && (resolution !== undefined || resolutionFile !== undefined)) {
    throw new Error(`soma_graph ${action}: resolution inputs are available only for close.`);
  }
  if (resolution !== undefined && resolutionFile !== undefined) {
    throw new Error("soma_graph close: supply either resolution or resolutionFile, not both.");
  }
  if (resolution !== undefined && (typeof resolution !== "string" || resolution.trim().length === 0)) {
    throw new Error("soma_graph close: resolution must be non-empty prose.");
  }
  if (resolutionFile !== undefined && typeof resolutionFile !== "string") {
    throw new Error("soma_graph close: resolutionFile must be a workspace-relative path.");
  }

  if (action !== "close") return { argv: ["graph", action, ...args], dispose: async () => {} };
  if (args.includes("--propose") && (resolution !== undefined || resolutionFile !== undefined)) {
    throw new Error("soma_graph close: resolution inputs cannot be combined with --propose; its body is the resolution.");
  }

  if (resolutionFile !== undefined) {
    const path = await resolveWorkspaceFile(cwd, resolutionFile);
    return { argv: ["graph", action, ...args, "--resolution-file", path], dispose: async () => {} };
  }
  if (resolution !== undefined) {
    const path = await writeTemporaryResolution(cwd, resolution);
    return {
      argv: ["graph", action, ...args, "--resolution-file", path],
      dispose: async () => { await rm(path, { force: true }); },
    };
  }
  return { argv: ["graph", action, ...args], dispose: async () => {} };
}

async function resolveWorkspaceFile(cwd, file) {
  if (file.trim().length === 0 || isAbsolute(file)) {
    throw new Error("soma_graph close: resolutionFile must be a non-empty path relative to the current workspace.");
  }
  const workspace = await realpath(cwd);
  const candidate = resolve(workspace, file);
  if (!isWithin(workspace, candidate)) {
    throw new Error("soma_graph close: resolutionFile must remain inside the current workspace.");
  }
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    throw new Error(`soma_graph close: resolutionFile could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isWithin(workspace, resolved)) {
    throw new Error("soma_graph close: resolutionFile resolves outside the current workspace.");
  }
  return resolved;
}

function isWithin(workspace, candidate) {
  const path = relative(workspace, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function writeTemporaryResolution(cwd, resolution) {
  const workspace = await realpath(cwd);
  const file = resolve(workspace, `${TEMP_RESOLUTION_PREFIX}${randomUUID()}.md`);
  // The generated basename is fixed here; reject any unexpected path before write.
  if (dirname(file) !== workspace || !basename(file).startsWith(TEMP_RESOLUTION_PREFIX)) {
    throw new Error("soma_graph close: could not prepare the workspace resolution file.");
  }
  await writeFile(file, resolution, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return file;
}

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
 * returns `{ exitCode, stdout, stderr }`; never throws for a non-zero exit.
 */
async function runSomaChecked(ctx, somaPath, args, cwd) {
  const outcome = await runSoma(ctx, somaPath, args, cwd);
  if (outcome.exitCode !== 0) {
    const stderr = outcome.stderr.trim();
    throw new Error(
      `Soma command failed (${outcome.exitCode ?? "could not start"}): ${[somaPath, ...args].join(" ")}${stderr ? `\n${stderr}` : ""}`,
    );
  }
  return outcome.stdout;
}

async function runSoma(ctx, somaPath, args, cwd) {
  const subprocess = ctx.subprocess;
  if (!subprocess) {
    console.warn("[soma-host] no subprocess provider mounted; skipping", args.join(" "));
    return { exitCode: null, stdout: "", stderr: "" };
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
    const stderr = handle.collected?.stderr?.readFrom?.(0)?.text ?? "";
    if (outcome.exitCode !== 0) {
      console.warn("[soma-host]", [somaPath, ...args].join(" "), "exited", outcome.exitCode, stderr.slice(0, 400));
    }
    return { exitCode: outcome.exitCode, stdout, stderr };
  } catch (error) {
    console.warn("[soma-host] spawn failed for", [somaPath, ...args].join(" "), error);
    return { exitCode: null, stdout: "", stderr: "" };
  }
}
