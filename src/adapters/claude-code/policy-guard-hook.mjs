#!/usr/bin/env bun
// Soma runtime-policy enforcement guard for Claude Code.
//
// SECURITY INVARIANT: this hook is FAIL-CLOSED. Unlike the mode classifier
// (advisory, fail-open), every error path here — missing config, spawn
// failure, non-zero exit, malformed output — denies the tool call or blocks
// the prompt. A broken enforcement path must never silently allow an
// un-inspected action. This mirrors the codex `codex-hook-entry.mjs` contract.
//
// It delegates the actual decision to the portable engine via the
// `soma policy inspect` CLI (substrate-parameterized), so the rules stay in
// one place and never drift per substrate.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function hookDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(join(hookDir(), "soma-policy-guard.config.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: `config is ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed}, not an object` };
    }
    return parsed;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.trim().length === 0) return { __somaParseError: "empty hook input" };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { __somaParseError: "hook input must be a JSON object" };
    }
    return parsed;
  } catch (error) {
    return { __somaParseError: error instanceof Error ? error.message : String(error) };
  }
}

function promptFromInput(input) {
  for (const key of ["prompt", "userPrompt", "message"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return "";
}

function eventName(input) {
  const name = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  if (name === "UserPromptSubmit" || promptFromInput(input)) return "UserPromptSubmit";
  return "PreToolUse";
}

function emitAndExit(payload) {
  console.log(JSON.stringify(payload));
  process.exit(0);
}

function denyPreToolUse(reason) {
  emitAndExit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function blockPromptSubmit(reason) {
  emitAndExit({
    continue: false,
    stopReason: reason,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      decision: "block",
      reason,
    },
  });
}

// "A rule fired" and "the guard could not run" are different operator problems:
// only the second has a recovery, and only the first is a judgement about the
// action. Both still deny — fail-closed is unchanged — but an operator reading
// the denial must be able to tell them apart without re-deriving it from the
// error text. soma#640.
const GUARD_UNAVAILABLE = "Soma policy guard UNAVAILABLE (fail-closed — this is not a policy denial)";

function unavailable(detail) {
  return `${GUARD_UNAVAILABLE}: ${detail} Recover with: soma install claude-code --apply, or soma runtime rollback --substrate claude-code.`;
}

// Prompt surface → runtime-policy inspection (prompt injection, etc.).
// Tool-call surface → the composite `policy guard` (runtime inspect +
// write-target private-context check + inbound content scan) so Claude Code
// reaches full codex three-check parity from one CLI call.
function runInspect(config, surface, payload) {
  const env = { ...process.env };
  let args;
  if (surface === "prompt") {
    env.SOMA_RUNTIME_POLICY_PROMPT = payload.prompt || "";
    args = [
      "src/cli.ts", "policy", "inspect",
      "--soma-home", config.somaHome,
      "--substrate", "claude-code",
      "--surface", "prompt",
      "--prompt-env", "SOMA_RUNTIME_POLICY_PROMPT",
      "--record", "deny", "--json",
    ];
  } else {
    const input = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input) ? payload.input : { raw: String(payload.input ?? "") };
    env.SOMA_RUNTIME_POLICY_TOOL_INPUT = JSON.stringify(input);
    args = [
      "src/cli.ts", "policy", "guard",
      "--soma-home", config.somaHome,
      "--substrate", "claude-code",
      "--tool-name", payload.toolName || "",
      "--tool-input-env", "SOMA_RUNTIME_POLICY_TOOL_INPUT",
      "--record", "deny", "--json",
    ];
    if (payload.cwd) args.push("--cwd", payload.cwd);
  }
  return spawnSync(config.bunPath, args, {
    cwd: config.trustedSomaRepo,
    encoding: "utf8",
    timeout: 25000,
    env,
  });
}

function parseInspection(output) {
  let inspection;
  try {
    inspection = JSON.parse(output);
  } catch {
    throw new Error(`returned invalid JSON: ${output || "empty output"}`);
  }
  if (!inspection || typeof inspection !== "object" || typeof inspection.decision !== "string") {
    throw new Error(`returned unexpected structure: ${output || "empty output"}`);
  }
  return inspection;
}

// Soma's substrate-neutral "ask principal" decision has no portable Claude
// Code PreToolUse shape, so it projects to a denial with an approval reason —
// the conservative choice for an enforcement gate.
function shouldBlock(decision) {
  return decision === "deny" || decision === "ask";
}

function isUsablePath(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function guard(input, surfaceEvent, deny) {
  const config = readConfig();
  if (config.error || !isUsablePath(config.bunPath) || !isUsablePath(config.trustedSomaRepo) || !isUsablePath(config.somaHome)) {
    deny(unavailable(`invalid config (${config.error || "missing or empty fields"}).`));
    return;
  }
  if (input.__somaParseError) {
    deny(unavailable(`${input.__somaParseError}.`));
    return;
  }

  const result = surfaceEvent === "UserPromptSubmit"
    ? runInspect(config, "prompt", { prompt: promptFromInput(input) })
    : runInspect(config, "tool_call", {
        toolName: input.tool_name || input.toolName,
        input: input.tool_input || input.toolInput || {},
        cwd: typeof input.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd : undefined,
      });

  const output = result.stdout || result.stderr || "";
  if (result.status !== 0) {
    deny(unavailable(`runtime policy inspection failed: ${output || "unknown error"}.`));
    return;
  }
  let inspection;
  try {
    inspection = parseInspection(output);
  } catch (error) {
    deny(unavailable(`runtime policy inspection ${error instanceof Error ? error.message : String(error)}.`));
    return;
  }
  if (shouldBlock(inspection.decision)) {
    deny(inspection.reason || `Soma runtime policy ${inspection.decision}.`);
    return;
  }

  emitAndExit({ continue: true });
}

/**
 * Fail closed on ANY unexpected throw, not just the paths enumerated above.
 * Two exceptions were found by review after the fact — a config parsing to
 * `null`, and a `bunPath` of `""` that passes a typeof check and then throws
 * inside spawn. Both crashed the guard, which is the one outcome worse than
 * denying: an operator sees a stack trace where a decision belongs. Enumerating
 * throw sites is a losing game, so the surface is chosen first and every
 * remaining path lands on it.
 */
function main() {
  const input = readHookInput();
  const surfaceEvent = eventName(input);
  const deny = surfaceEvent === "UserPromptSubmit" ? blockPromptSubmit : denyPreToolUse;
  try {
    guard(input, surfaceEvent, deny);
  } catch (error) {
    deny(unavailable(`guard failed unexpectedly: ${error instanceof Error ? error.message : String(error)}.`));
  }
}

main();
